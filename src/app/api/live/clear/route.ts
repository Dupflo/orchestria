import { NextResponse } from "next/server";
import { sseClearRecent } from "@/lib/orchestrator/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Flush the SSE recent-broadcast ring buffer. New SSE connections will then
 * see an empty replay, matching the visualizer's "I cleared the kernel"
 * action. Live (currently-running) missions keep broadcasting unaffected.
 */
export async function POST() {
  sseClearRecent();
  return NextResponse.json({ ok: true });
}
