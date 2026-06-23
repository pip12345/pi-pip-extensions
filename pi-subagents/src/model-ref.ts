export const MODEL_REF_FORMAT = "provider/model-id";
export const MODEL_REF_ERROR = "model must be provider/model-id with non-empty provider and model id.";

export interface ParsedModelRef {
  provider: string;
  id: string;
  value: string;
}

export function parseModelRef(value: string): ParsedModelRef {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || /\s/.test(trimmed)) throw new Error(MODEL_REF_ERROR);
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) throw new Error(MODEL_REF_ERROR);
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1), value: trimmed };
}
