# 基于官方 Casdoor 镜像，给其自带前端(/web/build)打 /casdoor 子路径补丁。
# 补丁逻辑见 docker/casdoor-basepath/patch-basepath.mjs（作者编写，已纳入版本库）。
#
# 设计：Casdoor 后端仍以根路径服务，由 Caddy 反向代理剥离 /casdoor 前缀后转发，
# 因此前端所有资源/API 请求统一带 /casdoor 前缀即可（详见 docker/Caddyfile）。

# 阶段1：用 node 镜像执行补丁（官方 Casdoor 镜像本身不含 node）
FROM node:20-alpine AS patcher
COPY docker/casdoor-basepath/patch-basepath.mjs /patch-basepath.mjs
COPY --from=casbin/casdoor:latest /web/build /web/build
RUN node /patch-basepath.mjs --web-dir=/web/build --prefix=/casdoor

# 阶段2：覆盖前端产物，其余(go 二进制 / 配置 / 数据)保持官方镜像不变
FROM casbin/casdoor:latest
COPY --from=patcher /web/build /web/build
