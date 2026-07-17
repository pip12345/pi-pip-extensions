# pi-secrets-guard

Blocks Pi tools from accessing common secret files and project-defined secret paths.

## Behavior

Secrets Guard is enabled by default. It protects direct reads and writes and preflights `ls`, `grep`, and `find` roots for guarded descendants. Existing paths are checked through their canonical locations, and new write paths are checked through the nearest existing parent to prevent symlink bypasses.

Built-in rules cover common files such as `.env`, private keys, cloud credentials, and SSH/GnuPG directories. Safe templates including `.env.example` remain accessible.

## Project rules

Add gitignore-style patterns to a trusted project's `.secretignore` file:

```gitignore
private/
credentials.*
!credentials.example.json
```

Project rules are ignored until Pi considers the project trusted. Legacy `.gitignore` protection is available but disabled by default because ignored paths often include non-secret caches and build output.

## Bash protection

Bash handling is intentionally best-effort: the default mode scans simple shell path tokens, but it is not a complete shell parser. Set **Bash guard** to `block` when shell access must be disabled entirely, or `off` when another policy owns shell access.

## Settings

Configure under **Secrets Guard** in:

```text
/pip-settings
```

Settings control common-secret, `.secretignore`, optional `.gitignore`, read, write, search/list, bash, and prompt-reminder behavior.
