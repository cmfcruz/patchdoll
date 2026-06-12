#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=docker/s6/scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag=github-observe-runtime

state_file=/run/patchdoll/github-observe-runtime.env
observe_issues_enabled="${PATCHDOLL_GITHUB_OBSERVE_ISSUES_ENABLED:-false}"
observe_prs_enabled="${PATCHDOLL_GITHUB_OBSERVE_PRS_ENABLED:-false}"
worker_image="${PATCHDOLL_GITHUB_OBSERVE_WORKER_IMAGE:-}"
check_timeout_seconds="${PATCHDOLL_GITHUB_OBSERVE_RUNTIME_CHECK_TIMEOUT_SECONDS:-10}"

write_status() {
  local status="$1" reason="${2:-}"
  local state_dir

  state_dir="$(dirname "$state_file")"
  mkdir -p "$state_dir"
  chown patchdoll:patchdoll-ipc "$state_dir" 2>/dev/null || true
  chmod 2770 "$state_dir"

  umask 007
  {
    printf 'PATCHDOLL_GITHUB_OBSERVE_RUNTIME_STATUS=%s\n' "$status"
    if [ -n "$reason" ]; then
      printf 'PATCHDOLL_GITHUB_OBSERVE_RUNTIME_REASON=%s\n' "$reason"
    fi
  } > "$state_file"
  chown patchdoll:patchdoll-ipc "$state_file" 2>/dev/null || true
  chmod 0660 "$state_file"
}

check_rootless_podman() {
  local podman_info rootless graph_root podman_status image_status

  if ! command -v podman >/dev/null 2>&1; then
    write_status unavailable podman_missing
    log "GitHub observe requested, but podman is not installed"
    return 0
  fi

  if podman_info="$(timeout "${check_timeout_seconds}s" s6-setuidgid agent podman info --format '{{printf "%v|%s" .Host.Security.Rootless .Store.GraphRoot}}' 2>/dev/null)"; then
    rootless="${podman_info%%|*}"
    graph_root="${podman_info#*|}"
  else
    podman_status="$?"
    if [ "$podman_status" = "124" ]; then
      write_status unavailable podman_info_timeout
      log "GitHub observe requested, but rootless podman info timed out for the agent user"
    else
      write_status unavailable podman_info_failed
      log "GitHub observe requested, but rootless podman info failed for the agent user"
    fi
    return 0
  fi

  if [ "$rootless" != "true" ]; then
    write_status unavailable podman_not_rootless
    log "GitHub observe requested, but podman is not running rootless for the agent user"
    return 0
  fi

  if [ -z "$graph_root" ] || [ "$graph_root" = "$podman_info" ]; then
    write_status unavailable podman_storage_unavailable
    log "GitHub observe requested, but rootless podman storage is unavailable"
    return 0
  fi

  if [ -z "$worker_image" ]; then
    write_status unavailable worker_image_unconfigured
    log "GitHub observe requested, but PATCHDOLL_GITHUB_OBSERVE_WORKER_IMAGE is not configured"
    return 0
  fi

  if timeout "${check_timeout_seconds}s" s6-setuidgid agent podman image exists "$worker_image" >/dev/null 2>&1; then
    write_status available
    log "GitHub observe container runtime is available"
    return 0
  fi

  image_status="$?"
  if [ "$image_status" = "124" ]; then
    write_status unavailable worker_image_check_timeout
    log "GitHub observe requested, but checking the configured worker image timed out"
  else
    write_status unavailable worker_image_missing
    log "GitHub observe requested, but the configured worker image is not available locally"
  fi
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
  log "GitHub observe runtime check failed unexpectedly"
  exit 0
}
