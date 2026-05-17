import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

/** Opens a native macOS folder picker via AppleScript and returns the chosen path. */
export async function POST() {
  // AppleScript is macOS-only. Elsewhere, signal the UI to fall back to a
  // manual path input instead of failing with a confusing osascript ENOENT.
  if (process.platform !== "darwin") {
    return NextResponse.json({ path: null, unsupported: true });
  }
  try {
    const { stdout } = await execAsync(
      `osascript -e 'POSIX path of (choose folder with prompt "Sélectionner le répertoire de travail :")'`
    );
    const chosen = stdout.trim().replace(/\/$/, "") || "~";
    return NextResponse.json({ path: chosen });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // User cancelled: osascript exits with code 1 and "User canceled"
    if (msg.includes("User canceled") || msg.includes("(-128)")) {
      return NextResponse.json({ path: null, cancelled: true });
    }
    return NextResponse.json({ error: "pick-folder failed", detail: msg }, { status: 500 });
  }
}
