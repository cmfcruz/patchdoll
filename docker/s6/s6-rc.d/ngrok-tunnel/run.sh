#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "ngrok-tunnel: $*" >&2
}

wait_for_patchdoll() {
  local port="${PORT:-3000}"
  local attempts="${PATCHDOLL_NGROK_HEALTH_ATTEMPTS:-30}"
  local delay="${PATCHDOLL_NGROK_HEALTH_DELAY_SECONDS:-1}"

  log "waiting for Patchdoll health endpoint on 127.0.0.1:${port}"
  for _ in $(seq 1 "$attempts"); do
    if PATCHDOLL_HEALTH_URL="http://127.0.0.1:${port}/health" node -e '
      fetch(process.env.PATCHDOLL_HEALTH_URL)
        .then((response) => process.exit(response.ok ? 0 : 1))
        .catch(() => process.exit(1));
    '; then
      return 0
    fi
    sleep "$delay"
  done

  log "Patchdoll health endpoint did not become ready"
  exit 1
}

if [ -n "${PATCHDOLL_NGROK_AUTHTOKEN:-}" ]; then
  log "PATCHDOLL_NGROK_AUTHTOKEN must be configured in /run/secrets/patchdoll.env, not the container environment"
  exit 1
fi
ngrok_authtoken="$(awk -F= '
  $1 == "PATCHDOLL_NGROK_AUTHTOKEN" {
    sub(/^[^=]*=/, "")
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    print
    exit
  }
' /run/secrets/patchdoll.env 2>/dev/null || true)"
if [ -z "$ngrok_authtoken" ]; then
  log "disabled because PATCHDOLL_NGROK_AUTHTOKEN is not set in /run/secrets/patchdoll.env"
  exec sleep infinity
fi

if ! command -v ngrok >/dev/null 2>&1; then
  log "ngrok is not installed or not on PATH"
  exit 1
fi

wait_for_patchdoll

port="${PORT:-3000}"
upstream="http://127.0.0.1:${port}"
args=(http "$upstream" --log=stdout --log-format=json)

if [ -n "${PATCHDOLL_NGROK_DOMAIN:-}" ]; then
  domain="${PATCHDOLL_NGROK_DOMAIN#https://}"
  domain="${domain#http://}"
  domain="${domain%/}"
  args+=(--url "https://${domain}")
fi

export NGROK_AUTHTOKEN="$ngrok_authtoken"
log "starting ngrok tunnel for ${upstream}"
exec ngrok "${args[@]}"
