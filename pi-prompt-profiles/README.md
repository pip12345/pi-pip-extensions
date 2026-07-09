# pi-prompt-profiles

Simple selectable system prompt overlays for pi.

Put user-managed `.md` files in `~/.pi/agent/pip/prompt-profiles/`, reload pi, then choose one in `/pip-settings` under **Prompt Profiles**. The extension creates this directory but leaves it empty. The selected file is read each turn, so edits to the active file apply on the next prompt; new files require reload so they appear in settings.

The package also includes managed profiles under `pi-prompt-profiles/prompts/`. These remain updateable with the extension instead of being copied into user-owned state. A user profile with the same filename intentionally overrides its bundled counterpart; remove or rename it to resume using the bundled version.

Settings:

- Enabled: on/off
- Profile: selected markdown file
- Mode: append, prepend, or replace
