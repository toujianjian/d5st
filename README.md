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

1. 浏览器打开 `http://localhost:8000`，使用 `.env` 中配置的 `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PASSWORD` 登录
2. 进入 **Organizations** → 创建组织 `d5st`
3. 进入 **Applications** → 创建应用 `d5st-app`，配置：
   - **Organization**: `d5st`
   - **Redirect URL**: `http://localhost:35555/auth/callback`
   - **Client ID** 和 **Client Secret** 复制到 `.env` 中的对应变量
4. 重启服务使其生效：`docker compose restart app`

### 访问地址

| 服务 | 地址 |
|------|------|
| D5ST 应用 | http://localhost:35555 |
| Casdoor 控制台 | http://localhost:8000 |
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

## 许可证

MIT License
