import { sseSubscribeGlobal, sseRecentBroadcasts } from "@/lib/orchestrator/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (data: unknown) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Replay the recent-broadcast snapshot before going live so a client
      // landing on the visualizer sees the last few events instead of an
      // empty mesh. `replay: true` lets the client treat them differently
      // (e.g. skip a sound, no autoscroll spike).
      for (const r of sseRecentBroadcasts()) {
        write({ missionId: r.missionId, agentId: r.agentId, event: r.event, replay: true });
      }

      const unsubscribe = sseSubscribeGlobal(({ missionId, agentId, event }) => {
        write({ missionId, agentId, event });
      });
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000);

      const cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
