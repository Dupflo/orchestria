import { NextResponse } from "next/server";
import { readJson } from "@/lib/api/json";
import { registry } from "@/lib/orchestrator/registry";
import { getProvider, binOnPath, PROVIDERS } from "@/lib/orchestrator/providers";
import { loadAgentConfig } from "@/lib/orchestrator/config";
import type { AgentProvider } from "@/lib/orchestrator/providers";
import type { SpawnRequest } from "@/lib/orchestrator/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolve which CLI an agent needs, or null if the agent does not exist. */
function providerForAgent(agentName: string): AgentProvider | null {
  try {
    return getProvider(loadAgentConfig(agentName).provider);
  } catch {
    return null;
  }
}

function explainSpawnError(e: unknown, bin: string): { status: number; message: string; hint?: string } {
  const msg = e instanceof Error ? e.message : String(e);

  if (msg.includes("not found") && msg.includes("config.json")) {
    return {
      status: 404,
      message: msg,
      hint: "Create the agent first via the Agents page or `.orchestria/agents/<name>/config.json`.",
    };
  }
  if (msg.includes("ENOENT") && msg.includes("posix_spawn")) {
    return {
      status: 503,
      message: `could not spawn the \`${bin}\` CLI`,
      hint: `Install it and make sure \`which ${bin}\` works in your shell.`,
    };
  }
  if (msg.includes("ENOENT")) {
    return { status: 500, message: msg, hint: "A required file is missing." };
  }
  return { status: 500, message: msg };
}

export async function POST(req: Request) {
  const body = await readJson<Partial<
    SpawnRequest & {
      resume_session_id?: string;
      kind?: import("@/lib/orchestrator/registry").SpawnKind;
      source_meta?: Record<string, unknown>;
      source_channel?: string;
    }
  >>(req);
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  if (!body.agent_name || !body.mission) {
    return NextResponse.json({ error: "agent_name and mission are required" }, { status: 400 });
  }

  // Pre-flight the right CLI based on the agent's provider so the user gets a
  // clear 503 instead of a cryptic posix_spawn failure mid-run.
  const provider = providerForAgent(body.agent_name);
  if (provider) {
    const cli = binOnPath(provider.bin);
    if (!cli.ok) {
      return NextResponse.json(
        {
          error: `\`${provider.bin}\` CLI not on PATH (required by ${provider.label})`,
          hint: `Install ${provider.label} (\`${provider.bin}\` command) and restart the dev server so it inherits the right PATH.`,
        },
        { status: 503 },
      );
    }
  }

  try {
    const agent = registry.spawn(body.agent_name, body.mission, {
      resumeSessionId: body.resume_session_id,
      kind: body.kind,
      skipKanbanCard: Boolean(body.skip_kanban_card),
      sourceMeta: body.source_meta,
      sourceChannel: body.source_channel,
    });
    return NextResponse.json(
      {
        mission_id: agent.missionId,
        agent_name: agent.agentName,
        provider: agent.provider.id,
        status: agent.status,
        started_at: agent.startedAt,
      },
      { status: 201 },
    );
  } catch (e) {
    const { status, message, hint } = explainSpawnError(e, provider?.bin ?? "claude");
    return NextResponse.json({ error: message, hint }, { status });
  }
}

export async function GET() {
  const providers = Object.fromEntries(
    Object.values(PROVIDERS).map((p) => [p.id, { ...binOnPath(p.bin), bin: p.bin, label: p.label }]),
  );
  return NextResponse.json({ live: registry.list(), providers });
}
