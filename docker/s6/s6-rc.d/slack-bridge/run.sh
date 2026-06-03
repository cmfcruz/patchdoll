#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="slack-bridge"

export PATCHDOLL_SECRETS_ENV_ALLOWED=1
slack_bot_token="$(secret_value PATCHDOLL_SLACK_BOT_TOKEN || true)"
slack_app_token="$(secret_value PATCHDOLL_SLACK_APP_TOKEN || true)"
if [ -n "$slack_bot_token" ]; then
  export PATCHDOLL_SLACK_BOT_TOKEN="$slack_bot_token"
fi
if [ -n "$slack_app_token" ]; then
  export PATCHDOLL_SLACK_APP_TOKEN="$slack_app_token"
fi

cd /app/packages/adapter-slack
exec s6-setuidgid patchdoll node /app/packages/adapter-slack/app.cjs
