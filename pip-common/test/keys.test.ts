import { describe, expect, it } from "vitest";
import { normalizeInputKey, printableInput, visibleWidth } from "../src/keys.ts";
import { expandTabs, safePadToWidth, safeTruncateToWidth } from "../src/text-width.ts";

describe("key normalization", () => {
  it("normalizes raw critical exit keys", () => {
    expect(normalizeInputKey("\u001b")).toBe("escape");
    expect(normalizeInputKey("\u0003")).toBe("ctrl+c");
    expect(normalizeInputKey("\u0004")).toBe("ctrl+d");
  });

  it("normalizes navigation and return keys", () => {
    expect(normalizeInputKey("\u001b[A")).toBe("up");
    expect(normalizeInputKey("\u001b[B")).toBe("down");
    expect(normalizeInputKey("\u001b[C")).toBe("right");
    expect(normalizeInputKey("\u001b[D")).toBe("left");
    expect(normalizeInputKey("\r")).toBe("return");
  });

  it("extracts printable input", () => {
    expect(printableInput("a")).toBe("a");
    expect(printableInput(" ")).toBe(" ");
    expect(printableInput("\u001b")).toBeUndefined();
  });

  it("normalizes tabs before safe width operations", () => {
    expect(expandTabs("a\tb")).toBe("a    b");
    expect(visibleWidth(safeTruncateToWidth("a\tb", 3))).toBe(3);
    expect(visibleWidth(safePadToWidth("a\tb", 10))).toBe(10);
  });
});
