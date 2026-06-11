#!/usr/bin/env bash
set -euo pipefail

log_tag=patchdoll-intake-runtime
# shellcheck source=docker/s6/scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh

state_file=/run/patchdoll/intake-review-runtime.env
observe_issues_enabled="${PATCHDOLL_GITHUB_OBSERVE_ISSUES_ENABLED:-false}"
observe_prs_enabled="${PATCHDOLL_GITHUB_OBSERVE_PRS_ENABLED:-false}"
worker_image="${PATCHDOLL_GITHUB_OBSERVE_WORKER_IMAGE:-}"

write_status() {
  local status="$1" reason="${2:-}"

  umask 007
  {
    printf 'PATCHDOLL_INTAKE_REVIEW_RUNTIME_STATUS=%s\n' "$status"
    if [ -n "$reason" ]; then
      printf 'PATCHDOLL_INTAKE_REVIEW_RUNTIME_REASON=%s\n' "$reason"
    fi
  } > "$state_file"
  chown patchdoll:patchdoll-ipc "$state_file" 2>/dev/null || true
  chmod 0660 "$state_file"
}

check_rootless_podman() {
  local rootless graph_root

  if ! command -v podman >/dev/null 2>&1; then
    write_status unavailable podman_missing
    log "intake reviews requested, but podman is not installed"
    return 0
  fi

  if ! rootless="$(s6-setuidgid agent podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)"; then
    write_status unavailable podman_info_failed
    log "intake reviews requested, but rootless podman info failed for the agent user"
    return 0
  fi

  if [ "$rootless" != "true" ]; then
    write_status unavailable podman_not_rootless
    log "intake reviews requested, but podman is not running rootless for the agent user"
    return 0
  fi

  if ! graph_root="$(s6-setuidgid agent podman info --format '{{.Store.GraphRoot}}' 2>/dev/null)" || [ -z "$graph_root" ]; then
    write_status unavailable podman_storage_unavailable
    log "intake reviews requested, but rootless podman storage is unavailable"
    return 0
  fi

  if [ -z "$worker_image" ]; then
    write_status unavailable worker_image_unconfigured
    log "intake reviews requested, but PATCHDOLL_GITHUB_OBSERVE_WORKER_IMAGE is not configured"
    return 0
  fi

  if ! s6-setuidgid agent podman image exists "$worker_image" >/dev/null 2>&1; then
    write_status unavailable worker_image_missing
    log "intake reviews requested, but the configured worker image is not available locally"
    return 0
  fi

  write_status available
  log "intake review container runtime is available"
}

main() {
  if ! is_enabled "$observe_issues_enabled" && ! is_enabled "$observe_prs_enabled"; then
    write_status disabled
    log "GitHub observe disabled; skipping rootless podman checks"
    return 0
  fi

  check_rootless_podman
}

main "$@" || {
  write_status unavailable check_error || true
  log "intake review runtime check failed unexpectedly"
  exit 0
}
