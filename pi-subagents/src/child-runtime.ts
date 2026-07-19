import { existsSync } from "node:fs";
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentTools, LaunchInput } from "./types.ts";

export interface ChildAgentRuntimeSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelRegistry: ReturnType<typeof ModelRegistry.create>;
}

export interface ChildAgentRuntime {
  create(input: LaunchInput, sessionDir: string): Promise<ChildAgentRuntimeSession>;
}

let authStorage: ReturnType<typeof AuthStorage.create> | undefined;
let modelRegistry: ReturnType<typeof ModelRegistry.create> | undefined;

function auth() {
  authStorage ??= AuthStorage.create();
  modelRegistry ??= ModelRegistry.create(authStorage);
  return { authStorage, modelRegistry };
}

export type ChildExtensionCapability = "guard" | "headless-tool" | "ui" | "parent-state" | "provider" | "external-resource" | "nested-agent" | "parent-telemetry" | "parent-prompt" | "infrastructure";

export const CHILD_EXTENSION_CAPABILITIES: Readonly<Record<string, ChildExtensionCapability>> = {
  "pip-common": "infrastructure",
  "pi-secrets-guard": "guard",
  "pi-webfetch-websearch": "headless-tool",
  "pi-question": "ui",
  "pi-tool-ui": "ui",
  "pi-pip-footer": "ui",
  "pi-tree-edit": "ui",
  "pi-context": "ui",
  "pi-todo": "parent-state",
  "pi-undo-redo": "parent-state",
  "pi-provider-proxy": "provider",
  "pi-tiny-mcp": "external-resource",
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
  if (capability === "guard") return true;
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
    const { authStorage, modelRegistry } = auth();
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
    const created = await createAgentSession({ cwd: input.cwd, sessionManager, authStorage, modelRegistry, settingsManager, resourceLoader });
    return { session: created.session, modelRegistry };
  }
}
