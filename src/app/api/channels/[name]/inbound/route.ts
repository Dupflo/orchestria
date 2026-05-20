import { NextResponse } from "next/server";
import { tryLoadChannelConfig } from "@/lib/channels/config";
import { resolveRoute } from "@/lib/channels/router";
import { verifyWebhookSignature } from "@/lib/channels/handlers/webhook";
import { authorizeTelegramMessage, buildInboundContext } from "@/lib/channels/handlers/telegram";
import {
  verifyDiscordSignature,
  extractCommandText,
  resolveDiscordSecrets,
  INTERACTION_TYPE_PING,
  INTERACTION_TYPE_APPLICATION_COMMAND,
  RESPONSE_TYPE_PONG,
  RESPONSE_TYPE_CHANNEL_MESSAGE,
  RESPONSE_TYPE_DEFERRED,
  FLAG_EPHEMERAL,
  type DiscordInteraction,
} from "@/lib/channels/handlers/discord";
import { registry } from "@/lib/orchestrator/registry";
import { composeInput } from "@/lib/channels/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TelegramInboundBody {
  message?: {
    chat: { id: number; type: string };
    message_id: number;
    text?: string;
    caption?: string;
  };
}

interface WebhookInboundBody {
  text?: string;
  reply_url?: string;
  meta?: Record<string, unknown>;
}

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const config = tryLoadChannelConfig(name);
  if (!config) {
    return NextResponse.json({ error: "channel_not_found" }, { status: 404 });
  }

  const rawBody = await req.text();

  if (config.type === "webhook") {
    const sigHeader = req.headers.get(config.signature_header ?? "x-orchestria-signature");
    if (!verifyWebhookSignature(rawBody, config, sigHeader)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    let parsed: WebhookInboundBody;
    try { parsed = JSON.parse(rawBody) as WebhookInboundBody; }
    catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
    if (!parsed.text) return NextResponse.json({ error: "text required" }, { status: 400 });

    const route = resolveRoute(parsed.text, config);
    const replyMeta: Record<string, unknown> = { ...(parsed.meta ?? {}) };
    if (parsed.reply_url) replyMeta.reply_url = parsed.reply_url;

    queueMicrotask(() => {
      registry.spawn(route.agent, route.cleanedInput, { sourceChannel: name, sourceMeta: replyMeta });
    });
    return NextResponse.json({ ok: true, agent: route.agent }, { status: 202 });
  }

  if (config.type === "telegram") {
    let body: TelegramInboundBody;
    try { body = JSON.parse(rawBody) as TelegramInboundBody; }
    catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
    if (!body.message) return NextResponse.json({ ok: true, skipped: true });
    if (!authorizeTelegramMessage(body.message, config)) {
      return NextResponse.json({ error: "chat_not_allowed" }, { status: 403 });
    }
    const ctx = await buildInboundContext(name, config, body.message);
    const route = resolveRoute(ctx.rawText, config);
    const input = composeInput(route.cleanedInput, ctx.attachments);
    queueMicrotask(() => {
      registry.spawn(route.agent, input, { sourceChannel: name, sourceMeta: ctx.replyMeta });
    });
    return NextResponse.json({ ok: true, agent: route.agent }, { status: 202 });
  }

  if (config.type === "discord") {
    const { publicKey } = resolveDiscordSecrets(config);
    if (!publicKey) {
      return NextResponse.json({ error: "public_key_env_not_set" }, { status: 500 });
    }
    const sig = req.headers.get("x-signature-ed25519");
    const ts = req.headers.get("x-signature-timestamp");
    if (!verifyDiscordSignature(rawBody, publicKey, sig, ts)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    let interaction: DiscordInteraction;
    try { interaction = JSON.parse(rawBody) as DiscordInteraction; }
    catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

    // Discord verifies the endpoint with a PING — answer PONG inline.
    if (interaction.type === INTERACTION_TYPE_PING) {
      return NextResponse.json({ type: RESPONSE_TYPE_PONG });
    }

    if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
      // Buttons, modals, autocomplete — ignore for now, ack with empty ephemeral.
      return NextResponse.json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "(unsupported interaction type)", flags: FLAG_EPHEMERAL },
      });
    }

    // Optional scoping per config.
    if (config.guild_id && interaction.guild_id !== config.guild_id) {
      return NextResponse.json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "This bot is not configured for this server.", flags: FLAG_EPHEMERAL },
      });
    }
    if (config.channel_id && interaction.channel_id !== config.channel_id) {
      return NextResponse.json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "This bot is not configured for this channel.", flags: FLAG_EPHEMERAL },
      });
    }

    const text = extractCommandText(interaction);
    if (!text) {
      return NextResponse.json({
        type: RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: { content: "Empty command — please include a prompt.", flags: FLAG_EPHEMERAL },
      });
    }

    const route = resolveRoute(text, config);
    const replyMeta: Record<string, unknown> = {
      interaction_id: interaction.id,
      interaction_token: interaction.token,
      application_id: interaction.application_id,
      channel_id: interaction.channel_id,
      user_id: interaction.member?.user.id ?? interaction.user?.id,
    };

    queueMicrotask(() => {
      registry.spawn(route.agent, route.cleanedInput, { sourceChannel: name, sourceMeta: replyMeta });
    });

    // Deferred — Discord shows "thinking…" until reply.ts PATCHes the original.
    return NextResponse.json({ type: RESPONSE_TYPE_DEFERRED });
  }

  return NextResponse.json({ error: "channel_type_not_supported", type: config.type }, { status: 501 });
}
