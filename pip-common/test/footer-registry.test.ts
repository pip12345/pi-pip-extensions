import { describe, expect, it } from "vitest";
import { getPipFooterItemRegistry, registerFooterItem, registerFooterLine, renderRegisteredFooterItems, renderRegisteredFooterLines } from "../src/footer-registry.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("footer registry", () => {
  it("renders right and below regions separately", () => {
    getPipFooterItemRegistry().clear();
    const disposeRight = registerFooterItem({ id: "right", region: "right", render: () => ["r1", "r2"] });
    const disposeBelow = registerFooterItem({ id: "below", region: "below", render: () => "b1" });

    expect(renderRegisteredFooterItems({ width: 80, theme, ctx: {}, region: "right" })).toEqual(["r1", "r2"]);
    expect(renderRegisteredFooterItems({ width: 80, theme, ctx: {}, region: "below" })).toEqual(["b1"]);

    disposeRight();
    disposeBelow();
  });

  it("keeps registerFooterLine as a below-region alias", () => {
    getPipFooterItemRegistry().clear();
    const dispose = registerFooterLine({ id: "line", render: () => "legacy" });
    expect(renderRegisteredFooterLines({ width: 80, theme, ctx: {} })).toEqual(["legacy"]);
    dispose();
  });
});
