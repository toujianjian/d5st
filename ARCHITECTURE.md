# D5ST 架构说明

## 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器 (客户端)                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
           ┌──────────────┴──────────────┐
           │                             │
           ▼                             ▼
┌─────────────────────┐       ┌────────────────────┐
│  D5ST Web (35555)   │       │  Casdoor (8000)     │
│  Express + EJS      │◄─────►│  OAuth2 / OIDC      │
│  会话存储           │       │  用户管理            │
└──────────┬──────────┘       └─────────┬──────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  MySQL 8.0 (3306)                            │
│  d5st 数据库: 业务数据 (帖子、用户、私信、保密号等)           │
│  casdoor 数据库: Casdoor 自身数据                             │
└─────────────────────────────────────────────────────────────┘
```

## 服务说明

### 1. d5st-app（Node.js 应用）
- **端口**: 35555
- **职责**: 处理 HTTP 请求、渲染 EJS 模板、业务逻辑
- **会话**: express-session，默认 2 小时过期，存储在内存中

### 2. casdoor（认证服务）
- **端口**: 8000
- **职责**: 用户注册、登录、OAuth2/OIDC 授权、账号管理
- **数据**: 自身数据库 `casdoor`（启动时自动建表）

### 3. mysql（数据库）
- **端口**: 3306（仅暴露给其他容器）
- **职责**: 存储所有业务数据
- **初始化**: `db-schema.sql` 在首次启动时自动执行

## 认证流程（OAuth2 Authorization Code）

```
用户 ──► D5ST /login ──► Casdoor /login/oauth/authorize
  │                                                        │
  │  ◄─────── Casdoor 登录页面 ───────────────────────────┘
  │                                                        │
  │  ──────── 授权后返回 code ──────────► D5ST /auth/callback
  │                                                        │
  │                                        D5ST 用 code 换 token
  │                                        Casdoor 返回 access_token
  │                                        D5ST 获取用户信息
  │                                        本地创建/更新用户
  │                                        设置 session
  │  ◄──────────────────────── 重定向到首页 ──────────────┘
```

## 路由架构

```
app.js (主入口)
├── 中间件层
│   ├── express-ejs-layouts  (布局模板)
│   ├── express-session      (会话管理)
│   ├── 认证守卫             (公开路径白名单)
│   └── 路径重定向           (管理员配置的重定向规则)
│
├── /api/*  (JSON 接口)
│   ├── /api/health          (健康检查)
│   ├── /api/check-login     (登录状态)
│   ├── /api/popups          (弹窗获取/关闭)
│   └── /api/notifications   (通知获取/已读)
│
├── 功能模块
│   ├── /                    → homepage + registration
│   ├── /user                → 用户中心
│   ├── /forum               → 校园贴吧
│   ├── /messages            → 私信 + 留言板
│   ├── /search              → 全站搜索
│   ├── /secret              → 保密号
│   ├── /sponsor             → 赞助
│   └── /admin               → 管理后台（需管理员）
│
└── 错误处理
    ├── 404 → errors/404.ejs
    └── 500 → errors/500.ejs
```

## 数据库表结构

### 用户相关
| 表名 | 说明 |
|------|------|
| casdoor_users | Casdoor 用户映射（核心用户表） |
| admins | 管理员账户 |
| ys_students | 学生基础数据（可选，用于注册验证） |
| user_preferences | 用户主题偏好 |
| user_medals | 用户勋章 |

### 内容相关
| 表名 | 说明 |
|------|------|
| forum_posts | 贴吧帖子 |
| post_comments | 帖子评论 |
| post_likes | 点赞记录 |
| reports | 举报记录 |
| deleted_items | 回收站 |

### 通讯相关
| 表名 | 说明 |
|------|------|
| messages | 私信 |
| guestbook | 留言板 |

### 系统相关
| 表名 | 说明 |
|------|------|
| user_secrets | 保密号 |
| sponsor_transactions | 赞助记录 |
| search_history | 搜索历史 |
| popups / popup_views | 弹窗系统 |
| notifications / global_notifications | 通知系统 |
| home_links / home_banners | 首页配置 |
| path_redirects | 路径重定向 |
| system_settings | 系统设置 |

## Casdoor 与本地用户的关系

Casdoor 是唯一的认证来源，但本地 `casdoor_users` 表存储了 D5ST 特有的用户属性：

- `casdoor_user_id` —— 对应 Casdoor 的用户 ID（外键）
- `grade` / `class_name` / `student_no` —— 校园信息
- `nickname` —— 社区昵称
- `points` —— 积分
- `is_admin` —— 管理员标记

首次登录时自动创建映射记录，后续登录只更新基础资料。

## 安全设计

1. **密码不存储** —— D5ST 从不接触用户密码，认证完全委托给 Casdoor
2. **Session HttpOnly** —— Cookie 设置 HttpOnly + 2 小时过期
3. **公开路径白名单** —— 未登录只能访问 `/login`、`/register`、`/forum`、`/search` 等公开页面
4. **管理员守卫** —— `/admin/*` 所有路由通过 `requireAdmin` 中间件检查
5. **SQL 参数化查询** —— 全部使用 `mysql2` prepared statement，防止注入
