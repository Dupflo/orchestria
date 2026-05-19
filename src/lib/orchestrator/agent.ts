import { spawn as ptySpawn, type IPty } from "node-pty";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import type { AgentFileConfig, ClaudeEvent, LiveStatus } from "./types";
import type { AgentProvider } from "./providers/types";

interface SpawnedAgentEvents {
  event: (e: ClaudeEvent) => void;
  raw: (line: string) => void;
  done: (exitCode: number) => void;
  session: (sessionId: string) => void;
}

// Intentional interface/class merge: the homonymous interface gives strongly
// typed `on`/`emit` overloads over EventEmitter. Safe and idiomatic here.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface SpawnedAgent {
  on<K extends keyof SpawnedAgentEvents>(event: K, listener: SpawnedAgentEvents[K]): this;
  emit<K extends keyof SpawnedAgentEvents>(event: K, ...args: Parameters<SpawnedAgentEvents[K]>): boolean;
}

// A single PTY driver. Everything CLI-specific (binary, argv, output parsing)
// is delegated to `provider`; this class only owns the pseudo-terminal,
// line buffering, session capture and completion detection.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SpawnedAgent extends EventEmitter {
  readonly missionId: string;
  readonly agentName: string;
  readonly provider: AgentProvider;
  readonly startedAt: number = Date.now();
  status: LiveStatus = "running";

  private pty: IPty;
  private buffer = "";

  sessionId: string | null = null;

  constructor(
    missionId: string,
    agentName: string,
    provider: AgentProvider,
    config: AgentFileConfig,
    systemPrompt: string,
    prompt: string,
    resumeSessionId?: string,
  ) {
    super();
    this.missionId = missionId;
    this.agentName = agentName;
    this.provider = provider;

    const args = provider.buildArgs({ config, systemPrompt, prompt, resumeSessionId });
    const bin = provider.resolveBin();
    const enrichedPath = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""]
      .filter(Boolean).join(":");
    // `config.cwd` comes from agent JSON — an invalid/missing dir would make
    // node-pty throw at spawn. Fall back to the home directory instead.
    let cwd = config.cwd;
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir();
    } catch {
      cwd = os.homedir();
    }
    this.pty = ptySpawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        PATH: enrichedPath,
        ORCHESTRIA_AGENT: agentName,
        ORCHESTRIA_MISSION: missionId,
        ORCHESTRIA_PROVIDER: provider.id,
      },
    });

    this.pty.onData((chunk) => this.ingest(chunk));
    this.pty.onExit(({ exitCode }) => {
      this.status = exitCode === 0 ? "completed" : "failed";
      this.emit("done", exitCode ?? 1);
    });
  }

  send(input: string): void {
    this.pty.write(input.endsWith("\n") ? input : input + "\n");
  }

  kill(): void {
    this.status = "halted";
    this.pty.kill();
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const parsed = this.provider.parseLine(line);
      if (parsed) {
        this.captureSession(parsed);
        this.emit("event", parsed);
      } else {
        this.emit("raw", line);
      }
    }
  }

  private captureSession(ev: ClaudeEvent): void {
    if (this.sessionId) return;
    const sid = this.provider.sessionIdFrom(ev);
    if (sid) {
      this.sessionId = sid;
      this.emit("session", sid);
    }
  }
}
