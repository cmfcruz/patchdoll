#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="codex-auth"

uses_codex_provider() {
  [ "$(selected_provider)" = "codex" ]
}

auth_on_startup="${PATCHDOLL_CODEX_AUTH_ON_STARTUP:-auto}"
reject_secret_env CODEX_ACCESS_TOKEN
reject_secret_env OPENAI_API_KEY
codex_access_token="$(secret_value CODEX_ACCESS_TOKEN || true)"
openai_api_key="$(secret_value OPENAI_API_KEY || true)"

if is_disabled "$auth_on_startup"; then
  log "Skipping Codex auth because PATCHDOLL_CODEX_AUTH_ON_STARTUP=${auth_on_startup}"
  exit 0
fi

if ! is_enabled "$auth_on_startup" \
  && [ -z "$codex_access_token" ] \
  && [ -z "$openai_api_key" ] \
  && ! uses_codex_provider; then
  log "Skipping Codex auth because the Codex provider is not enabled"
  exit 0
fi

codex_bin="codex"
if ! command -v "$codex_bin" >/dev/null 2>&1; then
  log "Codex CLI is not installed or not on PATH: ${codex_bin}"
  exit 1
fi

codex_home="/patchdoll/codex"
state_dir="/patchdoll/state"
operator_agents="/etc/codex/AGENTS.md"
export CODEX_HOME="$codex_home"
export HOME="$codex_home"
mkdir -p "$codex_home" "$state_dir"
if [ -d /etc/codex/skills ]; then
  mkdir -p "$codex_home/skills"
  cp -Rn /etc/codex/skills/. "$codex_home/skills/"
fi

if [ ! -r "$operator_agents" ]; then
  log "Missing readable operator Codex instructions: ${operator_agents}"
  exit 1
fi
if [ "$(stat -c '%u' "$operator_agents")" != "0" ]; then
  log "Operator Codex instructions must be owned by root: ${operator_agents}"
  exit 1
fi
if [ "$(stat -c '%a' "$operator_agents")" != "444" ]; then
  log "Operator Codex instructions must have mode 0444: ${operator_agents}"
  exit 1
fi

chown codex:codex "$codex_home"
chown -R codex:codex "$codex_home"
chown -R codex:patchdoll-ipc "$state_dir"
find "$state_dir" -type d -exec chmod 2770 {} +
find "$state_dir" -type f -exec chmod 0660 {} +

run_codex() {
  s6-setuidgid codex "$codex_bin" "$@"
}

if [ -n "$codex_access_token" ]; then
  log "Authenticating Codex with CODEX_ACCESS_TOKEN from runtime secrets"
  printf '%s\n' "$codex_access_token" | run_codex login --with-access-token
elif [ -n "$openai_api_key" ]; then
  log "Authenticating Codex with OPENAI_API_KEY from runtime secrets"
  printf '%s\n' "$openai_api_key" | run_codex login --with-api-key
elif run_codex login status >/dev/null 2>&1; then
  log "Codex is already authenticated"
else
  log "No Codex env credential found; starting device-code auth"
  run_codex login --device-auth
fi
