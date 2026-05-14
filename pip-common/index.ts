// pip-common is a shared utility package, not a real pi extension.
// If a whole extensions-pip checkout is scanned by pi, this no-op factory
// keeps pip-common safely loadable while preserving named utility exports.
export default function pipCommonNoopExtension() {}

export * from "./src/capabilities.ts";
export * from "./src/content.ts";
export * from "./src/keys.ts";
export * from "./src/lifecycle.ts";
export * from "./src/prompt-registry.ts";
export * from "./src/settings.ts";
export * from "./src/status.ts";
export * from "./src/usage.ts";
