import { describe, expect, it } from "vitest";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../src/testing.ts";

describe("testing helpers", () => {
  it("captures commands and events", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    pi.registerCommand("hello", { handler: async (args: string, ctx: any) => ctx.ui.notify(args) });
    pi.on("session_start", () => "started");

    await runCommand(pi, "hello", "world", ctx);
    expect(ctx.ui.notifications).toEqual([{ message: "world", level: "info" }]);
    expect(await emitEvent(pi, "session_start", {}, ctx)).toEqual(["started"]);
  });
});
