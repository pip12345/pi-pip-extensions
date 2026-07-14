import type { ToolDefinition, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piRuntimeKey } from "./runtime.ts";

export interface PipToolDisplayMetadata {
  kind?: "query" | "mutation" | "command" | "interactive" | "generic";
  call?: (args: any) => string | undefined;
  result?: (result: any) => string | undefined;
  expandedResult?: (result: any) => string | undefined;
  hideSuccessfulResult?: boolean;
}

export interface PipToolMetadata {
  pluginId: string;
  label?: string;
  display?: PipToolDisplayMetadata;
}

export interface PipToolRegistration {
  tool: ToolDefinition<any, any, any>;
  metadata?: PipToolMetadata;
}

export interface PipToolFinalizerContext {
  tool: ToolDefinition<any, any, any>;
  metadata?: PipToolMetadata;
}

export interface PipToolFinalizer {
  id: string;
  order?: number;
  finalize(context: PipToolFinalizerContext): ToolDefinition<any, any, any>;
}

type Listener = () => void;

interface PiState {
  pi: ExtensionAPI;
  registrations: PipToolRegistration[];
  registeredNames: Set<string>;
  scheduled: ReturnType<typeof setTimeout> | undefined;
  flushed: boolean;
}

interface RuntimeState {
  key: object;
  piStates: Map<ExtensionAPI, PiState>;
  finalizers: Map<string, PipToolFinalizer>;
  listeners: Set<Listener>;
}

const RUNTIME_STATES_KEY = Symbol.for("pip-common.pip-tools.runtime-states");
const knownRuntimeStates = new Set<RuntimeState>();

function runtimeStates(): WeakMap<object, RuntimeState> {
  const globalState = globalThis as any;
  if (!globalState[RUNTIME_STATES_KEY]) globalState[RUNTIME_STATES_KEY] = new WeakMap<object, RuntimeState>();
  return globalState[RUNTIME_STATES_KEY];
}

function disposePiState(runtime: RuntimeState, state: PiState): void {
  if (state.scheduled) clearTimeout(state.scheduled);
  runtime.piStates.delete(state.pi);
}

function disposeRuntime(runtime: RuntimeState): void {
  for (const state of runtime.piStates.values()) if (state.scheduled) clearTimeout(state.scheduled);
  runtime.piStates.clear();
  runtime.finalizers.clear();
  runtime.listeners.clear();
  runtimeStates().delete(runtime.key);
  knownRuntimeStates.delete(runtime);
}

function getRuntimeState(pi: ExtensionAPI): RuntimeState {
  const key = piRuntimeKey(pi);
  let runtime = runtimeStates().get(key);
  if (runtime) return runtime;
  runtime = { key, piStates: new Map(), finalizers: new Map(), listeners: new Set() };
  runtimeStates().set(key, runtime);
  knownRuntimeStates.add(runtime);
  pi.on("session_shutdown", async () => disposeRuntime(runtime!));
  return runtime;
}

function getPiState(pi: ExtensionAPI): { runtime: RuntimeState; state: PiState } {
  const runtime = getRuntimeState(pi);
  let state = runtime.piStates.get(pi);
  if (!state) {
    state = { pi, registrations: [], registeredNames: new Set(), scheduled: undefined, flushed: false };
    runtime.piStates.set(pi, state);
  }
  return { runtime, state };
}

function notify(runtime: RuntimeState): void {
  for (const listener of runtime.listeners) listener();
}

function isStalePiError(error: unknown): boolean {
  return error instanceof Error && /ctx is stale after session replacement or reload/i.test(error.message);
}

function sortedFinalizers(runtime: RuntimeState): PipToolFinalizer[] {
  return [...runtime.finalizers.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

function finalizeTool(runtime: RuntimeState, registration: PipToolRegistration): ToolDefinition<any, any, any> {
  let tool = registration.tool;
  for (const finalizer of sortedFinalizers(runtime)) tool = finalizer.finalize({ tool, metadata: registration.metadata });
  return tool;
}

function registerOne(runtime: RuntimeState, state: PiState, registration: PipToolRegistration): void {
  if (state.registeredNames.has(registration.tool.name)) return;
  state.pi.registerTool(finalizeTool(runtime, registration));
  state.registeredNames.add(registration.tool.name);
}

function refinalizeRegistered(runtime: RuntimeState, state: PiState): void {
  for (const registration of state.registrations) {
    if (!state.registeredNames.has(registration.tool.name)) continue;
    state.pi.registerTool(finalizeTool(runtime, registration));
  }
}

function scheduleFlush(state: PiState): void {
  if (state.scheduled) return;
  state.scheduled = setTimeout(() => {
    state.scheduled = undefined;
    flushPipTools(state.pi);
  }, 0);
}

export function registerPipTool(pi: ExtensionAPI, registration: PipToolRegistration): void {
  const { runtime, state } = getPiState(pi);
  state.registrations.push(registration);
  notify(runtime);
  registerOne(runtime, state, registration);
  if (!state.flushed) scheduleFlush(state);
}

export function registerPipToolFinalizer(pi: ExtensionAPI, finalizer: PipToolFinalizer): () => void {
  const runtime = getRuntimeState(pi);
  runtime.finalizers.set(finalizer.id, finalizer);
  for (const state of [...runtime.piStates.values()]) {
    try {
      refinalizeRegistered(runtime, state);
      if (!state.flushed) scheduleFlush(state);
    } catch (error) {
      if (!isStalePiError(error)) throw error;
      disposePiState(runtime, state);
    }
  }
  return () => runtime.finalizers.delete(finalizer.id);
}

export function flushPipTools(pi: ExtensionAPI): void {
  const { runtime, state } = getPiState(pi);
  if (state.scheduled) {
    clearTimeout(state.scheduled);
    state.scheduled = undefined;
  }
  try {
    for (const registration of state.registrations) registerOne(runtime, state, registration);
    state.flushed = true;
  } catch (error) {
    if (!isStalePiError(error)) throw error;
    disposePiState(runtime, state);
  }
}

export function listPipToolRegistrations(pi: ExtensionAPI): PipToolRegistration[] {
  const runtime = getRuntimeState(pi);
  const byName = new Map<string, PipToolRegistration>();
  for (const state of runtime.piStates.values()) for (const registration of state.registrations) byName.set(registration.tool.name, registration);
  return [...byName.values()].sort((a, b) => (a.metadata?.pluginId ?? "").localeCompare(b.metadata?.pluginId ?? "") || (a.metadata?.label ?? a.tool.label ?? a.tool.name).localeCompare(b.metadata?.label ?? b.tool.label ?? b.tool.name));
}

export function onPipToolRegistrationChange(pi: ExtensionAPI, listener: Listener): () => void {
  const runtime = getRuntimeState(pi);
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export function resetPipToolsForTests(): void {
  for (const runtime of [...knownRuntimeStates]) disposeRuntime(runtime);
}
