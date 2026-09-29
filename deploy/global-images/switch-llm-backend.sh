#!/usr/bin/env bash
# switch-llm-backend.sh — flip memory-core/memory-hub's MEMORY_LLM_* between
# the local Ollama/Qwen model, the claude-llm-proxy (Claude Pro/Max
# subscription via `claude -p`), or OpenRouter, then re-run
# start-memory-core.sh / start-memory-hub.sh so the new binding actually
# takes effect.
#
# Usage:
#   ./switch-llm-backend.sh proxy       # Claude subscription (../claude-llm-proxy)
#   ./switch-llm-backend.sh qwen        # local Ollama qwen3-mem
#   ./switch-llm-backend.sh openrouter  # OpenRouter (real OpenAI-compatible API,
#                                        #   native tool-calling — no proxy workarounds)
#   ./switch-llm-backend.sh status      # print which one .env currently points at
#
# openrouter mode reads OPENROUTER_API_KEY / OPENROUTER_MODEL from .env — set
# those first (see .env.example) or this refuses with a clear error.
#
# claude-llm-proxy emulates OpenAI tool-calling for L2/L3 by shelling out to
# `claude -p` (see deploy/claude-llm-proxy/server.mjs) — it works, but it's a
# workaround layered on a CLI never designed for this, verified only by
# simulation so far, not a live L2/L3 trigger. openrouter has none of that:
# it's a real OpenAI-compatible API with native tool-calling.

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

OPENROUTER_URL="https://openrouter.ai/api/v1"

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
  openrouter)
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
      die "OPENROUTER_API_KEY 未設定 — 先在 .env 填上 OPENROUTER_API_KEY / OPENROUTER_MODEL（見 .env.example）再切這個模式"
    fi
    if [[ -z "${OPENROUTER_MODEL:-}" ]]; then
      die "OPENROUTER_MODEL 未設定 — 先在 .env 填上要用的 OpenRouter model id（例如 anthropic/claude-sonnet-4.5）"
    fi
    set_env_var MEMORY_LLM_BASE_URL "$OPENROUTER_URL"
    set_env_var MEMORY_LLM_API_KEY "$OPENROUTER_API_KEY"
    set_env_var MEMORY_LLM_MODEL "$OPENROUTER_MODEL"
    set_env_var MEMORY_LLM_PROTOCOL "openai"
    ;;
  status)
    load_env
    case "${MEMORY_LLM_BASE_URL:-}" in
      "$PROXY_URL") echo "proxy (claude-llm-proxy, model=${MEMORY_LLM_MODEL:-})" ;;
      "$QWEN_URL") echo "qwen (local Ollama, model=${MEMORY_LLM_MODEL:-})" ;;
      "$OPENROUTER_URL") echo "openrouter (model=${MEMORY_LLM_MODEL:-})" ;;
      *) echo "unknown (MEMORY_LLM_BASE_URL=${MEMORY_LLM_BASE_URL:-<unset>})" ;;
    esac
    exit 0
    ;;
  *)
    die "用法: $0 proxy|qwen|openrouter|status"
    ;;
esac

ok ".env 已更新 → MEMORY_LLM_BASE_URL=$(grep '^MEMORY_LLM_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
info "重新拉起 memory-core / memory-hub 以套用新设定..."
"$SCRIPT_DIR/start-memory-core.sh"
"$SCRIPT_DIR/start-memory-hub.sh"
ok "切换完成 → $1"
