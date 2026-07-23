export interface PiRuntimeOwner {
  events?: object;
}

export function piRuntimeKey(pi: PiRuntimeOwner): object {
  const events = pi?.events;
  if ((typeof events === "object" && events !== null) || typeof events === "function") return events;
  if ((typeof pi === "object" && pi !== null) || typeof pi === "function") return pi as object;
  throw new Error("A Pi runtime owner is required");
}
