#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/patchdoll
chown patchdoll:patchdoll-ipc /run/patchdoll
chmod 2770 /run/patchdoll

/etc/s6-overlay/scripts/intake-review-runtime-check.sh

cd /workspace
exec s6-setuidgid patchdoll node /app/packages/core/dist/server.js
