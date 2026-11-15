import { existsSync } from "node:fs";
import { createAgentSession, SessionManager, ModelRuntime, DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentTools, LaunchInput } from "./types.ts";

export interface ChildAgentRuntimeSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelRuntime: ModelRuntime;
}

export interface ChildAgentRuntime {
  create(input: LaunchInput, sessionDir: string): Promise<ChildAgentRuntimeSession>;
}

export type ChildExtensionCapability = "guard" | "model-provider" | "headless-tool" | "ui" | "parent-state" | "provider" | "external-resource" | "nested-agent" | "parent-telemetry" | "parent-prompt" | "infrastructure";

export const CHILD_EXTENSION_CAPABILITIES: Readonly<Record<string, ChildExtensionCapability>> = {
  "pip-common": "infrastructure",
  "pi-secrets-guard": "guard",
  "pi-claude-agent": "model-provider",
  "pi-webfetch-websearch": "headless-tool",
  "pi-question": "ui",
  "pi-tool-ui": "ui",
  "pi-pip-footer": "ui",
  "pi-tree-edit": "ui",
  "pi-context": "ui",
  "pi-todo": "parent-state",
  "pi-undo-redo": "parent-state",
  "pi-provider-proxy": "provider",
  "pi-subagents": "nested-agent",
  "pi-stats": "parent-telemetry",
  "pi-prompt-profiles": "parent-prompt",
};

function extensionFeatureId(extension: any): string | undefined {
  const segments = [extension?.path, extension?.resolvedPath]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(/[\\/]+/));
  return segments.find((segment) => Object.hasOwn(CHILD_EXTENSION_CAPABILITIES, segment));
}

function requestedExtensionTools(tools: AgentTools): Set<string> | "all" {
  if (tools === "all") return "all";
  return new Set(Array.isArray(tools) ? tools : []);
}

export function childExtensionAllowed(extension: any, tools: AgentTools): boolean {
  const id = extensionFeatureId(extension);
  const capability = id ? CHILD_EXTENSION_CAPABILITIES[id] : undefined;
  // A model-provider extension registers its provider through the child's own
  // extension runner. Without it, the child cannot resolve that provider's
  // models even though the parent lists them.
  if (capability === "guard" || capability === "model-provider") return true;
  if (capability && capability !== "headless-tool") return false;

  const requested = requestedExtensionTools(tools);
  if (requested !== "all" && requested.size === 0) return false;
  const names = [...(extension?.tools?.keys?.() ?? [])] as string[];
  if (!names.length) return false;
  return requested === "all" || names.some((name) => requested.has(name));
}

export function applyChildExtensionProfile(base: any, tools: AgentTools): any {
  return { ...base, extensions: base.extensions.filter((extension: any) => childExtensionAllowed(extension, tools)) };
}

export class PiChildAgentRuntime implements ChildAgentRuntime {
  async create(input: LaunchInput, sessionDir: string): Promise<ChildAgentRuntimeSession> {
    // Each child needs its own runtime. Every child re-registers extension
    // providers on load, and a repeated registration on a shared runtime drops
    // the provider's fetched catalog and routes earlier children through the
    // newest child's provider instance.
    const modelRuntime = await ModelRuntime.create();
    if (input.resumeSessionFile && !existsSync(input.resumeSessionFile)) throw new Error(`Subagent session file not found: ${input.resumeSessionFile}`);

    const sessionManager = input.resumeSessionFile
      ? SessionManager.open(input.resumeSessionFile, sessionDir, input.cwd)
      : SessionManager.create(input.cwd, sessionDir);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(input.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      appendSystemPrompt: input.agent.systemPrompt ? [input.agent.systemPrompt] : [],
      extensionsOverride: (base) => applyChildExtensionProfile(base, input.agent.tools),
    });
    await resourceLoader.reload();
    const created = await createAgentSession({ cwd: input.cwd, sessionManager, modelRuntime, settingsManager, resourceLoader });
    return { session: created.session, modelRuntime };
  }
}
