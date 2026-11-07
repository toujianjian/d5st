// 公网 HTTPS 链路验证（不产生任何写入副作用）
// 目的：确认 CSRF 在 HTTPS 下可用 —— cookie 带 Secure、写操作能通过校验，
//       同时确认 HSTS 未开启（避免证书不匹配域名被锁死）。
//
// 用法：BASE=https://你的域名 node 测试/test-live-https.js
// 注意：这里**不设默认域名**。测试脚本不应该内置任何具体站点地址，
//       否则会随仓库泄露部署信息，别人克隆后也会误打到你自己的站点。
const https = require('https');

const BASE = process.env.BASE;
if (!BASE) {
  console.error('请通过环境变量指定目标站点，例如：');
  console.error('  BASE=https://your-domain.example node 测试/test-live-https.js');
  process.exit(2);
}
const jar = new Map();
const cookieMeta = new Map();

function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }

function store(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    jar.set(k, v);
    cookieMeta.set(k, attrs.map(a => a.trim()).join('; '));
  }
}

function req(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const headers = Object.assign({}, opts.headers || {});
    const ck = cookieHeader(); if (ck) headers.Cookie = ck;
    let body = opts.body;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers, timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { store(res); resolve({ status: res.statusCode, headers: res.headers, body: d }); });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + ' — ' + e); };
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  console.log('\n============================================');
  console.log(' 公网 HTTPS 验证');
  console.log(' 目标:', BASE);
  console.log('============================================\n');

  let first;
  try {
    first = await req('GET', '/');
    assert(first.status === 200, '首页状态 ' + first.status);
    ok('首页 200');
  } catch (e) { bad('首页', e.message); return finish(); }

  // 安全头
  try {
    const h = first.headers;
    assert(h['x-content-type-options'] === 'nosniff', '缺 nosniff');
    assert(!!h['content-security-policy'], '缺 CSP');
    assert(!!h['x-frame-options'], '缺 X-Frame-Options');
    assert(!!h['referrer-policy'], '缺 Referrer-Policy');
    ok('安全响应头齐全');
  } catch (e) { bad('安全响应头', e.message); }

  // HSTS 必须关闭
  try {
    assert(!first.headers['strict-transport-security'],
      '存在 HSTS 头！证书未覆盖全部 server_name 时会把用户锁在证书错误页');
    ok('HSTS 未下发（符合预期，避免锁死 www 域名）');
  } catch (e) { bad('HSTS 检查', e.message); }

  // CSRF cookie 在 HTTPS 下必须带 Secure
  try {
    assert(jar.get('csrf_token'), '未下发 csrf_token');
    const meta = cookieMeta.get('csrf_token') || '';
    assert(/secure/i.test(meta), 'csrf_token 未带 Secure 标记: ' + meta);
    ok('csrf_token 已下发且带 Secure（HTTPS 下正确）');
    console.log('     cookie 属性: ' + meta);
  } catch (e) { bad('CSRF cookie 属性', e.message); }

  // 无 token 的写请求 → 403
  try {
    const r = await req('POST', '/forum', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'content=csrf-probe-no-token'
    });
    assert(r.status === 403, '期望 403，实际 ' + r.status);
    ok('无 CSRF token 的写请求被拒绝（403）');
  } catch (e) { bad('无 token 拦截', e.message); }

  // 带 token 的写请求 → 通过 CSRF，但因未登录返回 401
  // （选择 /forum 是为了不产生任何实际写入：未登录会在鉴权处就返回 401）
  try {
    const token = jar.get('csrf_token');
    const r = await req('POST', '/forum', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': token },
      body: 'content=csrf-probe-with-token'
    });
    assert(r.status === 401, '期望 401（CSRF 通过但未登录），实际 ' + r.status);
    ok('带 CSRF token 的写请求通过校验（401=未登录，符合预期）');
  } catch (e) { bad('带 token 通过', e.message); }

  // 页面表单是否注入 token
  try {
    const r = await req('GET', '/login');
    assert(r.status === 200, '登录页 ' + r.status);
    ok('登录页 200');
  } catch (e) { bad('登录页', e.message); }

  // 关键静态资源
  try {
    for (const p of ['/public/js/main.js', '/public/css/bundle-app.011218947b.css']) {
      const r = await req('GET', p);
      assert(r.status === 200, p + ' 返回 ' + r.status);
    }
    ok('关键静态资源可访问');
  } catch (e) { bad('静态资源', e.message); }

  // robots / sitemap
  try {
    const rb = await req('GET', '/robots.txt');
    assert(rb.status === 200 && /User-agent/i.test(rb.body), 'robots 异常');
    const sm = await req('GET', '/sitemap.xml');
    assert(sm.status === 200 && /<urlset/.test(sm.body), 'sitemap 异常');
    ok('robots.txt / sitemap.xml 正常');
  } catch (e) { bad('robots/sitemap', e.message); }

  finish();

  function finish() {
    console.log('\n============================================');
    console.log(' 通过 ' + pass + ' · 失败 ' + fail);
    console.log('============================================\n');
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(e => { console.error('框架异常:', e); process.exit(2); });
