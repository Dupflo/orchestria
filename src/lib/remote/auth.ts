import { NextResponse } from "next/server";
import { verifyToken } from "./token";
import { getDb } from "../db";
import { rateLimit } from "./rateLimit";
import { audit } from "./audit";

export interface RemoteSession {
  jti: string;
  clientName: string;
  expiresAt: number;
}

type AuthResult =
  | { ok: true; session: RemoteSession }
  | { ok: false; response: NextResponse };

interface TokenRow {
  revoked_at: number | null;
  expires_at: number;
}

/**
 * TRUSTED-PROXY ASSUMPTION. `isLocalhost` reads the `Host` header and
 * `enforceHttps` reads `x-forwarded-proto` — both client-controllable. These
 * gates are sound only when OrchestrIA is bound to localhost directly (the
 * default, local-first deployment) OR sits behind a reverse proxy that
 * overwrites these headers. Do NOT expose the raw server to an untrusted
 * network without such a proxy: a client could spoof `Host: localhost` or
 * `x-forwarded-proto: https` to bypass the localhost-only / https gates.
 */
export function isLocalhost(req: Request): boolean {
  const host = req.headers.get("host") ?? new URL(req.url).hostname;
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

function enforceHttps(req: Request): NextResponse | null {
  if (isLocalhost(req)) return null;
  const proto = req.headers.get("x-forwarded-proto");
  if (proto !== "https") {
    return NextResponse.json({ error: "https_required" }, { status: 400 });
  }
  return null;
}

export function requireRemoteAuth(req: Request): AuthResult {
  const httpsViolation = enforceHttps(req);
  if (httpsViolation) return { ok: false, response: httpsViolation };

  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) {
    return { ok: false, response: NextResponse.json({ error: "missing_token" }, { status: 401 }) };
  }
  const payload = verifyToken(m[1].trim());
  if (!payload) {
    return { ok: false, response: NextResponse.json({ error: "invalid_token" }, { status: 401 }) };
  }

  const db = getDb();
  const row = db
    .prepare("SELECT revoked_at, expires_at FROM remote_tokens WHERE jti = ?")
    .get(payload.jti) as TokenRow | undefined;
  if (!row) {
    return { ok: false, response: NextResponse.json({ error: "unknown_token" }, { status: 401 }) };
  }
  if (row.revoked_at) {
    return { ok: false, response: NextResponse.json({ error: "token_revoked" }, { status: 401 }) };
  }

  if (!rateLimit(payload.jti)) {
    const url = new URL(req.url);
    audit({ jti: payload.jti, client: payload.sub, method: req.method, path: url.pathname, status: 429 });
    return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429 }) };
  }

  db.prepare(
    "UPDATE remote_tokens SET last_used_at = unixepoch(), call_count = call_count + 1 WHERE jti = ?"
  ).run(payload.jti);

  return {
    ok: true,
    session: { jti: payload.jti, clientName: payload.sub, expiresAt: row.expires_at },
  };
}

export function logRemoteCall(session: RemoteSession, req: Request, status: number): void {
  const url = new URL(req.url);
  audit({ jti: session.jti, client: session.clientName, method: req.method, path: url.pathname, status });
}

export function requireLocalhost(req: Request): NextResponse | null {
  if (isLocalhost(req)) return null;
  return NextResponse.json({ error: "localhost_only" }, { status: 403 });
}
