import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { StderrMode } from "./settings.ts";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: StderrMode;
}

export class StdioTransport extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private stderrTail: string[] = [];
  private closed = false;

  constructor(private options: StdioTransportOptions) {
    super();
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.emit("message", JSON.parse(line));
      } catch (error) {
        this.emit("error", new Error(`Invalid JSON on MCP stdout: ${line.slice(0, 200)}`));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.options.stderr === "inherit") process.stderr.write(chunk);
      if (this.options.stderr === "tail" || this.options.stderr === undefined) {
        this.stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
        this.stderrTail = this.stderrTail.slice(-50);
      }
      this.emit("stderr", chunk);
    });

    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      this.closed = true;
      rl.close();
      this.emit("close", { code, signal });
    });
  }

  send(message: Record<string, unknown>, _signal?: AbortSignal): void {
    if (!this.child || this.closed) throw new Error("MCP server process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  tail(): string[] {
    return [...this.stderrTail];
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return;
    child.stdin.end();
    const exited = await waitForExit(child, 2000);
    if (exited) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, 1000)) return;
    child.kill("SIGKILL");
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
