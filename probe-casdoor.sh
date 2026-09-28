#!/bin/sh
# 临时探针：确认 Casdoor 前端静态资源的引用前缀（绝对路径 or 相对路径）
echo "=== index.html 中的资源引用 ==="
grep -oE '(src|href)="[^"]*"' /web/build/index.html | head -20
echo ""
echo "=== assets 目录下的 js 中出现的根路径 ==="
grep -ohE '"/[a-zA-Z0-9_/.-]+"' /web/build/assets/*.js 2>/dev/null | sort -u | head -20
echo ""
echo "=== Casdoor 路由注册（prefix 相关）==="
grep -oE '"/[a-zA-Z0-9_/.-]*"' /server 2>/dev/null | sort -u | head -5
