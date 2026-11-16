import { Type, type Static } from "typebox";

export const LaunchParams = Type.Object({
  agent: Type.String({ description: "Agent name from the available subagent agents." }),
  prompt: Type.String({ description: "Task prompt. Must include all context the subagent needs." }),
  model: Type.Optional(Type.String({ description: "Model override as provider/model-id. Omit to use the agent's model or the current model." })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately; the result arrives later as a follow-up message." })),
});

export const MessageParams = Type.Object({
  id: Type.String({ description: "Subagent id." }),
  message: Type.String({ description: "Steering note for a running subagent, or the next prompt for a finished one." }),
  background: Type.Optional(Type.Boolean({ description: "When continuing a finished subagent, return immediately; the reply arrives as a follow-up message." })),
});

export const StatusParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Subagent id. Omit to list all subagents of this session." })),
});

export type LaunchParamsType = Static<typeof LaunchParams>;
export type MessageParamsType = Static<typeof MessageParams>;
export type StatusParamsType = Static<typeof StatusParams>;
