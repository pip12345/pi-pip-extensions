# Development notes

## Repository shape

This directory is a loose collection of Pi extensions plus shared helper code.

- `pip-common` - shared utilities, `/pip-settings`, and unit-test helpers
- `pi-quiet-tools` - compact rendering for built-in read/grep/find/ls tools
- `pi-stats` - interactive token/session/global usage inspector
- `pi-provider-model-patches` - generic persistent opt-in patches for stale provider model catalogs
- `pi-pip-footer` - footer with token counter, context gauge, model status, and quota usage
- `pi-prompt-profiles` - selectable markdown system prompt overlays
- `pi-tree-edit` - interactive session tree editor
- `pi-undo-redo` - destructive tail-only undo/redo for recent prompts
- `pi-todo` - session-scoped todo tools, compact widget, and `/todo`
- `pi-question` - interactive question tool
- `pi-subagents` - quiet subagent task runs
- `pi-tiny-mcp` - tiny stdio/HTTP MCP adapter
- `pi-webfetch-websearch` - cleaned web fetching and no-key web search

Each `pi-*` folder is intended to work both when the whole repo is loaded as a raw extension folder and when packages are installed with dependencies. Shared code lives in `pip-common`; packages declare it as a dependency, but source files use relative imports so raw-folder loading does not require `npm install`.

## `/pip-settings`

`pip-common` registers a shared `/pip-settings` command. Extensions can register settings sections with `registerSettingsSection()`:

```ts
import { registerSettingsSection, setting } from "../pip-common/index.ts";

registerSettingsSection({
  id: "example",
  title: "Example",
  order: 10,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
    behavior: setting.enum({
      label: "Default behavior",
      default: "ask",
      choices: ["ask", "always", "never"] as const,
      order: 2,
    }),
  },
});
```

The settings UI is inline: `enter`/right arrow advance values, left arrow goes backward, and booleans are `on`/`off` choices.
Values persist to `~/.pi/agent/pip/pip-settings.json`.

## Development setup

Only needed when changing code or running tests:

```bash
npm install
```

This installs TypeScript, Vitest, and Pi type packages for local development. Runtime use through Pi does not require this step.

## Run tests

```bash
npm test
```

Run one package/file:

```bash
npx vitest run pip-common
npx vitest run pi-quiet-tools
npx vitest run pi-tree-edit/index.test.ts
```

## Typecheck

```bash
npm run typecheck
```

## Recommended pre-commit check

```bash
npm test && npm run typecheck
```

## Unit-test approach

Tests use Vitest and mostly avoid launching Pi. Extensions are imported directly and passed a mocked `ExtensionAPI` from `pip-common/testing.ts`.

Example:

```ts
import extension from "../index.ts";
import { createMockPi } from "../pip-common/testing.ts";

it("registers command", () => {
  const pi = createMockPi();
  extension(pi as any);
  expect(pi.commands.has("my-command")).toBe(true);
});
```

Useful helpers:

- `createMockPi()` - captures registered commands, tools, handlers, messages
- `createMockCtx()` - fake extension context with fake `ctx.ui`
- `emitEvent()` - invokes registered event handlers
- `runCommand()` - invokes a registered slash command
- `getRegisteredTool()` / `getRegisteredCommand()`

## Adding a new extension

Create a new `pi-*` folder:

```text
pi-example/
  index.ts
  index.test.ts
  package.json
  README.md
```

Minimal `package.json`:

```json
{
  "name": "pi-example",
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "files": ["index.ts", "README.md"]
}
```

If the extension needs shared helpers, declare a `pip-common` dependency in `package.json`, but import it relatively in source so direct folder loading works without installing/linking workspace packages:

```ts
import { pipSettings } from "../pip-common/index.ts";
```

Keep `pip-common` dependency versions in sync with the workspace package version.
