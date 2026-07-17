import { describe, expect, it } from "vitest";
import extension, { __test } from "./index.ts";
import { createMockCtx, createMockPi, runCommand } from "../pip-common/testing.ts";

const theme = { fg: (_name: string, text: string) => text };

function makeCtx(extra: any = {}) {
  return createMockCtx({
    model: { contextWindow: 200_000, maxTokens: 8_000 },
    contextUsage: { tokens: 12_000, percent: 6, contextWindow: 200_000 },
    systemPrompt: "System\nPrompt",
    systemPromptOptions: {
      selectedTools: ["read", "bash"],
      toolSnippets: { read: "Read files", bash: "Run commands" },
      promptGuidelines: ["Use read before editing."],
      appendSystemPrompt: "Extra instructions",
      contextFiles: [{ path: "/workspace/AGENTS.md", content: "Agent notes" }],
      skills: [{ name: "devbox-docs", description: "Use Devbox docs", content: "Skill body" }],
    },
    entries: [
      { type: "message", id: "u1", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", message: { role: "assistant", provider: "anthropic", model: "claude", usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, total: 135 } } },
    ],
    ...extra,
  });
}

describe("pi-context", () => {
  it("registers /context and no model-facing tools", () => {
    const pi = createMockPi();
    extension(pi as any);
    expect(pi.commands.has("context")).toBe(true);
    expect(pi.tools.size).toBe(0);
  });

  it("opens the context overlay command", async () => {
    const pi = createMockPi();
    extension(pi as any);
    let opened = false;
    const ctx = makeCtx({ custom: async () => { opened = true; } });
    await runCommand(pi, "context", "", ctx);
    expect(opened).toBe(true);
  });

  it("builds observed usage and prompt breakdown", () => {
    const snapshot = __test.buildContextSnapshot(makeCtx());
    expect(snapshot.contextUsage?.tokens).toBe(12_000);
    expect(snapshot.latestUsage).toMatchObject({ input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cache: 15, total: 135 });
    expect(snapshot.maxOutputTokens).toBe(8_000);
    expect(snapshot.sections.map((s: any) => s.key)).toEqual(["effective", "tools", "files", "skills", "append", "conversation"]);
  });

  it("measures the effective compaction-aware conversation entries", () => {
    const branch = [
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "discarded ".repeat(5000) } },
      { type: "compaction", id: "compact", parentId: "old", summary: "effective summary", tokensBefore: 50_000, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "new", parentId: "compact", message: { role: "user", content: "new message" } },
    ];
    const snapshot = __test.buildContextSnapshot(
      makeCtx({
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
          getLeafId: () => "new",
        },
      }),
    );
    const conversation = snapshot.sections.find((section: any) => section.key === "conversation");
    expect(conversation?.detail).toBe("2 effective messages");
    expect(conversation?.estimatedTokens).toBeLessThan(1000);
  });

  it("uses the full active branch when no compaction has changed the effective entries", () => {
    const branch = [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "hi" } },
    ];
    const snapshot = __test.buildContextSnapshot(makeCtx({ sessionManager: { getBranch: () => branch, getEntries: () => branch, getLeafId: () => "a1" } }));
    expect(snapshot.sections.find((section: any) => section.key === "conversation")?.detail).toBe("2 effective messages");
  });

  it("renders without structured prompt options", () => {
    const ctx = makeCtx({ systemPromptOptions: undefined });
    const snapshot = __test.buildContextSnapshot(ctx);
    expect(snapshot.sections.map((s: any) => s.key)).toContain("effective");
    expect(snapshot.options).toBeUndefined();
  });

  it("p key opens prompt inspector with section navigation", () => {
    let result: any;
    const tui = { requestRender() {} };
    const component = new __test.ContextInspector(tui, makeCtx(), theme, () => { result = "closed"; });
    const main = component.render(100).join("\n");
    expect(main).toContain("Context inspector");
    expect(main).toContain("Context Usage");
    expect(main).toContain("System prompt");
    expect(main).toContain("System tools");
    expect(main).toContain("Free space");
    expect(main).toContain("Max output cap");
    expect(main).toContain("compaction reserve is separate");
    expect(main).not.toContain("Observed turns");
    component.handleInput("p");
    expect(component.render(100).join("\n")).toContain("[System]");
    component.handleInput("tab");
    const tools = component.render(100).join("\n");
    expect(tools).toContain("[Tools]");
    expect(tools).toContain("read: Read files");
    component.handleInput("l");
    expect(component.render(100).join("\n")).toContain("[Guidelines]");
    component.handleInput("h");
    expect(component.render(100).join("\n")).toContain("[Tools]");
    component.handleInput("b");
    expect(component.render(100).join("\n")).toContain("Context inspector");
    component.handleInput("q");
    expect(result).toBe("closed");
  });

  it("clamps prompt inspector scrolling", () => {
    const longPrompt = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const component = new __test.ContextInspector({ requestRender() {} }, makeCtx({ systemPrompt: longPrompt }), theme, () => {});
    component.render(100);
    component.handleInput("p");
    for (let i = 0; i < 99; i++) component.handleInput("pagedown");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("showing 53-80 of 80");
  });

  it("builds full prompt inspector source sections", () => {
    const sections = __test.buildPromptInspectorSections(__test.buildContextSnapshot(makeCtx()));
    expect(sections.map((s: any) => s.key)).toEqual(["effective", "tools", "guidelines", "files", "skills", "append"]);
    expect(sections.find((s: any) => s.key === "files")?.content).toContain("/workspace/AGENTS.md");
    expect(sections.find((s: any) => s.key === "skills")?.content).toContain("devbox-docs");
  });
});
