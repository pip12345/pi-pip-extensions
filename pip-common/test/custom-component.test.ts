import { describe, expect, it } from "vitest";
import { PipCustomComponent } from "../src/custom-component.ts";

class TestComponent extends PipCustomComponent<string> {
  keys: string[] = [];
  constructor(tui: any, theme: any, done: (result?: string) => void) {
    super(tui, theme, done);
  }
  protected handleKey(key: string): void {
    this.keys.push(key);
    if (key === "x") this.close("x-done");
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
});
