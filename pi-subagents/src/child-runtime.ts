import { existsSync } from "node:fs";
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LaunchInput } from "./types.ts";

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

function excludeNestedSubagents(extension: any): boolean {
  const path = `${extension?.path ?? ""} ${extension?.resolvedPath ?? ""}`;
  return !path.includes("pi-subagents");
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
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(excludeNestedSubagents),
      }),
    });
    await resourceLoader.reload();
    const created = await createAgentSession({ cwd: input.cwd, sessionManager, authStorage, modelRegistry, settingsManager, resourceLoader });
    return { session: created.session, modelRegistry };
  }
}
