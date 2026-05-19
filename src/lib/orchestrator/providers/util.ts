import { execSync } from "child_process";
import fs from "fs";

// node-pty doesn't always inherit the login shell PATH (homebrew, nvm, npm
// global bins), so each CLI is resolved to an absolute path once.
const cache = new Map<string, string>();

const BIN_RE = /^[a-z0-9_-]+$/;

function assertBin(bin: string): void {
  // `bin` is always a provider-defined literal, never user input — guard anyway
  // since it is interpolated into a shell `command -v`.
  if (!BIN_RE.test(bin)) throw new Error(`invalid CLI binary name: ${JSON.stringify(bin)}`);
}

function commonPaths(bin: string): string[] {
  return [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`];
}

/** Resolve a CLI to an absolute executable path. Throws if not found. */
export function resolveCliBin(bin: string): string {
  assertBin(bin);
  const cached = cache.get(bin);
  if (cached) return cached;
  const candidates = commonPaths(bin);
  try {
    const found = execSync(`command -v ${bin}`, { encoding: "utf8" }).trim();
    if (found) candidates.unshift(found);
  } catch {
    /* not on PATH — fall through to well-known locations */
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      cache.set(bin, c);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`\`${bin}\` CLI not found in /opt/homebrew/bin, /usr/local/bin, or PATH`);
}

/** Non-throwing availability check used by API routes for nice 503s. */
export function binOnPath(bin: string): { ok: boolean; path?: string } {
  assertBin(bin);
  try {
    const p = execSync(`command -v ${bin}`, { encoding: "utf8" }).trim();
    if (p) return { ok: true, path: p };
  } catch {
    /* fall through */
  }
  for (const c of commonPaths(bin)) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return { ok: true, path: c };
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}
