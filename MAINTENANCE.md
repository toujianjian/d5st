# D5ST 运维与维护指南

## 日常运维

### 查看服务状态
```bash
docker compose ps
```

### 查看日志
```bash
# 应用日志
docker compose logs -f --tail=100 app

# MySQL 日志
docker compose logs -f mysql

# Casdoor 日志
docker compose logs -f casdoor
```

### 重启单个服务
```bash
docker compose restart app
docker compose restart casdoor
```

### 更新应用（拉取新代码后）
```bash
docker compose down
docker compose up -d --build
```

### 备份数据库
```bash
# 备份 MySQL（包含 d5st + casdoor 两个数据库）
docker compose exec mysql mysqldump -u d5st -pd5st_pass_2026 --databases d5st casdoor > backup_$(date +%Y%m%d).sql
```

### 恢复数据库
```bash
docker compose exec -T mysql mysql -u d5st -pd5st_pass_2026 < backup_20260912.sql
```

## 环境变量说明

所有可配置项都在 `.env` 文件中定义：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_ROOT_PASSWORD` | d5st_root_2026 | MySQL root 密码 |
| `MYSQL_DATABASE` | d5st | 业务数据库名 |
| `MYSQL_USER` | d5st | MySQL 普通用户 |
| `MYSQL_PASSWORD` | d5st_pass_2026 | MySQL 密码 |
| `CASDOOR_ADMIN_USER` | admin | Casdoor 管理员 |
| `CASDOOR_ADMIN_PASSWORD` | d5st_admin_2026 | Casdoor 管理员密码 |
| `CASDOOR_CLIENT_ID` | d5st_client | Casdoor 应用 Client ID |
| `CASDOOR_CLIENT_SECRET` | d5st_client_secret_2026 | Casdoor 应用 Client Secret |
| `CASDOOR_ORGANIZATION` | d5st | Casdoor 组织名 |
| `CASDOOR_APPLICATION` | d5st-app | Casdoor 应用名 |
| `APP_PORT` | 35555 | D5ST 应用端口 |
| `APP_URL` | http://localhost:35555 | 应用对外 URL |
| `SESSION_SECRET` | d5st_session... | Session 加密密钥 |
| `NODE_ENV` | production | 运行环境 |

### 生产环境配置建议

```env
MYSQL_ROOT_PASSWORD=<强随机密码>
MYSQL_PASSWORD=<强随机密码>
CASDOOR_ADMIN_PASSWORD=<强随机密码>
CASDOOR_CLIENT_SECRET=<强随机密钥>
SESSION_SECRET=<64字符以上随机字符串>
APP_URL=https://d5st.yourdomain.com
NODE_ENV=production
```

## Casdoor 配置详解

### 1. 创建组织
路径：Casdoor 控制台 → **Organizations** → **Add**
- **Name**: `d5st`
- **Display Name**: D5ST 校园社区
- **Logo**: 可选，上传你的站点 Logo

### 2. 创建应用
路径：Casdoor 控制台 → **Applications** → **Add**
- **Organization**: `d5st`
- **Name**: `d5st-app`
- **Display Name**: D5ST Web
- **Redirect URL**: `https://你的域名/auth/callback`
- **Token format**: JWT（默认即可）

保存后记下 **Client ID** 和 **Client Secret**，填入 `.env`。

### 3. 配置登录方式
路径：应用编辑页 → **Providers**
- 至少启用一个登录方式（邮箱、手机号、密码）
- 可添加第三方登录（GitHub、微信等）

### 4. 关闭自助注册（可选）
如果只允许管理员创建账号：
- 应用编辑页 → 关闭 **Enable Sign Up**

## 管理后台使用

访问 `http://你的域名/admin`（仅管理员账号可进入）：

### 仪表盘
显示用户数、帖子数、待处理举报、私信总数。

### 功能模块
- **帖子管理** —— 软删除违规帖子
- **举报管理** —— 处理用户举报
- **全局通知** —— 推送系统通知给所有用户
- **弹窗管理** —— 在指定页面弹窗公告
- **首页链接/横幅** —— 自定义首页展示
- **路径重定向** —— 让旧路径跳转至外部
- **导出用户** —— 查看所有注册用户
- **系统设置** —— 修改站点名称、描述等

## 常见问题排查

### Q: Casdoor 启动后 D5ST 报连接失败
**原因**: `.env` 中 Casdoor Client ID/Secret 与 Casdoor 控制台不一致。
**解决**: 核对两端配置，确保 `.env` 更新后执行 `docker compose restart app`。

### Q: 登录后重定向回 /login
**原因**: Casdoor 用户信息 API 返回异常，或 Session 存储问题。
**排查**:
```bash
docker compose logs app | grep -i casdoor
docker compose exec app node -e "const cas = require('./配置/casdoor'); cas.isCasdoorAvailable().then(console.log)"
```

### Q: MySQL 连接失败
**排查**:
```bash
docker compose exec mysql mysql -u root -p
# 检查数据库是否存在
SHOW DATABASES;
```
如首次启动被中断，可能需要手动重建：
```bash
docker compose down -v
docker compose up -d --build
```
⚠️ 这会清除所有数据！

### Q: 端口被占用
修改 `.env` 中的端口变量（如 `APP_PORT=8080`、`CASDOOR_PORT=8001`）。

### Q: Session 丢失 / 频繁掉线
- 检查 `SESSION_SECRET` 是否一致（多实例部署需要固定）
- 检查浏览器是否禁用了 Cookie
- 默认 2 小时过期，可在 `app.js` 中调整 `maxAge`

### Q: 中文显示乱码
确保数据库和连接池都使用 `utf8mb4`。本项目已配置好。

## 性能与扩展性

### 当前架构的局限
- Session 存储在内存中 → 多实例部署需要 Redis
- MySQL 单节点 → 高可用需主从或集群
- Casdoor 内置 SQLite → 生产建议迁移到外部数据库

### 建议的扩展方向
1. 添加 Redis 做 Session 存储和缓存
2. 配置 Nginx 反向代理 + HTTPS + Gzip 压缩
3. Casdoor 独立部署到专门的容器组
4. 图片上传改为对象存储（MinIO / OSS）
5. 添加 WebSocket 实现实时消息推送

## 安全检查清单

- [ ] `.env` 中所有密码和密钥已修改为强随机值
- [ ] 前端使用 HTTPS（Let's Encrypt / 自建证书）
- [ ] Docker 端口未暴露不必要的服务（MySQL 内部网络访问）
- [ ] Casdoor 管理员密码已修改
- [ ] 生产环境 `NODE_ENV=production`
- [ ] 定期备份数据库（建议每天）
- [ ] 容器镜像定期更新（`docker compose pull`）

## 更新日志

### v1.0.0
- 初始版本
- Node.js + Express + EJS 架构
- Casdoor OAuth2 认证集成
- Docker Compose 一键部署
- 论坛 / 私信 / 搜索 / 保密号 / 赞助 / 管理后台完整功能
