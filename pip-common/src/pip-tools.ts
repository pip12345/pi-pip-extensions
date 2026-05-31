import type { ToolDefinition, ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const STATES_KEY = Symbol.for("pip-common.pip-tools.states");
const FINALIZERS_KEY = Symbol.for("pip-common.pip-tools.finalizers");
const LISTENERS_KEY = Symbol.for("pip-common.pip-tools.listeners");

function states(): Set<PiState> {
  const globalState = globalThis as any;
  if (!globalState[STATES_KEY]) globalState[STATES_KEY] = new Set<PiState>();
  return globalState[STATES_KEY];
}

function finalizers(): Map<string, PipToolFinalizer> {
  const globalState = globalThis as any;
  if (!globalState[FINALIZERS_KEY]) globalState[FINALIZERS_KEY] = new Map<string, PipToolFinalizer>();
  return globalState[FINALIZERS_KEY];
}

function listeners(): Set<Listener> {
  const globalState = globalThis as any;
  if (!globalState[LISTENERS_KEY]) globalState[LISTENERS_KEY] = new Set<Listener>();
  return globalState[LISTENERS_KEY];
}

function notify(): void {
  for (const listener of listeners()) listener();
}

function getState(pi: ExtensionAPI): PiState {
  for (const state of states()) if (state.pi === pi) return state;
  const state: PiState = { pi, registrations: [], registeredNames: new Set(), scheduled: undefined, flushed: false };
  states().add(state);
  return state;
}

function sortedFinalizers(): PipToolFinalizer[] {
  return [...finalizers().values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

function finalizeTool(registration: PipToolRegistration): ToolDefinition<any, any, any> {
  let tool = registration.tool;
  for (const finalizer of sortedFinalizers()) tool = finalizer.finalize({ tool, metadata: registration.metadata });
  return tool;
}

function registerOne(state: PiState, registration: PipToolRegistration): void {
  if (state.registeredNames.has(registration.tool.name)) return;
  state.pi.registerTool(finalizeTool(registration));
  state.registeredNames.add(registration.tool.name);
}

function scheduleFlush(state: PiState): void {
  if (state.scheduled) return;
  state.scheduled = setTimeout(() => {
    state.scheduled = undefined;
    flushPipTools(state.pi);
  }, 0);
}

export function registerPipTool(pi: ExtensionAPI, registration: PipToolRegistration): void {
  const state = getState(pi);
  state.registrations.push(registration);
  notify();
  if (state.flushed) registerOne(state, registration);
  else scheduleFlush(state);
}

export function registerPipToolFinalizer(finalizer: PipToolFinalizer): () => void {
  finalizers().set(finalizer.id, finalizer);
  for (const state of states()) if (!state.flushed) scheduleFlush(state);
  return () => finalizers().delete(finalizer.id);
}

export function flushPipTools(pi: ExtensionAPI): void {
  const state = getState(pi);
  if (state.scheduled) {
    clearTimeout(state.scheduled);
    state.scheduled = undefined;
  }
  for (const registration of state.registrations) registerOne(state, registration);
  state.flushed = true;
}

export function listPipToolRegistrations(): PipToolRegistration[] {
  const byName = new Map<string, PipToolRegistration>();
  for (const state of states()) for (const registration of state.registrations) byName.set(registration.tool.name, registration);
  return [...byName.values()].sort((a, b) => (a.metadata?.pluginId ?? "").localeCompare(b.metadata?.pluginId ?? "") || (a.metadata?.label ?? a.tool.label ?? a.tool.name).localeCompare(b.metadata?.label ?? b.tool.label ?? b.tool.name));
}

export function onPipToolRegistrationChange(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function resetPipToolsForTests(): void {
  for (const state of states()) if (state.scheduled) clearTimeout(state.scheduled);
  states().clear();
  finalizers().clear();
  listeners().clear();
}
