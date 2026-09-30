#!/usr/bin/env bash
# 停止并移除三件套容器。
#
# 用法：
#   ./stop-all.sh              # 停容器，保留 volume（数据保留）
#   ./stop-all.sh --purge      # 停容器 + 删 volume + 删网络（彻底清理）

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
fi

# .env 不存在时也允许运行（用默认卷名兜底）
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
MEMORY_CORE_DATA_DIR="${MEMORY_CORE_DATA_DIR:-$HOME/.personal-memory-hub/core-data}"
PANEL_DATA_DIR="${PANEL_DATA_DIR:-$HOME/.personal-memory-hub/panel-data}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-tdai-mongo-local}"

for c in tdai-proxy tdai-memory-hub tdai-memory-core "$MONGO_LOCAL_CONTAINER"; do
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    info "停止并移除 $c"
    $DOCKER rm -f "$c" >/dev/null
  else
    info "$c 未运行，跳过"
  fi
done

if (( PURGE == 1 )); then
  warn "--purge 已启用：移开数据目录与 admin key + 删除网络"
  # 宿主机数据目录不直接删除：改名成 *.purged-<时间>，确认不需要再自己删。
  for d in "$MEMORY_CORE_DATA_DIR" "$PANEL_DATA_DIR"; do
    if [[ -d "$d" ]]; then
      mv "$d" "$d.purged-$(date +%Y%m%d%H%M%S)" && ok "已移开数据目录 $d（改名为 .purged-*，未删除）" || warn "移开 $d 失败"
    fi
  done
  for v in mongo-local-db mongo-local-configdb mongo-local-mongot; do
    if $DOCKER volume inspect "$v" >/dev/null 2>&1; then
      $DOCKER volume rm "$v" >/dev/null && ok "已删除 volume $v" || warn "删除 volume $v 失败"
    fi
  done
  if $DOCKER network inspect tdai-memory-stack >/dev/null 2>&1; then
    $DOCKER network rm tdai-memory-stack >/dev/null && ok "已删除网络 tdai-memory-stack" || true
  fi
  # admin key 与 volume 强绑定，purge volume 必须同步清 key，否则下次启动会读到
  # 旧 key 但 volume 是新的，auth 校验会失败。
  ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$HOME/.personal-memory-hub/admin-key}"
  if [[ -f "$ADMIN_KEY_FILE" ]]; then
    mv "$ADMIN_KEY_FILE" "$ADMIN_KEY_FILE.purged-$(date +%Y%m%d%H%M%S)" && ok "已移开 admin key 文件 $ADMIN_KEY_FILE（未删除）"
  fi
  # 顺带清 proxy / memory-core 生成的 config
  PROXY_CFG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
  if [[ -d "$PROXY_CFG_DIR" ]]; then
    rm -rf "$PROXY_CFG_DIR" && ok "已删除 proxy config 目录 $PROXY_CFG_DIR"
  fi
  CORE_CFG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
  if [[ -d "$CORE_CFG_DIR" ]]; then
    rm -rf "$CORE_CFG_DIR" && ok "已删除 memory-core config 目录 $CORE_CFG_DIR"
  fi
fi

ok "完成。"
