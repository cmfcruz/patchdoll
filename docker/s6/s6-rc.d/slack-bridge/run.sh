#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../scripts/lib.sh
. /etc/s6-overlay/scripts/lib.sh
log_tag="slack-bridge"

# Slack tokens are migrated into the root-owned secrets file and scrubbed from
# the environment by cont-init.d/10-patchdoll-secrets. The bridge runs in the
# patchdoll group and reads them straight from that file (readSlackSecrets), so
# there is nothing to re-export here.

cd /app/packages/adapter-slack
exec s6-setuidgid patchdoll node /app/packages/adapter-slack/app.cjs
