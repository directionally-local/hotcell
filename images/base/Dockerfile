# Base sandbox image for hotcell — a general-purpose agent workspace.
# Python 3.11 + Node (22 LTS by default; NODE_MAJOR build arg) + git/bash and common build tools,
# plus tsrs (VoidZero's Rust TypeScript checker) so agent typecheck loops are fast out of the box.
# Multi-arch (amd64 + arm64); published to GHCR by .github/workflows/publish-base-image.yml.
FROM python:3.11-slim-bookworm

# Node major line to install from NodeSource. Published as hotcell-base:node<major>.
ARG NODE_MAJOR=22

# tsrs build to install globally. Keep in sync with the root package.json pin so a
# sandbox typechecks with the same checker the repo's `typecheck:fast` uses.
ARG TSRS_VERSION=0.18.0-ts7.1.0-dev.20260929

# OCI metadata — links the published GHCR package to this repo and sets provenance.
LABEL org.opencontainers.image.source="https://github.com/directionally-local/hotcell" \
      org.opencontainers.image.description="hotcell base sandbox — Python 3.11 + Node + git + tsrs + build tools" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    NODE_VERSION=${NODE_MAJOR}

# socat backs the preview-URL proxy's binary-safe TCP bridge (clean half-close);
# the daemon falls back to a bash /dev/tcp bridge on images without it.
# `upgrade` also applies Debian security fixes to packages the python base
# image already ships (the publish workflow rebuilds without cache so new
# fixes, like libbrotli1's for CVE-2026-111497, are picked up).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git bash build-essential procps \
        ripgrep jq tini socat \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# tsrs: a fast TypeScript checker for agent loops (the repo pins the same build).
# Installed globally so `tsrs --noEmit -p tsconfig.json` works in any sandbox
# without a per-run install; the version check fails the build if the platform
# binary is missing.
RUN npm install -g --no-fund --no-audit tsrs@${TSRS_VERSION} \
    && tsrs --version

# Workspace is where agent code lives and persists for the sandbox lifetime.
WORKDIR /workspace

# tini as PID 1 → clean signal handling / zombie reaping for many concurrent execs.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Keep the container alive so the daemon can exec into it on demand.
CMD ["sleep", "infinity"]
