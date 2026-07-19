# Development notes

## Repository shape

This repository is one aggregate Pi package with separately filterable feature entrypoints. Each `pi-*` workspace is also maintained as a standalone package.

- `pip-common` - shared utilities, `/pip-settings`, and unit-test helpers
- `pi-tool-ui` - compact rendering for built-in and Pip tools
- `pi-stats` - interactive token/session/global usage inspector
- `pi-pip-footer` - footer with token counter, context gauge, model status, and quota usage
- `pi-prompt-profiles` - selectable markdown system prompt overlays
- `pi-tree-edit` - interactive session tree editor
- `pi-undo-redo` - destructive tail-only undo/redo for recent prompts
- `pi-todo` - session-scoped todo tools, compact widget, and `/todo`
- `pi-question` - interactive question tool
- `pi-subagents` - quiet subagent task runs
- `pi-tiny-mcp` - tiny stdio/HTTP MCP adapter
- `pi-webfetch-websearch` - cleaned web fetching and no-key web search

Shared code lives in `pip-common`. Feature sources import it directly by relative source path, so the aggregate package loads from a clean checkout without workspace links. The standalone packaging script builds isolated staging trees, rewrites those staged imports to the `pip-common` package name, and bundles the common runtime under each feature's `node_modules`.

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
npx vitest run pi-tool-ui
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

## Package tarballs

Generate aggregate and standalone workspace tarballs through the staging command so each feature includes its bundled `pip-common` runtime:

```bash
npm run pack:workspaces -- --pack-destination <directory>
```

The package tests install every feature tarball in isolation and load it through Pi's package rules.

## Unit-test approach

Tests use Vitest and mostly avoid launching Pi. Extensions are imported directly and passed a mocked `ExtensionAPI` from `pip-common/testing.ts`.

Example:

```ts
import extension from "../index.ts";
import { createMockPi } from "pip-common/testing";

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
  "pi": {
    "extensions": [
      "node_modules/pip-common/index.ts",
      "./index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "dependencies": {
    "pip-common": "0.1.0"
  },
  "bundledDependencies": ["pip-common"],
  "files": ["index.ts", "README.md"]
}
```

If the extension needs shared helpers, declare and bundle the matching `pip-common` workspace version, load its bootstrap before the feature, and import it by package name:

```ts
import { pipSettings } from "pip-common";
```

Keep `pip-common` dependency versions in sync and use `npm run pack:workspaces` so the hoisted workspace dependency is staged into each tarball.
