#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="claude-worker"

if [ "$(selected_provider)" != "claude" ]; then
  log "disabled because the Claude provider is not selected"
  exec sleep infinity
fi

socket_path="/run/patchdoll/providers/claude.sock"
socket_dir="$(dirname "$socket_path")"
claude_home="/patchdoll/agent"
state_dir="/patchdoll/state"
workspace_dir="/workspace"

mkdir -p /run/patchdoll "$socket_dir" "$claude_home" "$state_dir" "$workspace_dir"
chown patchdoll:patchdoll-ipc /run/patchdoll
chmod 2770 /run/patchdoll
chown agent:patchdoll-ipc "$socket_dir" "$claude_home"
chmod 2770 "$socket_dir"
chmod 0770 "$claude_home"
if [ -d /etc/agent/skills ]; then
  mkdir -p "$claude_home/skills"
  cp -Rn /etc/agent/skills/. "$claude_home/skills/"
  chown -R agent:patchdoll-ipc "$claude_home/skills"
fi
chown -R agent:patchdoll-ipc "$state_dir"
find "$state_dir" -type d -exec chmod 2770 {} +
find "$state_dir" -type f -exec chmod 0660 {} +
if chown -R agent:patchdoll-ipc "$workspace_dir"; then
  find "$workspace_dir" -type d -exec chmod 2770 {} +
  find "$workspace_dir" -type f -exec chmod g+rw {} +
else
  log "unable to prepare ${workspace_dir}; Patchdoll requires a writable workspace mount and CAP_CHOWN"
  exit 1
fi
rm -f "$socket_path"

export HOME="$claude_home"
export CLAUDE_CONFIG_DIR="$claude_home"
export DISABLE_AUTOUPDATER=1
stash_secret_env ANTHROPIC_API_KEY
stash_secret_env CLAUDE_CODE_OAUTH_TOKEN
claude_code_oauth_token="$(secret_value CLAUDE_CODE_OAUTH_TOKEN || true)"
anthropic_api_key="$(secret_value ANTHROPIC_API_KEY || true)"
if [ -n "$claude_code_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$claude_code_oauth_token"
fi
if [ -n "$anthropic_api_key" ]; then
  export ANTHROPIC_API_KEY="$anthropic_api_key"
fi

if ! command -v claude >/dev/null 2>&1; then
  log "Claude Code CLI is not installed or not on PATH: claude"
  exit 1
fi

if command -v git >/dev/null 2>&1 && command -v gh >/dev/null 2>&1; then
  s6-setuidgid agent git config --global --replace-all credential.https://github.com.helper '!gh auth git-credential'
fi

exec s6-setuidgid agent node /app/packages/provider-claude/dist/worker.js
