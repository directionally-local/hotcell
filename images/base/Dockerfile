# Base sandbox image for hotcell — a general-purpose agent workspace.
# Python 3.11 + Node (22 LTS by default; NODE_MAJOR build arg) + git/bash and common build tools.
# Multi-arch (amd64 + arm64); published to GHCR by .github/workflows/publish-base-image.yml.
FROM python:3.11-slim-bookworm

# Node major line to install from NodeSource. Published as hotcell-base:node<major>.
ARG NODE_MAJOR=22

# OCI metadata — links the published GHCR package to this repo and sets provenance.
LABEL org.opencontainers.image.source="https://github.com/sinameraji/hotcell" \
      org.opencontainers.image.description="hotcell base sandbox — Python 3.11 + Node + git + build tools" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    NODE_VERSION=${NODE_MAJOR}

# socat backs the preview-URL proxy's binary-safe TCP bridge (clean half-close);
# the daemon falls back to a bash /dev/tcp bridge on images without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git bash build-essential procps \
        ripgrep jq tini socat \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Workspace is where agent code lives and persists for the sandbox lifetime.
WORKDIR /workspace

# tini as PID 1 → clean signal handling / zombie reaping for many concurrent execs.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Keep the container alive so the daemon can exec into it on demand.
CMD ["sleep", "infinity"]
