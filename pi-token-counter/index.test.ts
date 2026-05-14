import { describe, expect, it } from "vitest";
import tokenCounter from "./index.ts";
import { createMockPi } from "pip-common/testing";

describe("pi-token-counter", () => {
  it("registers token counter lifecycle handlers", () => {
    const pi = createMockPi();
    tokenCounter(pi as any);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
  });
});
