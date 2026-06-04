# syntax=docker/dockerfile:1.7

# Build with digest-pinned images in CI when possible, for example:
#   docker build --build-arg NODE_BUILD_IMAGE=node:24-bookworm@sha256:... .
ARG NODE_BUILD_IMAGE=node:24-bookworm
ARG NODE_RUNTIME_IMAGE=node:24-bookworm
ARG SAFE_CHAIN_VERSION=1.5.2
ARG SAFE_CHAIN_INSTALL_DIR=/usr/local/.safe-chain
ARG S6_OVERLAY_VERSION=3.2.1.0

FROM ${NODE_BUILD_IMAGE} AS safe-chain

ARG SAFE_CHAIN_VERSION
ARG SAFE_CHAIN_INSTALL_DIR

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN curl -fsSL "https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_VERSION}/install-safe-chain.sh" \
  | sh -s -- --ci --install-dir "${SAFE_CHAIN_INSTALL_DIR}"

ENV PATH="${SAFE_CHAIN_INSTALL_DIR}/shims:${SAFE_CHAIN_INSTALL_DIR}/bin:${PATH}" \
  SAFE_CHAIN_LOGGING=silent \
  SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=48 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false

RUN npm safe-chain-verify

FROM safe-chain AS deps

WORKDIR /app

COPY package*.json ./
COPY packages ./packages

RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds. Generate it in the approved dependency container, then rebuild." >&2; exit 1)

RUN npm ci --ignore-scripts

FROM deps AS build

WORKDIR /app

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages

RUN npm run build

FROM safe-chain AS prod-deps

WORKDIR /app

COPY package*.json ./
COPY packages ./packages

RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds. Generate it in the approved dependency container, then rebuild." >&2; exit 1)

RUN npm ci --omit=dev --ignore-scripts \
  && mkdir -p node_modules

FROM ${NODE_BUILD_IMAGE} AS peercred

WORKDIR /src
COPY tools/patchdoll-peercred.c ./patchdoll-peercred.c
RUN cc -O2 -Wall -Wextra -o /patchdoll-peercred ./patchdoll-peercred.c

FROM ${NODE_BUILD_IMAGE} AS validation

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /validation

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends python3-yaml; \
  rm -rf /var/lib/apt/lists/*

COPY docker/skills ./docker/skills

RUN python3 -c $'from pathlib import Path\n\
import yaml\n\
\n\
for skill in Path("docker/skills").glob("*/SKILL.md"):\n\
    text = skill.read_text(encoding="utf-8")\n\
    if not text.startswith("---\\n"):\n\
        raise SystemExit(f"{skill}: missing YAML frontmatter")\n\
    _, frontmatter, body = text.split("---", 2)\n\
    data = yaml.safe_load(frontmatter)\n\
    if not isinstance(data, dict) or not data.get("name") or not data.get("description"):\n\
        raise SystemExit(f"{skill}: frontmatter must include name and description")\n\
    if not body.strip():\n\
        raise SystemExit(f"{skill}: missing skill body")\n\
Path("/validation-ok").write_text("ok\\n", encoding="utf-8")'

FROM ${NODE_RUNTIME_IMAGE} AS runtime

ARG S6_OVERLAY_VERSION
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) s6_arch="x86_64" ;; \
    arm64) s6_arch="aarch64" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH:-unset}" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo /tmp/s6-overlay-noarch.tar.xz \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
  curl -fsSLo /tmp/s6-overlay-${s6_arch}.tar.xz \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz"; \
  tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-${s6_arch}.tar.xz; \
  rm -f /tmp/s6-overlay-*.tar.xz

RUN set -eux; \
  curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null; \
  echo "deb [signed-by=/etc/apt/trusted.gpg.d/ngrok.asc] https://ngrok-agent.s3.amazonaws.com bookworm main" \
    > /etc/apt/sources.list.d/ngrok.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ca-certificates gawk git gh grep ngrok jq \
    podman podman-docker buildah skopeo crun \
    fuse-overlayfs slirp4netns uidmap; \
  rm -rf /var/lib/apt/lists/*; \
  : "podman-docker drops a docker(1) shim; silence its 'Emulate Docker CLI' notice"; \
  touch /etc/containers/nodocker

ENV PATH="/app/node_modules/.bin:${PATH}" \
  NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  PATCHDOLL_SLACK_COMMAND=/patchdoll \
  S6_READ_ONLY_ROOT=1 \
  S6_SERVICES_GRACETIME=8000 \
  S6_KILL_GRACETIME=1000

WORKDIR /workspace

# Rootless podman for the agent user: the subuid/subgid range below lives in
# the image, but it only works if the host enables user namespaces
# (user.max_user_namespaces > 0, and nested userns when this image is itself
# run in a container). That sysctl is host kernel state and cannot be set here.
#
# A single `agent` user runs whichever provider (Codex or Claude) is selected;
# the runtime invariant is that only one agent runs at a time, so per-provider
# OS users are unnecessary. One user means one home (/patchdoll/agent) and one
# subuid range instead of hand-partitioned per-provider ranges.
RUN groupmod -n patchdoll node \
  && usermod -l patchdoll -d /home/patchdoll -m node \
  && groupadd --system patchdoll-ipc \
  && groupadd --system agent \
  && useradd --system --create-home --home-dir /home/agent --gid agent --groups patchdoll-ipc agent \
  && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 agent \
  && usermod --append --groups patchdoll-ipc patchdoll \
  && mkdir -p /app/slack /run/secrets /run/patchdoll/providers /workspace /patchdoll/state /patchdoll/agent /etc/codex \
  && chown -R patchdoll:patchdoll /app \
  && chown root:patchdoll /run/secrets \
  && chmod 0750 /run/secrets \
  && chown patchdoll:patchdoll-ipc /run/patchdoll \
  && chmod 2770 /run/patchdoll \
  && chown -R agent:patchdoll-ipc /run/patchdoll/providers /patchdoll/agent \
  && chown -R agent:patchdoll-ipc /workspace \
  && chown root:root /etc/codex \
  && chmod 0555 /etc/codex \
  && chmod 2770 /run/patchdoll/providers \
  && chmod 0770 /patchdoll/agent \
  && chmod 2770 /workspace \
  && chown -R agent:patchdoll-ipc /patchdoll/state \
  && chmod 2770 /patchdoll/state

COPY --from=prod-deps --chown=patchdoll:patchdoll /app/package.json /app/package.json
COPY --from=prod-deps --chown=patchdoll:patchdoll /app/node_modules /app/node_modules
COPY --from=build --chown=patchdoll:patchdoll /app/packages /app/packages
COPY --from=validation /validation-ok /tmp/patchdoll-validation-ok
COPY --from=peercred --chown=root:root /patchdoll-peercred /usr/local/bin/patchdoll-peercred
COPY --chown=root:root docker/codex/AGENTS.md /etc/codex/AGENTS.md
COPY --chown=root:root docker/skills /etc/codex/skills
COPY --chown=root:root docker/skills /etc/claude/skills
COPY --chown=root:root docker/cont-init.d/ /etc/cont-init.d/
COPY --chown=root:root docker/s6/scripts/ /etc/s6-overlay/scripts/
COPY docker/s6/s6-rc.d/ /etc/s6-overlay/s6-rc.d/

RUN rm -f /tmp/patchdoll-validation-ok \
  && ln -sf /app/packages/core/dist/patchdollctl.js /usr/local/bin/patchdollctl \
  && case "${TARGETARCH:-amd64}" in \
    amd64) claude_arch="x64" ;; \
    arm64) claude_arch="arm64" ;; \
    *) echo "Unsupported TARGETARCH for Claude Code: ${TARGETARCH:-unset}" >&2; exit 1 ;; \
  esac \
  && claude_binary="/app/packages/provider-claude/node_modules/@anthropic-ai/claude-code-linux-${claude_arch}/claude" \
  && test -x "${claude_binary}" \
  && ln -sf "${claude_binary}" /usr/local/bin/claude \
  && chmod 0444 /etc/codex/AGENTS.md \
  && find /etc/codex/skills -type d -exec chmod 0555 {} + \
  && find /etc/codex/skills -type f -exec chmod 0444 {} + \
  && find /etc/claude/skills -type d -exec chmod 0555 {} + \
  && find /etc/claude/skills -type f -exec chmod 0444 {} + \
  && chmod +x \
  /etc/cont-init.d/10-patchdoll-secrets \
  /etc/s6-overlay/s6-rc.d/claude-auth/auth.sh \
  /etc/s6-overlay/s6-rc.d/claude-auth/up \
  /etc/s6-overlay/s6-rc.d/claude-worker/run \
  /etc/s6-overlay/s6-rc.d/claude-worker/run.sh \
  /etc/s6-overlay/s6-rc.d/codex-auth/up \
  /etc/s6-overlay/s6-rc.d/codex-worker/run \
  /etc/s6-overlay/s6-rc.d/codex-worker/run.sh \
  /etc/s6-overlay/s6-rc.d/ngrok-tunnel/run \
  /etc/s6-overlay/s6-rc.d/ngrok-tunnel/run.sh \
  /etc/s6-overlay/s6-rc.d/patchdoll/run \
  /etc/s6-overlay/s6-rc.d/patchdoll/run.sh \
  /etc/s6-overlay/s6-rc.d/slack-bridge/run \
  /etc/s6-overlay/s6-rc.d/slack-bridge/run.sh \
  /usr/local/bin/patchdoll-peercred \
  /app/packages/core/dist/patchdollctl.js \
  /usr/local/bin/patchdollctl

EXPOSE 3000

STOPSIGNAL SIGTERM
ENTRYPOINT ["/init"]
CMD []
