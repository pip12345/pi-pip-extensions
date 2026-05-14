import { describe, expect, it } from "vitest";
import { normalizeInputKey, printableInput } from "../src/keys.ts";

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
});
