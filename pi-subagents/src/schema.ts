import { Type } from "typebox";

export const SubagentParams = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("launch"),
    Type.Literal("agents"),
    Type.Literal("get_agent"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("read"),
    Type.Literal("steer"),
    Type.Literal("cancel"),
    Type.Literal("keep"),
    Type.Literal("forget"),
    Type.Literal("background"),
  ], { description: "Operation. Omit for list, or provide agent+prompt to launch." })),
  agent: Type.Optional(Type.String({ description: "Agent name for launch/get_agent." })),
  prompt: Type.Optional(Type.String({ description: "Task prompt. Must include all context the subagent needs." })),
  id: Type.Optional(Type.String({ description: "Subagent id or kept name." })),
  name: Type.Optional(Type.String({ description: "Optional alias for kept subagents." })),
  message: Type.Optional(Type.String({ description: "Message for steer." })),
  background: Type.Optional(Type.Boolean({ description: "Run in background and return immediately." })),
  keep: Type.Optional(Type.Boolean({ description: "Retain for reuse after completion. Ephemeral completed subagents cannot be continued." })),
  wait: Type.Optional(Type.Boolean({ description: "For status, wait briefly for completion." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Maximum milliseconds to wait when wait=true." })),
});

export type SubagentParamsType = {
  action?: "launch" | "agents" | "get_agent" | "list" | "status" | "read" | "steer" | "cancel" | "keep" | "forget" | "background";
  agent?: string;
  prompt?: string;
  id?: string;
  name?: string;
  message?: string;
  background?: boolean;
  keep?: boolean;
  wait?: boolean;
  timeoutMs?: number;
};
