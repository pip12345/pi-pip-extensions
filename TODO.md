# Cleanup TODO

## Product model

- [ ] Treat this repository as one aggregate Pi package with multiple extension entrypoints.
- [ ] Keep every `pi-*` feature independently installable as a standalone package.
- [ ] Keep `pip-common` as the required shared runtime.
- [ ] Keep production features independent: a feature may depend on Pi and `pip-common`, but not on sibling features.
- [ ] Make feature removal local: deleting a feature should require only deleting its folder, aggregate manifest entry, feature-specific tests, and documentation.
- [ ] Preserve Pi package filtering by retaining separate extension entrypoints; do not hide every feature behind one root extension.

## 1. Dead-code and compiler-signal cleanup

- [x] Delete the unused `pip-common` capability registry.
- [x] Delete the unused `pip-common` prompt registry.
- [x] Delete the unused `pip-common` status broker.
- [x] Keep the footer registry as a supported extension point.
- [x] Remove the unused Tool UI `preset` setting.
- [x] Remove Tiny MCP's parsed-but-unused top-level config `settings` object.
- [x] Remove Tree Edit's empty highlight timer scaffold without removing Tree Edit behavior.
- [x] Remove Footer's nonexistent `session_end` handler.
- [x] Remove stale `pi-quiet-tools` documentation and replace it with current `pi-tool-ui` references where appropriate.
- [x] Review every strict unused-code diagnostic; delete genuinely dead code and fix diagnostics that reveal behavior bugs.
- [x] Fix Todo's unused `hiddenAbove` value by rendering both overflow directions.
- [x] Enable `noUnusedLocals` and `noUnusedParameters` after the diagnostic count reaches zero.
- [x] Run the full test suite and typecheck.

## 2. Make standalone packages real

- [ ] Define `pip-common` as the shared runtime package with a stable package identity.
- [ ] Bundle `pip-common` into every standalone feature package according to Pi package rules.
- [ ] Ensure a standalone feature loads the required `pip-common` extension bootstrap.
- [ ] Replace source-relative `pip-common` imports with package imports that resolve in both workspace development and installed packages.
- [ ] Make the shared bootstrap idempotent so aggregate and standalone loading cannot double-register commands or lifecycle handlers.
- [ ] Correct every feature package's `files` allowlist.
- [ ] Include all Tree Edit runtime source files in its tarball.
- [ ] Exclude test sources and fixtures from Footer and Stats tarballs.
- [ ] Generate every standalone tarball in tests.
- [ ] Install every generated tarball in an isolated temporary directory.
- [ ] Load every isolated package through Pi's package rules and verify its entrypoints.
- [ ] Keep the aggregate Git package as the recommended installation path.

## 3. Enforce removable feature boundaries

- [ ] Add a static test that rejects production imports between sibling `pi-*` features.
- [ ] Add a static test that rejects imports from `pip-common` into feature folders.
- [ ] Add a smoke test that loads each feature with only Pi and `pip-common` available.
- [ ] Test optional integrations with either side absent.
- [ ] Verify custom tools still register when `pi-tool-ui` is absent.
- [ ] Verify Tool UI still loads when Todo, Tiny MCP, Question, or Subagents is absent.
- [ ] Verify Stats still loads when Subagents is absent.
- [ ] Keep aggregate manifest entries literal and test that each referenced entrypoint exists.
- [ ] Verify aggregate package filtering exposes each feature as a separate Pi resource.

## 4. Repair trust and filesystem boundaries

- [ ] Prevent Tiny MCP from loading or auto-connecting project configuration when the project is untrusted.
- [ ] Prevent Subagents from loading project agent definitions when the project is untrusted.
- [ ] Canonicalize existing Secrets Guard targets through `realpath`.
- [ ] Canonicalize the nearest existing parent for write targets.
- [ ] Prevent recursive grep/find/ls operations from traversing or returning guarded descendants.
- [ ] Recompute or validate restored subagent context paths before recursive deletion.
- [ ] Quarantine malformed persisted subagent records instead of performing cleanup from untrusted fields.
- [ ] Add trusted/untrusted, symlink, recursive traversal, and path-containment regression tests.

## 5. Repair shared settings and runtime ownership

- [ ] Preserve malformed settings files and report parse errors instead of replacing them with defaults.
- [ ] Preserve settings sections belonging to unloaded, disabled, removed, or not-yet-loaded features.
- [ ] Stop writing settings merely because a section registered.
- [ ] Use atomic temporary-file plus rename writes.
- [ ] Batch `/pip-settings` changes into one commit.
- [ ] Enforce numeric `min` and `max` bounds in the central validator.
- [ ] Validate defaults when settings sections register.
- [ ] Add shared setting-change notifications.
- [ ] Make each extension apply live setting changes or explicitly report that reload is required.
- [ ] Scope shared tool, settings, footer, and lifecycle state by Pi runtime rather than process-global module state.
- [ ] Preserve correct behavior across reloads and concurrent parent/child runtimes.

## 6. Repair child runtime and Subagent lifecycle

- [ ] Define an explicit child extension/capability profile instead of substring-based exclusions.
- [ ] Prevent child sessions from loading UI-only extensions.
- [ ] Prevent child sessions from auto-connecting or shutting down parent Tiny MCP resources.
- [ ] Use one manager-owned start-generation path for launch, continue, and restart-via-steer.
- [ ] Enforce shutdown and concurrency limits for every run generation.
- [ ] Link and clean up parent cancellation for resumed foreground runs.
- [ ] Refresh run and detach promises for every generation.
- [ ] Clear `waitRun()` timeout timers in `finally`.
- [ ] Bound event text, persisted results, status output, and parent completion injection.
- [ ] Keep full transcripts in child sessions or artifacts rather than duplicating them in parent persistence.
- [ ] Deduplicate Stats usage by stable subagent run ID and cumulative deltas.

## 7. Repair Tiny MCP lifecycle and output contracts

- [ ] Replace unsafe manager reset with awaited shutdown followed by recreation.
- [ ] Give MCP managers explicit runtime ownership or reference-counted sharing.
- [ ] Ensure one runtime cannot close another runtime's managers.
- [ ] Throw execution failures so Pi receives framework-level tool errors.
- [ ] Add one shared bounded-result path for call, list, search, describe, and status output.
- [ ] Keep `details` bounded.
- [ ] Save full truncated output to managed artifacts and return the artifact path.
- [ ] Thread `AbortSignal` through JSON-RPC requests and transports.
- [ ] Ensure disabling Tiny MCP stops commands, tools, auto-connect, and owned resources.

## 8. Repair provider ownership and networking

- [ ] Give provider registration one owner per provider.
- [ ] Compose model-catalog patches and proxy endpoint/auth changes before registration.
- [ ] Otherwise enforce explicit per-provider mutual exclusion and report conflicts.
- [ ] Reconcile desired and applied provider IDs on every config load.
- [ ] Unregister owned provider overrides during shutdown.
- [ ] Make Provider Proxy and Model Patch config writes atomic.
- [ ] Redact token-shaped fields from every OAuth error.
- [ ] Make OAuth callback waits directly abort-aware.
- [ ] Remove polling abort listeners after both timer resolution and rejection.
- [ ] Add timeouts and retry expiry to temporary live pricing fetches.
- [ ] Remove the live-pricing workaround when upstream Pi data makes it obsolete.

## 9. Repair high-use Tree Edit and Context features

### Tree Edit

- [ ] Move Tree Edit onto `pip-common`'s atomic session-file writer.
- [ ] Reuse managed collision-safe backups and retention.
- [ ] Persist the selected target leaf using Pi's effective-final-record invariant.
- [ ] Replace `as any` scratch properties with typed operation results/state.
- [ ] Test save, process restart/reopen, and restored current leaf.
- [ ] Test interrupted/failed saves without corrupting the active session.

### Context

- [ ] Measure effective compacted context through Pi's session-context path rather than the whole branch.
- [ ] Distinguish maximum model output capacity from Pi's compaction reserve.
- [ ] Update labels so the inspector does not imply the wrong reservation semantics.
- [ ] Add tests covering compacted and uncompacted sessions.

## 10. Repair remaining correctness, UI, and resource bounds

- [ ] Preserve built-in prompt metadata when Tool UI overrides built-in tools, or avoid execution overrides if Pi supports renderer-only registration.
- [ ] Use renderer `context.isError` as the authoritative Tool UI error signal.
- [ ] Show a bounded first line for every collapsed failed execution.
- [ ] Add scrolling viewports and hidden-count indicators to Question and Todo inspectors.
- [ ] Add defensible Question schema count and text limits.
- [ ] Fix Footer quota identity, account/base-URL cache keys, stale state, and request races.
- [ ] Skip Footer quota work entirely when disabled or headless.
- [ ] Stream and cap Webfetch response bodies before buffering.
- [ ] Validate every Webfetch redirect and private-network destination.
- [ ] Stream and cap Websearch provider responses before parsing.
- [ ] Treat malformed and JSON-RPC error search responses as fallback-eligible failures.
- [ ] Dispose combined-signal listeners when requests settle.
- [ ] Bound and clean up Undo/Redo raw-prompt persistence.

## Completion criteria

- [ ] Aggregate Git installation works and remains the documented default.
- [ ] Every standalone feature tarball installs and loads in isolation.
- [ ] Removing a feature does not require changes inside sibling features.
- [ ] Pi package filtering can independently enable or disable aggregate features.
- [ ] Trust boundaries prevent untrusted project configuration from executing code.
- [ ] Parent and child runtimes cannot close or mutate each other's owned resources.
- [ ] Settings and session writes are atomic and preserve unknown data.
- [ ] Tool errors, cancellation, and output bounds follow Pi's runtime contracts.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] Strict unused-local and unused-parameter checking passes.
