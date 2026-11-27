// Local stand-in for https://api.hubapi.com/oauth/v3/token. NOT HubSpot: synthetic values only.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3199);
createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const form = new URLSearchParams(raw);
  const fields = [...form.keys()].join(",");
  console.log(
    `fake-token ${req.method} ${req.url} content-type=${req.headers["content-type"]} fields=${fields} grant_type=${form.get("grant_type")} code=${form.get("code")} redirect_uri=${form.get("redirect_uri")}`,
  );
  if (form.get("code") !== "synthetic-code-0001") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "BAD_AUTH_CODE", message: "fake endpoint: unknown code" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      token_type: "bearer",
      refresh_token: "na1-0000-synthetic-refresh-token-e2e1",
      access_token: "synthetic-access-token-e2e1",
      hub_id: 900000001,
      scopes: [
        "oauth",
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.schemas.contacts.read",
        "crm.schemas.contacts.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
      ],
      expires_in: 1800,
    }),
  );
}).listen(port, "127.0.0.1", () => console.log(`fake-token listening on 127.0.0.1:${port}`));
