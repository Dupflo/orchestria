import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { DiscordChannelConfig } from "../types";

// ─── Discord interaction shapes ─────────────────────────────────────────────

export const INTERACTION_TYPE_PING = 1;
export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;

export const RESPONSE_TYPE_PONG = 1;
export const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
/** Acknowledge the interaction now; we will PATCH the reply later via follow-up. */
export const RESPONSE_TYPE_DEFERRED = 5;
/** Sets the EPHEMERAL flag on a response so only the invoking user sees it. */
export const FLAG_EPHEMERAL = 1 << 6;

interface DiscordOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
}

export interface DiscordInteraction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  channel_id?: string;
  guild_id?: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  data?: {
    name: string;
    options?: DiscordOption[];
  };
}

// ─── Signature verification ─────────────────────────────────────────────────

// Discord ships its app public key as 32 raw bytes hex; Node's `verify` wants
// an SPKI-encoded key, so prepend the standard Ed25519 SPKI ASN.1 header.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function makeEd25519Key(publicKeyHex: string): KeyObject {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) throw new Error("Discord public key must be 32 bytes hex (64 chars)");
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/**
 * Verify a Discord interaction request signature. The signed payload is
 * `timestamp + rawBody` (no separator). Headers come from
 * `X-Signature-Ed25519` and `X-Signature-Timestamp`. Returns `false` on any
 * parse/length/key error rather than throwing — every failure path is "reject".
 */
export function verifyDiscordSignature(
  rawBody: string,
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
): boolean {
  if (!signatureHex || !timestamp) return false;
  try {
    const pub = makeEd25519Key(publicKeyHex);
    const sig = Buffer.from(signatureHex, "hex");
    if (sig.length !== 64) return false;
    const msg = Buffer.from(timestamp + rawBody);
    return verify(null, msg, pub, sig);
  } catch {
    return false;
  }
}

// ─── Interaction parsing ────────────────────────────────────────────────────

/**
 * Extract the user-supplied text from a slash command. We don't constrain the
 * command schema: every option whose value is a string (or coercible) gets
 * concatenated, so commands like `/ask prompt:<text>` or `/agent prompt:<text>
 * tag:<x>` both flow into a single line of input that the @-router can then
 * dispatch.
 */
export function extractCommandText(interaction: DiscordInteraction): string {
  const parts: string[] = [];
  const walk = (opts: DiscordOption[] | undefined): void => {
    if (!opts) return;
    for (const o of opts) {
      if (o.value !== undefined && o.value !== null) parts.push(String(o.value));
      walk(o.options);
    }
  };
  walk(interaction.data?.options);
  return parts.join(" ").trim();
}

// ─── Outbound (reply to the user) ───────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
// Hard Discord limit on message content. Leave a few chars for the ellipsis.
const MAX_CONTENT = 1990;

function truncate(s: string): string {
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + "…" : s;
}

/**
 * Edit the deferred response we sent on the inbound. Works for ~15 minutes
 * after the interaction; after that the token expires and we must fall back
 * to a direct channel post (see `sendDiscordChannelMessage`).
 */
export async function editDiscordInteractionReply(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: truncate(content) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord follow-up PATCH ${res.status}: ${text}`);
  }
}

/** Post a fresh message into a channel via the bot token (no follow-up window). */
export async function sendDiscordChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: truncate(content) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord channel POST ${res.status}: ${text}`);
  }
}

/** Read all the secrets a Discord channel needs from env. Missing values come
 *  back as empty strings so callers can fail with a clean 401/500 rather than
 *  throwing in the request path. */
export function resolveDiscordSecrets(config: DiscordChannelConfig): {
  publicKey: string;
  botToken: string;
  applicationId: string;
} {
  const publicKey = config.public_key_env ? (process.env[config.public_key_env]?.trim() ?? "") : "";
  const botToken = config.bot_token_env ? (process.env[config.bot_token_env]?.trim() ?? "") : "";
  return { publicKey, botToken, applicationId: config.application_id ?? "" };
}
