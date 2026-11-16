import { basename, dirname } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, type AgentConfig, type AgentTools } from "./agents.ts";
import { parseModelRef } from "./model-ref.ts";

/**
 * Extension packages a child session must not load. The child loads everything else the parent
 * loads, so guards and model providers keep working without a per-extension allowlist.
 * - pi-subagents: children must not start their own subagents.
 * - pi-stats: records usage from the session it runs in, so it would count child usage twice.
 * - pi-prompt-profiles: the parent's working style is not the child agent's system prompt.
 * - pi-question: children run without a UI, so a question would fail or never get an answer.
 */
export const CHILD_EXTENSION_DENYLIST: ReadonlySet<string> = new Set(["pi-subagents", "pi-stats", "pi-prompt-profiles", "pi-question"]);

/** An extension's package is the directory holding its entry file, e.g. `pi-stats/index.ts`. */
export function childExtensionAllowed(extension: { path?: string; resolvedPath?: string }): boolean {
  const entry = extension.resolvedPath ?? extension.path;
  return !entry || !CHILD_EXTENSION_DENYLIST.has(basename(dirname(entry)));
}

/**
 * SDK sessions do not load the CLI's built-in extensions. These entries mirror the CLI's, so MCP
 * servers, codemode, and tool_search behave as in the parent and `-builtin:<name>` settings apply.
 */
function builtinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
  ];
}

export interface ChildSessionOptions {
  cwd: string;
  agent: AgentConfig;
  /** `provider/model-id`; omitted keeps the model the session would pick on its own. */
  model?: string;
  projectTrusted: boolean;
  /** Owns the child conversation. Reusing it in a new session continues that conversation. */
  sessionManager: SessionManager;
  signal?: AbortSignal;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  settingsManager?: SettingsManager;
}

export interface ChildSession {
  session: AgentSession;
  /** Shuts the child down. Call it once the session is no longer needed. */
  close(): Promise<void>;
}

export type CreateChildSession = (options: ChildSessionOptions) => Promise<ChildSession>;

function activeTools(tools: AgentTools): string[] | undefined {
  if (tools === "all") return undefined;
  if (tools === "none") return [];
  if (tools === "builtins") return [...BUILTIN_TOOL_NAMES];
  return tools;
}

async function resolveModel(modelRuntime: ModelRuntime, ref: string, signal?: AbortSignal) {
  const { provider, id } = parseModelRef(ref);
  let model = modelRuntime.getModel(provider, id);
  if (!model) {
    // Extension providers can start with an empty catalog and discover models on refresh. Only
    // the parent's interactive mode refreshes catalogs, so the child refreshes this provider.
    await modelRuntime.refresh({ providers: [provider], signal });
    model = modelRuntime.getModel(provider, id);
  }
  if (model) return model;
  const known = (await Promise.resolve(modelRuntime.getAvailable())).filter((candidate) => candidate.provider === provider).map((candidate) => `${candidate.provider}/${candidate.id}`).sort();
  throw new Error(`Unknown subagent model: ${ref}. ${known.length ? `Available ${provider} models: ${known.join(", ")}` : `No available models for provider "${provider}".`}`);
}

export const createChildSession: CreateChildSession = async (options) => {
  const agentDir = options.agentDir ?? getAgentDir();
  // Each child needs its own runtime. Every child re-registers extension providers on load, and a
  // repeated registration on a shared runtime drops the provider's fetched catalog and routes
  // earlier children through the newest child's provider instance.
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create();
  const settingsManager = options.settingsManager ?? SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.projectTrusted });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: options.agent.systemPrompt ? [options.agent.systemPrompt] : [],
    extensionFactories: builtinExtensions(),
    extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter(childExtensionAllowed) }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: options.cwd, agentDir, sessionManager: options.sessionManager, modelRuntime, settingsManager, resourceLoader });
  // AgentSession.dispose() does not emit session_shutdown; Pi's runtime emits it first. Without
  // it, child extensions keep MCP server processes and provider connections alive, which also
  // keeps the parent process from exiting. Pending credential writes are awaited because an OAuth
  // refresh may already have spent the old single-use refresh token.
  const close = async () => {
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
      await modelRuntime.settleCredentialWrites();
    }
  };
  try {
    // Emits session_start, which MCP needs to connect its servers.
    await session.bindExtensions({ mode: "print" });
    // Resolve the model only now: extension providers register while the session loads extensions.
    if (options.model) await session.setModel(await resolveModel(modelRuntime, options.model, options.signal));
    const tools = activeTools(options.agent.tools);
    if (tools) session.setActiveToolsByName(tools);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return { session, close };
};
