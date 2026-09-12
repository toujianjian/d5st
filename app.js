const path = require('path');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const pool = require('./配置/db');
const initDatabase = require('./配置/init-db');
const casdoor = require('./配置/casdoor');
const { initCasdoor } = require('./配置/casdoor-init');
const CASDOOR_CONFIG = casdoor.C;

const app = express();
const PORT = process.env.PORT || 35555;

app.set('views', path.join(__dirname, '页面模板'));
app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.use(expressLayouts);

app.use('/public', express.static(path.join(__dirname, '静态资源')));
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

app.use(async (req, res, next) => {
  res.locals.siteTitle = 'D5ST 校园社区';
  res.locals.currentUser = req.session.user || null;
  res.locals.currentAdmin = req.session.admin || null;
  res.locals.casdoorEndpoint = CASDOOR_CONFIG.endpoint;

  // 侧边栏需要的统计变量
  res.locals.postCount = 0;
  res.locals.commentCount = 0;
  res.locals.userLevel = 1;
  res.locals.pageScript = null;

  if (req.session.user) {
    try {
      const [pRows] = await pool.query('SELECT COUNT(*) as cnt FROM posts WHERE user_id = ?', [req.session.user.id]);
      res.locals.postCount = pRows[0]?.cnt || 0;
      const [cRows] = await pool.query('SELECT COUNT(*) as cnt FROM comments WHERE user_id = ?', [req.session.user.id]);
      res.locals.commentCount = cRows[0]?.cnt || 0;
      res.locals.userLevel = Math.floor((res.locals.postCount + res.locals.commentCount) / 5) + 1;
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
  '/public',
  '/forum',
  '/search',
  '/',
  ''
];

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

app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
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

// Webhook 路径白名单（Casdoor 事件回推，不强制登录）
app.use('/api/casdoor/webhook', require('./功能模块/casdoor-webhook'));

app.use('/', require('./功能模块/homepage'));
app.use('/', require('./功能模块/registration'));
app.use('/user', require('./功能模块/user'));
app.use('/forum', require('./功能模块/forum'));
app.use('/messages', require('./功能模块/messages'));
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
    // Casdoor 自动初始化（组织/应用/组/Webhook），失败不阻塞
    setImmediate(async () => {
      try { await initCasdoor(); } catch (e) { console.warn('Casdoor init error:', e.message); }
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
