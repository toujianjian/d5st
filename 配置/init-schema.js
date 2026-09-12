module.exports = `
CREATE TABLE IF NOT EXISTS casdoor_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  casdoor_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  real_name TEXT,
  avatar TEXT,
  email TEXT,
  phone TEXT,
  grade TEXT,
  class_name TEXT,
  student_no TEXT,
  nickname TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(casdoor_user_id),
  UNIQUE(username)
);

CREATE TABLE IF NOT EXISTS ys_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade TEXT NOT NULL,
  class_name TEXT NOT NULL,
  student_no TEXT NOT NULL,
  real_name TEXT NOT NULL,
  ding_id TEXT
);

CREATE TABLE IF NOT EXISTS user_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  secret_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS sponsor_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_yuan REAL NOT NULL,
  points_added INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status TEXT NOT NULL DEFAULT 'success'
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  tags TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  is_top INTEGER NOT NULL DEFAULT 0,
  is_hot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_medals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  medal_type TEXT NOT NULL,
  medal_name TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, medal_type)
);

CREATE TABLE IF NOT EXISTS post_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, post_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  comment_id INTEGER,
  reporter_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS user_online_status (
  user_id INTEGER PRIMARY KEY,
  is_online INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS deleted_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  deleted_by INTEGER,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  data TEXT NOT NULL,
  is_restored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  real_name TEXT NOT NULL,
  casdoor_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(username)
);

CREATE TABLE IF NOT EXISTS home_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS home_banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  image_path TEXT NOT NULL,
  link_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS path_redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  redirect_url TEXT NOT NULL,
  path_desc TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  keyword TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  theme_name TEXT DEFAULT 'default',
  night_mode_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS popups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  target_pages TEXT NOT NULL,
  show_once INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS popup_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  popup_id INTEGER NOT NULL,
  closed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, popup_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  action_url TEXT,
  action_text TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS global_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  action_url TEXT,
  action_text TEXT,
  start_time TEXT,
  end_time TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS system_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO system_settings (setting_key, setting_value, description) VALUES
('site_name', 'D5ST 校园社区', '网站名称'),
('site_description', '连接每一位同学，共享校园生活', '网站描述'),
('enable_registration', '1', '是否开放注册'),
('default_points', '100', '新用户默认积分');

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id INTEGER NOT NULL,
  following_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE IF NOT EXISTS video_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  cover_url TEXT,
  duration INTEGER DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  category TEXT DEFAULT 'campus',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO home_links (title, url, icon, sort_order) VALUES
('校园贴吧', '/forum', '💬', 1),
('保密号中心', '/secret', '🔒', 2),
('个人中心', '/user', '👤', 3),
('赞助支持', '/sponsor', '❤️', 4);

INSERT OR IGNORE INTO home_banners (title, image_path, link_url, sort_order) VALUES
('欢迎来到 D5ST', '/public/images/banner1.jpg', '/', 1);

INSERT OR IGNORE INTO casdoor_users (casdoor_user_id, username, real_name, is_admin) VALUES
('d5st_admin_seed', 'admin', '系统管理员', 1);
`;
