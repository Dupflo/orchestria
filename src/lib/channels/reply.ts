import { sendTelegramMessage } from "./handlers/telegram";
import { postWebhookReply } from "./handlers/webhook";
import {
  editDiscordInteractionReply,
  sendDiscordChannelMessage,
  resolveDiscordSecrets,
} from "./handlers/discord";
import { tryLoadChannelConfig } from "./config";
import { listSubscribers } from "./subscribers";
import { buildMissionOutput } from "../remote/output";

interface MissionInfo {
  missionId: string;
  agentName: string;
  status: "done" | "failed" | "halted";
  sourceChannel: string | null;
  sourceMeta: Record<string, unknown> | null;
}

export async function dispatchMissionReply(info: MissionInfo): Promise<void> {
  // Two delivery paths run independently :
  //   1. Inbound-channel reply  — Telegram message → spawn → reply to the SAME chat
  //   2. Outbound notify        — any mission whose sourceMeta carries `notify_channel`
  //                               (e.g. kanban card configured to ping Telegram on done)
  await Promise.allSettled([
    deliverInboundReply(info),
    deliverNotifyMeta(info),
  ]);
}

async function deliverInboundReply(info: MissionInfo): Promise<void> {
  if (!info.sourceChannel) return;
  const config = tryLoadChannelConfig(info.sourceChannel);
  if (!config) {
    console.warn(`[channels] mission ${info.missionId} sourceChannel ${info.sourceChannel} not found`);
    return;
  }

  const output = buildMissionOutput(info.missionId) || `(mission ${info.status} with no text output)`;

  if (config.type === "telegram") {
    // If streaming already delivered the reply via editMessageText, skip the
    // duplicate end-of-mission sendMessage — streamTelegramReply did the final edit.
    if (info.sourceMeta?.streamed === true) return;
    const chatId = Number(info.sourceMeta?.chat_id);
    const replyTo = info.sourceMeta?.reply_to;
    if (!Number.isFinite(chatId)) {
      console.warn(`[channels] telegram reply missing chat_id for ${info.missionId}`);
      return;
    }
    await sendTelegramMessage(config, chatId, output, typeof replyTo === "number" ? replyTo : undefined);
    return;
  }

  if (config.type === "webhook") {
    const replyUrl = typeof info.sourceMeta?.reply_url === "string" ? info.sourceMeta.reply_url : null;
    if (!replyUrl) return;
    await postWebhookReply(replyUrl, {
      mission_id: info.missionId,
      status: info.status,
      output,
      source_meta: info.sourceMeta,
    });
    return;
  }

  if (config.type === "discord") {
    // Preferred path: PATCH the deferred interaction reply (works ≤15 min).
    const appId = typeof info.sourceMeta?.application_id === "string"
      ? info.sourceMeta.application_id
      : config.application_id;
    const token = typeof info.sourceMeta?.interaction_token === "string"
      ? info.sourceMeta.interaction_token
      : null;
    if (token && appId) {
      try {
        await editDiscordInteractionReply(appId, token, output);
        return;
      } catch (e) {
        console.warn(`[channels] discord follow-up edit failed for ${info.missionId}, falling back to channel send:`, e);
      }
    }

    // Fallback: post a fresh message via the bot token (no interaction window).
    const channelId = typeof info.sourceMeta?.channel_id === "string"
      ? info.sourceMeta.channel_id
      : config.channel_id;
    const { botToken } = resolveDiscordSecrets(config);
    if (!channelId || !botToken) {
      console.warn(`[channels] discord reply missing channel_id or bot token for ${info.missionId}`);
      return;
    }
    await sendDiscordChannelMessage(botToken, channelId, output);
    return;
  }
}

/**
 * Outbound notify : when a mission's sourceMeta declares `notify_channel`, deliver the output
 * there regardless of where the mission came from (kanban card, manual run, etc.).
 *
 * sourceMeta shape :
 *   notify_channel:   string  (channel name from `.orchestria/channels/<name>.json`)
 *   notify_on:        "always" | "failure" | "never"  (defaults to "always")
 *   target_chat_ids:  number[] (optional — empty/missing = broadcast to all subscribers)
 */
async function deliverNotifyMeta(info: MissionInfo): Promise<void> {
  const meta = info.sourceMeta;
  if (!meta) return;
  const channelName = typeof meta.notify_channel === "string" ? meta.notify_channel : null;
  if (!channelName) return;

  const notifyOn = (typeof meta.notify_on === "string" ? meta.notify_on : "always") as "always" | "failure" | "never";
  if (notifyOn === "never") return;
  if (notifyOn === "failure" && info.status === "done") return;

  const config = tryLoadChannelConfig(channelName);
  if (!config) {
    console.warn(`[channels] notify_channel "${channelName}" not found for mission ${info.missionId}`);
    return;
  }

  const output = buildMissionOutput(info.missionId) || `(mission ${info.status} with no text output)`;
  const prefix = info.status === "done"
    ? `📋 *${info.agentName}*\n`
    : `🚨 *${info.agentName}* — ${info.status.toUpperCase()}\n`;
  const body = prefix + output;

  if (config.type === "telegram") {
    let recipients: number[] = [];
    const rawTargets = meta.target_chat_ids;
    if (Array.isArray(rawTargets)) {
      recipients = rawTargets.map(Number).filter((n) => Number.isFinite(n));
    } else if (typeof rawTargets === "number") {
      recipients = [rawTargets];
    } else {
      recipients = listSubscribers(channelName).map((s) => s.chat_id);
    }
    if (recipients.length === 0) {
      console.warn(`[channels] no telegram recipients for mission ${info.missionId} on channel ${channelName}`);
      return;
    }
    // Avoid double-delivery if the inbound branch already sent something to one of these chats
    const inboundChatId = info.sourceChannel === channelName ? Number(meta.chat_id) : NaN;
    for (const chatId of recipients) {
      if (Number.isFinite(inboundChatId) && chatId === inboundChatId) continue;
      try {
        await sendTelegramMessage(config, chatId, body);
      } catch (e) {
        console.error(`[channels] notify to chat ${chatId} failed:`, e);
      }
    }
    return;
  }

  // discord / imessage / webhook : not implemented for outbound notify yet
}
