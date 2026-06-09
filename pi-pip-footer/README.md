# pi-pip-footer

Pip footer for pi. This is the renamed successor to `pi-token-counter`: it keeps the live token counter / working-indicator replacement above the editor, then adds a custom below-editor footer with context, model/thinking, quota usage, and future pip plugin footer lines.

## Shows

- live token burn while the assistant streams, above the input box
- settled token totals as `↓` input, `↑` output, and `↻`/`c` cache with optional latest cache hit rate, e.g. `↻:28k/75%`, plus short-lived deltas above the input box
- context usage bar in the lower footer, e.g. `gpt-5/high   ctx ━━━━━━━── 184k/272k   ~/proj   main*`
- model and thinking level as `{model}/{thinking}`
- Codex, Anthropic/Claude, or Copilot quota windows with reset times, e.g. `codex        5h ━━━━━━━── 74% ↻ 1h22m   7d ━━━────── 31% ↻ 4d`; if quota fetch fails, shows `usage offline`
- optional project/CWD and git branch
- additional lines registered by other pip plugins via `pip-common`'s footer line registry

## Settings

Configure in `/pip-settings` under **Pip Footer**:

- Enabled
- Quota provider: `auto`, `codex`, `anthropic`, `copilot`, `off`
- Context bar
- Model
- Above-editor token counter
- Cache icon: `↻`, `c`, `▣`, `◫`, or `□`
- Cache hit rate
- Plugin lines
- Git
- CWD: `off`, `project`, `path`
