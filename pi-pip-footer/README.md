# pi-pip-footer

Pip footer for pi. This is the renamed successor to `pi-token-counter`: it keeps the live token counter / working-indicator replacement above the editor, then adds a custom below-editor footer with context, model/thinking, quota usage, and future pip plugin footer lines.

## Shows

- live token burn while the assistant streams, above the input box
- settled input/output/cache token totals with short-lived deltas, above the input box
- context usage bar in the lower footer, e.g. `ctx ━━━━━━━── 220k/272k`
- model and thinking level
- Codex, Anthropic/Claude, or Copilot quota windows with reset times
- optional project/CWD and git branch
- additional lines registered by other pip plugins via `pip-common`'s footer line registry

## Settings

Configure in `/pip-settings` under **Pip Footer**:

- Enabled
- Quota provider: `auto`, `codex`, `anthropic`, `copilot`, `off`
- Context bar
- Model
- Above-editor token counter
- Plugin lines
- Git
- CWD: `off`, `project`, `path`
