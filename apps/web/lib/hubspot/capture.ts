import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebhookCapture } from "./webhook.ts";

/**
 * Writes each delivery to `<dir>/<receivedAt>-<status>-<id>.json`. For local live tests through a quick
 * tunnel, so the first real HubSpot delivery can be kept as evidence and turned into a fixture
 * (`jq -r .rawBody <file> > fixture.json`). Never set HUBSPOT_WEBHOOK_CAPTURE_DIR on Vercel.
 */
export function fileCapture(dir: string): (delivery: WebhookCapture) => Promise<void> {
  return async (delivery) => {
    await mkdir(dir, { recursive: true });
    const stamp = delivery.receivedAt.replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${delivery.status}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, `${JSON.stringify(delivery, null, 2)}\n`);
  };
}
