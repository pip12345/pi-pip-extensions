import { describe, expect, it } from "vitest";
import { clampScrollOffset, clampSelectedIndex, maxScrollOffset, moveSelection, scrollBy, scrollForKey, scrollWindow, selectionOffset, selectionWindow } from "../src/scroll.ts";

describe("scroll helpers", () => {
  it("clamps offsets to the valid range", () => {
    expect(clampScrollOffset(-5, 100, 10)).toBe(0);
    expect(clampScrollOffset(95, 100, 10)).toBe(90);
    expect(clampScrollOffset(5, 3, 10)).toBe(0);
    expect(clampScrollOffset(Number.NaN, 100, 10)).toBe(0);
  });

  it("computes max offset for short and long content", () => {
    expect(maxScrollOffset(3, 10)).toBe(0);
    expect(maxScrollOffset(10, 10)).toBe(0);
    expect(maxScrollOffset(11, 10)).toBe(1);
  });

  it("scrolls by line and clamps", () => {
    expect(scrollBy(0, 1, 5, 2)).toBe(1);
    expect(scrollBy(3, 1, 5, 2)).toBe(3);
    expect(scrollBy(1, -5, 5, 2)).toBe(0);
  });

  it("handles common scroll keys", () => {
    expect(scrollForKey("down", 0, 100, 10)).toBe(1);
    expect(scrollForKey("j", 0, 100, 10)).toBe(1);
    expect(scrollForKey("pageup", 20, 100, 10)).toBe(10);
    expect(scrollForKey("pagedown", 85, 100, 10)).toBe(90);
    expect(scrollForKey("home", 85, 100, 10)).toBe(0);
    expect(scrollForKey("end", 0, 100, 10)).toBe(90);
    expect(scrollForKey("x", 0, 100, 10)).toBeUndefined();
  });

  it("returns a bounded visible window", () => {
    const result = scrollWindow(["a", "b", "c", "d"], 3, 2);
    expect(result).toEqual({ offset: 2, end: 4, items: ["c", "d"], maxOffset: 2 });
  });

  it("keeps selected list rows visible", () => {
    expect(clampSelectedIndex(99, 4)).toBe(3);
    expect(moveSelection(1, 2, 4)).toBe(3);
    expect(selectionOffset(4, 0, 10, 3)).toBe(2);
    expect(selectionOffset(1, 5, 10, 3)).toBe(1);
    expect(selectionWindow(["a", "b", "c", "d"], 3, 0, 2)).toEqual({ selected: 3, offset: 2, end: 4, items: ["c", "d"], maxOffset: 2 });
  });
});
