import { describe, expect, it } from "vitest";
import { getPipFooterItemRegistry, registerFooterItem, registerFooterLine, renderRegisteredFooterItems, renderRegisteredFooterLines } from "../src/footer-registry.ts";
import { createMockPi } from "../src/testing.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("footer registry", () => {
  it("renders token, right, and below regions separately", () => {
    const pi = createMockPi();
    const disposeRight = registerFooterItem(pi, { id: "right", region: "right", render: () => ["r1", "r2"] });
    const disposeBelow = registerFooterItem(pi, { id: "below", region: "below", render: () => "b1" });
    const disposeTokens = registerFooterItem(pi, { id: "tokens", region: "tokens", render: () => "t1" });

    expect(renderRegisteredFooterItems(pi, { width: 80, theme, ctx: {}, region: "right" })).toEqual(["r1", "r2"]);
    expect(renderRegisteredFooterItems(pi, { width: 80, theme, ctx: {}, region: "below" })).toEqual(["b1"]);
    expect(renderRegisteredFooterItems(pi, { width: 80, theme, ctx: {}, region: "tokens" })).toEqual(["t1"]);

    disposeRight();
    disposeBelow();
    disposeTokens();
  });

  it("keeps registerFooterLine as a below-region alias", () => {
    const pi = createMockPi();
    const dispose = registerFooterLine(pi, { id: "line", render: () => "legacy" });
    expect(renderRegisteredFooterLines(pi, { width: 80, theme, ctx: {} })).toEqual(["legacy"]);
    dispose();
  });

  it("shares providers within one runtime and isolates child runtimes", () => {
    const owner = createMockPi();
    const sibling = createMockPi();
    sibling.events = owner.events;
    const child = createMockPi();
    registerFooterItem(owner, { id: "shared", render: () => "parent" });

    expect(getPipFooterItemRegistry(sibling).has("shared")).toBe(true);
    expect(renderRegisteredFooterLines(sibling, { width: 80, theme, ctx: {} })).toEqual(["parent"]);
    expect(renderRegisteredFooterLines(child, { width: 80, theme, ctx: {} })).toEqual([]);
  });
});
