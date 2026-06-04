---
name: patchdollctl
description: Use when an agent needs to inspect or change Patchdoll runtime settings through the validated `patchdollctl settings` CLI, especially for admin Slack requests to update safe DB-backed settings such as the active AI provider, model, reasoning effort, and fast mode (Codex and Claude alike).
---

# patchdollctl Settings CLI

Use `patchdollctl` instead of raw SQLite or direct config-file edits when changing Patchdoll settings. It validates setting names and values before writing to the Patchdoll state database. The same binary manages every provider, so it is provider-neutral: use it whether the active provider is Codex or Claude.

## Commands

```sh
patchdollctl settings list
patchdollctl settings get <key>
patchdollctl settings set <key> <json-or-string>
```

Values are parsed as JSON first, then as strings. Quote arrays and strings carefully in shell commands.

## Common settings

Provider-neutral (`ai.*`):

- `ai.provider`: provider name, e.g. `codex` or `claude`
- `ai.timeoutSeconds`: positive integer
- `ai.maxConcurrentRuns`: positive integer
- `ai.bypassSandboxAndApprovals`: boolean

Codex (`codex.*`):

- `codex.model`: non-empty string, e.g. `gpt-5.5`
- `codex.reasoningEffort`: one of `minimal`, `low`, `medium`, `high`, `xhigh`
- `codex.fastMode`: boolean

Claude (`claude.*`):

- `claude.model`: non-empty string, e.g. `opus` or `sonnet`
- `claude.effort`: one of `low`, `medium`, `high`, `xhigh`, `max`
- `claude.permissionMode`: one of `default`, `acceptEdits`, `bypassPermissions`, `plan`
- `claude.maxTurns`: non-negative integer

Settings only take effect for the provider selected by `ai.provider`. For the live value of any key, run `get`/`list` rather than assuming a default — values are DB-backed and changeable.

## Examples

```sh
patchdollctl settings get ai.provider
patchdollctl settings get claude.effort
patchdollctl settings set claude.effort high
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
