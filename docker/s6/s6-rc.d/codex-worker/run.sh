#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="codex-worker"

socket_path="/run/patchdoll/providers/codex.sock"
socket_dir="$(dirname "$socket_path")"
codex_home="/patchdoll/agent"
state_dir="/patchdoll/state"
workspace_dir="/workspace"
operator_agents="/etc/agent/AGENTS.md"

mkdir -p /run/patchdoll "$socket_dir" "$codex_home" "$state_dir" "$workspace_dir"
chown patchdoll:patchdoll-ipc /run/patchdoll
chmod 2770 /run/patchdoll
if [ -d /etc/agent/skills ]; then
  mkdir -p "$codex_home/skills"
  cp -Rn /etc/agent/skills/. "$codex_home/skills/"
fi

if [ ! -r "$operator_agents" ]; then
  log "missing readable operator Codex instructions: ${operator_agents}"
  exit 1
fi
if [ "$(stat -c '%u' "$operator_agents")" != "0" ]; then
  log "operator Codex instructions must be owned by root: ${operator_agents}"
  exit 1
fi
if [ "$(stat -c '%a' "$operator_agents")" != "444" ]; then
  log "operator Codex instructions must have mode 0444: ${operator_agents}"
  exit 1
fi

chown agent:patchdoll-ipc "$socket_dir" "$codex_home"
chmod 2770 "$socket_dir"
chmod 0770 "$codex_home"
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

export HOME="$codex_home"
export CODEX_HOME="$codex_home"

if command -v git >/dev/null 2>&1 && command -v gh >/dev/null 2>&1; then
  s6-setuidgid agent git config --global --replace-all credential.https://github.com.helper '!gh auth git-credential'
fi

exec s6-setuidgid agent node /app/packages/provider-codex/dist/worker.js
