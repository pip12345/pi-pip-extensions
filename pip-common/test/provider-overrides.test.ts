import { describe, expect, it } from "vitest";
import { composeProviderOverride, registerProviderOverrideContributor } from "../src/provider-overrides.ts";
import { createMockPi } from "../src/testing.ts";

function providerPi() {
  const pi = createMockPi() as any;
  pi.providerConfigs = new Map<string, any>();
  pi.unregistered = [] as string[];
  pi.registerProvider = (provider: string, config: any) => pi.providerConfigs.set(provider, config);
  pi.unregisterProvider = (provider: string) => {
    pi.unregistered.push(provider);
    pi.providerConfigs.delete(provider);
  };
  return pi;
}

describe("provider override coordinator", () => {
  it("composes catalog and transport contributions into one registration", () => {
    const owner = providerPi();
    const sibling = providerPi();
    sibling.events = owner.events;
    const catalog = registerProviderOverrideContributor(owner, { id: "model-patches", role: "catalog" });
    const transport = registerProviderOverrideContributor(sibling, { id: "provider-proxy", role: "transport" });

    catalog.set("openai", { baseUrl: "https://native", apiKey: "token", models: [{ id: "new", api: "openai-responses", baseUrl: "https://native" }] });
    transport.set("openai", { baseUrl: "http://relay/openai", oauth: { name: "relay" } });

    expect(owner.providerConfigs.get("openai")).toMatchObject({ baseUrl: "http://relay/openai", apiKey: "token", oauth: { name: "relay" } });
    expect(owner.providerConfigs.get("openai").models).toEqual([{ id: "new", api: "openai-responses", baseUrl: "http://relay/openai" }]);
    expect(owner.unregistered).toEqual(["openai"]);

    catalog.remove("openai");
    expect(owner.providerConfigs.get("openai")).toEqual({ baseUrl: "http://relay/openai", oauth: { name: "relay" } });
    transport.dispose();
    expect(owner.providerConfigs.has("openai")).toBe(false);
  });

  it("rejects duplicate owners for the same provider role, including duplicate extension ids", () => {
    const pi = providerPi();
    const first = registerProviderOverrideContributor(pi, { id: "duplicate", role: "catalog" });
    const second = registerProviderOverrideContributor(pi, { id: "duplicate", role: "catalog" });
    first.set("openai", { baseUrl: "https://first" });
    expect(() => second.set("openai", { baseUrl: "https://second" })).toThrow(/already has catalog owner duplicate/);
  });

  it("restores the last valid registration when a replacement is rejected", () => {
    const pi = providerPi();
    const register = pi.registerProvider;
    pi.registerProvider = (provider: string, config: any) => {
      if (config.invalid) throw new Error("invalid provider config");
      register(provider, config);
    };
    const owner = registerProviderOverrideContributor(pi, { id: "catalog", role: "catalog" });
    owner.set("openai", { baseUrl: "https://valid" });

    expect(() => owner.set("openai", { invalid: true })).toThrow("invalid provider config");
    expect(pi.providerConfigs.get("openai")).toEqual({ baseUrl: "https://valid" });
  });

  it("keeps one coordinator when an active owner removes and later re-adds its contribution", () => {
    const ownerPi = providerPi();
    const siblingPi = providerPi();
    siblingPi.events = ownerPi.events;
    const transport = registerProviderOverrideContributor(ownerPi, { id: "transport", role: "transport" });
    transport.set("openai", { baseUrl: "https://first" });
    transport.remove("openai");
    registerProviderOverrideContributor(siblingPi, { id: "catalog", role: "catalog" }).set("openai", { baseUrl: "https://native", models: [{ id: "m" }] });

    transport.set("openai", { baseUrl: "https://second" });

    expect(ownerPi.providerConfigs.get("openai")).toMatchObject({ baseUrl: "https://second", models: [{ id: "m", baseUrl: "https://second" }] });
    expect(siblingPi.providerConfigs.size).toBe(0);
  });

  it("isolates parent and child runtime registrations", () => {
    const parent = providerPi();
    const child = providerPi();
    registerProviderOverrideContributor(parent, { id: "parent", role: "transport" }).set("openai", { baseUrl: "https://parent" });
    registerProviderOverrideContributor(child, { id: "child", role: "transport" }).set("openai", { baseUrl: "https://child" });
    expect(parent.providerConfigs.get("openai").baseUrl).toBe("https://parent");
    expect(child.providerConfigs.get("openai").baseUrl).toBe("https://child");
  });

  it("drops the stale registrar when the last owner disposes during reload", () => {
    const oldPi = providerPi();
    const oldOwner = registerProviderOverrideContributor(oldPi, { id: "proxy", role: "transport" });
    oldOwner.set("openai", { baseUrl: "https://old" });
    oldOwner.dispose();

    const reloadedPi = providerPi();
    reloadedPi.events = oldPi.events;
    registerProviderOverrideContributor(reloadedPi, { id: "proxy", role: "transport" }).set("openai", { baseUrl: "https://new" });

    expect(reloadedPi.providerConfigs.get("openai").baseUrl).toBe("https://new");
    expect(oldPi.providerConfigs.has("openai")).toBe(false);
  });

  it("merges headers without mutating either contribution", () => {
    const catalog = { headers: { A: "1" }, models: [{ id: "m" }] };
    const transport = { headers: { B: "2" } };
    expect(composeProviderOverride(catalog, transport)).toMatchObject({ headers: { A: "1", B: "2" }, models: [{ id: "m" }] });
    expect(catalog).toEqual({ headers: { A: "1" }, models: [{ id: "m" }] });
  });
});
