import type { AgentSession } from "@earendil-works/pi-coding-agent";

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

export type RunStatus = "running" | "completed" | "error" | "cancelled";

export type SubagentEvent =
  | { type: "steer"; text: string; at: number }
  | { type: "tool_start"; id: string; name: string; argsSummary: string; at: number }
  | { type: "tool_end"; id: string; ok: boolean; resultSummary?: string; durationMs?: number; at: number }
  | { type: "text_delta"; text: string; at: number };

export interface SubagentSnapshot {
  id: string;
  name?: string;
  agent: string;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  keep: boolean;
  background: boolean;
  detached: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  sessionFile?: string;
  resultText?: string;
  errorText?: string;
  events: SubagentEvent[];
}

export interface SubagentRun {
  id: string;
  name?: string;
  agent: string;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  keep: boolean;
  background: boolean;
  detached: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  session?: AgentSession;
  sessionFile?: string;
  resultText?: string;
  errorText?: string;
  events: SubagentEvent[];
  abortController: AbortController;
  runPromise?: Promise<SubagentRun>;
  dispose?: () => Promise<void> | void;
  continuePrompt?: (prompt: string) => Promise<void>;
  steer?: (message: string) => Promise<void>;
  cancel?: () => Promise<void>;
  detach?: () => void;
  detachPromise?: Promise<void>;
  resolveDetach?: () => void;
  forwarding?: boolean;
  removeParentAbort?: () => void;
}

export interface LaunchInput {
  agent: AgentConfig;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile?: string;
  name?: string;
  keep: boolean;
  background: boolean;
  model?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: { content: [{ type: "text"; text: string }]; details?: any }) => void;
}

export interface Runner {
  launch(input: LaunchInput, run: SubagentRun): Promise<SubagentRun>;
}
