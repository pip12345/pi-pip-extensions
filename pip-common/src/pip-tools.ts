import type { ToolDefinition, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piRuntimeKey } from "./runtime.ts";

export interface PipToolDisplayMetadata {
  kind?: "query" | "mutation" | "command" | "interactive" | "generic";
  call?: (args: any) => string | undefined;
  result?: (result: any) => string | undefined;
  expandedResult?: (result: any) => string | undefined;
  hideSuccessfulResult?: boolean;
}

export interface PipToolMetadata {
  pluginId: string;
  label?: string;
  display?: PipToolDisplayMetadata;
}

export interface PipToolRegistration {
  tool: ToolDefinition<any, any, any>;
  metadata?: PipToolMetadata;
}

const RUNTIME_METADATA_KEY = Symbol.for("pip-common.pip-tools.runtime-metadata");

function runtimeMetadata(): WeakMap<object, Map<string, PipToolMetadata>> {
  const state = globalThis as any;
  return state[RUNTIME_METADATA_KEY] ??= new WeakMap<object, Map<string, PipToolMetadata>>();
}

export function registerPipTool(pi: ExtensionAPI, { tool, metadata }: PipToolRegistration): void {
  pi.registerTool(tool);
  const key = piRuntimeKey(pi);
  let tools = runtimeMetadata().get(key);
  if (!tools) {
    const metadataMap = new Map<string, PipToolMetadata>();
    tools = metadataMap;
    runtimeMetadata().set(key, metadataMap);
    pi.on("session_shutdown", () => {
      metadataMap.clear();
      runtimeMetadata().delete(key);
    });
  }
  if (metadata) tools.set(tool.name, metadata);
  else tools.delete(tool.name);
}

/** Display-only metadata shared by extensions in this runtime, including package-local copies. */
export function getPipToolMetadata(pi: ExtensionAPI, name: string): PipToolMetadata | undefined {
  return runtimeMetadata().get(piRuntimeKey(pi))?.get(name);
}

export function resetPipToolsForTests(): void {
  (globalThis as any)[RUNTIME_METADATA_KEY] = new WeakMap<object, Map<string, PipToolMetadata>>();
}
