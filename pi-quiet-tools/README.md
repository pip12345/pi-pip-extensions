# pi-quiet-tools

Quiet collapsed TUI rendering for pi's built-in `read`, `grep`, `find`, and `ls` tools.

- The actual tool execution is delegated to pi's built-in tools.
- Collapsed/default view shows only one muted summary line.
- Press Ctrl+O to expand a tool row and see the full output.

Loaded automatically when `settings.json` includes `./extensions-pip`.
