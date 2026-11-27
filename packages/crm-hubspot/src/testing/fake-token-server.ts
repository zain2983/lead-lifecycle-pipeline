import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for HubSpot's `/oauth/v3/token`, for tests only. It records every request and answers
 * with whatever the test's handler returns. Nothing it returns is a HubSpot response.
 */
export interface FakeTokenRequest {
  method: string;
  contentType: string | undefined;
  form: URLSearchParams;
}

export type FakeTokenHandler = (
  request: FakeTokenRequest,
) => { status: number; body: unknown } | "hang";

export async function startFakeTokenServer(handler: FakeTokenHandler) {
  const requests: FakeTokenRequest[] = [];
  const hanging: ServerResponse[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: FakeTokenRequest = {
      method: req.method ?? "",
      contentType: req.headers["content-type"],
      form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
    };
    requests.push(request);
    const answer = handler(request);
    if (answer === "hang") {
      hanging.push(res);
      return;
    }
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/oauth/v3/token`,
    requests,
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Shaped like the documented v3 token response; every value is synthetic. */
export function syntheticTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    token_type: "bearer",
    refresh_token: "na1-0000-synthetic-refresh-token-0001",
    access_token: "synthetic-access-token-0001",
    hub_id: 900000001,
    scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"],
    expires_in: 1800,
    ...overrides,
  };
}
