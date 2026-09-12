-- ============================================================
-- D5ST 数据库建表脚本
-- 创建数据库：CREATE DATABASE d5st DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- ============================================================

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
CREATE TABLE IF NOT EXISTS forum_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  content TEXT NOT NULL,
  tags VARCHAR(255) DEFAULT NULL,
  section VARCHAR(50) DEFAULT 'general',
  views INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES casdoor_users(id) ON DELETE CASCADE,
  INDEX idx_created_at (created_at),
  INDEX idx_section (section)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='论坛帖子';

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
  is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='首页链接';

-- 首页横幅
CREATE TABLE IF NOT EXISTS home_banners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  link_url VARCHAR(255) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1
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
('欢迎来到 D5ST', '/public/images/banner1.jpg', '/', 1);

INSERT IGNORE INTO casdoor_users (casdoor_user_id, username, real_name, is_admin) VALUES
('d5st_admin_seed', 'admin', '系统管理员', 1);
