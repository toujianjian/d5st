-- ============================================================
-- D5ST 数据库建表脚本
-- 创建数据库：CREATE DATABASE d5st DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- ============================================================

-- 关键：本文件会被 MySQL 容器的 docker-entrypoint-initdb.d 用 mysql 客户端执行，
-- 该客户端默认字符集可能是 latin1，导致脚本里的中文被写成「双重编码」乱码
-- （如 系统管理员 -> ç³»ç»Ÿç®¡ç†å'˜）。显式声明可彻底避免。
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS d5st DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE d5st;

-- Casdoor 用户映射表：关联 Casdoor 账户与本站用户资料
CREATE TABLE IF NOT EXISTS casdoor_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  casdoor_user_id VARCHAR(100) NOT NULL COMMENT 'Casdoor 用户 ID',
  username VARCHAR(100) NOT NULL COMMENT 'Casdoor 用户名',
  real_name VARCHAR(100) DEFAULT NULL COMMENT '真实姓名',
  avatar VARCHAR(255) DEFAULT NULL COMMENT '头像 URL',
  email VARCHAR(150) DEFAULT NULL,
  phone VARCHAR(30) DEFAULT NULL,
  grade VARCHAR(20) DEFAULT NULL COMMENT '年级',
  class_name VARCHAR(20) DEFAULT NULL COMMENT '班级',
  student_no VARCHAR(20) DEFAULT NULL COMMENT '学号',
  nickname VARCHAR(50) DEFAULT NULL,
  points INT NOT NULL DEFAULT 0,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_casdoor_id (casdoor_user_id),
  UNIQUE KEY uniq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Casdoor 用户映射';

-- ys 学生基础数据（用于注册验证）
CREATE TABLE IF NOT EXISTS ys_students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  grade VARCHAR(20) NOT NULL,
  class_name VARCHAR(20) NOT NULL,
  student_no VARCHAR(20) NOT NULL,
  real_name VARCHAR(50) NOT NULL,
  ding_id VARCHAR(100) DEFAULT NULL,
  UNIQUE KEY uniq_student (grade, class_name, student_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生基础数据';

-- 保密号
CREATE TABLE IF NOT EXISTS user_secrets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  secret_code VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_user_secret (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='保密号';

-- 赞助记录
CREATE TABLE IF NOT EXISTS sponsor_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount_yuan DECIMAL(10,2) NOT NULL,
  points_added INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'success',
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='赞助记录';

-- 论坛帖子
-- 字段设计参考 linfeng-community：
--   post_type 图文帖(normal)/长文贴(long)/视频贴(video)
--   is_top 置顶、is_hot 精华（对应后台「置顶/设为精华」管理）
--   board_id 所属版块（对应「圈子」概念）
--   category 兼容旧代码的一级分类
CREATE TABLE IF NOT EXISTS forum_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) DEFAULT NULL,
  content TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'general',
  board_id INT DEFAULT NULL,
  post_type VARCHAR(20) NOT NULL DEFAULT 'normal',
  cover_image VARCHAR(500) DEFAULT NULL,
  tags VARCHAR(255) DEFAULT NULL,
  views INT NOT NULL DEFAULT 0,
  is_top TINYINT(1) NOT NULL DEFAULT 0,
  is_hot TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_created_at (created_at),
  INDEX idx_category (category),
  INDEX idx_board (board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='论坛帖子';

-- 论坛版块（圈子）
CREATE TABLE IF NOT EXISTS forum_boards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  icon VARCHAR(20) DEFAULT '💬',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_slug (slug),
  INDEX idx_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='论坛版块';

-- 话题标签
CREATE TABLE IF NOT EXISTS tags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='话题标签';

-- 帖子-标签关联
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INT NOT NULL,
  tag_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, tag_id),
  INDEX idx_tag (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子标签关联';

-- 用户关注
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id INT NOT NULL,
  following_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, following_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户关注';

-- 视频作品（meyho 风格：列表/播放/分类/推荐）
CREATE TABLE IF NOT EXISTS video_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  video_url VARCHAR(500) NOT NULL,
  cover_url VARCHAR(500) DEFAULT NULL,
  duration INT NOT NULL DEFAULT 0,
  views INT NOT NULL DEFAULT 0,
  category VARCHAR(50) NOT NULL DEFAULT 'campus',
  is_recommended TINYINT(1) NOT NULL DEFAULT 0,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_created (created_at),
  INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='校园视频';

-- 积分/经验（linfeng 签到与积分体系）
CREATE TABLE IF NOT EXISTS user_points (
  user_id INT NOT NULL PRIMARY KEY,
  points INT NOT NULL DEFAULT 0,
  exp INT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户积分经验';

-- 每日签到
CREATE TABLE IF NOT EXISTS user_checkins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  checkin_date DATE NOT NULL,
  points INT NOT NULL DEFAULT 10,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_date (user_id, checkin_date),
  INDEX idx_date (checkin_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日签到';

-- 用户勋章
CREATE TABLE IF NOT EXISTS user_medals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  medal_type VARCHAR(50) NOT NULL,
  medal_name VARCHAR(100) NOT NULL,
  earned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_user_medal (user_id, medal_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户勋章';

-- 帖子点赞
CREATE TABLE IF NOT EXISTS post_likes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  post_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES forum_posts(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_like (user_id, post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子点赞';

-- 帖子评论
CREATE TABLE IF NOT EXISTS post_comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  post_id INT NOT NULL,
  user_id INT NOT NULL,
  parent_id INT DEFAULT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (post_id) REFERENCES forum_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_post_id (post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子评论';

-- 举报
CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  post_id INT DEFAULT NULL,
  comment_id INT DEFAULT NULL,
  reporter_id INT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at DATETIME DEFAULT NULL,
  FOREIGN KEY (post_id) REFERENCES forum_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES post_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES casdoor_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='举报记录';

-- 私信
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_messages_sender (sender_id),
  INDEX idx_messages_receiver (receiver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信';

-- 用户在线状态
CREATE TABLE IF NOT EXISTS user_online_status (
  user_id INT PRIMARY KEY,
  is_online TINYINT(1) NOT NULL DEFAULT 0,
  last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='在线状态';

-- 留言板
CREATE TABLE IF NOT EXISTS guestbook (
  id INT AUTO_INCREMENT PRIMARY KEY,
  author_id INT DEFAULT NULL,
  author_name VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES casdoor_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='留言板';

-- 回收站
CREATE TABLE IF NOT EXISTS deleted_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_type VARCHAR(50) NOT NULL,
  item_id INT NOT NULL,
  deleted_by INT DEFAULT NULL,
  deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data JSON NOT NULL,
  is_restored TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (deleted_by) REFERENCES casdoor_users(id) ON DELETE SET NULL,
  INDEX idx_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='回收站';

-- 管理员（独立表，便于与普通用户区分）
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  real_name VARCHAR(50) NOT NULL,
  casdoor_user_id VARCHAR(100) DEFAULT NULL COMMENT '关联 Casdoor 用户',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员';

-- 首页链接
CREATE TABLE IF NOT EXISTS home_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  url VARCHAR(255) NOT NULL,
  icon VARCHAR(50) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  -- 唯一键：保证下面的 INSERT IGNORE 真正幂等，否则每次启动都会重复插入
  UNIQUE KEY uniq_home_links_title (title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='首页链接';

-- 首页横幅
CREATE TABLE IF NOT EXISTS home_banners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  image_path VARCHAR(255) NOT NULL,
  link_url VARCHAR(255) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uniq_home_banners_title (title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='首页横幅';

-- 路径重定向
CREATE TABLE IF NOT EXISTS path_redirects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  path VARCHAR(255) NOT NULL,
  redirect_url VARCHAR(500) NOT NULL,
  path_desc VARCHAR(100) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='路径重定向';

-- 搜索历史
CREATE TABLE IF NOT EXISTS search_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  keyword VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='搜索历史';

-- 用户主题偏好
CREATE TABLE IF NOT EXISTS user_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  theme_name VARCHAR(50) DEFAULT 'default',
  night_mode_enabled TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_user_prefs (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户偏好';

-- 弹窗
CREATE TABLE IF NOT EXISTS popups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'info',
  target_pages TEXT NOT NULL,
  show_once TINYINT(1) NOT NULL DEFAULT 0,
  start_time DATETIME NULL,
  end_time DATETIME NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='弹窗';

-- 弹窗关闭记录
CREATE TABLE IF NOT EXISTS popup_views (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  popup_id INT NOT NULL,
  closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_popup (user_id, popup_id),
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  FOREIGN KEY (popup_id) REFERENCES popups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='弹窗关闭记录';

-- 通知
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  action_url VARCHAR(255) DEFAULT NULL,
  action_text VARCHAR(50) DEFAULT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_is_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知';

-- 全局通知
CREATE TABLE IF NOT EXISTS global_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  action_url VARCHAR(255) DEFAULT NULL,
  action_text VARCHAR(50) DEFAULT NULL,
  start_time DATETIME DEFAULT NULL,
  end_time DATETIME DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全局通知';

-- 系统设置
CREATE TABLE IF NOT EXISTS system_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(50) NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统设置';

-- 违禁词词库（敏感词过滤，算法参考 https://github.com/houbb/sensitive-word 的 DFA + 忽略干扰字符思路）
CREATE TABLE IF NOT EXISTS sensitive_words (
  id INT AUTO_INCREMENT PRIMARY KEY,
  word VARCHAR(128) NOT NULL COMMENT '敏感词',
  category VARCHAR(32) NOT NULL DEFAULT 'default' COMMENT '分类（政治/辱骂/广告…）',
  is_disabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=停用（不生效）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_word (word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='违禁词词库';

-- 敏感词命中记录（谁、在哪、命中了什么、原文）——审计留痕
CREATE TABLE IF NOT EXISTS sensitive_word_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL COMMENT '触发者（游客为 NULL）',
  username VARCHAR(100) DEFAULT NULL COMMENT '触发时用户名（冗余存储，便于追溯）',
  content_type VARCHAR(32) NOT NULL COMMENT 'post/comment/message/guestbook',
  content_id INT DEFAULT NULL COMMENT '对应内容 ID（未落库前可能为 NULL）',
  matched_words JSON NOT NULL COMMENT '本次命中的词列表',
  raw_content TEXT NOT NULL COMMENT '触发时的原始内容（屏蔽前）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_content_type (content_type),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='敏感词命中记录';

-- 初始化默认数据
INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES
('site_name', 'D5ST 校园社区', '网站名称'),
('site_description', '连接每一位同学，共享校园生活', '网站描述'),
('enable_registration', '1', '是否开放注册'),
('default_points', '100', '新用户默认积分');

INSERT IGNORE INTO home_links (title, url, icon, sort_order) VALUES
('校园贴吧', '/forum', '💬', 1),
('保密号中心', '/secret', '🔒', 2),
('个人中心', '/user', '👤', 3),
('赞助支持', '/sponsor', '❤️', 4);

INSERT IGNORE INTO home_banners (title, image_path, link_url, sort_order) VALUES
('欢迎来到 D5ST', '/public/images/banner1.svg', '/', 1);

-- 默认管理员：用户名需与 casdoor-init.js 里 DEFAULT_ADMIN_USER 一致，
-- 首次 Casdoor OAuth 登录时 findOrCreateCasdoorUser 会按 username 命中本行并回填真实 id。
INSERT IGNORE INTO casdoor_users (casdoor_user_id, username, real_name, is_admin) VALUES
('d5st_admin_seed', 'd5stadmin', '系统管理员', 1);

-- ------------------------------------------------------------
-- 默认示例内容：论坛版块 / 一篇帖子 / 两条评论 / 一个视频
-- 目的：新库初始化后首页与论坛即有内容，不再是空白页。
-- 幂等：全部走 INSERT IGNORE，配合固定主键或唯一键，重复执行不会产生重复数据。
-- 归属：示例内容挂到上面的默认管理员账号，用 SELECT 动态取 id，
--       避免把自增主键写死（casdoor_users 的 id 由自增/后续同步决定）。
-- ------------------------------------------------------------
INSERT IGNORE INTO forum_boards (name, slug, icon, description, sort_order) VALUES
('校园闲聊', 'chat', '💬', '校园日常，随便聊聊', 1),
('学习交流', 'study', '📚', '课程、考研、干货分享', 2),
('情感树洞', 'emotion', '💗', '倾诉与倾听的角落', 3),
('二手交易', 'market', '🛒', '闲置流转，校内交易', 4),
('求职实习', 'job', '💼', '实习、校招、简历经验', 5);

INSERT IGNORE INTO forum_posts (id, user_id, title, content, category, board_id, post_type, tags, views)
SELECT 1, cu.id,
  '图书馆三楼靠窗的位置真的太香了',
  '每天早上八点前去三楼，靠窗那一排基本都能占到。阳光刚好，插座也有，复习效率直接翻倍。就是下午会有点晒，建议带个小夹子挂个本子挡一下。',
  'campus',
  (SELECT id FROM forum_boards WHERE slug = 'chat' LIMIT 1),
  'normal', '图书馆 学习 日常', 436
FROM casdoor_users cu WHERE cu.username = 'd5stadmin' LIMIT 1;

INSERT IGNORE INTO post_comments (id, post_id, user_id, parent_id, content)
SELECT 1, 1, cu.id, NULL, '三楼确实好，不过我这学期才发现，已经期末了😭'
FROM casdoor_users cu WHERE cu.username = 'd5stadmin' LIMIT 1;

INSERT IGNORE INTO post_comments (id, post_id, user_id, parent_id, content)
SELECT 2, 1, cu.id, 1, '补充一下：四楼有插座的位置更多，安静程度也更好。'
FROM casdoor_users cu WHERE cu.username = 'd5stadmin' LIMIT 1;

INSERT IGNORE INTO video_posts (id, user_id, title, description, video_url, duration, views, category, is_recommended)
SELECT 1, cu.id,
  '校园秋季运动会开幕式航拍',
  '无人机视角记录今年运动会的开幕式，方阵入场 + 团体操表演。',
  'https://www.w3schools.com/html/mov_bbb.mp4', 214, 1832, 'campus', 1
FROM casdoor_users cu WHERE cu.username = 'd5stadmin' LIMIT 1;
