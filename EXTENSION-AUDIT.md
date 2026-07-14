# Extension Audit — Preliminary Findings

Date: 2026-07-09

This is a read-only audit checkpoint of the current Pi extensions in `/workspace`. It records the important findings verified so far, including the continuation pass performed after the initial checkpoint. Narrow parallel reviews are still running, so this is not yet the final exhaustive report.

## Cleanup progress — 2026-07-14

- Findings 1–2 were resolved by removing `pi-plan-mode` and its shared read-only machinery.
- Finding 27 was resolved by rendering Todo overflow counts in both directions and adding a regression test.
- Finding 35 was resolved by deleting the unused capability, prompt, and status registries; the consumed footer registry remains supported.
- Findings 6, 20, and 36 were resolved by producing self-contained standalone packages with bundled `pip-common`, explicit runtime allowlists, and isolated Pi-loader tests.
- Removable feature boundaries are now enforced: production sibling imports and reverse `pip-common` dependencies fail tests, while each standalone feature loads with only Pi and its bundled common runtime.
- Findings 3–4 were resolved by threading `ctx.isProjectTrusted()` into Tiny MCP config/manager creation and Subagent agent discovery.
- Finding 5 was resolved with canonical path checks, nearest-existing-parent resolution for writes, and preflight blocking for search/list roots containing guarded descendants.
- Finding 23 was resolved by removing derived context paths from persistence, validating restored records, quarantining malformed indexes, and deriving recursive deletion targets from managed roots.
- Finding 9's corruption/data-loss paths and finding 32 were resolved with strict loads, unknown-section preservation, transactional atomic commits, batched UI saves, and central bound/default validation.
- Finding 14 was resolved with batched settings notifications, live consumers, and declarative reload warnings.
- The runtime-ownership half of findings 21 and 34 was resolved by keying common services to Pi's shared event bus and giving Tiny MCP/Subagents runtime-local managers.
- The stale Tool UI/Tiny MCP/Tree Edit/Footer scaffolding listed below was removed.
- All strict unused-code diagnostics were resolved, and `noUnusedLocals` plus `noUnusedParameters` are now part of the normal typecheck.

## Validation completed

- `npm test`: **39 files, 329 tests passed**
- `npm run typecheck`: **passed**
- `npm pack --dry-run --json --workspaces`: inspected package contents
- `tsc --noUnusedLocals --noUnusedParameters`: found **21 unused-code diagnostics**
- Pi 0.80.1 extension, TUI, session, compaction, package, and keybinding contracts were checked against the installed documentation and type declarations.
- Runtime reproduction of the plan-mode classifier confirmed that all of these mutating commands are currently accepted as read-only:
  - `find . -delete`
  - `find . -exec rm {} +`
  - `env rm victim`
- `npm view pip-common@0.1.0`: **404 Not Found**, confirming that current standalone extension tarballs cannot resolve their shared runtime dependency from npm.
- Installed Pi extension-loader source was inspected to verify that child sessions in the same CWD reuse cached extension factory/module state (`loadExtensionsCached()`), which matters for the Tiny MCP/subagent lifecycle finding below.

Passing tests/typecheck do not cover several lifecycle, trust, packaging, and runtime-policy failures below. Extensive `any` usage also prevents TypeScript from detecting API mistakes such as the nonexistent `session_end` event.

---

## Critical / high-impact findings

### 1–2. Plan mode shell-policy and subagent bypass — **resolved by removal**

`pi-plan-mode` was removed on 2026-07-14 rather than expanding its unsafe shell classifier or shared read-only machinery. The package, settings, tests, aggregate manifest entry, shared `pip-common` read-only state, and subagent read-only filtering were deleted together.

The original runtime evidence remains the reason for removal: the purported read-only classifier accepted `find . -delete`, `find . -exec rm {} +`, and `env rm victim`, while child subagents retained unrestricted mutation paths.

---

### 3. `pi-tiny-mcp` can honor and auto-run project MCP configuration without checking project trust — **resolved**

Tiny MCP now creates trust-specific managers from `ctx.isProjectTrusted()`. Untrusted managers exclude `.mcp.json` and `.pi/tiny-mcp.json` before server discovery, tool execution, commands, or auto-connect. Regression tests cover direct config loading and `session_start` with an untrusted project server.

---

### 4. `pi-subagents` also reads project agent definitions without checking project trust — **resolved**

Agent discovery now defaults to builtin/user definitions only. Every extension path—prompt injection, listing, details, launch, continuation, and steering—passes explicit project trust from the current context. Both `.pi/agents` and legacy `.agents` are ignored when untrusted, with trusted/untrusted regression coverage.

---

### 5. Secrets Guard has containment gaps for symlinks and broad searches — **resolved**

Direct tool targets are now checked through both lexical and canonical paths. Existing targets resolve through `realpath`; new write/edit targets resolve through the nearest existing canonical parent, so symlink aliases cannot bypass common or `.secretignore` rules.

Before execution, `ls` inspects immediate entries and `grep`/`find` inspect recursive descendants. If any reachable path is guarded, the whole call is blocked rather than reading and attempting post-result redaction. Missing search paths default to `.`, and project `.secretignore` is read only when trust is explicitly true. Regression tests cover symlink reads, writes below symlinked parents, recursive search/list containment, clean roots, and untrusted project rules.

The explicitly best-effort Bash token classifier remains intentionally non-authoritative.

---

### 6. `pi-tree-edit` is broken when packed/published as its own package — **resolved**

Tree Edit's standalone allowlist now includes `draft.ts`, `session.ts`, `tree.ts`, and `types.ts`. The generated tarball is installed in an isolated temporary project and loaded through Pi's package rules as part of `test/package-tarballs.test.ts`.

---

### 7. Tiny MCP manager reset leaks live subprocesses and HTTP connections

**Evidence**

- `/tiny-mcp config` calls `resetManager()` at `pi-tiny-mcp/index.ts:50-53` after editing configuration.
- `pi-tiny-mcp/src/proxy-tool.ts:25-27` implements reset as only `managers.clear()`.
- The correct shutdown path at `pi-tiny-mcp/src/proxy-tool.ts:20-22` closes every manager before clearing the map.

**Impact**

Previously connected stdio MCP child processes and HTTP/SSE connections become unreachable and are never closed by later `session_shutdown`, because their managers were removed from the map.

**Recommended direction**

Remove the unsafe reset operation. Configuration reload should await the existing `shutdownManager()` and only then create a fresh manager.

---

### 8. Custom tool failures are often reported as successful tool executions

**Evidence**

Pi 0.80.1’s tool contract says `execute()` must **throw** to set `isError: true`; returning an `isError` property never marks failure.

- `pi-subagents/index.ts:55-56` returns `{ ..., isError }`.
- Many subagent failure paths call `textResult(..., true)`, including disabled/error/status paths around `pi-subagents/index.ts:221-317`.
- `pi-tiny-mcp/src/proxy-tool.ts:112-114` catches every error and returns normal text beginning with `Error:`.

**Impact**

Pi, extensions, renderers, and the model receive a successful tool result for failed launches, invalid arguments, timeouts, transport failures, and MCP call errors. Error styling, telemetry, retry behavior, and tool-batch semantics are wrong.

**Recommended direction**

Throw execution errors. Reserve normal returned results for domain-level non-errors. Update tests to assert framework-level `isError`, not merely an `isError` property returned by the implementation.

---

### 9. Shared settings registration can silently destroy or discard persisted settings — **substantially resolved**

Settings loads now distinguish missing files from malformed JSON/shape errors. A malformed file remains untouched, writes are refused, and `/pip-settings` reports the exact failure. Stored sections and keys are retained independently of loaded definitions, so unloaded features survive later saves.

Registration validates defaults and normalizes in-memory values without persisting. Intentional changes are validated into a cloned snapshot, written through temp-file plus rename, and only then committed in memory. `/pip-settings` applies its draft through one transactional write instead of one rewrite per row.

Concurrent independent Pi processes can still produce last-writer-wins updates because there is no cross-process merge/lock; atomic replacement prevents partial-file corruption but not semantic write races.

---

### 10. Webfetch’s private-host block is not a complete SSRF boundary, and its byte cap is post-buffer

**Evidence**

- `pi-webfetch-websearch/src/webfetch.ts:35-60` checks only the URL hostname text and only a subset of private IP literals.
- `pi-webfetch-websearch/src/webfetch.ts:86` uses `redirect: "follow"` without validating redirect destinations.
- Hostnames are not DNS-resolved and checked against private/link-local ranges.
- Private IPv6 ranges are not covered.
- `pi-webfetch-websearch/src/webfetch.ts:123-127` calls `response.arrayBuffer()` and only then rejects a body exceeding `maxBytes` when `Content-Length` is absent or false.

**Impact**

A public URL can redirect to a local/private service, and a public hostname can resolve to a private address. A server using chunked transfer can force the entire response into memory before the configured 1–5 MB cap is enforced.

**Recommended direction**

Handle redirects manually and validate every hop. Resolve/check addresses (including IPv6 and IPv4-mapped IPv6) or use a dispatcher that rejects private targets at connection time. Stream the body and abort as soon as the byte limit is exceeded.

---

### 11. Tool UI overrides five built-ins without preserving their prompt metadata

**Evidence**

- `pi-tool-ui/index.ts:265-281` constructs replacement definitions for `read`, `grep`, `find`, `ls`, and `edit` but copies only name, label, description, parameters, argument preparation, and execution mode.
- It does not set `promptSnippet` or `promptGuidelines`.
- Pi’s current extension contract explicitly says built-in prompt metadata is **not inherited** when overriding a built-in tool.

**Impact**

Loading `pi-tool-ui` removes Pi’s built-in one-line tool snippets/guidelines for those tools from the system prompt. This can degrade model tool selection and correct usage even though execution still works.

**Recommended direction**

Preserve the built-in prompt metadata explicitly, or avoid execution overrides when only rendering needs to change. The latter would be the cleaner architecture if Pi exposes a renderer-only registration mechanism.

---

### 12. Tool UI can hide real errors in collapsed output

**Evidence**

- `pi-tool-ui/index.ts:89-93` decides whether a result is an error by matching text prefixes (`error`, `access denied`, or `failed`).
- `pi-tool-ui/index.ts:99-103` ignores the renderer context’s authoritative `context.isError` for quiet built-in results.
- `pi-tool-ui/index.ts:198-201` does the same for edit fallback.

**Impact**

Errors whose message starts with another phrase—such as `ENOENT`, `Path not found`, or transport-specific text—can render as an empty collapsed result.

**Recommended direction**

Use `context.isError` as the source of truth and show the first bounded line for every failed execution.

---

## Important correctness and cleanup findings

### 13. `/context` measures the whole branch instead of the effective compacted context

**Evidence**

- `pi-context/index.ts:101-102` uses `getBranch()` (or all entries) rather than `sessionManager.buildContextEntries()`.
- `pi-context/index.ts:115-123` builds the conversation estimate from that full branch.
- `pi-context/index.ts:135,185-195` labels `model.maxTokens` simply as “Reserved.” This may intentionally represent maximum output-token capacity, but it is not Pi’s compaction reserve and the UI does not say which meaning is intended.

**Impact**

After compaction, the inspector counts old messages that are no longer sent to the model, so its conversation allocation and breakdown are misleading. The “Reserved” value can also differ from Pi’s actual compaction reserve.

**Recommended direction**

Base the conversation section on `buildContextEntries()` / the same session-context path Pi uses. Label `model.maxTokens` explicitly as maximum output capacity if that is the intended reservation; do not imply that it is Pi’s compaction reserve.

---

### 14. Settings changes have no lifecycle notification, so several toggles do not apply live — **resolved**

The settings registry emits one filtered, subscribable change batch after each successful transaction. Todo subscribes to refresh or remove its widget immediately, and its tools/command reject calls while disabled. Subagent commands and shortcuts now honor `enabled`. Tiny MCP no longer auto-connects while disabled and does not register its tool after a disabled reload.

Settings whose registrations/resources cannot safely change in place carry declarative `requiresReload` metadata. `/pip-settings` names those settings in a warning after saving; this covers footer installation, Tiny MCP process/name configuration, Tool UI registration-time adapters, and provider catalog patches. Other settings are read at action/render time and apply to subsequent work without reload.

---

### 15. Tiny MCP output handling is bounded only partially

**Evidence**

- `pi-tiny-mcp/src/proxy-tool.ts:177-180` truncates called-tool text by characters but stores the full MCP result in `details`.
- The truncated response gives no artifact path from which the full output can be recovered.
- Status/list/search/describe paths use `textResult()` and have no shared output cap.
- The tool ignores its `AbortSignal`; MCP requests continue until their own timeout.

**Impact**

Large details can bloat session JSONL files, list/describe output can exceed Pi’s required tool-output budget, truncated content is lost to the model, and Esc does not promptly cancel an MCP request.

**Recommended direction**

Create one shared bounded-result path using Pi’s line/byte truncation conventions, save full output to a managed artifact when needed, keep `details` bounded, and thread cancellation into JSON-RPC pending requests/transports.

---

### 16. Subagent result/event persistence is effectively unbounded

**Evidence**

- `pi-subagents/src/runner.ts:74-82` limits event count, but adjacent text deltas are merged into one ever-growing string.
- Run persistence stores both `resultText` and recent event payloads in `pi-subagents/src/persistence.ts:65-93`.
- Background completion injection includes the full `resultText` in `pi-subagents/src/manager.ts`’s `completionMessage()`.

**Impact**

A verbose child can produce very large persistence files and inject a huge follow-up into the parent context, bypassing normal tool-output budgets. The same assistant text may be duplicated in `resultText` and events.

**Recommended direction**

Apply explicit byte/line caps at ingestion, persistence, status rendering, tool result, and parent injection boundaries. Store full transcripts only in child session/artifact files and return a bounded summary plus path.

---

### 17. Undo/redo stores every raw prompt indefinitely in one non-atomic JSON file

**Evidence**

- `pi-undo-redo/index.ts:94-121` stores raw prompts in `~/.pi/agent/pip/undo-redo/raw-prompts.json` keyed by session file and entry id.
- `pi-undo-redo/index.ts:384` adds entries after turns.
- There is no pruning when sessions are deleted, no size/age limit, and writes are direct read-modify-write.

**Impact**

The file grows forever, retains prompts after session deletion, duplicates potentially sensitive user text, and is susceptible to lost updates/corruption across multiple Pi processes.

**Recommended direction**

Prefer session-local persisted metadata if possible. Otherwise use per-session files, atomic writes/locking, and cleanup tied to session existence and retention limits.

---

### 18. Tree Edit has untyped operation state and uses a non-atomic destructive save — **partially resolved**

The empty highlight timer scaffold was removed during cleanup.

**Remaining evidence**

- `pi-tree-edit/index.ts` passes operation state through ad-hoc `as any` properties named `__lastFoldedIds` and `__lastVisibleRangeEntries`.
- Tree Edit makes a backup and then overwrites the live session directly with `writeFileSync` instead of the existing atomic session writer in `pip-common`.

**Impact**

Internal state bypasses its type model, and a crash/interruption during save can corrupt the active session file despite the backup.

**Recommended direction**

Put summarize-range data in a typed result/state field and use the shared atomic session-file abstraction for save.

---

### 19. Provider OAuth code has avoidable secret/error and cancellation hazards

**Evidence**

- Token-response validators in `pi-provider-proxy/index.ts` stringify the entire response when required fields are missing; a partial response can therefore place an access or refresh token in an error message.
- The OAuth callback wait is not directly raced against the callback abort signal, so cancellation/error callback paths can leave a listener/server waiting longer than necessary.
- The polling `sleep()` installs an abort listener per iteration without removing it when the timer resolves.

**Impact**

Malformed token responses can leak credentials into logs/UI, cancellation can be sluggish, and long device-code polling can accumulate listeners and trigger warnings.

**Recommended direction**

Redact token-shaped fields in every error, make callback waits abort-aware, and always remove abort listeners on both timer resolution and rejection.

---

## Additional verified findings from the continuation pass

### 20. Every standalone extension package has an unresolved/unbundled `pip-common` dependency — **resolved**

Every feature now imports `pip-common` by package name, declares it in `bundledDependencies`, and loads `node_modules/pip-common/index.ts` before its own entrypoint. Because npm hoists workspace dependencies, `scripts/pack-workspaces.mjs` stages the common package into each feature before packing and cleans the staging directories afterward.

The common settings bootstrap deduplicates by the shared `session_start` context when multiple physical standalone copies load in one runtime. Pip-tool broker states now register shutdown cleanup through their owning feature API rather than relying on the unrelated common API wrapper.

`test/package-tarballs.test.ts` generates every tarball, verifies the bundle and runtime allowlist, installs all 15 features without registry access to `pip-common`, loads each through `DefaultResourceLoader`, and covers multiple standalone features in one runtime.

---

### 21. Subagent child sessions load Tiny MCP, whose global shutdown can close the parent’s MCP servers — **partially resolved**

**Remaining evidence**

- `pi-subagents/src/child-runtime.ts` still uses path exclusions rather than an explicit capability profile, so Tiny MCP and UI-only extensions can load in children.
- Every loaded Tiny MCP child runtime can still auto-connect its own project/user MCP servers on `session_start`, even when the child does not need MCP.
- Headless child sessions can still load `pi-pip-footer`, which starts quota network work and a refresh interval despite having no UI.

**Remaining impact**

A child can create unnecessary MCP processes/HTTP streams and quota traffic. Runtime-local ownership now prevents that child from closing or mutating the parent’s resources, but the child should not start those resources in the first place.

**Resolution status**

Tiny MCP manager pools are now owned by each extension runtime, and Subagents no longer uses a process-global manager. Parent/child isolation tests prove that shutting down either child manager leaves the parent manager and work intact. The remaining half is child capability policy: child sessions still load and auto-connect Tiny MCP and still load UI-only extensions. That is tracked in section 6 of `TODO.md`.

---

### 22. Resuming or steering an existing subagent bypasses concurrency and cancellation lifecycle controls

**Evidence**

- `maxRunning` is enforced only in `SubagentManager.launch()` at `pi-subagents/src/manager.ts:173-180`.
- `continueRun()` and restart-via-`steer()` at `pi-subagents/src/manager.ts:261-337` do not enforce `shuttingDown` or `maxRunning`.
- Only a new launch links the parent tool’s `AbortSignal` at `pi-subagents/src/manager.ts:220-230`; continuation/steering calls receive no parent signal.
- Continuation through an existing `continuePrompt` does not assign a new `run.runPromise` or reset `detachPromise` at `pi-subagents/src/manager.ts:280-287`.
- `waitRun()` at `pi-subagents/index.ts:151-156` trusts those promises and leaves its timeout timer running when another race branch wins.

**Impact**

- Repeated continuation can exceed the configured process-wide maximum.
- Esc/parent abort does not cancel a resumed foreground child.
- Ctrl+Shift+B can report that a resumed child moved to background while the original tool call remains blocked awaiting completion.
- `status(wait:true)` can return immediately against an old resolved launch promise while a continuation is still running.
- Repeated short waits leave live timeout timers behind until expiry.

**Recommended direction**

Use one manager-owned “start run generation” path for launch, continue, and restart-via-steer. It should enforce limits, create a fresh run/detach promise, link and clean up the parent abort signal, and expose a current generation promise. Implement `waitRun()` with a cleared timeout in `finally`.

---

### 23. Restored subagent persistence can drive an uncontained recursive delete — **resolved**

New persistence records no longer store `contextRoot` or `runContextDir`; legacy fields are accepted only for migration and ignored. Restored records validate required fields, statuses, usage, event payloads, parent ownership, and path-safe run IDs. Context paths are always recomputed from the active parent key and managed context root, and deletion derives that same path instead of trusting mutable run state.

Malformed indexes or records are moved to a quarantine file outside the parent persistence directory and are not used for cleanup. Regression tests verify that a persisted arbitrary deletion path survives manual deletion and that a traversal run ID is quarantined without touching its target.

---

### 24. Session stats repeatedly count the same subagent’s cumulative usage

**Evidence**

- `pi-stats/index.ts:131-144` extracts cumulative usage from `details.run`, every item in `details.runs`, and every item in `details.results` for any `subagent` tool result.
- `pi-stats/index.ts:175-186` adds every extracted snapshot directly into the current row with no run-ID deduplication or delta calculation.
- Subagent `status`, `read`, `cancel`, `keep`, `steer`, continuation, and launch results commonly include `details.run` (`pi-subagents/index.ts:239-316`).

**Impact**

Polling or reading the same run twice counts the complete child usage twice. A later cumulative snapshot after continuation counts all earlier usage again and attributes it to whichever parent prompt contained the status call. The session inspector’s totals and per-prompt breakdown become materially wrong, even though global stats record child assistant messages separately.

**Recommended direction**

Track usage by stable run ID and apply only positive deltas between successive cumulative snapshots, or derive subagent usage from child session files once. Add tests covering launch + repeated status/read + continuation.

---

### 25. Tree Edit does not persist the selected current leaf

**Evidence**

- Pi’s `SessionManager` restores the active leaf as the last entry in the JSONL file (`dist/core/session-manager.js:586-595`).
- Tree Edit tracks the desired leaf separately as `draft.targetLeafId`.
- `saveDraft()` writes `[draft.header, ...draft.entries]` in existing array order at `pi-tree-edit/index.ts:423-430`; it does not make `targetLeafId` the final effective record.
- It then calls `navigateTree(targetLeafId)` only in the newly loaded in-memory session at `pi-tree-edit/index.ts:431-437`.

**Impact**

“Set current location” appears to work immediately after save, but after the next process restart/reload the session opens at whatever record happened to be last in the file, not the selected target. This is especially visible when selecting another branch without creating a new final entry.

**Recommended direction**

Before the atomic save, reorder the target leaf record to be the effective final record using the same session-file invariant already handled by Undo/Redo’s `makeEffectiveLeafLast()`. Add an integration test that saves, reopens with `SessionManager.open()`, and asserts `getLeafId()`.

Tree Edit also creates unmanaged second-resolution `.bak-*` files beside sessions forever (`pi-tree-edit/index.ts:427-430`). Reuse `pip-common`’s collision-safe managed backup retention and atomic session writer.

---

### 26. Footer quota selection/cache can show the wrong account or provider

**Evidence**

- `pip-common/src/quota/index.ts:16-22` maps plain provider IDs `openai`, `openai-completions`, and broad `github` matches to Codex/Copilot subscription quota.
- `pip-common/src/quota/auth.ts:35-47` can then use a Codex subscription credential—or even `OPENAI_API_KEY`—for the ChatGPT `/wham/usage` endpoint.
- The global quota cache is keyed only by provider at `pi-pip-footer/src/quota.ts:4`, not account, base URL, or credential identity.
- `refreshUsageForModel()` at `pi-pip-footer/index.ts:113-131` leaves the previous provider’s `latestUsage` in place when switching to an uncached provider and silently ignores rejected fetches.
- The only race guard is provider ID, so two same-provider requests for different model base URLs/accounts can overwrite one another.
- Footer-disabled/headless sessions still call refresh and start the interval at `pi-pip-footer/index.ts:156-158`.

**Impact**

A standard OpenAI API model can display unrelated Codex subscription quota, model/account switches can temporarily or permanently show stale quota, and child/headless sessions perform unnecessary credential lookup/network work. Cached quota can bleed between accounts in one process.

**Recommended direction**

Detect subscription quota from the actual auth/provider capability, not broad provider-name substrings. Key cache/request generations by provider + account/base URL identity, clear display state immediately on identity changes, and do no footer work when the footer has no UI/has been disabled.

---

### 27. Todo’s compact viewport drops the “hidden above” count — **resolved**

**Evidence**

- `chooseVisibleTodos()` computes both `hiddenAbove` and `hiddenBelow` at `pi-todo/index.ts:115-145`.
- `renderCompactTodos()` destructures both at `pi-todo/index.ts:158`, but constructs overflow text only from `hiddenBelow` at `:161-164`.
- `hiddenAbove` is one of the strict unused-code diagnostics.

**Impact**

When the active/pending window starts in the middle or near the end of a long todo list, earlier hidden todos are not indicated. If nothing is hidden below, the widget can even reserve an item slot and pad it blank while giving no indication that items exist above.

**Resolution**

`renderCompactTodos()` now reports both `hiddenAbove` and `hiddenBelow`, with a regression test for an active item near the end of the list. Todo's incomplete `enabled` behavior remains tracked under finding 14.

---

### 28. Question and Todo inspectors lack a real scrolling viewport for model-sized lists

**Evidence**

- Question schemas impose no maximum question/option count at `pi-question/src/schema.ts:3-21`.
- `QuestionComponent.render()` renders every option and only truncates the tab strip at `pi-question/src/ui.ts:105-145`; selection can move to options/tabs that are no longer visible.
- `TodoInspector.render()` emits every todo at `pi-todo/index.ts:276-287` despite using an overlay capped at 80% terminal height.

**Impact**

A large but schema-valid model tool call or todo list creates an unusable dialog: the selected row can move below the visible overlay, later question tabs disappear from the truncated strip, and there is no scroll indicator or offset tracking.

**Recommended direction**

Use the shared overlay row-budget/selection-offset abstraction, render a bounded slice around selection, and show position/hidden counts. Add defensible schema count/text limits as a resource bound, not as the only UI fix. Wrap explanatory hints instead of relying on `boxLines()`’s safety truncation.

---

### 29. Websearch buffers unbounded provider responses and may suppress automatic fallback

**Evidence**

- `pi-webfetch-websearch/src/mcp.ts:39-62` reads the entire provider response with `response.text()` and has no byte limit.
- `contextMaxCharacters` is only sent as a provider argument; it is not a client-side download bound.
- `parseMcpResponse()` returns `undefined` for JSON-RPC errors, malformed payloads, or content without a text block.
- `executeWebSearch()` at `pi-webfetch-websearch/src/websearch.ts:137-148` treats that as a successful provider response containing “No search results” and does not try the next provider.
- `signalWithTimeout()` at `pi-webfetch-websearch/src/limits.ts:24-32` leaves parent abort listeners attached after successful requests until/unless the parent later aborts.

**Impact**

A faulty or hostile public endpoint can force a very large response into memory despite the tool’s bounded-output promise. In auto mode, a malformed/JSON-RPC-error response from Parallel can prevent the advertised Exa fallback. Repeated requests sharing a long-lived parent signal can accumulate abort listeners.

**Recommended direction**

Stream and cap response bytes before parsing, treat JSON-RPC errors/invalid payloads as provider failures eligible for fallback, and use a disposable combined-signal helper that removes listeners when each fetch settles.

---

### 30. Provider Proxy does not fully reconcile or tear down dynamic provider overrides

**Evidence**

- The extension tracks applied providers in `pi-provider-proxy/index.ts:858-889` and already has `unapply()`.
- `session_shutdown` merely clears `appliedProviders` at `pi-provider-proxy/index.ts:1057-1059`; it does not call `pi.unregisterProvider()`.
- `/proxy` reloads the config file at the start of each command (`:912-925`), but status/on do not unregister providers removed by an external edit before applying the new set.
- Config writes at `pi-provider-proxy/index.ts:203-208` are direct/non-atomic.

**Impact**

On reload/removal/load failure, stale dynamic provider overrides can survive in Pi’s model registry, especially if the new extension version no longer registers the same provider. A manually edited config can report one state while the runtime continues using old routes. This is particularly risky for auth/API relay URLs.

**Recommended direction**

Reconcile desired versus applied provider IDs on every load and call `unapply()` during shutdown. Make config writes atomic. Add a lifecycle test for register → shutdown/reload with the provider removed.

---

### 31. Live Copilot pricing fallback has no timeout and permanently caches transient failure

**Evidence**

- `pip-common/src/temporary-live-models-dev-pricing.ts:35-42` performs a global `fetch("https://models.dev/api.json")` with no timeout.
- The resulting promise, including `undefined` after any error/non-OK response, is cached for the process lifetime.
- Both Stats and Footer await this helper in `message_end` handlers.

**Impact**

A hanging network request can stall message-end handling, while one transient outage disables the fallback for the rest of the process. Every subagent child also loads the stats/footer extensions, increasing the number of event paths depending on this shared promise.

**Recommended direction**

Use a short timeout, cache successful data with an expiry, and allow bounded retry after failure. Prefer removing this workaround once Pi’s bundled model data is updated, as the file comment already requests.

---

### 32. Numeric settings declare bounds that the registry never enforces — **resolved**

The central validator now enforces finite numeric values plus declared `min`/`max` bounds for loaded and programmatic values. Section registration rejects invalid defaults before mutating registry definitions. Regression tests cover invalid persisted values, rejected out-of-range writes, accepted boundaries, and invalid defaults.

---

## Verified stale/dead-code and documentation drift

Resolved during cleanup:

- Replaced stale `pi-quiet-tools` documentation with `pi-tool-ui` and restored Tool UI to the top-level extension list.
- Removed Footer's nonexistent `session_end` registration.
- Removed Tool UI's unused `preset` setting.
- Corrected Tool UI's built-in adapter documentation.
- Removed Tiny MCP's unused top-level config `settings` merge.
- Removed Tree Edit's empty highlight scaffold.
- Resolved all strict unused-code diagnostics and enabled `noUnusedLocals` plus `noUnusedParameters` in `tsconfig.json`.
- Corrected the top-level local-development path example.

Remaining documentation gaps:

- `pi-context`, `pi-secrets-guard`, and `pi-stats` have no package README, while the other feature packages do.

---

## Collection-level continuation — 2026-07-14

After removing `pi-plan-mode`, the repository contains 15 `pi-*` extensions plus `pip-common`, with 117 production TypeScript files and 15,418 production lines. The largest concentration is `pip-common` (2,198 lines), `pi-subagents` (2,197), `pi-tree-edit` (1,673), `pi-tiny-mcp` (1,472), `pi-webfetch-websearch` (1,162), `pi-stats` (1,121), `pi-provider-proxy` (1,062), and `pi-pip-footer` (1,043). Those eight areas account for about 77% of production TypeScript, so cleanup should focus on their ownership boundaries rather than merging small folders merely to reduce the plugin count.

### 33. Provider Model Patches and Provider Proxy cannot safely compose ownership of one provider

**Evidence**

- The top-level manifest loads `pi-provider-model-patches` immediately before `pi-provider-proxy` at `package.json:17-18`.
- Model Patches registers complete provider catalogs at `pi-provider-model-patches/index.ts:230-247` and unregisters providers while reconciling at `:269-315`.
- Provider Proxy independently registers the same provider IDs at `pi-provider-proxy/index.ts:878-892` and unregisters them during reapplication at `:869-887`.
- Pi's provider API restores the built-in provider when `unregisterProvider()` is called; it does not expose a composable stack of independent extension overrides.
- Model Patches repeats Provider Proxy's teardown bug from finding 30: its `session_shutdown` handler only clears `appliedIds` at `pi-provider-model-patches/index.ts:389-391` and does not unregister providers it owns.
- `pi-provider-model-patches/README.md` already acknowledges that another extension overriding the same provider may conflict, but both extensions are enabled in the aggregate manifest with no coordination or exclusion.

**Impact**

Load order becomes part of the runtime contract. A proxy reapply can replace a patched catalog, while toggling a model patch can unregister the proxy override and restore the built-in endpoint. Status from either extension can say it is active while the other extension owns the effective provider registration. Reload/shutdown can also leave a model-patch registration live after its owning bookkeeping has been discarded.

**Recommended direction**

Give provider registration one owner. The clean aggregate design is a provider-override coordinator that composes endpoint/auth changes and catalog changes into one registration per provider. If that is not implemented, enforce mutual exclusion per provider and report the conflict instead of silently applying both.

---

### 34. The aggregate package has no composition root, so manifest order and module-global state act as an undocumented runtime API — **substantially resolved**

**Remaining evidence**

- `package.json` intentionally loads separate, filterable factories rather than one root factory.
- Cross-cutting Tool UI decoration and settings discovery still coordinate through `pip-common`, although those services are now runtime-keyed and load-order safe.
- Child extension selection is still implemented separately in Subagents through path filtering rather than a declared capability profile.

**Remaining impact**

The aggregate and standalone packaging contracts are now compatible with runtime isolation, but child startup policy remains implicit. A future extension can still be accidentally loaded into children until section 6 introduces an explicit profile.

**Resolution status**

Separate aggregate/standalone entrypoints remain intentional. Settings definitions now register inside factories, and settings, tool finalizers/registrations, footer providers, bootstrap lifecycle, Tiny MCP managers, and Subagent managers are scoped by Pi runtime rather than process lifetime. Multiple physical `pip-common` copies coordinate only through an event-bus-keyed runtime service.

An explicit child-runtime capability profile is still missing, so extension selection in children remains load-order/path-policy driven. That remaining issue is tracked in section 6 of `TODO.md`; it no longer causes cross-runtime manager shutdown.

---

### 35. `pip-common` exposes speculative registries with no production consumers — **resolved**

**Evidence**

- Repository-wide production-use search found no plugin consumer for `createCapabilityRegistry()` in `pip-common/src/capabilities.ts`.
- The same is true for `createPromptRegistry()` in `pip-common/src/prompt-registry.ts` and `createStatusBroker()` in `pip-common/src/status.ts`.
- These modules are still re-exported as public common-package API at `pip-common/index.ts:9,17,26` and have unit coverage, which makes them appear supported despite not owning current behavior.
- The footer registry is consumed for rendering, but no production plugin registers a footer contribution through most of its public producer API; the main footer still owns the effective composition.

**Impact**

`pip-common` is becoming a kitchen-sink framework in anticipation of abstractions the extensions do not actually use. This increases the apparent API surface and makes it harder to tell which shared mechanisms are authoritative—the exact ambiguity visible in settings, prompt injection, statuses, and footer ownership.

**Resolution**

The capability, prompt, and status registries, their exports, and their self-only tests were deleted. The footer registry remains because the footer consumes it as a supported optional extension point. Domain-specific common code remains subject to the same current-consumer test.

---

### 36. Standalone package tarballs include test sources as runtime files — **resolved**

Every feature manifest now has an explicit runtime file allowlist. Footer and Stats no longer ship test sources, Tree Edit includes all required implementation files, and the isolated tarball test rejects any packed `*.test.ts` file.

---

## Suggested cleanup order

1. **Trust/security boundary:** Tiny MCP project config, project subagent definitions, Secrets Guard canonicalization/recursive containment, restored-path deletion validation.
2. **Removable feature boundaries:** enforce no sibling production imports, smoke-test each feature with only Pi plus `pip-common`, and verify optional integrations with either side absent.
3. **Child/runtime ownership:** make shared services runtime-scoped, define a child-extension profile, prevent child Tiny MCP/footer resources from affecting the parent, and unify subagent launch/continue lifecycle.
4. **Provider ownership:** compose model-catalog and proxy contributions through one provider-registration owner; reconcile and unregister owned providers during shutdown.
5. **Runtime contracts:** throw tool errors, preserve built-in prompt metadata, honor cancellation, and bound all outputs/details/downloads.
6. **Resource lifecycle:** close only owned Tiny MCP managers on config reload/shutdown; fix OAuth and web abort-listener cleanup; make enabled settings actually stop resources.
7. **Persistence safety:** atomic settings/session/raw-prompt writes, unknown/malformed-config preservation, bounded subagent/raw-prompt storage, and persistent Tree Edit leaf selection.
8. **Correctness/UI:** subagent usage deduplication, quota identity/cache correctness, compacted-context accounting, Tool UI error rendering, live settings propagation, and list scrolling.
9. **Mechanical simplification:** remove dead registries, dead `session_end`, empty helpers, unused imports/settings, `as any` scratch state, stale docs, and unintended package files.

## Current assessment

The repository has strong breadth of tests and several thoughtful shared abstractions, but it currently behaves as a coupled application presented as independent plugins. The most important gaps sit outside tested happy paths: trust boundaries, product/package ownership, parent/child runtime state, provider override composition, lifecycle cleanup, persistence invariants, and exact Pi tool error/output contracts. Establishing one explicit runtime and distribution boundary will make the security and correctness fixes substantially simpler; cosmetic folder consolidation will not.
