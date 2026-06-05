import { describe, expect, it } from "vitest";
import { PipCustomComponent, type OverlayRowBudgetOptions } from "../src/custom-component.ts";

class TestComponent extends PipCustomComponent<string> {
  keys: string[] = [];
  constructor(tui: any, theme: any, done: (result?: string) => void) {
    super(tui, theme, done);
  }
  protected handleKey(key: string): void {
    this.keys.push(key);
    if (key === "x") this.close("x-done");
  }
  rowBudget(options: OverlayRowBudgetOptions): number {
    return this.overlayRowBudget(options);
  }
}

describe("PipCustomComponent", () => {
  it("routes normalized keys through handleKey", () => {
    const component = new TestComponent({ requestRender() {} }, {}, () => undefined);
    component.handleInput("\u001b[A");
    expect(component.keys).toEqual(["up"]);
  });

  it("closes on default terminal escape keys", () => {
    for (const key of ["\u001b", "\u0003", "\u0004"]) {
      let closed = false;
      const component = new TestComponent({ requestRender() {} }, {}, () => { closed = true; });
      component.handleInput(key);
      expect(closed).toBe(true);
    }
  });

  it("calculates overlay row budgets from terminal height", () => {
    const component = new TestComponent({ terminal: { rows: 24 }, requestRender() {} }, {}, () => undefined);
    expect(component.rowBudget({ maxRows: 30, minRows: 8, reservedRows: 8, maxHeightRatio: 0.85 })).toBe(12);
  });
});
