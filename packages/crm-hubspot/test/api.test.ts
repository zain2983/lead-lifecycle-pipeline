import { afterEach, describe, expect, it } from "vitest";
import { HubSpotApiError, HubSpotClient, HubSpotOutcomeUnknownError } from "../src/api.ts";
import { type FakeHubSpot, startFakeHubSpot } from "../src/testing/index.ts";

const TOKEN = "synthetic-service-key-0001";
let fake: FakeHubSpot | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** A client whose sleeps are recorded instead of waited (the clock still moves, so the limiter works). */
function client(
  url: string,
  overrides: Partial<ConstructorParameters<typeof HubSpotClient>[0]> = {},
) {
  const sleeps: number[] = [];
  let clock = 0;
  const c = new HubSpotClient({
    token: TOKEN,
    baseUrl: url,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    ...overrides,
  });
  return { client: c, sleeps };
}

const GROUPS = "/crm/properties/2026-09/contacts/groups/contactinformation";
const TOO_MANY = {
  status: 429,
  body: {
    status: "error",
    message: "You have reached your ten_secondly_rolling limit.",
    errorType: "RATE_LIMIT",
    policyName: "TEN_SECONDLY_ROLLING",
  },
};

describe("HubSpotClient", () => {
  it("sends the service key as a Bearer token and never accepts a wrong one", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    const ok = await client(fake.url).client.request({ method: "GET", path: GROUPS });
    expect(ok.status).toBe(200);
    const wrong = new HubSpotClient({ token: "other", baseUrl: fake.url });
    await expect(wrong.request({ method: "GET", path: GROUPS })).rejects.toMatchObject({
      status: 401,
      category: "INVALID_AUTHENTICATION",
    });
  });

  it("backs off on a 429 with growing, jittered delays, then succeeds", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ path: GROUPS }, TOO_MANY, 3);
    const { client: c, sleeps } = client(fake.url);
    const response = await c.request({ method: "GET", path: GROUPS });
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([375, 750, 1500]); // base/2 + 0.5 × base/2, base = 500 × 2^attempt
    expect(c.stats).toMatchObject({ requests: 4, retries: 3 });
  });

  it("retries a 429 on a write too (HubSpot refused it before processing)", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ method: "POST", path: /batch\/upsert$/ }, TOO_MANY, 1);
    const { client: c } = client(fake.url);
    const response = await c.request({
      method: "POST",
      path: "/crm/objects/2026-09/contacts/batch/upsert",
      body: {
        inputs: [{ idProperty: "email", id: "a@example.com", properties: { firstname: "A" } }],
      },
    });
    expect(response.status).toBe(200);
    expect(c.stats.retries).toBe(1);
  });

  it("gives up after maxRetries and reports HubSpot's 429 body as it came", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ path: GROUPS }, TOO_MANY, 10);
    const { client: c } = client(fake.url, { maxRetries: 2 });
    const error = await c.request({ method: "GET", path: GROUPS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubSpotApiError);
    expect((error as HubSpotApiError).status).toBe(429);
    expect((error as HubSpotApiError).body).toContain("TEN_SECONDLY_ROLLING");
    expect(c.stats.requests).toBe(3);
  });

  it("does not retry the daily limit", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext(
      { path: GROUPS },
      {
        status: 429,
        body: {
          status: "error",
          message: "You have reached your daily limit.",
          errorType: "RATE_LIMIT",
          policyName: "DAILY",
        },
      },
      5,
    );
    const { client: c, sleeps } = client(fake.url);
    await expect(c.request({ method: "GET", path: GROUPS })).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toEqual([]);
  });

  it("turns a timeout on a write into an unknown outcome, without retrying", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ method: "POST", path: /batch\/upsert$/ }, "hang", 5);
    const { client: c } = client(fake.url, { timeoutMs: 200 });
    const error = await c
      .request({
        method: "POST",
        path: "/crm/objects/2026-09/contacts/batch/upsert",
        body: { inputs: [] },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubSpotOutcomeUnknownError);
    expect((error as HubSpotOutcomeUnknownError).outcome).toBe("unknown");
    expect(c.stats.requests).toBe(1);
  });

  it("turns a 5xx on a write into an unknown outcome too, but retries it on a read", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext(
      { method: "POST", path: /batch\/upsert$/ },
      { status: 504, body: "gateway timeout" },
      1,
    );
    fake.failNext({ path: GROUPS }, { status: 502, body: "bad gateway" }, 1);
    const { client: c } = client(fake.url);
    await expect(
      c.request({
        method: "POST",
        path: "/crm/objects/2026-09/contacts/batch/upsert",
        body: { inputs: [] },
      }),
    ).rejects.toBeInstanceOf(HubSpotOutcomeUnknownError);
    expect((await c.request({ method: "GET", path: GROUPS })).status).toBe(200);
  });

  it("retries a timed-out read", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ path: GROUPS }, "hang", 1);
    const { client: c } = client(fake.url, { timeoutMs: 200 });
    expect((await c.request({ method: "GET", path: GROUPS })).status).toBe(200);
    expect(c.stats.retries).toBe(1);
  });

  it("waits for the window when its own limit is reached", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    const { client: c, sleeps } = client(fake.url, {
      rateLimit: { maxRequests: 3, windowMs: 10_000 },
    });
    for (let i = 0; i < 7; i++) await c.request({ method: "GET", path: GROUPS });
    expect(c.stats.rateLimitWaits).toBe(2);
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  it("waits when HubSpot's headers say the window is used up", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext(
      { path: GROUPS },
      {
        status: 200,
        body: { name: "contactinformation" },
        headers: {
          "x-hubspot-ratelimit-remaining": "0",
          "x-hubspot-ratelimit-interval-milliseconds": "10000",
        },
      },
      1,
    );
    const { client: c, sleeps } = client(fake.url);
    await c.request({ method: "GET", path: GROUPS });
    await c.request({ method: "GET", path: GROUPS });
    expect(sleeps).toEqual([10_000]);
  });

  it("never puts the token in an error message", async () => {
    fake = await startFakeHubSpot({ token: TOKEN });
    fake.failNext({ path: GROUPS }, { status: 400, body: { status: "error", message: "bad" } }, 1);
    const error = (await client(fake.url)
      .client.request({ method: "GET", path: GROUPS })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(TOKEN);
  });
});
