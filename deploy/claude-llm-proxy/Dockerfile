# claude-llm-proxy — containerized so it survives the way memory-core/
# memory-hub/Panel already do (--restart unless-stopped), instead of being a
# bare background process tied to whatever terminal/session started it. That
# was the actual cause of it getting killed under host memory pressure —
# Docker's restart policy is unaffected by that, the other three containers
# never went down over the same period.
#
# Needs the `claude` CLI (for subscription auth via CLAUDE_CODE_OAUTH_TOKEN)
# and the `docker` CLI + bash (server.mjs's /control/backend shells out to
# ../global-images/switch-llm-backend.sh, which itself runs `docker run` to
# restart memory-core/memory-hub — see run-docker.sh for how the socket and
# repo path get mounted in).
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash docker.io git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Deliberately no COPY: run-docker.sh bind-mounts this repo's deploy/ dir in
# (server.mjs, .env, claude-config/, workdir/, and ../global-images/ as
# siblings, matching the host layout) so server.mjs's `path.join(__dirname, …)`
# relative paths resolve exactly as they do outside Docker — including the
# `../global-images/switch-llm-backend.sh` call — with no code changes.
WORKDIR /deploy/claude-llm-proxy

EXPOSE 8622
CMD ["node", "server.mjs"]
