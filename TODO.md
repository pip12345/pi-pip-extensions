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

- [x] Define `pip-common` as the shared runtime package with a stable package identity.
- [x] Bundle `pip-common` into every standalone feature package according to Pi package rules.
- [x] Ensure a standalone feature loads the required `pip-common` extension bootstrap.
- [x] Keep aggregate source imports independent of installed workspace links while emitting standalone packages that resolve bundled `pip-common` imports.
- [x] Make the shared bootstrap idempotent so aggregate and standalone loading cannot double-register commands or lifecycle handlers.
- [x] Correct every feature package's `files` allowlist.
- [x] Include all Tree Edit runtime source files in its tarball.
- [x] Exclude test sources and fixtures from Footer and Stats tarballs.
- [x] Generate every standalone tarball in tests.
- [x] Install every generated tarball in an isolated temporary directory.
- [x] Load every isolated package through Pi's package rules and verify its entrypoints.
- [x] Keep the aggregate Git package as the recommended installation path.

## 3. Enforce removable feature boundaries

- [x] Add a static test that rejects production imports between sibling `pi-*` features.
- [x] Add a static test that rejects imports from `pip-common` into feature folders.
- [x] Add a smoke test that loads each feature with only Pi and `pip-common` available.
- [x] Test optional integrations with either side absent.
- [x] Verify custom tools still register when `pi-tool-ui` is absent.
- [x] Verify Tool UI still loads when Todo, Tiny MCP, Question, or Subagents is absent.
- [x] Verify Stats still loads when Subagents is absent.
- [x] Keep aggregate manifest entries literal and test that each referenced entrypoint exists.
- [x] Verify aggregate package filtering exposes each feature as a separate Pi resource.

## 4. Repair trust and filesystem boundaries

- [x] Prevent Tiny MCP from loading or auto-connecting project configuration when the project is untrusted.
- [x] Prevent Subagents from loading project agent definitions when the project is untrusted.
- [x] Canonicalize existing Secrets Guard targets through `realpath`.
- [x] Canonicalize the nearest existing parent for write targets.
- [x] Prevent recursive grep/find/ls operations from traversing or returning guarded descendants.
- [x] Recompute or validate restored subagent context paths before recursive deletion.
- [x] Quarantine malformed persisted subagent records instead of performing cleanup from untrusted fields.
- [x] Add trusted/untrusted, symlink, recursive traversal, and path-containment regression tests.

## 5. Repair shared settings and runtime ownership

- [x] Preserve malformed settings files and report parse errors instead of replacing them with defaults.
- [x] Preserve settings sections belonging to unloaded, disabled, removed, or not-yet-loaded features.
- [x] Stop writing settings merely because a section registered.
- [x] Use atomic temporary-file plus rename writes.
- [x] Batch `/pip-settings` changes into one commit.
- [x] Enforce numeric `min` and `max` bounds in the central validator.
- [x] Validate defaults when settings sections register.
- [x] Add shared setting-change notifications.
- [x] Make each extension apply live setting changes or explicitly report that reload is required.
- [x] Scope shared tool, settings, footer, and lifecycle state by Pi runtime rather than process-global module state.
- [x] Preserve correct behavior across reloads and concurrent parent/child runtimes.

## 6. Repair child runtime and Subagent lifecycle

- [x] Define an explicit child extension/capability profile instead of substring-based exclusions.
- [x] Prevent child sessions from loading UI-only extensions.
- [x] Prevent child sessions from auto-connecting or shutting down parent Tiny MCP resources.
- [x] Use one manager-owned start-generation path for launch, continue, and restart-via-steer.
- [x] Enforce shutdown and concurrency limits for every run generation.
- [x] Link and clean up parent cancellation for resumed foreground runs.
- [x] Refresh run and detach promises for every generation.
- [x] Clear `waitRun()` timeout timers in `finally`.
- [x] Bound event text, persisted results, status output, and parent completion injection.
- [x] Keep full transcripts in child sessions or artifacts rather than duplicating them in parent persistence.
- [x] Deduplicate Stats usage by stable subagent run ID and cumulative deltas.

## 7. Repair Tiny MCP lifecycle and output contracts

- [x] Replace unsafe manager reset with awaited shutdown followed by recreation.
- [x] Give MCP managers explicit runtime ownership or reference-counted sharing.
- [x] Ensure one runtime cannot close another runtime's managers.
- [x] Throw execution failures so Pi receives framework-level tool errors.
- [x] Add one shared bounded-result path for call, list, search, describe, and status output.
- [x] Keep `details` bounded.
- [x] Save full truncated output to managed artifacts and return the artifact path.
- [x] Thread `AbortSignal` through JSON-RPC requests and transports.
- [x] Ensure disabling Tiny MCP stops commands, tools, auto-connect, and owned resources.

## 8. Repair provider ownership and networking

- [x] Give provider registration one owner per provider.
- [x] Compose model-catalog patches and proxy endpoint/auth changes before registration.
- [x] Otherwise enforce explicit per-provider mutual exclusion and report conflicts.
- [x] Reconcile desired and applied provider IDs on every config load.
- [x] Unregister owned provider overrides during shutdown.
- [x] Make Provider Proxy config writes atomic; keep Model Patch toggles on shared atomic settings (its user patch config is read-only).
- [x] Redact token-shaped fields from every OAuth error.
- [x] Make OAuth callback waits directly abort-aware.
- [x] Remove polling abort listeners after both timer resolution and rejection.
- [x] Add timeouts and retry expiry to temporary live pricing fetches.
- [ ] Remove the live-pricing workaround when upstream Pi data makes it obsolete.

## 9. Repair high-use Tree Edit and Context features

### Tree Edit

- [x] Move Tree Edit onto `pip-common`'s atomic session-file writer.
- [x] Reuse managed collision-safe backups and retention.
- [x] Persist the selected target leaf using Pi's effective-final-record invariant.
- [x] Replace `as any` scratch properties with typed operation results/state.
- [x] Test save, process restart/reopen, and restored current leaf.
- [x] Test interrupted/failed saves without corrupting the active session.

### Context

- [x] Measure effective compacted context through Pi's session-context path rather than the whole branch.
- [x] Distinguish maximum model output capacity from Pi's compaction reserve.
- [x] Update labels so the inspector does not imply the wrong reservation semantics.
- [x] Add tests covering compacted and uncompacted sessions.

## 10. Repair remaining correctness, UI, and resource bounds

- [x] Preserve built-in prompt metadata when Tool UI overrides built-in tools, or avoid execution overrides if Pi supports renderer-only registration.
- [x] Use renderer `context.isError` as the authoritative Tool UI error signal.
- [x] Show a bounded first line for every collapsed failed execution.
- [x] Add scrolling viewports and hidden-count indicators to Question and Todo inspectors.
- [x] Add defensible Question schema count and text limits.
- [ ] Fix Footer quota identity, account/base-URL cache keys, stale state, and request races.
- [ ] Skip Footer quota work entirely when disabled or headless.
- [x] Stream and cap Webfetch response bodies before buffering.
- [x] Validate every Webfetch redirect and private-network destination.
- [x] Stream and cap Websearch provider responses before parsing.
- [x] Treat malformed and JSON-RPC error search responses as fallback-eligible failures.
- [x] Dispose combined-signal listeners when requests settle.
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
