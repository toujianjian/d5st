const path = require('path');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const pool = require('./配置/db');
const initDatabase = require('./配置/init-db');
const casdoor = require('./配置/casdoor');
const { initCasdoorWithRetry } = require('./配置/casdoor-init');
const CASDOOR_CONFIG = casdoor.C;

const app = express();
const PORT = process.env.PORT || 35555;

app.set('views', path.join(__dirname, '页面模板'));
app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.use(expressLayouts);

app.use('/public', express.static(path.join(__dirname, '静态资源')));
// Font Awesome 的 all.min.css 内部以 ../webfonts/ 引用字体（相对 CSS 自身），
// 解析后是 /public/webfonts/，但字体实际放在 /public/font-awesome/webfonts/ 下，
// 会导致所有图标 404。这里补一条映射，不改动原有目录结构。
app.use('/public/webfonts', express.static(path.join(__dirname, '静态资源/font-awesome/webfonts')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'd5st-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 2,
      httpOnly: true
    }
  })
);

// 统一的日期格式化：MySQL 返回的是 Date 对象，直接 String() 会得到
// 「Sat Sep 26 2026 11:32:00 GMT+0800」这种英文长串，页面很难看。
// 这里统一成 2026-09-26 11:32，供所有模板使用。
function fmtDate(value, withTime = true) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value).slice(0, withTime ? 16 : 10);
  const p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

app.use(async (req, res, next) => {
  res.locals.siteTitle = 'D5ST 校园社区';
  res.locals.fmtDate = fmtDate;
  res.locals.currentPath = req.path;

  res.locals.currentUser = req.session.user || null;
  res.locals.currentAdmin = req.session.admin || null;
  res.locals.casdoorEndpoint = CASDOOR_CONFIG.endpoint;

  // 侧边栏需要的统计变量
  res.locals.postCount = 0;
  res.locals.commentCount = 0;
  res.locals.userLevel = 1;
  res.locals.userPoints = 0;
  res.locals.friendRequestCount = 0;
  res.locals.unreadMessageCount = 0;
  res.locals.pageScript = null;

  // 赞助入口开关（system_settings.sponsor_enabled；0 或缺失 = 暂停）
  res.locals.sponsorEnabled = false;
  try {
    const [sRows] = await pool.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'sponsor_enabled' LIMIT 1"
    );
    res.locals.sponsorEnabled = sRows.length > 0 && String(sRows[0].setting_value) === '1';
  } catch (e) { /* 设置表可能不存在，忽略 */ }

  if (req.session.user) {
    try {
      const uid = req.session.user.id;
      // 注意：真实表名是 forum_posts / post_comments（旧代码查 posts/comments 永远为 0）
      const [pRows] = await pool.query(
        'SELECT COUNT(*) as cnt FROM forum_posts WHERE user_id = ? AND is_deleted = 0', [uid]
      );
      res.locals.postCount = pRows[0]?.cnt || 0;
      const [cRows] = await pool.query(
        'SELECT COUNT(*) as cnt FROM post_comments WHERE user_id = ? AND is_deleted = 0', [uid]
      );
      res.locals.commentCount = cRows[0]?.cnt || 0;
      res.locals.userLevel = Math.floor((res.locals.postCount + res.locals.commentCount) / 5) + 1;

      const [uRows] = await pool.query('SELECT points FROM casdoor_users WHERE id = ?', [uid]);
      res.locals.userPoints = (uRows[0] && uRows[0].points) || 0;

      const [frRows] = await pool.query(
        "SELECT COUNT(*) as cnt FROM friend_requests WHERE to_user_id = ? AND status = 'pending'", [uid]
      );
      res.locals.friendRequestCount = frRows[0]?.cnt || 0;

      const [umRows] = await pool.query(
        'SELECT COUNT(*) as cnt FROM messages WHERE receiver_id = ? AND is_read = 0', [uid]
      );
      res.locals.unreadMessageCount = umRows[0]?.cnt || 0;
    } catch (e) {
      // 表可能不存在，忽略
    }
  }
  next();
});

const publicPaths = [
  '/login',
  '/register',
  '/auth',
  '/logout',
  '/forgot-password',
  '/messages/guestbook',
  '/secret',
  '/secret/show',
  '/sponsor',
  '/api/check-login',
  '/api/popups',
  '/api/health',
  '/rss.xml',
  '/public',
  '/forum',
  '/videos',
  '/search',
  '/',
  ''
];

// 路径重定向必须在认证中间件之前：未登录访客访问被重定向的路径时，
// 才能跳到目标，而不是被踢到 /login。同时排除 /admin（管理后台自己）
// 与 /api（避免 JSON 接口被意外 302 到 HTML 页面）。
app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
  if (req.path.startsWith('/api/')) return next();
  try {
    const [rows] = await pool.query(
      'SELECT redirect_url FROM path_redirects WHERE path = ? AND is_active = 1',
      [req.path]
    );
    if (rows.length > 0) return res.redirect(302, rows[0].redirect_url);
  } catch (err) {
    console.error('路径重定向查询失败:', err.message);
  }
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/public/')) return next();
  
  const isPublic = publicPaths.some(p => 
    p === '' ? req.path === '/' : (req.path === p || req.path.startsWith(p + '/'))
  );
  
  if (isPublic) return next();
  if (!req.session.user) return res.redirect('/login');
  next();
});

// Webhook 路径白名单（Casdoor 事件回推，不强制登录）
app.use('/api/casdoor/webhook', require('./功能模块/casdoor-webhook'));

app.use('/', require('./功能模块/homepage'));
app.use('/', require('./功能模块/registration'));
app.use('/user', require('./功能模块/user'));
app.use('/forum', require('./功能模块/forum'));
app.use('/messages', require('./功能模块/messages'));
app.use('/friends', require('./功能模块/friends'));
app.use('/search', require('./功能模块/search'));
app.use('/secret', require('./功能模块/secret-code'));
app.use('/sponsor', require('./功能模块/sponsor'));
app.use('/videos', require('./功能模块/videos'));
app.use('/admin', require('./功能模块/admin'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/check-login', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ loggedIn: false, error: '会话已过期' });
  }
  res.json({
    loggedIn: true,
    user: {
      id: req.session.user.id,
      username: req.session.user.username,
      real_name: req.session.user.real_name,
      is_admin: req.session.user.is_admin
    }
  });
});

app.get('/api/popups', async (req, res) => {
  const page = req.query.page || 'home';
  const userId = req.session.user?.id || null;
  try {
    // 兼容 SQLite（无 FIND_IN_SET）：取本页/全局且在生效期内的弹窗，在 JS 里过滤
    let query = `
      SELECT * FROM popups 
      WHERE is_active = 1 
        AND (target_pages = 'all' OR INSTR(COALESCE(target_pages,''), ?) > 0)
        AND (start_time IS NULL OR start_time <= CURRENT_TIMESTAMP)
        AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP)
      ORDER BY sort_order ASC, id DESC
      LIMIT 50
    `;
    const [popups] = await pool.query(query, [page]);
    // 精确按逗号分隔匹配，避免 INSTR 子串误判
    const filtered = popups.filter(p => {
      if (!p.target_pages || p.target_pages === 'all') return true;
      return p.target_pages.split(',').map(x => x.trim()).includes(page);
    });
    if (userId) {
      const [viewed] = await pool.query('SELECT popup_id FROM popup_views WHERE user_id = ?', [userId]);
      const viewedIds = viewed.map(v => v.popup_id);
      res.json(filtered.filter(p => !p.show_once || !viewedIds.includes(p.id)));
    } else {
      res.json(filtered.filter(p => !p.show_once));
    }
  } catch (err) {
    console.error('弹窗查询失败:', err.message);
    res.json([]);
  }
});

app.post('/api/popups/:id/close', async (req, res) => {
  const popupId = req.params.id;
  const userId = req.session.user?.id;
  if (!userId) return res.json({ success: true });
  try {
    const [exists] = await pool.query(
      'SELECT id FROM popup_views WHERE user_id = ? AND popup_id = ?',
      [userId, popupId]
    );
    if (!exists || exists.length === 0) {
      await pool.query('INSERT INTO popup_views (user_id, popup_id) VALUES (?, ?)', [userId, popupId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

app.get('/api/notifications', async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.json([]);
  try {
    const [userNotif] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 10',
      [userId]
    );
    const [globalNotif] = await pool.query(
      `SELECT * FROM global_notifications 
       WHERE is_active = 1 AND (start_time IS NULL OR start_time <= CURRENT_TIMESTAMP)
       AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP)
       ORDER BY created_at DESC LIMIT 5`
    );
    const combined = [...userNotif, ...globalNotif.map(n => ({ ...n, is_global: true }))];
    combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(combined.slice(0, 10));
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/notifications/:id/read', async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.json({ success: true });
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// RSS 2.0 订阅（madblog 整合点）
app.get('/rss.xml', async (req, res) => {
  try {
    const [posts] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name FROM forum_posts fp
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       WHERE fp.is_deleted = 0
       ORDER BY fp.created_at DESC LIMIT 20`
    );
    const siteTitle = 'D5ST 校园社区';
    const siteUrl = process.env.APP_URL || 'http://localhost:35555';
    const now = new Date().toUTCString();
    const itemsXml = posts.map(p => {
      const author = (p.real_name || p.username || '匿名').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const title = (p.title || p.content.slice(0, 50)).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const desc = String(p.content || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      return `<item>
  <title>${title}</title>
  <link>${siteUrl}/forum/${p.id}</link>
  <guid>${siteUrl}/forum/${p.id}</guid>
  <pubDate>${new Date(p.created_at).toUTCString()}</pubDate>
  <author>${author}</author>
  <description><![CDATA[${desc}]]></description>
</item>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${siteTitle}</title>
  <link>${siteUrl}</link>
  <description>D5ST 校园社区 最新话题 RSS 订阅</description>
  <language>zh-CN</language>
  <lastBuildDate>${now}</lastBuildDate>
  <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
${itemsXml}
</channel>
</rss>`;
    res.type('application/rss+xml').send(xml);
  } catch (err) {
    res.status(500).send('RSS 生成失败');
  }
});

app.use((req, res) => {
  res.status(404).render('errors/404', { title: '页面未找到' });
});

app.use((err, req, res, next) => {
  console.error('全局错误:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: '服务器内部错误' });
  }
  res.status(500).render('errors/500', { title: '服务器错误', error: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

async function startServer() {
  try {
    await initDatabase();
    // 启动后加载敏感词词库到内存（管理员在后台增删词后会即时 reload）
    setImmediate(async () => {
      try { await require('./配置/sensitive-word').reload(); } catch (e) { console.warn('敏感词加载失败:', e.message); }
    });
    // Casdoor 自动初始化（组织/应用/组/Webhook），失败不阻塞。
    // 使用带重试的版本，避免 Casdoor 容器先启动、内部尚未就绪时一次性失败后再不重试。
    setImmediate(async () => {
      try {
        const r = await initCasdoorWithRetry();
        // Casdoor 就绪后，把 Casdoor 用户与本地映射表对账：
        // 正向补齐 Casdoor 用户，并清理 seed.js / dev-login 写入的演示账号，
        // 避免"本地表数量"与 Casdoor 长期不一致。
        if (r && r.ok) {
          const { reconcileCasdoorUsers } = require('./配置/user-service');
          const rc = await reconcileCasdoorUsers(casdoor);
          console.log(`[用户同步] 对账完成：同步 ${rc.synced}/${rc.total} 个，清理演示账号 ${rc.removed} 个${rc.reason ? '（' + rc.reason + '）' : ''}`);
        }
      } catch (e) { console.warn('Casdoor init error:', e.message); }
    });
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`D5ST 服务运行中: http://localhost:${PORT}`);
      console.log(`Casdoor 端点: ${CASDOOR_CONFIG.endpoint}`);
      console.log(`Casdoor 组织: ${CASDOOR_CONFIG.organization} / 应用: ${CASDOOR_CONFIG.application}`);
    });
  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

startServer();
