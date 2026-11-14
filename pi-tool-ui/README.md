# pi-tool-ui

Unified TUI rendering for PiP tool calls and results.

- Customizes the display of `read`, `grep`, `find`, `ls`, and `edit` without replacing their execution or prompt instructions.
- Keeps the normal display when Tool UI or edit diffs are disabled.
- Consumes `metadata.display` from tools registered through `pip-common`.
- Keeps successful results compact/quiet, but always shows a bounded first line when Pi marks an execution as failed.
- Configures Tool UI enabled, edit-diff enabled, and diff layout under **Tool UI** in `/pip-settings`.

Compact adapters use fixed rendering thresholds and follow the main Tool UI switch. Extensions should keep behavior-specific settings in their own sections and expose only display hints through `metadata.display`.
