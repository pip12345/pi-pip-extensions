# extensions-pip

Local pi extension packages plus shared utilities.

## Packages

- `pip-common` - shared utilities and unit-test helpers for the extensions
- `pi-quiet-tools` - compact rendering for built-in read/grep/find/ls tools
- `pi-stats` - interactive token/session/global usage inspector
- `pi-token-counter` - live token counter widget
- `pi-tree-edit` - interactive session tree editor

Each extension is intended to work independently, but may depend on `pip-common`.

## Setup

From this directory:

```bash
npm install
```

## Run tests

Run all unit tests:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

Run tests for one package/file:

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

Tests use Vitest and mostly avoid launching pi. Extensions are imported directly and passed a mocked `ExtensionAPI` from `pip-common/testing`.

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

## Package layout

```text
extensions-pip/
  package.json
  tsconfig.json
  vitest.config.mjs

  pip-common/
    index.ts
    testing.ts
    src/
    test/

  pi-quiet-tools/
    index.ts
    index.test.ts
    package.json

  pi-stats/
    index.ts
    index.test.ts
    package.json

  pi-token-counter/
    index.ts
    index.test.ts
    package.json

  pi-tree-edit/
    index.ts
    index.test.ts
    package.json
```

## Adding a new extension

Create a new `pi-*` package with a dependency on `pip-common`:

```json
{
  "name": "pi-example",
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "pip-common": "file:../pip-common"
  },
  "files": ["index.ts", "README.md"]
}
```

Then add an `index.test.ts` smoke test that verifies the extension loads and registers the expected commands/tools/events.
