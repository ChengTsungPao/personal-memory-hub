#!/usr/bin/env bash
# run-docker.sh — build + run claude-llm-proxy as a container with
# --restart unless-stopped, matching memory-core/memory-hub/Panel instead of
# being a bare background process (see Dockerfile header for why that
# mattered: it got killed under host memory pressure, the other three never
# did over the same period).
#
# Mounts this repo's deploy/ directory in at the same relative layout it has
# on the host (claude-llm-proxy/ next to global-images/), so server.mjs's
# `path.join(__dirname, ...)` calls — including the
# `../global-images/switch-llm-backend.sh` one behind /control/backend —
# resolve unchanged, no code paths baked differently for Docker vs bare.
#
# KNOWN BROKEN (not solved here): /control/backend's switch shells out to
# switch-llm-backend.sh, which runs `docker run` for memory-core/memory-hub —
# from *inside* this container, that goes over the mounted Docker socket to
# the HOST's Docker daemon (Docker-outside-of-Docker), and any -v bind-mount
# paths that script builds (e.g. the generated tdai-gateway.yaml config) get
# built from *this container's* view of the filesystem (/deploy/...), which
# is not a path that exists on the actual Windows host the daemon runs
# against. The /v1/chat/completions endpoint (this container's actual point)
# is unaffected — it never shells out to docker. Switching backends via the
# web UI while the proxy itself runs in this container will likely fail with
# a mount error; use `switch-llm-backend.sh` directly from the host instead
# until this is solved for real (would need each container-relative path the
# script builds translated back to its host equivalent before use, or a
# rewrite that never generates host-facing bind-mount paths in the first
# place).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "Missing $SCRIPT_DIR/.env — cp .env.example .env and fill in CLAUDE_CODE_OAUTH_TOKEN first." >&2
  exit 1
fi

# Docker Desktop's Windows CLI needs C:/... form for -v host paths — same
# reason MemoryPanel/docker/local/run-local.sh converts its config path the
# same way. Mounting at the identical path on both sides of the colon is
# what the Docker-outside-of-Docker caveat above is banking on.
DEPLOY_DIR_WIN="$DEPLOY_DIR"
if command -v cygpath >/dev/null 2>&1; then
  DEPLOY_DIR_WIN=$(cygpath -m "$DEPLOY_DIR")
fi

echo "Building claude-llm-proxy:local ..."
(cd "$SCRIPT_DIR" && MSYS_NO_PATHCONV=1 docker build -t claude-llm-proxy:local -f Dockerfile .)

docker rm -f claude-llm-proxy >/dev/null 2>&1 || true

echo "Starting on :8622 ..."
MSYS_NO_PATHCONV=1 docker run -d --name claude-llm-proxy \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 8622:8622 \
  -v "$DEPLOY_DIR_WIN":/deploy \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -w /deploy/claude-llm-proxy \
  claude-llm-proxy:local >/dev/null

sleep 2
if curl -sf -m 5 http://127.0.0.1:8622/health >/dev/null; then
  echo "OK -> http://localhost:8622/"
else
  echo "Container started but health check failed — check: docker logs claude-llm-proxy" >&2
fi
