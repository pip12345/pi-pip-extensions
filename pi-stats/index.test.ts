import { describe, expect, it } from "vitest";
import stats from "./index.ts";
import { createMockPi } from "../pip-common/testing.ts";

describe("pi-stats", () => {
  it("registers the stats command and usage event handlers", () => {
    const pi = createMockPi();
    stats(pi as any);
    expect(pi.commands.has("stats")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
  });
});
