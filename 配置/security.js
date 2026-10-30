'use strict';
// ============================================================
// 安全中间件层
// ------------------------------------------------------------
// 目标：一次性补齐 Web 侧最常见的几类攻击面，业务路由无需重复实现。
//
//   1) securityHeaders   —— CSP / X-Content-Type-Options / X-Frame-Options 等
//   2) csrfProtection    —— 双提交 Cookie（Double Submit Cookie）CSRF 防护
//   3) rateLimit         —— 内存滑动窗口限流（登录、发帖、私信、评论、上传）
//   4) validateId        —— 路由参数 :id 必须是正整数（防类型混淆 / 慢查询）
//   5) safeRedirect      —— 站内跳转白名单，堵住开放重定向
//   6) sanitizeInput     —— 统一裁剪超长输入、剥除控制字符
//
// 设计取舍：不引入 helmet / csurf 等额外依赖（离线构建 + 依赖体积），
// 全部自实现且零依赖，便于审计。CSRF 采用双提交 Cookie：
// 服务端下发随机 token 到非 httpOnly 的 csrf_token cookie，
// 前端 JS 读出来放进 X-CSRF-Token 头或 _csrf 表单字段；
// 服务端比对「cookie 值 == 提交值」。攻击者跨站读不到 cookie，也就伪造不出来。
// ============================================================
const crypto = require('crypto');

// ------------------------------------------------------------
// 1) 安全响应头
// ------------------------------------------------------------
// 说明：站点大量使用内联 <style>/<script> 与 onclick，且引入了 Casdoor 子路径，
// 因此 CSP 不能用严格 nonce 模式，这里采用「限制来源」而非「禁止内联」的折中策略，
// 至少堵死外域脚本注入与 data: 文档劫持。
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // 旧版浏览器 XSS 过滤器本身可被利用，显式关闭
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // 上传的视频走 blob:/self，Casdoor 子路径同源，故 script-src 保留 'unsafe-inline'
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  // HSTS 默认**关闭**，必须显式 ENABLE_HSTS=1 才发送。
  // 原因：HSTS 一旦下发，浏览器会在 max-age 内强制 HTTPS 且不允许跳过证书警告。
  // 若站点同时存在「证书不覆盖的域名」（例如 cert 只签了 s1.example.com，
  // 但 server_name 里还有 www.example.com），开启 HSTS 会把访问那些域名的用户
  // 永久锁在证书错误页。这类判断必须由部署者确认后再打开。
  if (process.env.ENABLE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ------------------------------------------------------------
// 2) CSRF 双提交 Cookie
// ------------------------------------------------------------
const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_FIELD = '_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 判断本次请求是否真的走 HTTPS。
// 不用 APP_URL 判断：站点可能同时通过域名(HTTPS)和 内网/IP(HTTP) 访问，
// 若一律按 APP_URL 打 secure，走 HTTP 的客户端根本存不下 cookie，
// 表现为「页面能打开，但任何表单提交都 403」。
// trust proxy 已开启，req.secure 会读取 X-Forwarded-Proto。
function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

// 签发/续期 token：每次请求保证 cookie 存在（过期自动补）
function ensureCsrfToken(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies[CSRF_COOKIE];
  if (!token || token.length < 32) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // 前端 JS 需要读取后回填，双提交模式的必要前提
      sameSite: 'lax',
      path: '/',
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: isSecureRequest(req)
    });
  }
  req.csrfToken = token;
  return token;
}

function csrfProtection(req, res, next) {
  const token = ensureCsrfToken(req, res);
  // 模板里可直接用 <%= csrfToken %> 生成隐藏字段
  res.locals.csrfToken = token;

  if (SAFE_METHODS.has(req.method)) return next();

  // Webhook 走独立签名校验，不参与 CSRF（外部服务不可能持有本站 cookie）
  if (req.path.startsWith('/api/casdoor/webhook')) return next();

  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE];
  const submitted = req.get(CSRF_HEADER) ||
    (req.body && req.body[CSRF_FIELD]) ||
    (req.query && req.query[CSRF_FIELD]) || '';

  if (!cookieToken || !submitted || !timingSafeEqualStr(String(submitted), String(cookieToken))) {
    // JSON 接口返回 403 JSON，页面表单返回 403 文本（避免误渲染成 500）
    if (req.xhr || req.path.startsWith('/api/') ||
        (req.get('accept') || '').includes('application/json') ||
        (req.get('content-type') || '').includes('application/json')) {
      return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面后重试' });
    }
    return res.status(403).type('text/plain; charset=utf-8')
      .send('CSRF 校验失败：请刷新页面后重试。');
  }
  next();
}

// ------------------------------------------------------------
// 3) 内存限流（滑动窗口）
// ------------------------------------------------------------
// 单实例部署够用；多副本时各进程独立计数，量级仍能拦住刷接口。
const buckets = new Map();

// 定期清理过期桶，避免 Map 无限增长（被大量伪造 IP 撑爆内存）
let lastSweep = Date.now();
function sweep(now) {
  if (now - lastSweep < 60 * 1000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.start > bucket.window * 2) buckets.delete(key);
  }
}

function clientKey(req) {
  // trust proxy 已开启，req.ip 取 X-Forwarded-For 首段
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * @param {object} opts
 * @param {string} opts.name     桶名（区分不同限流策略）
 * @param {number} opts.window   窗口毫秒
 * @param {number} opts.max      窗口内最大请求数
 * @param {string} [opts.keyBy]  'ip' | 'user' | 'ip+path'
 */
function rateLimit(opts) {
  const { name, window, max, keyBy = 'ip' } = opts;
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    sweep(now);

    let subject;
    if (keyBy === 'user') subject = req.session?.user?.id ? 'u' + req.session.user.id : clientKey(req);
    else if (keyBy === 'ip+path') subject = clientKey(req) + '|' + req.path;
    else subject = clientKey(req);

    const key = name + ':' + subject;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= window) {
      bucket = { start: now, count: 0, window };
      buckets.set(key, bucket);
    }
    bucket.count++;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + window - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      if (req.path.startsWith('/api/') || req.xhr ||
          (req.get('accept') || '').includes('application/json') ||
          (req.get('content-type') || '').includes('application/json')) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试', retryAfter });
      }
      return res.status(429).type('text/plain; charset=utf-8')
        .send('请求过于频繁，请稍后再试（' + Math.max(1, retryAfter) + ' 秒后重试）');
    }
    next();
  };
}

// 测试用：重置所有计数（不对外暴露）
function resetRateLimits() { buckets.clear(); }

// ------------------------------------------------------------
// 4) 路由参数校验
// ------------------------------------------------------------
function parseId(value) {
  // 只接受纯数字串，拒绝 '1abc' / '1e3' / ' 1' / '0x10' 这类会被 parseInt 部分解析的值
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  if (!/^[1-9]\d{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 生成一个校验 :id 参数的中间件。
 * 用法：router.get('/x/:id', requireId('id'), handler)
 */
function requireId(paramName = 'id') {
  return function requireIdMiddleware(req, res, next) {
    const raw = req.params[paramName];
    const id = parseId(raw);
    if (id === null) {
      if (req.path.startsWith('/api/') || req.xhr ||
          (req.get('accept') || '').includes('application/json')) {
        return res.status(400).json({ error: '参数非法' });
      }
      return res.status(404).render('errors/404', { title: '页面不存在' });
    }
    req.params[paramName] = id; // 后续直接用，已是数字
    next();
  };
}

// ------------------------------------------------------------
// 5) 安全跳转（开放重定向防护）
// ------------------------------------------------------------
/**
 * 只允许站内相对路径。拒绝：
 *   //evil.com、/\evil.com、http://evil.com、javascript:、data:
 */
function safeRedirect(target, fallback = '/') {
  if (typeof target !== 'string') return fallback;
  const t = target.trim();
  if (!t) return fallback;
  // 必须以单个 / 开头，且第二个字符不能是 / 或 \
  if (t[0] !== '/') return fallback;
  if (t[1] === '/' || t[1] === '\\') return fallback;
  // 排除协议相对与伪协议
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return fallback;
  // 排除控制字符与换行（响应拆分）
  if (/[\r\n\t]/.test(t)) return fallback;
  // 反斜杠在部分浏览器等价于 /，统一拒绝
  if (t.includes('\\')) return fallback;
  return t;
}

// ------------------------------------------------------------
// 6) 输入清洗
// ------------------------------------------------------------
// 剥除 C0 控制字符（保留 \n \r \t），并裁剪长度
function cleanText(value, maxLen = 10000) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// 站点内使用的展示名/标题等短文本
function cleanShort(value, maxLen = 200) {
  return cleanText(value, maxLen).trim();
}

// 分页参数：必须落在 [1, maxPage] 区间内。
// 之前 page 直接 parseInt 后算 offset，传入 1e21 这类值时
// offset 溢出成非整数，SQLite/MySQL 都会报 datatype mismatch → 500。
function parsePage(value, maxPage = 100000) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > maxPage) n = maxPage;
  return n;
}

module.exports = {
  securityHeaders,
  csrfProtection,
  ensureCsrfToken,
  rateLimit,
  resetRateLimits,
  parseId,
  requireId,
  safeRedirect,
  cleanText,
  cleanShort,
  parsePage,
  parseCookies,
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_FIELD
};
