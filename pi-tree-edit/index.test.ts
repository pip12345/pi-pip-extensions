import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, generateSummary: vi.fn(async () => "generated compaction summary") };
});
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSummary, SessionManager } from "@earendil-works/pi-coding-agent";
import treeEdit from "./index.ts";
import { getPipSettingsRegistry } from "../pip-common/index.ts";
import { createMockPi, runCommand } from "../pip-common/testing.ts";

describe("pi-tree-edit", () => {
  it("registers the tree-edit command", () => {
    const pi = createMockPi();
    treeEdit(pi as any);
    expect(pi.commands.has("tree-edit")).toBe(true);
  });

  it("does not expose fixed snapshot policy as settings", () => {
    const pi = createMockPi();
    treeEdit(pi as any);
    expect(getPipSettingsRegistry(pi).section("tree-edit")).toBeUndefined();
  });

  it("atomically persists the selected current leaf as the effective final record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-leaf-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "session-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir, leafId: "tail" }),
        JSON.stringify({ type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "root" }] } }),
        JSON.stringify({ type: "message", id: "main", parentId: "root", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "main" }] } }),
        JSON.stringify({ type: "message", id: "branch", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "branch" }] } }),
        JSON.stringify({ type: "message", id: "tail", parentId: "main", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "tail" }] } }),
      ].join("\n") + "\n",
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      const ctx: any = {
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: { getSessionFile: () => sessionFile, getLeafId: () => "tail" },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("j");
            component.handleInput("return");
            component.handleInput("q");
            return result;
          },
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);

      const records = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)?.id).toBe("branch");
      expect(records[0].leafId).toBe("branch");
      expect(SessionManager.open(sessionFile).getLeafId()).toBe("branch");
      expect(readdirSync(dir)).toEqual(["session.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts messages before the selected normal message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-compaction-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 10, output: 5 } } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "x", toolCallId: "call_1", content: [{ type: "text", text: "tool" }] } }),
        JSON.stringify({ type: "message", id: "u2", parentId: "t1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "next" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      let customCalls = 0;
      const ctx: any = {
        model: { provider: "test", modelId: "test-model" },
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }) },
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "u2",
        },
        ui: {
          custom: async (factory: any) => {
            customCalls++;
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            if (customCalls === 1) {
              component.handleInput("k");
              component.handleInput("C");
              return result;
            }
            expect(component.render(120).join("\n")).toContain("C compact before");
            component.handleInput("q");
            return result;
          },
          editor: async () => "reviewed compaction summary",
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const compaction = entries.find((entry) => entry.type === "compaction");
      expect(compaction).toMatchObject({ parentId: "a1", summary: "reviewed compaction summary", firstKeptEntryId: "a1", details: { from: "pi-tree-edit", kind: "manual", compactedBeforeEntryId: "a1", sourceEntryIds: ["u1"] } });
      expect(compaction.tokensBefore).toBeGreaterThan(0);
      expect(entries.find((entry) => entry.id === "t1")?.parentId).toBe(compaction.id);
      expect(entries.find((entry) => entry.id === "u2")?.parentId).toBe("t1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts only entries since the previous compaction on the selected branch", async () => {
    vi.mocked(generateSummary).mockClear();
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-compaction-after-existing-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "old-user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "old user" }] } }),
        JSON.stringify({ type: "message", id: "old-assistant", parentId: "old-user", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "old assistant" }] } }),
        JSON.stringify({ type: "compaction", id: "existing-compaction", parentId: "old-assistant", timestamp: "2026-01-01T00:00:02.000Z", summary: "already compacted", firstKeptEntryId: "old-assistant", tokensBefore: 123, details: { from: "pi-tree-edit", kind: "manual" } }),
        JSON.stringify({ type: "message", id: "new-user", parentId: "existing-compaction", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "new user" }] } }),
        JSON.stringify({ type: "message", id: "new-assistant", parentId: "new-user", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "new assistant" }] } }),
        JSON.stringify({ type: "message", id: "selected", parentId: "new-assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: [{ type: "text", text: "selected" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      let customCalls = 0;
      const ctx: any = {
        model: { provider: "test", modelId: "test-model" },
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }) },
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "selected",
        },
        ui: {
          custom: async (factory: any) => {
            customCalls++;
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            if (customCalls === 1) {
              component.handleInput("C");
              return result;
            }
            component.handleInput("q");
            return result;
          },
          editor: async () => "reviewed second compaction summary",
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      const summarizedMessages = vi.mocked(generateSummary).mock.calls[0][0] as any[];
      expect(summarizedMessages.map((message) => message.content[0].text)).toEqual(["new user", "new assistant"]);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const compaction = entries.find((entry) => entry.summary === "reviewed second compaction summary");
      expect(compaction.details.sourceEntryIds).toEqual(["new-user", "new-assistant"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not compact when selected entry is not a normal message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-compaction-invalid-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolName: "x", content: [{ type: "text", text: "tool" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      let selectCalls = 0;
      const ctx: any = {
        waitForIdle: async () => undefined,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "t1",
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("f");
            component.handleInput("j");
            component.handleInput("C");
            expect(component.render(120).join("\n")).toContain("Select a user/assistant message to compact before");
            component.handleInput("q");
            return result;
          },
          select: async () => {
            selectCalls++;
            return "Cancel";
          },
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      expect(selectCalls).toBe(0);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes selected tool output without deleting the tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-prune-tool-"));
    const sessionFile = join(dir, "session.jsonl");
    const largeOutput = "x".repeat(5000);
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "read file" }] } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "big.txt" } }], stopReason: "toolUse" } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "read", toolCallId: "call_1", content: [{ type: "text", text: largeOutput }], isError: false } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      const ctx: any = {
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "t1",
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("f");
            component.handleInput("j");
            component.handleInput("t");
            expect(component.render(120).join("\n")).toContain("Pruned 1 tool result");
            component.handleInput("q");
            return result;
          },
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const assistant = entries.find((entry) => entry.id === "a1");
      const toolResult = entries.find((entry) => entry.id === "t1");
      expect(assistant.message.content).toEqual([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "big.txt" } }]);
      expect(toolResult.message.content[0].text).toContain("tool result pruned by pi-tree-edit");
      expect(toolResult.message.content[0].text).not.toContain(largeOutput);
      expect(toolResult.message.details).toMatchObject({ prunedBy: "pi-tree-edit", originalTextChars: 5000, prunePolicy: "stub" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes tool output linked to a selected assistant tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-prune-assistant-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "read file" }] } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "big.txt" } }], stopReason: "toolUse" } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "read", toolCallId: "call_1", content: [{ type: "text", text: "big output" }], isError: false } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      const ctx: any = {
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "u1",
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("f");
            component.handleInput("j");
            component.handleInput("t");
            component.handleInput("q");
            return result;
          },
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const toolResult = entries.find((entry) => entry.id === "t1");
      expect(toolResult.message.content[0].text).toContain("tool result pruned by pi-tree-edit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sizes visible tree rows from terminal height", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-height-"));
    const sessionFile = join(dir, "session.jsonl");
    const lines = [JSON.stringify({ type: "session", id: "session-test" })];
    for (let i = 0; i < 60; i++) {
      lines.push(JSON.stringify({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `message ${i}` }] },
      }));
    }
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    async function renderedMessageRows(terminalRows: number): Promise<number> {
      const pi = createMockPi();
      treeEdit(pi as any);
      let count = 0;
      const ctx: any = {
        model: { provider: "test", modelId: "test-model", contextWindow: 200000 },
        waitForIdle: async () => undefined,
        sessionManager: { getSessionFile: () => sessionFile, getLeafId: () => "e59" },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {}, terminal: { rows: terminalRows } }, theme, undefined, (value: any) => { result = value; }) as any;
            count = component.render(120).filter((line: string) => /message \d+/.test(line)).length;
            component.handleInput("q");
            return result;
          },
          select: async () => "Cancel",
          notify: () => undefined,
        },
      };
      await runCommand(pi, "tree-edit", "", ctx);
      return count;
    }

    try {
      expect(await renderedMessageRows(24)).toBeLessThan(await renderedMessageRows(80));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens deep linear sessions without overflowing the call stack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-deep-"));
    const sessionFile = join(dir, "session.jsonl");
    const depth = 15000;
    const lines = [JSON.stringify({ type: "session", id: "session-test" })];
    for (let i = 0; i < depth; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      lines.push(JSON.stringify({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        message: { role, content: [{ type: "text", text: `message ${i}` }], ...(role === "assistant" && i % 1000 === 1 ? { usage: { input: i, output: 10 } } : {}) },
      }));
    }
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      const ctx: any = {
        model: { provider: "test", modelId: "test-model", contextWindow: 200000 },
        waitForIdle: async () => undefined,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => `e${depth - 1}`,
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, undefined, (value: any) => { result = value; }) as any;
            expect(component.render(120).join("\n")).toContain("tree-edit");
            component.handleInput("q");
            return result;
          },
          select: async () => "Cancel",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quits immediately without prompting when the draft is clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-clean-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      let selectCalls = 0;
      const ctx: any = {
        waitForIdle: async () => undefined,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "u1",
        },
        ui: {
          custom: async (_factory: any) => ({ action: "quit" }),
          select: async () => {
            selectCalls++;
            return "Cancel";
          },
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      expect(selectCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
