const path = require('path');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const pool = require('./配置/db');
const initDatabase = require('./配置/init-db');
const casdoor = require('./配置/casdoor');
const level = require('./配置/level');
const { initCasdoorWithRetry } = require('./配置/casdoor-init');
const security = require('./配置/security');
const CASDOOR_CONFIG = casdoor.C;

const app = express();
const PORT = process.env.PORT || 35555;

// 反向代理信任配置。
// 链路：浏览器 → (CDN) → nginx(TLS) → Caddy → app
//   - 老写法 trust proxy: 1 只信任 1 跳，若前面还有 CDN，req.ip 会取错一层；
//   - 这里改为信任「内网 + 回环」：容器网络与宿主反代都属于这一类，
//     公网直连的对端不会被信任（防止伪造 X-Forwarded-For 绕过限流）。
// 如果有 CDN，请在 .env 里用 TRUSTED_PROXIES 追加 CDN 回源 IP 段，
// 应用侧的真实 IP 还原见 配置/security.js 的 clientKey()。
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// ============================================================
// 安全响应头 + CDN 适配头
// ------------------------------------------------------------
// 必须放在 static 之前：否则 /public、/uploads 这些静态资源请求
// 直接被 express.static 处理掉，永远不会经过这里，结果是静态资源
// 缺 CSP/Vary/CDN-Cache-Control，既不利安全也不利 CDN 命中。
// ============================================================
app.use(security.securityHeaders);

app.set('views', path.join(__dirname, '页面模板'));
app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.use(expressLayouts);

// 模板里可直接调用：formatPoints(1200) → '1.2k'（见 配置/level.js）
app.locals.formatPoints = level.formatPoints;

// 带内容指纹的静态资源（如 bundle-app.b011993136.css、fa-solid-900.0b172f4669.woff2）
// 内容一变文件名就变，因此可以安全地长缓存一年；
// 其余未指纹化的资源保持 1 小时，改了图片/样式也能较快生效。
// 指纹由 _fa_build.py 生成，命名约定：<名字>.<10位十六进制>.<扩展名>
const FINGERPRINTED_ASSET = /\.[0-9a-f]{10}\.(?:css|js|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico)$/i;
function staticCacheHeaders(res, filePath) {
  if (FINGERPRINTED_ASSET.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // 同步告诉 CDN：内容变了文件名就变，可以永久缓存
    res.setHeader('CDN-Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('CDN-Cache-Control', 'public, max-age=3600');
  }
}

app.use('/public', express.static(path.join(__dirname, '静态资源'), { setHeaders: staticCacheHeaders }));
// Font Awesome 的 CSS 内部以 ../webfonts/ 引用字体（相对 CSS 自身），
// 解析后是 /public/webfonts/，但字体实际放在 /public/font-awesome/webfonts/ 下，
// 会导致所有图标 404。这里补一条映射，不改动原有目录结构。
app.use('/public/webfonts', express.static(path.join(__dirname, '静态资源/font-awesome/webfonts'), { setHeaders: staticCacheHeaders }));
// 用户上传的视频等文件：容器内 /app/uploads，由 docker-compose 挂宿主 ./uploads 持久化。
// 这些文件是用户上传的，名字里带随机串但**不带内容指纹**（同名文件内容可能变），
// 所以给 7 天而不是 immutable —— 否则替换同名文件后 CDN 会一直发旧内容。
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  setHeaders: (res) => { res.setHeader('Cache-Control', 'public, max-age=604800'); }
}));

// 动态 HTML 一律不缓存。
// 否则浏览器/边缘会把「游客版首页」缓存下来：用户登录成功后跳回首页，
// 拿到的却是缓存里的未登录页面 —— 表现为右上角不显示昵称、按钮仍是「登录/注册」。
// private + no-store 同时告诉浏览器和 CDN 都不要存。
app.use((req, res, next) => {
  if (req.path.startsWith('/public') || req.path.startsWith('/uploads') || req.path.startsWith('/avatar')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  // 部分 CDN 只认 CDN-Cache-Control，这里再显式说一次，防止边缘缓存私有页面
  res.setHeader('CDN-Cache-Control', 'no-store');
  next();
});

// 请求体解析上限。
// 默认 limit 是 100kb，对含长文本的帖子/评论来说太小，会直接 413；
// 但也不能放开到无限——超大 body 是廉价的资源耗尽手段。
// 这里给 2MB（正文本身另有 20k 字符的业务层校验），并显式限制参数个数，
// 防止 `a[b][c][d]...` 这种嵌套参数把 CPU 打满（qs 深度攻击）。
app.use(express.urlencoded({
  extended: true,
  limit: '2mb',
  parameterLimit: 500,
  depth: 5
}));
app.use(express.json({ limit: '2mb' }));

// ============================================================
// 页面级全局限流（防 CC）
// ------------------------------------------------------------
// 之前只在写操作与验证码上做了限流，GET 页面完全不设防：
// 实测 400 个并发页面请求全部放行，每个页面渲染要查 5~10 次数据库，
// 只要有人持续刷就能把连接池和 CPU 打满（典型的 CC 攻击）。
// 这里加一层宽松的全局限性：只统计页面 GET，静态资源与健康检查不计数。
// 阈值取 300 次/分钟/IP —— 正常浏览远远达不到，脚本刷立刻被挡。
// ============================================================
const pageFloodLimiter = security.rateLimit({
  name: 'page-flood',
  window: 60 * 1000,
  max: 300
});
app.use((req, res, next) => {
  // 只拦页面 GET；静态资源走静态中间件，不参与计数
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path || '/';
  if (p.startsWith('/public/') || p.startsWith('/uploads/') || p.startsWith('/avatar/')) return next();
  if (p === '/api/health') return next();
  return pageFloodLimiter(req, res, next);
});

// 搜索接口单独限流：每次搜索都要做两次 LIKE 全表扫描，比普通页面更贵
app.use('/search', security.rateLimit({ name: 'search', window: 60 * 1000, max: 30 }));

// ============================================================
// 启动期安全自检
// ------------------------------------------------------------
// 只告警不退出：避免因为一个弱配置把整站拦死。
// 但这些项一旦漏配就是真实风险，必须在日志里吼出来。
// ============================================================
const WEAK_SECRETS = new Set([
  'd5st-dev-secret-change-me',
  'd5st_session_secret_change_in_production',
  'secret',
  'changeme',
  ''
]);
function runSecuritySelfCheck() {
  const warns = [];
  const secret = process.env.SESSION_SECRET || '';

  if (WEAK_SECRETS.has(secret) || secret.length < 32) {
    warns.push('SESSION_SECRET 过弱或未设置（当前长度 ' + secret.length + '）—— 攻击者可伪造会话，' +
      '请用 openssl rand -hex 32 生成后写入环境变量');
  }
  if (process.env.ENABLE_DEV_LOGIN === '1') {
    if (process.env.NODE_ENV === 'production') {
      warns.push('ENABLE_DEV_LOGIN=1 且 NODE_ENV=production —— 免密登录后门已开启，' +
        '生产环境必须删除该变量（代码层已额外拦截，但仍应关闭）');
    } else {
      console.warn('[安全] ENABLE_DEV_LOGIN=1（仅开发用）：任何人可免密登录，上线前务必关闭');
    }
  }
  const appUrl = process.env.APP_URL || '';
  if (!appUrl) {
    warns.push('APP_URL 未设置 —— OAuth 回调与 robots/sitemap 里的绝对地址会不正确');
  } else if (appUrl.startsWith('http://') && process.env.NODE_ENV === 'production') {
    warns.push('APP_URL 是 http:// —— 生产建议启用 HTTPS（否则会话 cookie 无法设置 secure）');
  }
  if (process.env.NODE_ENV === 'production' && process.env.USE_MYSQL !== '1') {
    warns.push('生产环境未启用 USE_MYSQL=1 —— 当前使用的是本地 SQLite，不适合多实例/高并发');
  }
  if (warns.length) {
    console.warn('\n========== 安全自检未通过项（' + warns.length + '） ==========');
    warns.forEach((w, i) => console.warn(`  ${i + 1}. ${w}`));
    console.warn('=====================================================\n');
  } else {
    console.log('[安全] 启动自检通过（会话密钥、开发后门、APP_URL 均已正确配置）');
  }
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'd5st-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
      sameSite: 'lax'
    }
  })
);

// CSRF 防护（双提交 Cookie）。必须在 session 之后、所有业务路由之前。
// 只拦写操作（POST/PUT/PATCH/DELETE），GET/HEAD 放行。
app.use(security.csrfProtection);

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
  // 等级/积分统一由 配置/level.js 推导（等级只跟积分挂钩，不再用帖子数估算）
  res.locals.userLevel = 1;
  res.locals.userLevelName = level.LEVELS[0].name;
  res.locals.userPoints = 0;
  res.locals.userPointsText = '0';
  res.locals.levelProgress = 0;
  res.locals.levelRemaining = 0;
  res.locals.levelNextName = null;
  res.locals.levelIsMax = false;
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

      // 等级由积分推导（配置/level.js），不再用「帖子+评论」估算，避免和积分口径打架
      const [uRows] = await pool.query('SELECT points FROM casdoor_users WHERE id = ?', [uid]);
      level.applyToLocals(res, (uRows[0] && uRows[0].points) || 0);

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
  '/robots.txt',
  '/sitemap.xml',
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
  // 上传的视频/图片是静态文件，无需登录即可播放（页面本身已有访问控制），
  // 否则 <video src="/uploads/..."> 在未登录时会被 302 到 /login，播放器直接坏掉。
  if (req.path.startsWith('/uploads/')) return next();
  if (req.path.startsWith('/avatar/')) return next();
  if (req.path.startsWith('/casdoor')) return next();
  
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

// 用户头像输出（二进制存 user_avatars 表，随数据库迁移）
app.get('/avatar/:id', async (req, res) => {
  const uid = parseInt(req.params.id, 10);
  if (isNaN(uid)) return res.status(400).end();
  try {
    const [rows] = await pool.query('SELECT mime, data FROM user_avatars WHERE user_id = ?', [uid]);
    if (!rows || rows.length === 0) return res.status(404).end();
    res.set('Content-Type', rows[0].mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rows[0].data);
  } catch (e) {
    res.status(500).end();
  }
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
  try {
    // 未登录也返回全局通知（站内公告对访客同样可见）；个人通知需登录
    let userNotif = [];
    if (userId) {
      const [rows] = await pool.query(
        'SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 10',
        [userId]
      );
      userNotif = rows;
    }
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

// robots.txt
// 说明：必须返回 text/plain，且内容里不能有 YAML/HTML —— 否则 Lighthouse 判为
// 「robots.txt is not valid」。同时把后台/接口/用户私有页挡在爬虫之外。
app.get('/robots.txt', (req, res) => {
  const siteUrl = process.env.APP_URL || '';
  const lines = [
    'User-agent: *',
    'Allow: /$',
    'Allow: /forum',
    'Allow: /videos',
    'Allow: /search',
    'Allow: /secret',
    'Allow: /sponsor',
    'Allow: /messages/guestbook',
    '',
    '# 用户私有内容与后台不收录',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /user',
    'Disallow: /messages',
    'Disallow: /friends',
    'Disallow: /auth/',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /forgot-password',
    'Disallow: /avatar/',
    'Disallow: /uploads/',
    'Disallow: /casdoor'
  ];
  if (siteUrl) lines.push('', 'Sitemap: ' + siteUrl.replace(/\/$/, '') + '/sitemap.xml');
  res.type('text/plain; charset=utf-8').send(lines.join('\n') + '\n');
});

// 简易 sitemap：公开可索引的静态入口 + 最新帖子/视频
app.get('/sitemap.xml', async (req, res) => {
  try {
    const siteUrl = (process.env.APP_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    const esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const [posts] = await pool.query(
      'SELECT id, created_at FROM forum_posts WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 500'
    ).catch(() => [[]]);
    const [videos] = await pool.query(
      'SELECT id, created_at FROM video_posts WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 500'
    ).catch(() => [[]]);
    const statics = ['/', '/forum', '/videos', '/search', '/secret', '/sponsor', '/messages/guestbook'];
    const urlTag = (loc, lastmod) =>
      `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : ''}</url>`;
    const urls = [
      ...statics.map(p => urlTag(siteUrl + p)),
      ...posts.map(p => urlTag(siteUrl + '/forum/' + p.id, p.created_at)),
      ...videos.map(v => urlTag(siteUrl + '/videos/' + v.id, v.created_at))
    ].join('');
    res.type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  } catch (err) {
    res.status(500).send('sitemap 生成失败');
  }
});

// RSS 2.0 订阅（madblog 整合点）
app.get('/rss.xml', async (req, res) => {
  try {
    const [posts] = await pool.query(
      `SELECT fp.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name FROM forum_posts fp
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
  // ------------------------------------------------------------
  // 客户端错误不能算 500
  // ------------------------------------------------------------
  // body-parser 在遇到畸形 JSON / 超大 body / 非法 charset 时会抛错，
  // 这些是「请求方的问题」，必须回 4xx，否则：
  //   1) 监控会把正常攻击流量误报成服务端故障；
  //   2) 攻击者只要发一堆畸形 JSON 就能把 5xx 指标打满。
  // err.type 由 body-parser 提供，err.status / err.statusCode 是通用约定。
  const clientErrTypes = new Set([
    'entity.parse.failed',      // JSON 语法错误
    'entity.too.large',         // 超过 express.json() 的 limit
    'encoding.unsupported',     // 不支持的字符集
    'request.aborted',          // 客户端中断
    'request.size.invalid',     // Content-Length 与实际不符
    'charset.unsupported',
    'parameters.too.many'
  ]);
  const status = err.status || err.statusCode;
  const isClientErr = clientErrTypes.has(err.type) || (status >= 400 && status < 500);

  if (isClientErr) {
    const code = status || 400;
    // 这类请求不记完整堆栈，避免日志被刷爆（只留一行摘要）
    console.warn(`[请求被拒绝] ${req.method} ${req.path} → ${code} (${err.type || err.message})`);
    if (req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json')) {
      return res.status(code).json({ error: code === 413 ? '请求体过大' : '请求格式不正确' });
    }
    return res.status(code).type('text/plain; charset=utf-8').send(code === 413 ? '请求体过大' : '请求格式不正确');
  }

  console.error('全局错误:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: '服务器内部错误' });
  }
  res.status(500).render('errors/500', { title: '服务器错误', error: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ============================================================
// 进程级兜底
// ------------------------------------------------------------
// Express 4 不会自动捕获 async 路由里抛出的 rejection，
// 一旦某处 await 失败且没有 try/catch，Node 默认行为是直接退出进程
// （一次畸形请求就能让整站下线）。这里把未捕获异常记录下来但不退出，
// 保证单个请求的故障不会演变成全站不可用。
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('[未捕获的 Promise 异常]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获的异常]', err && err.stack ? err.stack : err);
  // 内存耗尽等无法恢复的错误仍需退出，交给容器/进程管理器重启
  if (err && (err.code === 'ENOMEM' || err.name === 'RangeError')) {
    process.exit(1);
  }
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
      runSecuritySelfCheck();
    });
  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

startServer();
