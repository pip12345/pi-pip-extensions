# pi-prompt-profiles

Simple selectable system prompt overlays for pi.

Drop `.md` files in `pi-prompt-profiles/prompts/`, reload pi, then choose one in `/pip-settings` under **Prompt Profiles**. The extension is enabled by default and selects `default.md` by default.

Settings:

- Enabled: on/off
- Profile: selected markdown file
- Mode: append, prepend, or replace

The selected file is read each turn, so edits to the active file apply on the next prompt. New files require reload so they appear in `/pip-settings`.
