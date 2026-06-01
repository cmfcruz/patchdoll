#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "codex-auth: $*" >&2
}

is_disabled() {
  case "${1,,}" in
    0|false|no|off) return 0 ;;
    *) return 1 ;;
  esac
}

is_enabled() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

secrets_file="/run/secrets/patchdoll.env"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

secret_value() {
  local name="$1"
  local line key value

  [ -r "$secrets_file" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    [ -n "$line" ] || continue
    [[ "$line" != \#* ]] || continue
    if [[ "$line" == export\ * ]]; then
      line="$(trim "${line#export }")"
    fi
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(trim "${BASH_REMATCH[2]}")"
      if [ "$key" = "$name" ]; then
        if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:${#value}-2}"
        fi
        printf '%s' "$value"
        return 0
      fi
    fi
  done < "$secrets_file"

  return 1
}

reject_secret_env() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    log "${name} must be configured in ${secrets_file}, not the container environment"
    exit 1
  fi
}

uses_codex_provider() {
  return 0
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
  log "Authenticating Codex with CODEX_ACCESS_TOKEN from ${secrets_file}"
  printf '%s\n' "$codex_access_token" | run_codex login --with-access-token
elif [ -n "$openai_api_key" ]; then
  log "Authenticating Codex with OPENAI_API_KEY from ${secrets_file}"
  printf '%s\n' "$openai_api_key" | run_codex login --with-api-key
elif run_codex login status >/dev/null 2>&1; then
  log "Codex is already authenticated"
else
  log "No Codex env credential found; starting device-code auth"
  run_codex login --device-auth
fi
