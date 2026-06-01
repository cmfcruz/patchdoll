---
name: patchdollctl
description: Use when Codex needs to inspect or change Patchdoll runtime settings through the validated `patchdollctl settings` CLI, especially for admin Slack requests to update safe DB-backed settings such as Codex model, reasoning effort, and fast mode.
---

# patchdollctl Settings CLI

Use `patchdollctl` instead of raw SQLite or direct config-file edits when changing Patchdoll settings. It validates setting names and values before writing to the Patchdoll state database.

## Commands

```sh
patchdollctl settings list
patchdollctl settings get <key>
patchdollctl settings set <key> <json-or-string>
```

Values are parsed as JSON first, then as strings. Quote arrays and strings carefully in shell commands.

## Common settings

- `codex.model`: non-empty string, e.g. `gpt-5.5`
- `codex.reasoningEffort`: one of `minimal`, `low`, `medium`, `high`, `xhigh`
- `codex.fastMode`: boolean
- `ai.timeoutSeconds`: positive integer
- `ai.maxConcurrentRuns`: positive integer
- `ai.bypassSandboxAndApprovals`: boolean

## Examples

```sh
patchdollctl settings get codex.reasoningEffort
patchdollctl settings set codex.reasoningEffort high
patchdollctl settings set codex.fastMode true
```

## Safety rules

- Only use this CLI for explicit user requests to inspect or change Patchdoll settings.
- Do not use raw `sqlite3`, ad hoc Node scripts, or direct DB writes to bypass validation.
- Do not move secrets into settings. Slack tokens, API keys, cookies, private keys, and credentials stay in secrets/env files.
- Admin actors are configured only with `PATCHDOLL_ADMINS`; do not try to set admins with `patchdollctl`.
- If the Slack context says the actor is not an admin, explain that the settings change cannot be applied rather than attempting a write.
- Some startup-loaded settings may require restarting Patchdoll before they affect already-running processes.
