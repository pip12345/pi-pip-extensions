import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { StderrMode } from "./types.ts";
import { MAX_MCP_MESSAGE_BYTES, MAX_MCP_STDERR_LINE_CHARS } from "./transport-limits.ts";

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

    let stdoutBuffer = "";
    let stdoutFailed = false;
    const failStdout = (error: Error) => {
      if (stdoutFailed) return;
      stdoutFailed = true;
      stdoutBuffer = "";
      this.emit("error", error);
      child.kill("SIGTERM");
    };
    const handleLine = (line: string) => {
      if (!line.trim() || stdoutFailed) return;
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_MESSAGE_BYTES) {
        failStdout(new Error(`MCP stdout message exceeded ${MAX_MCP_MESSAGE_BYTES} byte limit`));
        return;
      }
      try {
        this.emit("message", JSON.parse(line));
      } catch {
        failStdout(new Error(`Invalid JSON on MCP stdout: ${line.slice(0, 200)}`));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutFailed) return;
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        if (stdoutFailed) return;
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_MCP_MESSAGE_BYTES) failStdout(new Error(`MCP stdout message exceeded ${MAX_MCP_MESSAGE_BYTES} byte limit`));
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.options.stderr === "inherit") process.stderr.write(chunk);
      const boundedChunk = chunk.slice(0, MAX_MCP_STDERR_LINE_CHARS * 50);
      if (this.options.stderr === "tail" || this.options.stderr === undefined) {
        this.stderrTail.push(...boundedChunk.split(/\r?\n/).filter(Boolean).map((line) => line.slice(0, MAX_MCP_STDERR_LINE_CHARS)));
        this.stderrTail = this.stderrTail.slice(-50);
      }
      this.emit("stderr", boundedChunk);
    });

    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutFailed) handleLine(stdoutBuffer.replace(/\r$/, ""));
      stdoutBuffer = "";
      this.closed = true;
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
