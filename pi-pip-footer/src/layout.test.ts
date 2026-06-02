import { describe, expect, it } from "vitest";
import { joinRight } from "./layout.ts";

describe("pi-pip-footer layout", () => {
  it("right-aligns add-ons without shifting left content and keeps edge padding", () => {
    const line = joinRight("workspace > model > ctx", "tools expanded", 50);
    expect(line.startsWith("workspace > model > ctx")).toBe(true);
    expect(line.endsWith("tools expanded")).toBe(true);
    expect(line.length).toBe(49);
    expect(joinRight("workspace > model > ctx", "tools expanded", 22)).toBe("workspace > model > ctx");
  });
});
