import crypto from "crypto";
import type { WebhookChannelConfig } from "../types";
import { assertPublicHttpUrl } from "../../net/ssrf";

function getSecret(config: WebhookChannelConfig): string {
  const s = process.env[config.secret_env];
  if (!s) throw new Error(`env var ${config.secret_env} not set`);
  return s;
}

export function verifyWebhookSignature(
  rawBody: string,
  config: WebhookChannelConfig,
  headerValue: string | null,
): boolean {
  if (!headerValue) return false;
  const secret = getSecret(config);
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Accept both `sha256=<hex>` and bare `<hex>`
  const provided = headerValue.replace(/^sha256=/i, "").trim();
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface WebhookCallbackPayload {
  mission_id: string;
  status: "done" | "failed" | "halted";
  output: string;
  source_meta: Record<string, unknown> | null;
}

export async function postWebhookReply(replyUrl: string, body: WebhookCallbackPayload): Promise<void> {
  // reply_url is caller-supplied (from the inbound webhook body). Block SSRF
  // before fetching; a blocked URL is logged and skipped, never thrown, so a
  // hostile reply_url can't break the mission-complete flow.
  try {
    await assertPublicHttpUrl(replyUrl);
  } catch (e) {
    console.error(`[webhook] blocked reply_url: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await fetch(replyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
