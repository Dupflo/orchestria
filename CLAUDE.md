# Project context for AI coding assistants

OrchestrIA is a **local-first agentic OS**: a Next.js app that spawns and
supervises Claude CLI agents, persists runs/memory to SQLite, and exposes a web
dashboard.

## Architecture (where things live)

- `src/app/` — Next.js App Router pages (`/visualizer`, `/chat`, `/missions`,
  `/dashboard`, `/agents`, `/skills`, `/memory`, `/kanban`, `/routines`) and
  `src/app/api/*` route handlers.
- `src/lib/orchestrator/` — agent spawning (`agent.ts` drives an agentic CLI
  over a `node-pty` pseudo-terminal — there is **no SDK**), the registry,
  config/memory loading, and `providers/` (the pluggable per-agent backend:
  `claude` drives the `claude` CLI, `openai` drives `codex exec --json`).
- `src/lib/db.ts` — SQLite (`better-sqlite3`), WAL mode. Schema: `missions`,
  `events`, `kanban_cards`, `routines`, `remote_tokens`.
- `src/lib/channels/` — Telegram + webhook inbound, routing via `@agent` tags.
- `src/lib/routines/` — cron-style scheduler.
- `src/lib/remote/` — token issuing/auth for external agents.
- `.orchestria/` — user-space runtime: agent/skill/channel configs. Databases,
  logs, memory and channel secrets are git-ignored (see `.gitignore`).

## Conventions

- An agent is a directory `.orchestria/agents/<id>/` with `config.json` and an
  optional `system-prompt.md`. The source tree has **no hardcoded agent/skill
  names** — discovery is filesystem-driven.
- `config.json` may set `"provider": "claude" | "openai"` (default `claude`,
  so existing agents are unchanged). An unknown/typo value falls back to
  `claude` rather than failing the mission. The `openai` provider needs the
  `codex` CLI on PATH; its model defaults to the `codex` CLI's own unless the
  agent's `model` is a non-Claude id or `ORCHESTRIA_OPENAI_MODEL` is set.
  Adding a provider = one file in `src/lib/orchestrator/providers/` + an entry
  in its `index.ts` registry; nothing else is provider-aware.
- The internal discriminant for OrchestrIA-managed agents is
  `source: "orchestria"` (vs `"skill"` / `"agent"`).
- Path constants are centralized in `src/lib/orchestrator/config.ts`
  (`ORCHESTRIA_HOME`, etc.). Env vars use the `ORCHESTRIA_*` prefix.

## ⚠️ This is not the Next.js you may know

This repo runs Next.js 16, which has breaking changes vs. older majors. Before
writing framework code, check `node_modules/next/dist/docs/` and heed
deprecation notices rather than relying on training-data assumptions.

## Quality gates & deliberately deferred strictness

CI hard-gates `lint` + `typecheck` + `test` (see `.github/workflows/ci.yml`).
Two strictness levers are intentionally **not** enabled yet — each is a
dedicated, individually-reviewed workstream, not a drive-by change:

- **`eslint-plugin-react-hooks` React-Compiler rules** (`refs`, `purity`,
  `set-state-in-effect`, `immutability`, `preserve-manual-memoization`) are
  set to `warn` in `eslint.config.mjs`. The force-layout/animation hooks use
  deliberate ref/mutation patterns; flip to `error` only if/when the project
  adopts the React Compiler.
- **`noUncheckedIndexedAccess`** is off. Enabling it surfaces ~112 sites
  across ~19 files (mostly UI/hooks); adopting it well needs a focused pass
  with the dev server up to verify the UI, not `!` sprinkled to silence it.
- **Prettier** config + `npm run format` / `format:check` exist but the
  repo-wide reformat is intentionally a separate, isolated commit (a 100-file
  whitespace diff must not be bundled with logic changes), so `format:check`
  is not yet a CI gate.

## Security rule (non-negotiable)

Never commit secrets or third-party data: bot tokens, passwords, API keys,
client data, databases, or `*.bak`. Channel credentials live in
`.orchestria/channels/*.json` (git-ignored); only `*.json.example` is tracked.
