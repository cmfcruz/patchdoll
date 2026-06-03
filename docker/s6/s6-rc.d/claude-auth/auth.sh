#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="claude-auth"

uses_claude_provider() {
  [ "$(selected_provider)" = "claude" ]
}

auth_on_startup="${PATCHDOLL_CLAUDE_AUTH_ON_STARTUP:-auto}"
reject_secret_env ANTHROPIC_API_KEY
reject_secret_env CLAUDE_CODE_OAUTH_TOKEN
anthropic_api_key="$(secret_value ANTHROPIC_API_KEY || true)"
claude_code_oauth_token="$(secret_value CLAUDE_CODE_OAUTH_TOKEN || true)"

if is_disabled "$auth_on_startup"; then
  log "Skipping Claude auth because PATCHDOLL_CLAUDE_AUTH_ON_STARTUP=${auth_on_startup}"
  exit 0
fi

if ! is_enabled "$auth_on_startup" \
  && [ -z "$anthropic_api_key" ] \
  && [ -z "$claude_code_oauth_token" ] \
  && ! uses_claude_provider; then
  log "Skipping Claude auth because the Claude provider is not enabled"
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  log "Claude Code CLI is not installed or not on PATH: claude"
  exit 1
fi

claude_home="/patchdoll/claude"
state_dir="/patchdoll/state"
export HOME="$claude_home"
export CLAUDE_CONFIG_DIR="$claude_home"
export DISABLE_AUTOUPDATER=1
mkdir -p "$claude_home" "$state_dir"
chown claude:patchdoll-ipc "$claude_home"
chmod 0770 "$claude_home"
chown -R claude:patchdoll-ipc "$state_dir"
find "$state_dir" -type d -exec chmod 2770 {} +
find "$state_dir" -type f -exec chmod 0660 {} +

if [ -n "$claude_code_oauth_token" ]; then
  log "Claude Code OAuth token found in runtime secrets"
elif [ -n "$anthropic_api_key" ]; then
  log "Anthropic API key found in runtime secrets"
elif s6-setuidgid claude claude auth status >/dev/null 2>&1; then
  log "Claude Code is already authenticated"
else
  log "No Claude Code env credential found; generate one with 'claude setup-token' or pre-authenticate /patchdoll/claude"
fi
