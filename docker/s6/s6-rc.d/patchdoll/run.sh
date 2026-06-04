#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/patchdoll
chown patchdoll:patchdoll-ipc /run/patchdoll
chmod 2770 /run/patchdoll

cd /workspace
exec s6-setuidgid patchdoll node /app/packages/core/dist/server.js
