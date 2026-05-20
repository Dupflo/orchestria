export type ChannelType = "telegram" | "imessage" | "discord" | "webhook";

export interface BaseChannelConfig {
  type: ChannelType;
  default_agent: string;
  agent_routing?: Record<string, string>;
}

export interface TelegramChannelConfig extends BaseChannelConfig {
  type: "telegram";
  /** Name of the env var holding the bot token (preferred for security). */
  bot_token_env?: string;
  /** Raw bot token. Less safe — stored in plain text in .orchestria/channels/*.json. */
  bot_token?: string;
  allowed_chat_ids?: number[];
}

export interface ImessageChannelConfig extends BaseChannelConfig {
  type: "imessage";
  /** macOS-only — uses AppleScript to send/receive via Messages.app */
  allowed_handles?: string[]; // emails or phone numbers
  poll_interval_sec?: number;
}

export interface WebhookChannelConfig extends BaseChannelConfig {
  type: "webhook";
  secret_env: string;
  signature_header?: string;
}

export interface DiscordChannelConfig extends BaseChannelConfig {
  type: "discord";
  /** Discord application id — used to build interaction follow-up URLs. Public.
   *  Required for the slash-command handler; legacy configs may omit it. */
  application_id?: string;
  /** Env var holding the bot token (needed for fallback channel sends). */
  bot_token_env: string;
  /** Env var holding the application's Ed25519 public key (32-byte hex).
   *  Required for the slash-command handler; legacy configs may omit it. */
  public_key_env?: string;
  /** Optional: restrict to a specific guild. */
  guild_id?: string;
  /** Optional: restrict replies to a specific channel. */
  channel_id?: string;
}

export type ChannelConfig = TelegramChannelConfig | ImessageChannelConfig | WebhookChannelConfig | DiscordChannelConfig;

export interface ResolvedRoute {
  agent: string;
  cleanedInput: string;
}

export interface InboundContext {
  channelName: string;
  config: ChannelConfig;
  rawText: string;
  attachments?: { name: string; path: string }[];
  /** Per-channel reply context (e.g. Telegram chat_id, webhook reply_url) */
  replyMeta: Record<string, unknown>;
}
