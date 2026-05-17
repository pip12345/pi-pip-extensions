export interface PipReadOnlyState {
  active: boolean;
  source: string;
  updatedAt: number;
}

const KEY = Symbol.for("pip-common.read-only-state");

function states(): Map<string, PipReadOnlyState> {
  const globalState = globalThis as any;
  if (!globalState[KEY]) globalState[KEY] = new Map<string, PipReadOnlyState>();
  return globalState[KEY];
}

export function setPipReadOnlyState(source: string, active: boolean): void {
  states().set(source, { source, active, updatedAt: Date.now() });
}

export function clearPipReadOnlyState(source: string): void {
  states().delete(source);
}

export function isPipReadOnlyActive(): boolean {
  for (const state of states().values()) if (state.active) return true;
  return false;
}

export function listPipReadOnlyStates(): PipReadOnlyState[] {
  return [...states().values()].sort((a, b) => a.source.localeCompare(b.source));
}

export function resetPipReadOnlyStatesForTests(): void {
  states().clear();
}
