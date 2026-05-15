# pi-quiet-tools

Quiet collapsed TUI rendering for pi tools.

- Built-in `read`, `grep`, `find`, and `ls` execution is delegated to pi's built-in tools.
- Other pip plugins can opt into quiet presentation metadata, e.g. `pi-todo`.
- Collapsed/default view shows only one muted summary line and hides successful results.
- Press Ctrl+O to expand a tool row and see the full output.
- Configure globally and per tool in `/pip-settings` under **Quiet Tools**. Shell-style changes take effect on reload.

Loaded automatically when `settings.json` includes `./extensions-pip`.
