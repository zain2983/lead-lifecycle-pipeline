import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HubSpotClient } from "../src/api.ts";
import { CONTACT_READ_PROPERTIES, getContactById } from "../src/contact-read.ts";
import {
  exchangeAuthorizationCode,
  HubSpotOAuthError,
  oauthErrorCodes,
  refreshAccessToken,
} from "../src/oauth.ts";

/**
 * Contract tests: each fixture in fixtures/api is one HubSpot exchange (request + response). Today every
 * one is `source: "docs"`, built from HubSpot's documented examples with synthetic values. To swap one
 * for a recording, overwrite the file with the same envelope and `source: "recording"`: the assertions
 * below read their expectations from the fixture itself, so they keep working unless HubSpot's shape
 * differs from the docs, which is exactly what they should catch.
 */
const dir = path.resolve(import.meta.dirname, "../fixtures/api");

const fixtureSchema = z.object({
  source: z.enum(["docs", "recording"]),
  /** docs: the page the shape came from. */
  docs: z.url().optional(),
  /** recording: when, against which account (never a token). */
  recordedAt: z.string().optional(),
  read: z.string().optional(),
  note: z.string(),
  request: z.object({
    method: z.enum(["GET", "POST", "PATCH"]),
    path: z.string().startsWith("/"),
    form: z.array(z.string()).optional(),
  }),
  response: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown(),
  }),
});
type Fixture = z.infer<typeof fixtureSchema>;

function load(name: string): Fixture {
  return fixtureSchema.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
}

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  form?: URLSearchParams;
  authorization: string | null;
}

/** A fetch that answers exactly as the fixture says, and records what was sent. */
function serve(fixture: Fixture): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      form: init?.body instanceof URLSearchParams ? init.body : undefined,
      authorization: headers.get("authorization"),
    });
    return new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status,
      headers: { "content-type": "application/json", ...fixture.response.headers },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

describe("fixtures/api", () => {
  it("every file has the envelope, a source and where it came from", () => {
    const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const fixture = load(file);
      if (fixture.source === "docs") expect(fixture.docs, file).toBeDefined();
      else expect(fixture.recordedAt, file).toBeDefined();
    }
  });
});

describe("GET /crm/objects/2026-09/contacts/{id}", () => {
  it("200: keeps exactly the allow-listed properties, missing ones as null", async () => {
    const fixture = load("contacts-get.200.json");
    const { fetch, seen } = serve(fixture);
    const client = new HubSpotClient({ token: "synthetic-key", baseUrl: "https://x.test", fetch });
    const id = fixture.request.path.split("/").at(-1) ?? "";
    const contact = await getContactById(client, id);

    const body = fixture.response.body as {
      id: string;
      properties: Record<string, string | null>;
      createdAt: string;
    };
    expect(seen[0]?.method).toBe(fixture.request.method);
    expect(seen[0]?.path).toBe(fixture.request.path);
    expect(seen[0]?.query.get("properties")?.split(",")).toEqual([...CONTACT_READ_PROPERTIES]);
    expect(contact?.id).toBe(body.id);
    expect(contact?.createdAt.toISOString()).toBe(new Date(body.createdAt).toISOString());
    expect(Object.keys(contact?.properties ?? {})).toEqual([...CONTACT_READ_PROPERTIES]);
    for (const name of CONTACT_READ_PROPERTIES) {
      expect(contact?.properties[name], name).toBe(body.properties[name] ?? null);
    }
    // HubSpot's own extras never leave the function.
    expect(contact?.properties).not.toHaveProperty("hs_object_id");
    expect(contact?.properties).not.toHaveProperty("createdate");
  });

  it("404: not found is null, not an error", async () => {
    const fixture = load("contacts-get.404.json");
    const { fetch } = serve(fixture);
    const client = new HubSpotClient({ token: "synthetic-key", baseUrl: "https://x.test", fetch });
    const id = fixture.request.path.split("/").at(-1) ?? "";
    expect(await getContactById(client, id)).toBeNull();
  });

  it("refuses a property outside the allow-list before sending anything", async () => {
    const { fetch, seen } = serve(load("contacts-get.200.json"));
    const client = new HubSpotClient({ token: "synthetic-key", baseUrl: "https://x.test", fetch });
    await expect(
      // @ts-expect-error: not on the allow-list
      getContactById(client, "610000000001", ["email", "hs_analytics_source"]),
    ).rejects.toThrow("not on the read allow-list: hs_analytics_source");
    expect(seen).toHaveLength(0);
  });
});

describe("POST /oauth/v3/token", () => {
  const credentials = { clientId: "client-0001", clientSecret: "client-secret-0001" };

  it("authorization_code 200: sends the documented form and parses the answer", async () => {
    const fixture = load("oauth-token.authorization_code.200.json");
    const { fetch, seen } = serve(fixture);
    const tokens = await exchangeAuthorizationCode({
      ...credentials,
      code: "synthetic-code",
      redirectUri: "http://localhost:3100/api/hubspot/oauth/callback",
      tokenUrl: `https://x.test${fixture.request.path}`,
      fetch,
      now: () => new Date("2026-11-28T00:00:00Z"),
    });
    const body = fixture.response.body as { hub_id: number; expires_in: number };
    expect([...(seen[0]?.form?.keys() ?? [])].sort()).toEqual(
      [...(fixture.request.form ?? [])].sort(),
    );
    expect(tokens.portalId).toBe(BigInt(body.hub_id));
    expect(tokens.accessTokenExpiresAt.toISOString()).toBe(
      new Date(Date.parse("2026-11-28T00:00:00Z") + body.expires_in * 1000).toISOString(),
    );
  });

  it("refresh_token 200: sends the documented form and parses the answer", async () => {
    const fixture = load("oauth-token.refresh_token.200.json");
    const { fetch, seen } = serve(fixture);
    const refreshed = await refreshAccessToken({
      ...credentials,
      refreshToken: "na1-synthetic-refresh",
      tokenUrl: `https://x.test${fixture.request.path}`,
      fetch,
    });
    const body = fixture.response.body as {
      expires_in: number;
      hub_id?: number;
      refresh_token?: string;
    };
    expect([...(seen[0]?.form?.keys() ?? [])].sort()).toEqual(
      [...(fixture.request.form ?? [])].sort(),
    );
    expect(seen[0]?.form?.get("grant_type")).toBe("refresh_token");
    expect(refreshed.expiresInSeconds).toBe(body.expires_in);
    expect(refreshed.portalId).toBe(body.hub_id === undefined ? undefined : BigInt(body.hub_id));
    expect(refreshed.refreshToken).toBe(body.refresh_token);
  });

  it("refresh_token 400 BAD_REFRESH_TOKEN: rejected, with HubSpot's codes", async () => {
    const fixture = load("oauth-token.refresh_token.400.json");
    const { fetch } = serve(fixture);
    const error = await refreshAccessToken({
      ...credentials,
      refreshToken: "na1-synthetic-refresh",
      tokenUrl: `https://x.test${fixture.request.path}`,
      fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HubSpotOAuthError);
    const oauthError = error as HubSpotOAuthError;
    const body = fixture.response.body as { status: string; error: string };
    expect(oauthError.kind).toBe("rejected");
    expect(oauthError.status).toBe(fixture.response.status);
    expect(oauthErrorCodes(oauthError.body)).toEqual({ status: body.status, error: body.error });
  });
});
