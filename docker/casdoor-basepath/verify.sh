#!/bin/sh
# ============================================================
# 补丁验证脚本
# 用法（在已构建的 casdoor 镜像内）：
#   docker run --rm --entrypoint /bin/sh <image> /verify.sh
# 校验：
#   1. index.html 资源引用带前缀
#   2. 无残留的裸 window.location.origin
#   3. 运行时前缀常量已注入
#   4. /casdoor/assets/... 能在容器内取到（前端资源可服务）
# ============================================================
set -e
PREFIX="${CASDOOR_BASE_PATH:-/casdoor}"
cd /web/build || exit 1

FAIL=0
pass() { echo "  [OK]   $1"; }
fail() { echo "  [FAIL] $1"; FAIL=1; }

echo "=== 1. index.html 资源引用 ==="
if grep -qE '(src|href)="'"$PREFIX"'/assets/' index.html; then
  pass "资源引用已带前缀 $PREFIX"
  grep -oE '(src|href)="[^"]*assets/[^"]*"' index.html | sed 's/^/         /'
else
  fail "index.html 中未发现带前缀的资源引用"
  grep -oE '(src|href)="[^"]*"' index.html | sed 's/^/         /'
fi

echo "=== 2. 裸 window.location.origin 残留 ==="
RESIDUAL=$(grep -rl 'window\.location\.origin' assets/ ./*.js 2>/dev/null \
  | while read -r f; do
      n=$(grep -o 'window\.location\.origin' "$f" | wc -l)
      # 排除已改写形式 origin+(
      m=$(grep -o 'window\.location\.origin+' "$f" | wc -l)
      if [ "$n" -gt "$m" ]; then echo "$f($n/$m)"; fi
    done)
if [ -z "$RESIDUAL" ]; then
  pass "无残留裸用法"
else
  fail "存在残留: $RESIDUAL"
fi

echo "=== 3. API 基址常量 ==="
if grep -q "const se=\"$PREFIX\"" assets/index-*.js; then
  pass "serverUrl 基址已改写为 $PREFIX"
else
  fail "serverUrl 基址未改写"
  grep -o 'const se="[^"]*"' assets/index-*.js | head -3 | sed 's/^/         /'
fi

echo "=== 4. 运行时前缀注入 ==="
if grep -q 'CASDOOR_BASE_PATH' index.html; then
  pass "运行时前缀已注入 index.html"
else
  fail "运行时前缀未注入"
fi

echo "=== 5. 后端静态资源可服务（容器内自测） ==="
BIN=""
command -v wget >/dev/null 2>&1 && BIN=wget
command -v curl >/dev/null 2>&1 && BIN=curl
if [ -n "$BIN" ]; then
  JS=$(grep -oE 'src="[^"]*assets/[^"]*\.js"' index.html | head -1 | sed 's/src="//;s/"$//')
  if [ -n "$JS" ]; then
    # 后端仍需以根路径服务资源；反代负责剥离前缀
    STRIPPED=$(echo "$JS" | sed "s|^$PREFIX||")
    if [ "$BIN" = "wget" ]; then
      code=$(wget -S -O /dev/null "http://localhost:8000$STRIPPED" 2>&1 | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]{3}' | awk '{print $2}')
    else
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8000$STRIPPED")
    fi
    [ "$code" = "200" ] && pass "后端可服务剥离前缀后的资源 ($STRIPPED -> 200)" \
                       || fail "后端资源不可达 ($STRIPPED -> ${code:-?})"
  fi
else
  echo "  [SKIP] 容器内无 wget/curl，跳过"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "验证通过"; else echo "验证失败"; fi
exit "$FAIL"
