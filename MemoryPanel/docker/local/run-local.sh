#!/bin/bash
# run-local.sh — build + run the mobile-friendly Panel (port 8123), alongside
# the official agentmemory/memory-hub deployment (port 8125). Neither touches
# the other; this is a separate, opt-in Panel build.
#
# What this is: MemoryPanel/web's own source, patched here for:
#   - responsive layout at phone widths (header, sidebar, detail view)
#   - Traditional Chinese UI strings (was Simplified upstream)
# See MemoryPanel/README.mobile.md for details and the visual before/after.
#
# Requires: config/metadata-instances.json (gitignored — create it first):
#   cp config/metadata-instances.example.json config/metadata-instances.json
#   # then point gateway_endpoint at your MemoryCore, e.g.:
#   #   "gateway_endpoint": "http://host.docker.internal:8420"
#   #   "api_key": "local"   (any non-empty string — see docs/claude-code/README.md
#   #                         "the gateway needs an Authorization header even
#   #                         with no apiKey set")
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # -> MemoryPanel/

CONFIG=config/metadata-instances.json
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG — see this script's header comment." >&2
  exit 1
fi

echo "Building team-memory-control:local ..."
MSYS_NO_PATHCONV=1 docker build --build-arg PANEL_UI=web \
  -t team-memory-control:local -f docker/local/Dockerfile.local .

docker rm -f team-memory-control-local >/dev/null 2>&1 || true

CONFIG_HOST_PATH="$PWD/$CONFIG"
if command -v cygpath >/dev/null 2>&1; then
  CONFIG_HOST_PATH=$(cygpath -m "$CONFIG_HOST_PATH")  # Git Bash: /c/... -> C:/...
fi

echo "Starting on :8123 ..."
MSYS_NO_PATHCONV=1 docker run -d --name team-memory-control-local \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 8123:8123 \
  -e METADATA_INSTANCES_CONFIG=/app/config/metadata-instances.json \
  -v "$CONFIG_HOST_PATH":/app/config/metadata-instances.json:ro \
  team-memory-control:local >/dev/null

sleep 3
if curl -sf -m 5 http://127.0.0.1:8123/health >/dev/null; then
  echo "OK -> http://localhost:8123/  (LAN: http://<this machine's IP>:8123/)"
else
  echo "Container started but health check failed — check: docker logs team-memory-control-local" >&2
fi
