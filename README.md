# D5ST 校园社区

> 基于 Node.js + Express + Casdoor 的现代化校园社区平台，支持 Docker 一键部署。

## 功能特性

- 🔐 **Casdoor 统一认证** —— OAuth2/OIDC 标准协议，安全便捷
- 💬 **校园贴吧** —— 发帖、评论、点赞、举报
- 🔒 **保密号系统** —— 生成个人专属保密号，保护隐私
- 💌 **私信与留言板** —— 站内通讯 + 公开留言
- 🔎 **全站搜索** —— 帖子 + 用户搜索
- ❤️ **赞助支持** —— 积分系统
- 📊 **管理后台** —— 内容审核、弹窗通知、路径重定向等完整运维功能
- 🎨 **响应式设计** —— 完美适配 PC / 平板 / 手机
- 🐳 **Docker 部署** —— 一键启动 MySQL + Casdoor + App

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js 20 + Express 4 |
| 模板引擎 | EJS + express-ejs-layouts |
| 数据库 | MySQL 8.0 |
| 认证 | Casdoor (OAuth2/OIDC) |
| 容器化 | Docker Compose |
| 前端 | Vanilla CSS + JavaScript（无框架依赖） |

## 快速开始

### 前置条件

- Docker 20.10+
- Docker Compose 2.0+

### 一键部署

```bash
# 1. 克隆或下载项目
cd d5st

# 2. 复制环境变量文件
copy .env.example .env

# 3. 根据需要修改 .env（生产环境务必改密码！）
# Windows 下用记事本打开: notepad .env

# 4. 启动所有服务（首次会自动拉取镜像、初始化数据库）
docker compose up -d --build

# 5. 查看启动状态
docker compose ps

# 6. 查看日志
docker compose logs -f app
```

### 首次配置 Casdoor

1. 浏览器打开 `http://localhost:35545/casdoor`，使用 `.env` 中配置的 `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PASSWORD` 登录
2. 进入 **Organizations** → 创建组织 `d5st`
3. 进入 **Applications** → 创建应用 `d5st-app`，配置：
   - **Organization**: `d5st`
   - **Redirect URL**: `http://localhost:35545/auth/callback`
   - **Client ID** 和 **Client Secret** 复制到 `.env` 中的对应变量
4. 重启服务使其生效：`docker compose restart app`

### 访问地址

| 服务 | 地址 |
|------|------|
| D5ST 应用 | http://localhost:35545 |
| Casdoor 控制台 | http://localhost:35545/casdoor |
| MySQL | localhost:3306（仅容器内部访问） |

### 授予管理员权限

默认没有管理员账号。用户首次通过 Casdoor 登录后，系统会在 `casdoor_users` 表创建一条记录。要将某个用户设为管理员：

```bash
# 进入 MySQL 容器
docker compose exec mysql mysql -u d5st -p

# 执行 SQL（将 'admin_username' 替换为该用户的 Casdoor 用户名）
UPDATE casdoor_users SET is_admin = 1 WHERE username = 'admin_username';
```

设置后该用户登录即可访问 `/admin` 管理后台。

### 运行测试

```bash
# 在容器外执行（需要 Node.js 环境）
npm install
npm test

# 或在容器内执行
docker compose exec app node 测试/test-auth.js
```

## 目录结构

```
d5st/
├── app.js                    # 应用入口
├── package.json              # Node 依赖
├── Dockerfile                # 应用镜像构建
├── docker-compose.yml        # 服务编排
├── db-schema.sql             # 数据库建表脚本
├── .env.example              # 环境变量模板
├── 配置/                      # 配置与服务层
│   ├── db.js                 # MySQL 连接池
│   ├── casdoor.js            # Casdoor SDK 封装
│   ├── user-service.js       # 用户服务
│   └── init-db.js            # 数据库初始化
├── 功能模块/                   # Express 路由
│   ├── homepage/             # 首页
│   ├── registration/         # 认证（Casdoor 集成）
│   ├── user/                 # 个人中心
│   ├── forum/                # 校园贴吧
│   ├── messages/             # 私信与留言板
│   ├── search/               # 搜索
│   ├── secret-code/          # 保密号
│   ├── sponsor/              # 赞助
│   └── admin/                # 管理后台
├── 页面模板/                   # EJS 视图
├── 静态资源/                   # CSS / JS / 图片
├── 测试/                      # 测试脚本
└── docker/                    # Docker 相关初始化脚本
```

## 常用命令

```bash
docker compose up -d              # 启动所有服务
docker compose down               # 停止并删除容器
docker compose logs -f app        # 查看应用日志
docker compose exec app sh        # 进入应用容器
docker compose exec mysql mysql -u d5st -p   # 进入 MySQL

# 开发模式（热重载）
docker compose run --rm -p 35555:35555 app npm run dev
```

## 安全提示

- 生产环境请务必修改 `.env` 中所有默认密码和密钥
- 建议在前端配置 HTTPS 反向代理（Nginx / Traefik）
- Casdoor 管理后台默认口令请在首次登录后立即修改

### 高危：`ENABLE_DEV_LOGIN` 开发登录后门

`.env` 中的 `ENABLE_DEV_LOGIN=1` 会开启一个**免密开发登录入口** `GET /auth/dev-login`（仅用于本地自动化测试），**绝不能留在生产环境**。

危害：
- 任何能访问站点的人，只要请求 `/auth/dev-login` 即可**免密登录**默认账号 `dev_user`；
- 若请求 `/auth/dev-login?admin=1`，该账号会被**直接提权为管理员**（`is_admin=1`），进而访问 `/admin` 后台、篡改/删除内容、操作数据。

正确做法：
- 本地调试：`.env` 保留 `ENABLE_DEV_LOGIN=1`（该文件已在 `.gitignore`，不入库）；
- 生产部署：**务必删除该条目或设为 `ENABLE_DEV_LOGIN=0`**，并排查 CI / 服务器环境变量中是否残留此变量；
- 上线前检查 `casdoor_users` 表是否存在 `dev_user` 或异常提权账号，及时清理。

### 注意事项：找回密码 SMTP / MailHog

当前 `.env` 的 SMTP 指向容器内 MailHog（`CASDOOR_SMTP_HOST=mail`），验证码**只在本地 `http://localhost:8025` 可见、不会真发邮件**。生产请：
- 替换为真实 SMTP，并删除 `docker-compose.yml` 中的 `mailhog` 服务；
- 否则 `/forgot-password/request` 发出的验证码会落到本地 MailHog，存在被本地拦截、邮件内容外泄的风险。

### 注意事项：密钥与 Secret

注册/登录走 Casdoor OAuth。切勿将 Casdoor 的 `Client Secret`、管理员口令、数据库密码写入前端代码或提交到仓库。

### 注意事项：Session Cookie 与密钥

`app.js` 使用 `express-session`，当前 cookie 仅配置了 `httpOnly: true` 与 2 小时 `maxAge`。以下生产隐患需在部署前自行处理（均为代码层配置，需改 `app.js` 的 `session(...)` 调用）：

- **`SESSION_SECRET` 必须改**：代码 fallback 为 `d5st-dev-secret-change-me`、`.env.example` 占位为 `d5st_session_secret_change_in_production`。若部署者未改，攻击者可伪造 session。生产请设置强随机值（如 `openssl rand -hex 32`）。
- **缺 `secure`**：cookie 未设 `secure`。HTTPS 部署时建议 `secure: process.env.NODE_ENV === 'production'`，避免会话 cookie 在非安全通道传输（中间人风险）。
- **缺 `sameSite`**：建议显式 `sameSite: 'lax'`（敏感操作可用 `'strict'`），收紧跨站 CSRF 面。
- **默认 MemoryStore**：未配置 `store`，session 存进程内存。单实例本地无碍，但容器重启会全员掉登录、多副本不共享、长期运行有内存增长。生产建议改接 MySQL（如 `express-mysql-session`）。

## 许可证

MIT License
