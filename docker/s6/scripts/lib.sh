#!/usr/bin/env bash
# Shared helpers for Patchdoll s6 service scripts and cont-init hooks.
# This file is sourced, not executed; callers run under `set -euo pipefail`.
#
# Set `log_tag` to the service name before calling log().

# Secret env files, tried in order. Within a file the last assignment wins,
# matching the semantics of sourcing the file.
secrets_files="/run/secrets/patchdoll.env /run/patchdoll/secrets.env"

log() {
  printf '%s: %s\n' "${log_tag:-patchdoll}" "$*" >&2
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

# Print the value assigned to a key in the secret env files.
# Keys are fixed literals (e.g. ANTHROPIC_API_KEY), so interpolating $name into
# the regex is safe — keep callers passing literal key names.
secret_value() {
  local name="$1" file line
  for file in $secrets_files; do
    [ -r "$file" ] || continue
    # grep locates the assignment; tail keeps the last one so a later
    # assignment overrides an earlier one.
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$file" | tail -n1)" || true
    [ -n "$line" ] || continue
    line="${line#*=}"                    # drop the key and '='
    line="${line%\"}"; line="${line#\"}" # strip optional double quotes
    line="${line%\'}"; line="${line#\'}" # strip optional single quotes
    printf '%s' "$line"
    return 0
  done
  return 1
}

# Single-quote a value so it round-trips when the env file is sourced.
shell_quote() {
  local value="$1"
  printf "'"
  printf '%s' "$value" | sed "s/'/'\\''/g"
  printf "'"
}

# Move a secret out of the process environment into the root-owned env file so
# it is not inherited by unrelated child processes.
stash_secret_env() {
  local name="$1"
  local secrets_file="/run/patchdoll/secrets.env"
  local secrets_dir="/run/patchdoll"
  local s6_env_dir

  if [ -z "${!name:-}" ]; then
    return 0
  fi

  if ! secret_value "$name" >/dev/null 2>&1; then
    umask 077
    mkdir -p "$secrets_dir"
    {
      printf '%s=' "$name"
      shell_quote "${!name}"
      printf '\n'
    } >> "$secrets_file"
    chmod 0600 "$secrets_file"
  fi

  for s6_env_dir in /var/run/s6/container_environment /run/s6/container_environment; do
    rm -f "${s6_env_dir}/${name}"
  done
  unset "$name"
}

reject_secret_env() {
  stash_secret_env "$1"
}

# Print the configured AI provider (lowercased), defaulting to codex.
# PATCHDOLL_AI_PROVIDER wins; otherwise read it through the CLI we already ship.
selected_provider() {
  local provider="${PATCHDOLL_AI_PROVIDER:-}"
  if [ -z "$provider" ]; then
    # `settings get` prints JSON, so a string value comes back double-quoted.
    provider="$(patchdollctl settings get ai.provider 2>/dev/null || true)"
    provider="${provider%\"}"; provider="${provider#\"}"
    [ "$provider" = "undefined" ] && provider=""
  fi
  provider="${provider,,}"
  printf '%s' "${provider:-codex}"
}
