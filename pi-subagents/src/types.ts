import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TokenUsage } from "pip-common";

export type AgentTools = "all" | "none" | "builtins" | string[];
export type AgentSource = "builtin" | "user" | "legacy" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools: AgentTools;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiagnostic {
  path: string;
  message: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  diagnostics: AgentDiagnostic[];
}

export type RunStatus = "running" | "completed" | "error" | "cancelled" | "interrupted";

export type SubagentEvent =
  | { type: "steer"; text: string; at: number }
  | { type: "tool_start"; id: string; name: string; argsSummary: string; at: number }
  | { type: "tool_end"; id: string; ok: boolean; resultSummary?: string; durationMs?: number; at: number }
  | { type: "text_delta"; text: string; at: number };

export interface SubagentSnapshot {
  id: string;
  name?: string;
  agent: string;
  model?: string;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  keep: boolean;
  anchorEntryId?: string;
  background: boolean;
  detached: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  sessionFile?: string;
  contextRoot?: string;
  runContextDir?: string;
  resultText?: string;
  errorText?: string;
  usage?: TokenUsage;
  events: SubagentEvent[];
}

export interface SubagentRun {
  id: string;
  name?: string;
  agent: string;
  model?: string;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  keep: boolean;
  anchorEntryId?: string;
  background: boolean;
  detached: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  session?: AgentSession;
  sessionFile?: string;
  contextRoot?: string;
  runContextDir?: string;
  resultText?: string;
  errorText?: string;
  usage: TokenUsage;
  events: SubagentEvent[];
  abortController: AbortController;
  runPromise?: Promise<SubagentRun>;
  dispose?: () => Promise<void> | void;
  continuePrompt?: (prompt: string) => Promise<void>;
  steer?: (message: string, displayMessage?: string) => Promise<void>;
  cancel?: () => Promise<void>;
  detach?: () => void;
  detachPromise?: Promise<void>;
  resolveDetach?: () => void;
  forwarding?: boolean;
  removeParentAbort?: () => void;
  persist?: () => void;
}

export interface LaunchInput {
  agent: AgentConfig;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  anchorEntryId?: string;
  name?: string;
  keep: boolean;
  background: boolean;
  model?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: { content: [{ type: "text"; text: string }]; details?: any }) => void;
  resumeSessionFile?: string;
  contextRoot?: string;
  runContextDir?: string;
}

export interface Runner {
  launch(input: LaunchInput, run: SubagentRun): Promise<SubagentRun>;
}
