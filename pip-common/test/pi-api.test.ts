import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { branchEntries, leafId, sessionEntries, sessionFile, sessionKey } from "../src/pi-api.ts";
import { createMockSessionManager } from "../src/testing.ts";

describe("native session API helpers", () => {
  it("reads only the active branch, including an empty root, with the real Pi manager", () => {
    const manager = SessionManager.inMemory();
    const root = manager.appendCustomEntry("state", { value: "root" });
    const abandoned = manager.appendCustomEntry("state", { value: "abandoned" });
    manager.branch(root);
    const active = manager.appendCustomEntry("state", { value: "active" });
    const ctx = { sessionManager: manager };
    expect(branchEntries(ctx).map((entry) => entry.id)).toEqual([root, active]);
    expect(sessionEntries(ctx).map((entry) => entry.id)).toContain(abandoned);
    expect(leafId(ctx)).toBe(active);
    manager.resetLeaf();
    expect(branchEntries(ctx)).toEqual([]);
    expect(leafId(ctx)).toBeNull();
    expect(sessionFile(ctx)).toBeUndefined();
    expect(sessionKey(ctx)).toBe(manager.getSessionId());
  });

  it("does not replace missing baseline methods with other APIs", () => {
    const getEntries = vi.fn(() => [{ id: "unrelated" }]);
    const getLeafEntry = vi.fn(() => ({ id: "unrelated" }));
    const ctx = { sessionManager: { getEntries, getLeafEntry } } as any;
    expect(() => branchEntries(ctx)).toThrow(TypeError);
    expect(() => leafId(ctx)).toThrow(TypeError);
    expect(getEntries).not.toHaveBeenCalled();
    expect(getLeafEntry).not.toHaveBeenCalled();
  });

  it("preserves actual absent contexts and explicit null mock leaves", () => {
    expect(branchEntries(undefined)).toEqual([]);
    expect(leafId(undefined)).toBeUndefined();
    expect(sessionKey(undefined, "absent")).toBe("absent");
    expect(createMockSessionManager([{ id: "old" }], null).getLeafId()).toBeNull();
  });
});
