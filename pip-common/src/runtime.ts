export interface PiRuntimeEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PiRuntimeOwner {
  events: PiRuntimeEventBus;
  on?(event: "session_shutdown", handler: () => void | Promise<void>): void;
}

const RUNTIME_DISCOVERY_CHANNEL = "pip-common:runtime-key:v1";
const RUNTIME_DISCOVERY_REQUEST = Symbol.for("pip-common.runtime-key.request");
const EVENT_RUNTIME_KEYS = Symbol.for("pip-common.runtime-key.by-event-facade");

type RuntimeDiscoveryRequest = {
  [RUNTIME_DISCOVERY_REQUEST]: true;
  key?: object;
};

function eventRuntimeKeys(): WeakMap<object, object> {
  const state = globalThis as any;
  if (!state[EVENT_RUNTIME_KEYS]) state[EVENT_RUNTIME_KEYS] = new WeakMap<object, object>();
  return state[EVENT_RUNTIME_KEYS];
}

function isRuntimeDiscoveryRequest(data: unknown): data is RuntimeDiscoveryRequest {
  return typeof data === "object" && data !== null && (data as RuntimeDiscoveryRequest)[RUNTIME_DISCOVERY_REQUEST] === true;
}

export function piRuntimeKey(pi: PiRuntimeOwner): object {
  // Pi gives each extension a scoped events facade, so use the shared underlying
  // bus to discover one owner token for all pip extensions in this runtime.
  const events = pi?.events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") throw new Error("A Pi runtime event bus is required");

  const facade = events as object;
  const cached = eventRuntimeKeys().get(facade);
  if (cached) return cached;

  const request: RuntimeDiscoveryRequest = { [RUNTIME_DISCOVERY_REQUEST]: true };
  events.emit(RUNTIME_DISCOVERY_CHANNEL, request);
  if (request.key) {
    eventRuntimeKeys().set(facade, request.key);
    return request.key;
  }

  const key = {};
  eventRuntimeKeys().set(facade, key);
  const unsubscribe = events.on(RUNTIME_DISCOVERY_CHANNEL, (data) => {
    if (isRuntimeDiscoveryRequest(data) && !data.key) data.key = key;
  });
  pi.on?.("session_shutdown", unsubscribe);
  return key;
}
