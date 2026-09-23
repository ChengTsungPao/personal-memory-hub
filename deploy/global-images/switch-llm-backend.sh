#!/usr/bin/env bash
# switch-llm-backend.sh — flip memory-core/memory-hub's MEMORY_LLM_* between
# the local Ollama/Qwen model and the claude-llm-proxy (Claude Pro/Max
# subscription via `claude -p`), then re-run start-memory-core.sh /
# start-memory-hub.sh so the new binding actually takes effect.
#
# Usage:
#   ./switch-llm-backend.sh proxy   # Claude subscription (../claude-llm-proxy)
#   ./switch-llm-backend.sh qwen    # local Ollama qwen3-mem
#   ./switch-llm-backend.sh status  # print which one .env currently points at
#
# IMPORTANT: claude-llm-proxy only implements plain-text completion (L1
# extraction). Switching to "proxy" mode will make L2 scene extraction, L3
# persona generation, and Knowledge Service wiki ingest/summarize fail
# (they call with tools enabled, which the proxy explicitly rejects) until
# tool-calling support is added to the proxy, or you switch back to "qwen".

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Required on Windows Git Bash: without it, Git Bash rewrites the container-side
# half of `-v host:/data/config/tdai-gateway.yaml` into a bogus Windows path, the
# mount lands nowhere, and memory-core silently falls back to its built-in
# gpt-4o/OpenAI config (see agents/claude-code/README.md "Setup" step 1). No-op
# on macOS/Linux.
export MSYS_NO_PATHCONV=1

load_env
ENV_FILE="$SCRIPT_DIR/.env"

QWEN_URL="http://host.docker.internal:11434/v1"
QWEN_KEY="ollama"
QWEN_MODEL="qwen3-mem"

PROXY_URL="http://host.docker.internal:8622/v1"
PROXY_KEY="local"
PROXY_MODEL="sonnet"

set_env_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Portable in-place edit (works on both GNU and BSD/macOS sed).
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

case "${1:-}" in
  proxy)
    warn "切到 claude-llm-proxy —— L2 场景抽取 / L3 人格生成 / Knowledge wiki 摘要会开始失败"
    warn "（proxy 只支持纯文字 L1 抽取，收到 tools 请求会直接报错，不会产生坏数据）。"
    set_env_var MEMORY_LLM_BASE_URL "$PROXY_URL"
    set_env_var MEMORY_LLM_API_KEY "$PROXY_KEY"
    set_env_var MEMORY_LLM_MODEL "$PROXY_MODEL"
    set_env_var MEMORY_LLM_PROTOCOL "openai"
    ;;
  qwen)
    set_env_var MEMORY_LLM_BASE_URL "$QWEN_URL"
    set_env_var MEMORY_LLM_API_KEY "$QWEN_KEY"
    set_env_var MEMORY_LLM_MODEL "$QWEN_MODEL"
    set_env_var MEMORY_LLM_PROTOCOL "openai"
    ;;
  status)
    load_env
    case "${MEMORY_LLM_BASE_URL:-}" in
      "$PROXY_URL") echo "proxy (claude-llm-proxy, model=${MEMORY_LLM_MODEL:-})" ;;
      "$QWEN_URL") echo "qwen (local Ollama, model=${MEMORY_LLM_MODEL:-})" ;;
      *) echo "unknown (MEMORY_LLM_BASE_URL=${MEMORY_LLM_BASE_URL:-<unset>})" ;;
    esac
    exit 0
    ;;
  *)
    die "用法: $0 proxy|qwen|status"
    ;;
esac

ok ".env 已更新 → MEMORY_LLM_BASE_URL=$(grep '^MEMORY_LLM_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
info "重新拉起 memory-core / memory-hub 以套用新设定..."
"$SCRIPT_DIR/start-memory-core.sh"
"$SCRIPT_DIR/start-memory-hub.sh"
ok "切换完成 → $1"
