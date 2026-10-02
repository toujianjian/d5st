#!/usr/bin/env bash
# 数据库迁移脚本（导出 / 导入 d5st + casdoor 两个库）
# 用法：
#   ./docker/db-migrate.sh export [输出文件]
#   ./docker/db-migrate.sh import <备份文件>
#
# 说明：
#   - 在项目根目录（docker-compose.yml 所在目录）执行。
#   - 必须同时导出 d5st 与 casdoor 两个库：
#       d5st    = 站点数据（用户映射、帖子、好友、积分…）
#       casdoor = 认证数据（Casdoor 用户/组织/应用/Provider…）
#     只导 d5st 会出现"本地有用户、Casdoor 没有"的不一致。
#   - 导入会覆盖目标环境这两个库的同名表，导入前请自行备份目标库。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_PWD="d5st_root_2026"
if [ -f .env ]; then
  v=$(grep -E '^MYSQL_ROOT_PASSWORD=' .env | head -n1 | cut -d= -f2- | tr -d '\r' || true)
  [ -n "${v:-}" ] && ROOT_PWD="$v"
fi

ACTION="${1:-}"
case "$ACTION" in
  export)
    OUT="${2:-backup/d5st-backup-$(date +%Y%m%d-%H%M%S).sql}"
    mkdir -p "$(dirname "$OUT")"
    echo "[export] d5st + casdoor -> $OUT"
    docker compose exec -T mysql mysqldump -uroot -p"$ROOT_PWD" \
      --databases d5st casdoor \
      --single-transaction --routines --triggers \
      --default-character-set=utf8mb4 > "$OUT"
    echo "[export] 完成：$OUT"
    ;;
  import)
    FILE="${2:-}"
    [ -z "$FILE" ] && { echo "import 需要指定备份文件"; exit 1; }
    [ -f "$FILE" ] || { echo "备份文件不存在: $FILE"; exit 1; }
    echo "[import] 从 $FILE 导入（将覆盖 d5st / casdoor 同名表）..."
    docker compose exec -T mysql mysql -uroot -p"$ROOT_PWD" < "$FILE"
    echo "[import] 完成，建议重启应用： docker compose restart app"
    ;;
  *)
    echo "用法: $0 export [输出文件] | $0 import <备份文件>"
    exit 1
    ;;
esac
