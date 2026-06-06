# Patchdoll ゼロ (Zero)

Slack-driven AI assistant for GitHub maintainers.

You ask in Slack. Patchdoll sends the task to Codex inside a Docker container.
Codex works in the mounted project folder, then Patchdoll posts the answer back
to Slack.

## Warning: GitHub Write Access

You are playing with fire by granting an AI agent access to your GitHub
organization or repositories. That can be useful fire. It can also burn down the
kitchen if you hand it the wrong permissions and walk away for snacks.

Give Patchdoll the least access it needs for the work you actually want it to
do. Prefer repository-scoped access over organization-wide access, and prefer
pull-request workflows over direct pushes to protected branches.

Potential risks include:

- unintended code changes, force pushes, branch deletions, or broken releases
- malicious or mistaken changes caused by prompt injection in issues, pull
  requests, comments, logs, docs, or Slack messages
- accidental exposure of secrets, private source code, customer data, or
  internal implementation details
- dependency, workflow, or configuration changes that weaken CI, deployment,
  security scanning, or branch protection
- creation or modification of GitHub Actions workflows that can run with
  repository credentials
- changes to access controls, deploy keys, webhooks, repository settings, or
  GitHub App permissions if the granted token allows them
- large automated edits that are hard to review and easy to merge by mistake
- commits or comments that appear to come from a trusted automation identity
  even when the requested action was unsafe

Use short-lived credentials when possible, review generated changes before
merge, keep branch protections enabled, and audit the permissions granted to any
GitHub App, token, or service account used by Patchdoll.

## Prerequisites

Use this when you just want Patchdoll running.

You need:

- Docker
- a Slack app with a bot token and app token

If you do not have Slack tokens yet, do the [Slack How-To](docs/slack-how-to.md)
first.

### 1. Build the image

Run this from the `patchdolls/patchdoll` directory:

```sh
docker build -t patchdoll:latest .
```

### 2. Create the local Patchdoll folder

```sh
PATCHDOLL_HOME="$HOME/.patchdoll"
mkdir -p "$PATCHDOLL_HOME"/{state,codex}
chmod 700 "$PATCHDOLL_HOME" "$PATCHDOLL_HOME"/{state,codex}
```

### 3. Save your Slack secrets

Paste your real Slack tokens:

```sh
cat > "$PATCHDOLL_HOME/secrets.env" <<'EOF'
PATCHDOLL_SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
PATCHDOLL_SLACK_APP_TOKEN=xapp-your-slack-app-token
EOF
chmod 600 "$PATCHDOLL_HOME/secrets.env"
```

If you want noninteractive Codex login, add `OPENAI_API_KEY=...` or
`CODEX_ACCESS_TOKEN=...` to this same file. If neither is present, Patchdoll
starts Codex device-code auth on first startup and stores the login state in
`/patchdoll/agent`.

### 4. Run Patchdoll

Run this from the project you want Patchdoll to work on:

```sh
docker run -d --rm \
  --name patchdoll \
  -v "patchdoll-data:/patchdoll" \
  -v "patchdoll-workspace:/workspace" \
  -v "$PATCHDOLL_HOME/secrets.env:/run/secrets/patchdoll.env:ro" \
  patchdoll:latest
```

### 5. Watch it start

```sh
docker logs -f patchdoll
```

On first startup, Codex may print a device-code login URL and code. Complete
that browser flow once. The login is stored under `$PATCHDOLL_HOME/codex`, so
later starts reuse it.

Pressing Ctrl-C here only stops log watching. It does not stop Patchdoll.

### 6. Try it in Slack

In Slack, try:

```text
/patchdoll say hi
```

Or mention the app in a channel:

```text
@Patchdoll summarize this channel
```

Or send the app a direct message.

### Stop Patchdoll

```sh
docker stop --timeout 15 patchdoll
```

That is the quick path. Sweet little win.

## Slack How-To

The Slack app setup guide now lives in [Slack How-To](docs/slack-how-to.md).
GitHub webhook setup lives in [GitHub Webhook Ingress](docs/github-webhook.md).

## How Patchdoll Uses Your Folders

Patchdoll uses fixed paths inside the container:

- `/workspace`: the project Patchdoll can inspect or edit
- `/patchdoll/state`: Patchdoll state database
- `/patchdoll/agent`: provider (Codex or Claude) login and session data
- `/run/secrets/patchdoll.env`: secret tokens

You do not need a `config.json` for the normal setup. Patchdoll has defaults.

Use a config file only when you want advanced overrides. Most people can skip
it.

## Advanced Usage

Use this section when you want to tune the runtime.

### Use mounted paths for data and a local repo

Use host paths when you want Patchdoll state on disk and want Codex to work on
a specific local checkout instead of an empty Docker volume.

Set `PATCHDOLL_HOME` to the folder that contains your `secrets.env` file, and
set `PATCHDOLL_WORKSPACE` to the repo Patchdoll should inspect or edit:

```sh
PATCHDOLL_HOME="$HOME/.patchdoll"
PATCHDOLL_WORKSPACE="$HOME/src/my-repo"

docker run -d --rm \
  --name patchdoll \
  -v "$PATCHDOLL_HOME:/patchdoll" \
  -v "$PATCHDOLL_WORKSPACE:/workspace" \
  -v "$PATCHDOLL_HOME/secrets.env:/run/secrets/patchdoll.env:ro" \
  patchdoll:latest
```

Note: startup may adjust ownership or permissions inside `/workspace` so the
container's `codex` user can write there. Use a disposable branch or clone if
you want an easy undo button.

### Use a Docker volume as the workspace

Patchdoll only cares that the project is available at `/workspace`.

This works:

```sh
-v patchdoll-workspace:/workspace
```

A named volume starts empty. Use it for scratch work or copy files into it
before asking Patchdoll to work there.

### Optional runtime knobs

You can add these `-e` values to `docker run` when needed:

```sh
-e PATCHDOLL_AI_PROVIDER=codex
-e PATCHDOLL_AI_TIMEOUT_SECONDS=900
-e PATCHDOLL_SLACK_COMMAND=/patchdoll
```

Prefer keeping Slack tokens and OAuth tokens in `secrets.env` instead of `-e`
values.

If a deployment platform can only provide secrets as container environment
variables, Patchdoll moves a narrow allowlist of secret env vars into
`/run/secrets/patchdoll.env` during early s6 initialization when that path is
writable. If `/run/secrets` is a read-only Docker secrets mount, Patchdoll falls
back to `/run/patchdoll/secrets.env`. In both cases it removes the allowlisted
secrets from the s6 service environment before user-facing services start. This
reduces accidental inheritance by Codex or other child processes; it does not
hide those values from the container runtime, Docker metadata, root users, or
processes with access to the secrets file.

### Environment reference

Patchdoll reads secrets from `/run/secrets/patchdoll.env`, with
`/run/patchdoll/secrets.env` as the runtime fallback for env-file migrations when
Docker mounts `/run/secrets` read-only. Runtime knobs stay in the container
environment. Keep those buckets separate.

Secrets file values:

| Name | Required | Purpose |
| --- | --- | --- |
| `PATCHDOLL_SLACK_BOT_TOKEN` | yes | Slack bot token, usually starts with `xoxb-`. |
| `PATCHDOLL_SLACK_APP_TOKEN` | yes | Slack Socket Mode app token, usually starts with `xapp-`. |
| `OPENAI_API_KEY` | no | Noninteractive Codex login with an OpenAI API key. |
| `CODEX_ACCESS_TOKEN` | no | Noninteractive Codex login with a Codex access token. |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | Noninteractive Claude Code OAuth authentication when `PATCHDOLL_AI_PROVIDER=claude`. |
| `ANTHROPIC_API_KEY` | no | Noninteractive Claude Code login with an Anthropic API key when `PATCHDOLL_AI_PROVIDER=claude`. |
| `PATCHDOLL_GITHUB_APP_ID` | no | GitHub App ID for temporary Codex `gh` access. |
| `PATCHDOLL_GITHUB_APP_INSTALLATION_ID` | no | GitHub App installation ID. |
| `PATCHDOLL_GITHUB_APP_PRIVATE_KEY_BASE64` | no | Base64-encoded GitHub App PEM private key. |
| `PATCHDOLL_GITHUB_WEBHOOK_SECRET` | no | Secret used to verify GitHub `X-Hub-Signature-256` webhook requests. |
| `PATCHDOLL_NGROK_AUTHTOKEN` | no | ngrok auth token for optional public webhook exposure. |

If one GitHub App value is set, all three GitHub App values must be set. When
configured, Patchdoll mints a short-lived installation token for each Codex task
and injects it as `GH_TOKEN` and `GITHUB_TOKEN`.

Container environment values:

| Name | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Health server bind host. |
| `PORT` | `3000` | Health server port. |
| `PATCHDOLL_AI_PROVIDER` | `codex` | AI provider to use. Use `codex` or `claude`. |
| `PATCHDOLL_AI_TIMEOUT_SECONDS` | `900` | AI task timeout (applies to the active provider). |
| `PATCHDOLL_AI_MAX_CONCURRENT_RUNS` | `1` | Maximum concurrent AI tasks (applies to the active provider). |
| `PATCHDOLL_CODEX_BYPASS_APPROVALS_AND_SANDBOX` | `true` | Whether Codex runs with bypassed approvals and sandbox. Use `0`, `false`, `no`, or `off` to disable. |
| `PATCHDOLL_CODEX_AUTH_ON_STARTUP` | `auto` | Codex startup auth mode. Use `0`, `false`, `no`, or `off` to skip startup auth. |
| `PATCHDOLL_CODEX_PROFILE` | unset | Optional Codex profile passed to new Codex sessions. |
| `PATCHDOLL_CODEX_SKIP_GIT_REPO_CHECK` | `true` | Adds `--skip-git-repo-check` unless disabled. |
| `PATCHDOLL_THREAD_CONTEXT_MAX_CHARS` | `60000` | Maximum Slack transcript characters included in the agent prompt. |
| `PATCHDOLL_SLACK_COMMAND` | `/patchdoll` | Slash command name the Slack bridge listens for. |
| `PATCHDOLL_SLACK_THREAD_MAX_MESSAGES` | `100` | Maximum Slack thread messages fetched. Use `0` to disable thread fetching. |
| `PATCHDOLL_SLACK_THREAD_MAX_MESSAGE_CHARS` | `4000` | Maximum characters kept per Slack thread message. |
| `PATCHDOLL_ADMINS` | unset | Comma- or newline-separated Slack user IDs allowed to change settings. |
| `PATCHDOLL_LOG_LEVEL` | `info` | Container console log level: `warn`, `info`, `debug`, or `trace`. |
| `PATCHDOLL_GITHUB_NOTIFY_SLACK_CHANNEL` | unset | Slack channel ID that receives GitHub webhook notifications. |
| `PATCHDOLL_GITHUB_WEBHOOK_TRACKED_REPOS` | unset | Comma- or newline-separated GitHub repositories tracked through webhooks. |
| `PATCHDOLL_NGROK_DOMAIN` | unset | Stable ngrok domain to use for the public webhook URL. |

Internal runtime values such as `CODEX_HOME`, `HOME`, `PATCHDOLL_TASK`,
`GH_TOKEN`, `GITHUB_TOKEN`, and `GH_PROMPT_DISABLED` are set by Patchdoll for the
Codex process. Do not configure them yourself.

### Experimental Claude provider scaffold

Patchdoll has early provider plumbing for Claude Code behind:

```sh
PATCHDOLL_AI_PROVIDER=claude
```

The current scaffold installs the pinned Claude Code npm package and uses print
mode with JSON output, model selection, permission mode, and max-turn settings.
For noninteractive authentication, generate a long-lived Claude Code OAuth token:

```sh
claude setup-token
```

Then store the printed token in `/run/secrets/patchdoll.env`:

```sh
CLAUDE_CODE_OAUTH_TOKEN=...
```

Patchdoll scrubs allowlisted Claude credentials from the inherited service
environment during startup. Prefer the secrets file; `-e`/`--env-file` works as
a migration path, with the usual Docker metadata caveats, because apparently
secrets still enjoy paperwork.

Useful DB-backed settings:

```sh
patchdollctl settings set ai.provider claude
patchdollctl settings set claude.model sonnet
patchdollctl settings set claude.effort high
patchdollctl settings set claude.permissionMode default
patchdollctl settings set claude.maxTurns 0
```

### Let Slack admins change Patchdoll settings

Patchdoll is secure by default. Slack users cannot change Patchdoll settings
unless you explicitly list their Slack user IDs in `PATCHDOLL_ADMINS`.

```sh
-e PATCHDOLL_ADMINS=U12345678,W12345678
```

Use Slack user IDs, not display names. See
[Allow Slack Admin Settings Changes](docs/slack-how-to.md#optional-allow-slack-admin-settings-changes)
for how to copy the right ID from Slack.

After that, listed admins can ask Patchdoll to update non-secret runtime
settings:

```text
/patchdoll set Codex reasoning effort to high
/patchdoll set Codex model to gpt-5.5
```

## Build Notes

Build the image from this directory:

```sh
docker build -t patchdoll:latest .
```

The build expects `package-lock.json` to be present.

## Troubleshooting

### Patchdoll says a Slack token is missing

Check that your secret file is mounted here:

```text
/run/secrets/patchdoll.env
```

And that it contains:

```text
PATCHDOLL_SLACK_BOT_TOKEN=xoxb-...
PATCHDOLL_SLACK_APP_TOKEN=xapp-...
```

Do not pass Slack tokens with `-e` or `--env-file`. Patchdoll intentionally reads
them from the mounted secrets file.

### Slash command works, but mentions do not

Invite the app into the channel:

```text
/invite @Patchdoll
```

Also check that `app_mention` is subscribed under **Event Subscriptions**.

### Direct messages do not work

Check that `message.im` is subscribed under **Event Subscriptions** and that App
Home allows messages.

### Patchdoll cannot answer about a thread

Make sure the bot has the matching history scope for that conversation:

- public channels: `channels:history`
- private channels: `groups:history`
- direct messages: `im:history`
- group DMs: `mpim:history`

The app also has to be present in the conversation.

## Development

Patchdoll is a small set of pieces:

- the Slack bridge receives Slack messages
- the runner prepares a Codex task
- the Codex provider runs Codex in `/workspace`
- the policy layer checks any proposed external action

The main rule: Codex can work inside the container, while Patchdoll owns the
outside boundary.

### Linting

Install Node dependencies, then install the git hooks:

```sh
npm ci
npm run prepare
```

Run all linters locally:

```sh
npm run lint
```

The lint suite covers:

- TypeScript and JavaScript with ESLint
- shell scripts with ShellCheck
- Dockerfiles with hadolint
- YAML with yamllint

ShellCheck, hadolint, and yamllint are included in the Patchdoll runtime image.
If you lint outside that image, install the same tools first, for example:

```sh
# Debian/Ubuntu
sudo apt-get install shellcheck yamllint
sudo curl -fsSLo /usr/local/bin/hadolint \
  https://github.com/hadolint/hadolint/releases/download/v2.14.0/hadolint-Linux-x86_64
sudo chmod 0755 /usr/local/bin/hadolint

# macOS
brew install shellcheck hadolint yamllint
```
