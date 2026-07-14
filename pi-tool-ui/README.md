# pi-tool-ui

Unified TUI rendering for PiP tool calls and results.

- Owns built-in display adapters for `read`, `grep`, `find`, `ls`, and `edit`.
- Consumes `metadata.display` from tools registered through `pip-common`.
- Keeps default behavior compact/quiet, with settings under **Tool UI** in `/pip-settings`.

Extensions should keep behavior-specific settings in their own settings sections and expose only display hints through `metadata.display`.
