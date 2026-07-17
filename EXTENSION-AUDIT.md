# Extension Audit — Final Findings

Date: 2026-07-09; remediation completed 2026-07-14

This records the repository audit and its completed remediation pass. Every numbered finding below is resolved by removal, implementation, or an explicitly documented architectural constraint.

## Cleanup progress — 2026-07-14

- Findings 1–2 were resolved by removing `pi-plan-mode` and its shared read-only machinery.
- Finding 26 was resolved with OAuth-capability quota detection, account/base-URL cache identities, request generations, and disabled/headless lifecycle gating.
- Findings 27–28 were resolved with correct Todo overflow counts plus terminal-bounded, selection-following Question and Todo viewports and bounded Question schemas.
- Finding 35 was resolved by deleting the unused capability, prompt, and status registries; the consumed footer registry remains supported.
- Findings 6, 20, and 36 were resolved by producing self-contained standalone packages with bundled `pip-common`, explicit runtime allowlists, and isolated Pi-loader tests.
- Removable feature boundaries are now enforced: production sibling imports and reverse `pip-common` dependencies fail tests, while each standalone feature loads with only Pi and its bundled common runtime.
- Findings 3–4 were resolved by threading `ctx.isProjectTrusted()` into Tiny MCP config/manager creation and Subagent agent discovery.
- Finding 5 was resolved with canonical path checks, nearest-existing-parent resolution for writes, and preflight blocking for search/list roots containing guarded descendants.
- Finding 23 was resolved by removing derived context paths from persistence, validating restored records, quarantining malformed indexes, and deriving recursive deletion targets from managed roots.
- Finding 9's corruption/data-loss paths and finding 32 were resolved with strict loads, unknown-section preservation, transactional atomic commits, batched UI saves, and central bound/default validation.
- Finding 17 was resolved by replacing the global raw-prompt cache with bounded, session-owned metadata that follows undo/redo and session retention.
- Finding 14 was resolved with batched settings notifications, live consumers, and declarative reload warnings.
- Findings 21 and 34 were resolved by keying common services to Pi's shared event bus, giving Tiny MCP/Subagents runtime-local managers, and applying an explicit child extension capability profile.
- The stale Tool UI/Tiny MCP/Tree Edit/Footer scaffolding listed below was removed.
- All strict unused-code diagnostics were resolved, and `noUnusedLocals` plus `noUnusedParameters` are now part of the normal typecheck.

## Validation completed

- `npm test`: **42 files, 409 tests passed**.
- `npm run typecheck`: **passed**, including `noUnusedLocals` and `noUnusedParameters`.
- Aggregate package test loads all source entrypoints from a clean checkout without workspace links.
- Standalone tarball tests generate, install, inspect, and load every feature through Pi package rules; test sources are rejected from runtime tarballs.
- Static boundaries reject sibling production imports and reverse `pip-common` dependencies, and package-filtering tests verify independent aggregate resources.
- Focused regression suites cover trust, symlink/path containment, runtime ownership, child capabilities, provider composition, cancellation, output bounds, persistence, network SSRF/streaming limits, and UI viewport behavior.
- Pi extension, TUI, session, compaction, model/auth, package, and keybinding contracts were checked against the installed documentation, declarations, and runtime source.

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

### 7. Tiny MCP manager reset leaks live subprocesses and HTTP connections — **resolved**

`TinyMcpRuntime.reset()` now awaits `shutdown()`, which closes every owned manager before clearing the runtime-local map. Config editing awaits reset before later manager recreation; disable and session shutdown use the same close path. Parent and child runtimes have separate manager ownership, and lifecycle tests verify one runtime cannot close the other's connections.

---

### 8. Custom tool failures are often reported as successful tool executions — **resolved**

Tiny MCP now throws validation, transport, JSON-RPC, timeout, disabled-state, unknown-tool, and MCP `isError` failures. Subagent now throws disabled-state, argument/model validation, missing-run, failed foreground launch/continue, and parent-cancellation failures instead of returning an ignored `isError` field. Successful status inspection of an already-failed retained run remains a normal domain query. Regression tests assert rejected execution promises for framework failures.

---

### 9. Shared settings registration can silently destroy or discard persisted settings — **resolved**

Settings loads now distinguish missing files from malformed JSON/shape errors. A malformed file remains untouched, writes are refused, and `/pip-settings` reports the exact failure. Stored sections and keys are retained independently of loaded definitions, so unloaded features survive later saves.

Registration validates defaults and normalizes in-memory values without persisting. Intentional changes are validated into a cloned snapshot, written through temp-file plus rename, and only then committed in memory. `/pip-settings` applies its draft through one transactional write instead of one rewrite per row.

Concurrent independent Pi processes still have documented last-writer-wins semantics because settings do not implement a cross-process merge protocol. Atomic replacement prevents partial-file corruption; this concurrency constraint does not reintroduce the original registration-time overwrite, malformed-file destruction, or unloaded-section loss.

---

### 10. Webfetch’s private-host block is not a complete SSRF boundary, and its byte cap is post-buffer — **resolved**

Webfetch now uses a dependency-free HTTP(S) transport that validates every redirect, resolves each hostname once, rejects mixed/private/local IPv4 and IPv6 answers (including IPv4-mapped IPv6), and pins the approved address into the actual connection lookup to prevent a second DNS resolution. URL credentials and non-HTTP redirect targets are rejected. Response bodies share a streaming byte-cap reader that cancels as soon as the configured limit is crossed, including chunked bodies without `Content-Length`. Regression tests cover address classification, mixed DNS answers, redirect handling, and early chunked-response cancellation.

---

### 11. Tool UI overrides five built-ins without preserving their prompt metadata — **resolved**

Tool UI now builds from Pi's public `create*ToolDefinition()` factories rather than the stripped core `AgentTool` wrappers. Each override spreads the complete built-in definition before replacing execution/rendering, preserving prompt snippets, guidelines, argument preparation, execution mode, and future definition metadata. Tests verify prompt snippets for all five overridden tools and Read/Edit guidelines.

---

### 12. Tool UI can hide real errors in collapsed output — **resolved**

Built-in and Pip display adapters now treat renderer `context.isError` as authoritative instead of guessing from text prefixes. Every collapsed failure renders a first-line fallback bounded to 200 columns, including empty, `ENOENT`, and `Path not found` errors; error-looking successful text remains quiet. Edit errors suppress stale success diffs. Regression tests cover each case.

---

## Important correctness and cleanup findings

### 13. `/context` measures the whole branch instead of the effective compacted context — **resolved**

The conversation estimate now uses Pi's `buildSessionContext()` path (preferring the runtime manager method and using the public pure function as fallback), so discarded pre-compaction history is replaced by the effective compaction summary and retained messages. The allocation labels `model.maxTokens` as “Max output cap” and explicitly says Pi's separate compaction reserve is not exposed to extensions. Tests cover compacted and uncompacted session paths.

---

### 14. Settings changes have no lifecycle notification, so several toggles do not apply live — **resolved**

The settings registry emits one filtered, subscribable change batch after each successful transaction. Todo subscribes to refresh or remove its widget immediately, and its tools/command reject calls while disabled. Subagent commands and shortcuts now honor `enabled`. Tiny MCP no longer auto-connects while disabled and does not register its tool after a disabled reload.

Settings whose registrations/resources cannot safely change in place carry declarative `requiresReload` metadata. `/pip-settings` names those settings in a warning after saving; this covers footer installation, Tiny MCP process/name configuration, Tool UI registration-time adapters, and provider catalog patches. Other settings are read at action/render time and apply to subsequent work without reload.

---

### 15. Tiny MCP output handling is bounded only partially — **resolved**

Call, list, search, describe, connect, add, disconnect, and status now share one bounded-result path. `details` contains only bounded metadata (`action`, character count, truncation flag, and optional artifact path), while oversized full text is written under the managed Tiny MCP artifact root and linked from the result.

Execution and MCP `isError` failures are thrown so Pi marks tool errors at the framework level. `AbortSignal` now flows through the tool, manager, MCP client, JSON-RPC pending request, and HTTP POST/legacy transport; abort removes pending timers/listeners, sends cancellation notification where possible, and aborts fetch work. Live disable closes owned managers and blocks subsequent tool/command work.

---

### 16. Subagent result/event persistence is effectively unbounded — **resolved**

Subagent text now has shared character, line, event-count, status, and completion bounds applied at ingestion and again at snapshot/persistence boundaries. Completed snapshots omit duplicated text-delta events when bounded `resultText` exists. Persistence version 4 stores bounded prompts, results, errors, and operational events.

The child session file remains the authoritative full transcript. Truncated tool/status/completion output names that transcript path. Regression coverage feeds oversized custom-runner output through in-memory state, snapshots, persistence, status rendering, and parent completion injection.

---

### 17. Undo/redo stores every raw prompt indefinitely in one non-atomic JSON file — **resolved**

Undo/Redo no longer uses a process-shared raw-prompt JSON map. Unchanged prompts use the authoritative session message directly; only transformed raw input is persisted as a Pi custom entry in the owning session, capped at 64 KiB. The metadata is part of the same branch tail, so undo/redo removes and restores it atomically with the associated prompt and session deletion removes it naturally. Oversized/untrusted metadata is ignored, and the obsolete global cache is removed on session startup.

Regression tests cover session-owned recall, selective/bounded persistence, tail undo/redo, and legacy-cache cleanup.

---

### 18. Tree Edit has untyped operation state and uses a non-atomic destructive save — **resolved**

Tree Edit now carries summarize-range data in its typed UI result and has no production `as any` scratch properties. Save validates the draft, creates a collision-safe managed backup with retention, and replaces the session through the shared atomic writer. That writer now preserves file mode, uses random temporary names, and removes temporary files after both success and failure. Regression coverage verifies failed replacement leaves the original target intact.

---

### 19. Provider OAuth code has avoidable secret/error and cancellation hazards — **resolved**

OAuth HTTP and validation errors now omit response bodies and values rather than serializing token responses, and displayed endpoints exclude credentials and query strings. Browser callback waits cancel directly from the login signal and remove their abort listeners when settled. Device polling sleep removes its listener on both timer completion and abort. Regression tests cover malformed/HTTP response redaction and callback cancellation.

---

## Additional verified findings from the continuation pass

### 20. Every standalone extension package has an unresolved/unbundled `pip-common` dependency — **resolved**

Feature source imports resolve directly to the repository's `pip-common`, so aggregate loading does not depend on npm workspace links. Each feature still declares `pip-common` in `bundledDependencies` and loads `node_modules/pip-common/index.ts` before its own entrypoint. `scripts/pack-workspaces.mjs` builds isolated package staging trees, rewrites only the staged shared imports to the package name, and bundles the common runtime without mutating the source checkout.

The common settings bootstrap deduplicates by the shared `session_start` context when multiple physical standalone copies load in one runtime. Pip-tool broker states now register shutdown cleanup through their owning feature API rather than relying on the unrelated common API wrapper.

`test/package-tarballs.test.ts` generates every tarball, verifies the bundle and runtime allowlist, installs all 15 features without registry access to `pip-common`, loads each through `DefaultResourceLoader`, and covers multiple standalone features in one runtime.

---

### 21. Subagent child sessions load Tiny MCP, whose global shutdown can close the parent’s MCP servers — **resolved**

Child extension selection now uses an explicit capability profile and exact feature IDs. Guards are retained; requested headless/custom tool extensions can be retained; UI, parent-state, telemetry, provider, nested-agent, and external-resource extensions are excluded. Tiny MCP and Footer handlers therefore never enter the child session lifecycle.

Tiny MCP and Subagent managers are also runtime-owned. Isolation tests cover child shutdown while parent MCP connections and Subagent work remain active.

---

### 22. Resuming or steering an existing subagent bypasses concurrency and cancellation lifecycle controls — **resolved**

`SubagentManager.startGeneration()` now owns launch, continuation, and restart-via-steer lifecycle. Every generation enforces shutdown/concurrency limits, creates fresh run and detach promises, installs and removes foreground parent cancellation, and performs one completion/cleanup path. `RealRunner` owns only child-session execution rather than duplicating manager status transitions.

`waitRun()` clears its timeout in `finally`. Regression tests cover continuation and steer limits, post-shutdown rejection, resumed parent abort, promise refresh, timeout cleanup, and parent/child manager isolation.

---

### 23. Restored subagent persistence can drive an uncontained recursive delete — **resolved**

New persistence records no longer store `contextRoot` or `runContextDir`; legacy fields are accepted only for migration and ignored. Restored records validate required fields, statuses, usage, event payloads, parent ownership, and path-safe run IDs. Context paths are always recomputed from the active parent key and managed context root, and deletion derives that same path instead of trusting mutable run state.

Malformed indexes or records are moved to a quarantine file outside the parent persistence directory and are not used for cleanup. Regression tests verify that a persisted arbitrary deletion path survives manual deletion and that a traversal run ID is quarantined without touching its target.

---

### 24. Session stats repeatedly count the same subagent’s cumulative usage — **resolved**

Session Stats now tracks cumulative Subagent usage by stable run ID, applies only positive deltas against a per-branch high-water mark, and ignores repeated status/read snapshots with no new usage. A regression test covers duplicate launch snapshots, continuation growth, duplicate continuation snapshots, per-row attribution, and cumulative totals.

---

### 25. Tree Edit does not persist the selected current leaf — **resolved**

The effective-final-record invariant now belongs to `pip-common` and is shared by Tree Edit and Undo/Redo. Tree Edit updates known header leaf fields, moves the selected target record to the effective final position before atomic save, and keeps immediate in-memory navigation. An integration test saves a non-final branch target, reopens the file with Pi's real `SessionManager.open()`, and verifies `getLeafId()`. Backups live under the managed Tree Edit backup root rather than accumulating beside session files.

---

### 26. Footer quota selection/cache can show the wrong account or provider — **resolved**

Auto detection now requires Pi's authoritative `modelRegistry.isUsingOAuth(model)` capability and an exact supported provider ID (`openai-codex`, `anthropic`, or `github-copilot`). Standard OpenAI/Anthropic API keys are no longer accepted for subscription usage endpoints. Footer resolves the active model's effective OAuth token/account through Pi and passes it directly to the adapter.

Quota cache keys are SHA-256 identities over quota provider, credential/account, and effective base URL; raw secrets never appear in keys. The cache is runtime-local and bounded to 25 identities. Model selection immediately clears displayed quota, while request generations and full identity checks reject stale same-provider responses. Disabled/headless sessions skip footer, token, pricing, quota, and timer work entirely; quota `off` also starts no refresh timer.

Regression tests cover API-key exclusion, hashed identity separation, endpoint/account/model switches, stale response ordering, active proxy base URLs, and disabled/headless sessions.

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

### 28. Question and Todo inspectors lack a real scrolling viewport for model-sized lists — **resolved**

Question and Todo now derive bounded body heights from the shared terminal-aware overlay row budget and use shared selection/scroll windows. Their viewports follow selection, show position and hidden-row/item counts, and wrap explanatory hints. Question additionally keeps the active late tab visible, aligns wrapped option windows to label boundaries, and supports review scrolling; Todo supports line, page, Home, and End navigation.

Question input is independently resource-bounded to 8 questions, 12 options per question, 500-character question/description prose, and 120-character labels. Runtime validation mirrors the TypeBox schema. Regression tests exercise late tabs, long wrapped option lists, terminal-height bounds, Todo selection near the end, and each schema count/text ceiling.

---

### 29. Websearch buffers unbounded provider responses and may suppress automatic fallback — **resolved**

MCP responses now use the shared streaming byte-cap reader with a client-side limit derived from the requested context and capped at 1 MB. Malformed JSON, JSON-RPC errors, missing content, and missing text are provider failures, so automatic mode continues to the next provider. Timeout signals are explicitly disposed in `finally`, clearing timers and removing parent abort listeners after both success and failure. Tests cover oversized chunked responses, all invalid-response fallback cases, and signal cleanup.

---

### 30. Provider Proxy does not fully reconcile or tear down dynamic provider overrides — **resolved**

Provider Proxy now derives the complete desired provider set from each changed config load, removes no-longer-desired contributions, and reapplies changed routes. Shutdown disposes all of its coordinator contributions, restoring either the remaining catalog contribution or Pi's built-in provider. Config writes use a same-directory private temporary file and atomic rename.

---

### 31. Live Copilot pricing fallback has no timeout and permanently caches transient failure — **resolved**

The temporary live `models.dev` fetch and its cache were removed after verifying Pi's bundled GitHub Copilot catalog now carries nonzero pricing for all 22 current models. Footer cost display and Stats aggregation now rely on Pi's authoritative model metadata and perform no independent pricing network request.

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

- `pi-secrets-guard` and `pi-stats` have no package README, while the other feature packages do.

---

## Collection-level continuation — 2026-07-14

After removing `pi-plan-mode`, the repository contains 15 `pi-*` extensions plus `pip-common`, with 117 production TypeScript files and 15,418 production lines. The largest concentration is `pip-common` (2,198 lines), `pi-subagents` (2,197), `pi-tree-edit` (1,673), `pi-tiny-mcp` (1,472), `pi-webfetch-websearch` (1,162), `pi-stats` (1,121), `pi-provider-proxy` (1,062), and `pi-pip-footer` (1,043). Those eight areas account for about 77% of production TypeScript, so cleanup should focus on their ownership boundaries rather than merging small folders merely to reduce the plugin count.

### 33. Provider Model Patches and Provider Proxy cannot safely compose ownership of one provider — **resolved**

`pip-common` now owns one runtime-scoped provider coordinator. Model Patches contributes the `catalog` slot and Provider Proxy contributes the `transport` slot; the coordinator emits one composed Pi registration and applies proxy endpoints to every patched model. Duplicate owners for either slot fail explicitly instead of silently replacing each other. Removing either contribution reconciles the remaining registration, while last-owner shutdown unregisters the override and drops the stale registrar before reload. Tests cover composition, duplicate ownership, parent/child isolation, and registrar replacement across reload.

---

### 34. The aggregate package has no composition root, so manifest order and module-global state act as an undocumented runtime API — **resolved by explicit runtime contracts**

Separate aggregate/standalone entrypoints remain intentional because Pi package filtering depends on them. Cross-cutting settings, tool finalization, footer providers, provider overrides, lifecycle state, Tiny MCP managers, and Subagent managers are keyed by Pi's shared event bus rather than extension object or process identity. Multiple physical `pip-common` copies coordinate through that runtime key, and registration is load-order safe.

Subagent child startup now applies the declarative `CHILD_EXTENSION_CAPABILITIES` profile: guards and requested headless tools are eligible, while UI, parent-state, provider, external-resource, nested-agent, telemetry, and parent-prompt capabilities are excluded. Tests verify the explicit profile and parent/child resource isolation.

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

## Final assessment

The repository now has an explicit aggregate-plus-standalone distribution contract, removable feature boundaries, runtime-scoped shared services, a declarative child capability profile, coordinated provider ownership, transactional persistence, bounded network/tool output, and regression coverage for the audited trust and lifecycle boundaries. Remaining constraints—such as cross-process settings last-writer-wins semantics—are documented tradeoffs rather than unresolved findings.
