# pi-tool-ui

Unified TUI rendering for PiP tool calls and results.

- Owns built-in display adapters for `read`, `grep`, `find`, `ls`, and `edit` while preserving Pi's prompt snippets and guidelines.
- Consumes `metadata.display` from tools registered through `pip-common`.
- Keeps successful results compact/quiet, but always shows a bounded first line when Pi marks an execution as failed.
- Configures adapters under **Tool UI** in `/pip-settings`.

Extensions should keep behavior-specific settings in their own settings sections and expose only display hints through `metadata.display`.
