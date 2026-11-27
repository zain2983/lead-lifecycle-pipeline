import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("spike queue route", () => {
  it.each([undefined, "0", "true", "yes"])("is a 404 when SPIKE_ROUTES=%s", async (value) => {
    vi.stubEnv("SPIKE_ROUTES", value);
    // No database is touched: the gate comes first.
    vi.stubEnv("DATABASE_URL", undefined);
    const post = await POST(new Request("http://localhost/api/spikes/queue", { method: "POST" }));
    const get = await GET(new Request("http://localhost/api/spikes/queue?id=x"));
    expect([post.status, get.status]).toEqual([404, 404]);
  });
});
