# D5ST 校园社区

> 基于 Node.js + Express + Casdoor 的现代化校园社区平台，支持 Docker 一键部署。

## 功能特性

- 🔐 **Casdoor 统一认证** —— OAuth2/OIDC 标准协议，安全便捷，首次启动自动完成初始化
- 💬 **校园贴吧** —— 发帖、评论、点赞、举报，支持删除自己的帖子（进回收站）
- 🔒 **保密号系统** —— 生成个人专属保密号，保护隐私
- 👥 **好友系统** —— 搜索同学、发送/接受好友请求、好友列表管理
- 💌 **私信与留言板** —— 站内一对一私信（未读提示）+ 公开留言
- 🏅 **积分与等级体系** —— 发帖/签到/赞助获得积分，10 级称号体系与升级进度
- 🗄️ **数据导出** —— 后台一键把 d5st + casdoor 两个库的数据导出为单个 CSV
- 🔎 **全站搜索** —— 帖子 + 用户搜索
- ❤️ **赞助支持** —— 积分系统（可在后台一键暂停入口）
- 📊 **管理后台** —— 内容审核、弹窗通知、路径重定向、违禁词等完整运维功能
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

### Casdoor 初始化（通常无需手工操作）

**首次启动会自动完成 Casdoor 的全部配置**：`配置/casdoor-init.js` 会用管理员账号登录 Casdoor，
自动创建组织 `d5st`、应用 `d5st-app`（含回调地址、注册表单项）、用户组
（`d5st-admin` / `d5st-moderator` / `d5st-user`）、Webhook、邮件 Provider，
并在 d5st 组织下创建默认管理员账号（见 `.env` 的 `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASSWORD`）。

想看它做了什么，启动后看日志即可：

```bash
docker compose logs app | grep Casdoor-Init
```

需要进控制台做高级管理时：

1. 浏览器打开 `http://localhost:35545/casdoor`
2. 用 `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PASSWORD` 登录（默认 `admin` / `123`，见下方「修改密码」）

> 只有在你**手工改名**了组织 / 应用时，才需要同步修改 `.env` 里的 `CASDOOR_ORGANIZATION` /
> `CASDOOR_APPLICATION` 并重启 app。

### 访问地址

| 服务 | 地址 |
|------|------|
| D5ST 应用 | http://localhost:35545 |
| Casdoor 控制台 | http://localhost:35545/casdoor |
| MySQL | localhost:3306（仅容器内部访问） |

### 授予 / 取消管理员权限

**权限的唯一来源是 Casdoor 的用户组**：只要用户属于组 `d5st-admin`，本站就认定其为管理员
（见 `配置/user-service.js` 的 `isAdminFromCasdoor()`）。

#### 方式一：Casdoor 控制台（推荐）

1. 打开 `http://localhost:35545/casdoor` → 左侧 **用户管理 → 用户** → 找到目标用户，点右侧 **编辑**
2. 在编辑表单里**往下滚**，找到 **「群组」** 字段
   （位置在 **「权限」下面**、`注册来源` / `角色` 附近；新控制台 UI 是中文，即英文界面的 `Groups`）
3. 展开「群组」下拉 → 选中 **`D5ST 管理员 (d5st/d5st-admin)`** → 右上角 **保存**
4. 让该用户**退出后重新登录**

取消管理员同理：把「群组」里的 `d5st-admin` 去掉再保存，然后重新登录。

#### 方式二：直接改组关系（控制台不好找字段时）

改 Casdoor 的组关系与在控制台勾选「群组」是同一件事（`casdoor-init.js` 内部也是这么做的），
而且它才是权威来源，**不会被覆写**：

```bash
docker compose exec mysql mysql -u d5st -p"${MYSQL_PASSWORD:-d5st_pass_2026}" casdoor \
  -e "UPDATE casdoor.user SET \`groups\` = '[\"d5st-admin\"]' WHERE owner = 'd5st' AND name = 'some_user';"
```

改完让该用户**重新登录**即可（登录时会自动同步到本地 `is_admin`）。
想立刻刷新本地库，也可以在管理员仪表盘点一次「同步用户」（`POST /admin/sync-users`）。

> ⚠️ **只改本站数据库的 `is_admin` 是没用的**。本站每次登录都会用 Casdoor 的组关系
> **覆写**本地 `casdoor_users.is_admin`（`findOrCreateCasdoorUser()` 的 UPDATE 分支），
> 所以：
> ```sql
> -- 反例：下次登录就被改回 0
> UPDATE casdoor_users SET is_admin = 1 WHERE username = 'some_user';
> ```

> 另一个坑：app 每次启动会与 Casdoor 对账，**本地存在但 Casdoor 里已不存在的用户会被删除**
> （连带其帖子 / 评论 / 私信 / 好友关系）。所以不要指望只用 SQL 造账号。

### 修改密码

本站有三个容易混淆的账号，改法完全不同：

| 账号 | 用途 | 改哪里 | 注意 |
|------|------|--------|------|
| 本站普通用户 | 日常登录 d5st | Casdoor 登录页「忘记密码」（走 SMTP 验证码），或控制台 Users → 改密 | 建议开启真实 SMTP，否则验证码只进 MailHog |
| `DEFAULT_ADMIN_USER`（默认 `d5stadmin`） | 本站默认管理员 | **只能改 `.env` 的 `DEFAULT_ADMIN_PASSWORD`，然后重启 app** | Casdoor 控制台里改它**没用**——`casdoor-init.js` 每次启动都会用 env 的值重写该用户密码（日志里那句「密码已写入」） |
| Casdoor 内置 `admin` | 登录 Casdoor 控制台 | 控制台 → 右上角头像 → 修改密码 | 改完**必须同步 `.env` 的 `CASDOOR_ADMIN_PASSWORD`**，否则 d5st 调 Casdoor 的管理接口全失效（初始化 / 发验证码 / 用户同步 / 审计日志） |

改本站默认管理员密码：

```bash
# 编辑 .env（Windows 用记事本）
# DEFAULT_ADMIN_PASSWORD=你的新密码
docker compose up -d app      # 重启 app，casdoor-init 会把新密码写回 Casdoor
```

改 Casdoor 控制台密码（两处必须一致）：

```bash
# 1. 在控制台 http://localhost:35545/casdoor 里改掉 admin 的密码
# 2. 同步 .env
# CASDOOR_ADMIN_PASSWORD=你刚设置的新密码
docker compose up -d app      # 重启后 d5st 才能继续调用 Casdoor 管理接口
```

> 只改控制台、不同步 `.env` 的典型症状：app 日志出现 `[Casdoor-Init] 管理员 token 获取失败`，
> 随后 Casdoor 自动初始化、找回密码发验证码、用户同步/对账、审计日志
> （`/api/add-record`）等依赖管理接口的功能一起失效。
> （注意：`/admin/export-all` 全库导出走的是数据库直连，不受影响。）

### 运行测试

```bash
# 在容器外执行（需要 Node.js 环境）
npm install
npm test                       # = node 测试/test-auth.js

# 其余脚本按需单独运行（不依赖浏览器）
node 测试/test-level.js        # 等级/积分规则单元测试（22 项）

# 需要真实浏览器（Playwright）的端到端脚本
node 测试/e2e-register.js      # 注册链路
node 测试/verify-features.js   # 好友/发帖删帖/私信/赞助等 13 项
node 测试/test-export-all.js   # 全库 CSV 导出 21 项（需管理员账号）
```

## 管理后台

登录后访问 `/admin`（需管理员权限，设置方法见上文「授予 / 取消管理员权限」）。

| 页面 | 路径 | 说明 |
|------|------|------|
| 仪表盘 | `/admin` | 帖子/用户/评论/举报/视频统计 |
| 帖子 / 评论 / 举报 | `/admin/forum` 等 | 内容管理，删除进回收站 |
| 全局通知 / 弹窗 | `/admin/notifications`、`/admin/popups` | 通知支持生效时间段；弹窗的「目标页面」为多选勾选 |
| 首页设置 | `/admin/home-links`、`/admin/home-banners` | 首页「常用链接」完全由这里驱动 |
| 违禁词 / 拦截记录 | `/admin/sensitive-words` 等 | 发帖/评论/私信命中即屏蔽并记录 |
| 设置 | `/admin/settings` | 站点名、默认积分、赞助入口开关（`sponsor_enabled`）等 |
| 导出用户 | `/admin/export-users` | 导出用户列表 CSV |
| **导出全部数据** | `/admin/export-all` | 把 d5st + casdoor 两库数据导出为**单个 CSV** |

导出全部数据的 CSV 采用长表格式（两库表结构不同，无法并成宽表），固定列为：

```
库, 表, 行号, 字段, 值, 是否为空
```

- 同一「库 + 表 + 行号」的多行即原始一行记录，Excel 数据透视即可还原；
- `是否为空 = 1` 表示该字段是 SQL NULL（用于区分 NULL 与空字符串）；
- 空表会写一行 `行号 = 0` 的标记行，避免「表存在却查不到」；
- 文件带 UTF-8 BOM，中文不乱码。

> ⚠️ 该 CSV 含 Casdoor 全部数据（用户密码哈希与 salt、会话、token），请勿外发或提交仓库。

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
│   ├── casdoor-init.js       # Casdoor 自动初始化（组织/应用/组/管理员）
│   ├── user-service.js       # 用户服务（Casdoor ↔ 本地映射、管理员判定）
│   ├── level.js              # 等级与积分口径（等级阶梯 + 积分 k 缩写）
│   └── init-db.js            # 数据库初始化
├── 功能模块/                   # Express 路由
│   ├── homepage/             # 首页
│   ├── registration/         # 认证（Casdoor 集成）
│   ├── user/                 # 个人中心
│   ├── forum/                # 校园贴吧
│   ├── friends/              # 好友系统
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

- 生产环境请务必修改 `.env` 中所有默认密码和密钥（**改 Casdoor 控制台密码时必须同步 `CASDOOR_ADMIN_PASSWORD`，否则后台管理接口全失效，详见「修改密码」**）
- 建议在前端配置 HTTPS 反向代理（Nginx / Traefik）
- Casdoor 管理后台默认口令（`admin` / `123`）请在首次登录后立即修改，并同步 `.env`

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
