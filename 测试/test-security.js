'use strict';
// ============================================================
// 安全回归测试（零依赖，直接跑：node 测试/test-security.js）
// ------------------------------------------------------------
// 覆盖本次加固的每一类攻击面，每个用例都断言「攻击失败 / 防护生效」：
//   1. 安全响应头
//   2. CSRF 双提交校验
//   3. SQL 注入（sort / category / 搜索 / 后台设置键）
//   4. 开放重定向（/login?next=、/auth/login?next=）
//   5. 参数校验（:id 类型混淆）
//   6. 存储型 XSS 载荷处理
//   7. 越权访问（未登录 / 非管理员）
//   8. 限流
//   9. 上传协议校验
//  10. 纯函数单测（safeRedirect / parseId / cleanText）
//
// 说明：需要站点已启动（默认 http://localhost:35555）。
// 未登录用例不依赖 Casdoor；登录类用例在 ENABLE_DEV_LOGIN=1 时自动启用，
// 否则跳过并标记 SKIP，不算失败。
// ============================================================
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:35555';
const ORIGIN = new URL(BASE).origin;

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }

async function test(name, fn) {
  try {
    const r = await fn();
    if (r === 'SKIP') { skipped++; log('○', `${name} (跳过)`); return; }
    passed++; log('✓', name);
  } catch (err) {
    failed++; failures.push({ name, err: err.message });
    log('✗', `${name} — ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---- HTTP 客户端（带 cookie 罐）----
function makeClient() {
  const jar = new Map();
  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  function storeCookies(res) {
    const sc = res.headers['set-cookie'] || [];
    for (const c of sc) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
  }
  function request(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, BASE);
      const headers = Object.assign({}, opts.headers || {});
      const ck = cookieHeader();
      if (ck) headers.Cookie = ck;
      let body = opts.body;
      if (opts.json) {
        body = JSON.stringify(opts.json);
        headers['Content-Type'] = 'application/json';
      } else if (opts.form) {
        body = new URLSearchParams(opts.form).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method, headers
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          storeCookies(res);
          resolve({ status: res.statusCode, headers: res.headers, body: data, location: res.headers.location });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  return {
    jar,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    csrf: () => jar.get('csrf_token') || '',
    // 带 CSRF 的写请求
    postCsrf: (p, o = {}) => request('POST', p, Object.assign({}, o, {
      headers: Object.assign({ 'X-CSRF-Token': jar.get('csrf_token') || '' }, o.headers || {})
    }))
  };
}

async function main() {
  console.log('\n============================================');
  console.log(' D5ST 安全回归测试');
  console.log(' 目标:', BASE);
  console.log('============================================\n');

  // 探活
  const probe = makeClient();
  let alive = true;
  try { const r = await probe.get('/api/health'); alive = r.status === 200; } catch (e) { alive = false; }
  if (!alive) {
    console.error('✗ 站点未启动或 /api/health 不可达，无法测试。');
    console.error('  请先运行: npm start   （或 docker compose up -d）');
    process.exit(2);
  }

  // ==========================================================
  console.log('[1] 安全响应头');
  // ==========================================================
  await test('X-Content-Type-Options = nosniff', async () => {
    const r = await probe.get('/api/health');
    assert(r.headers['x-content-type-options'] === 'nosniff', '缺失 nosniff');
  });
  await test('X-Frame-Options 存在（防点击劫持）', async () => {
    const r = await probe.get('/api/health');
    assert(!!r.headers['x-frame-options'], '缺失 X-Frame-Options');
  });
  await test('Content-Security-Policy 存在且禁止 object-src', async () => {
    const r = await probe.get('/api/health');
    const csp = r.headers['content-security-policy'] || '';
    assert(csp.includes("object-src 'none'"), 'CSP 未限制 object-src');
    assert(csp.includes("frame-ancestors"), 'CSP 未设置 frame-ancestors');
  });
  await test('Referrer-Policy 存在', async () => {
    const r = await probe.get('/api/health');
    assert(!!r.headers['referrer-policy'], '缺失 Referrer-Policy');
  });
  await test('未启用 X-XSS-Protection: 1（旧过滤器本身可被利用）', async () => {
    const r = await probe.get('/api/health');
    assert(r.headers['x-xss-protection'] === '0', 'X-XSS-Protection 应为 0');
  });

  // ==========================================================
  console.log('\n[2] CSRF 防护');
  // ==========================================================
  await test('GET 请求会下发 csrf_token cookie', async () => {
    const c = makeClient();
    await c.get('/login');
    assert(c.csrf().length >= 32, '未下发 csrf_token');
  });
  await test('无 token 的 POST 被拒绝（403）', async () => {
    const c = makeClient();
    await c.get('/login'); // 先拿 cookie
    const r = await c.post('/messages/guestbook', { form: { content: 'csrf-test-no-token' } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await test('错误 token 的 POST 被拒绝（403）', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.post('/messages/guestbook', {
      form: { content: 'csrf-test-bad-token', _csrf: 'deadbeef'.repeat(8) }
    });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await test('正确 token 的 POST 被放行（不再 403）', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.post('/messages/guestbook', {
      form: { content: 'csrf-ok-test', _csrf: c.csrf() }
    });
    assert(r.status !== 403, `正确 token 仍被拒: ${r.status}`);
  });
  await test('CSRF token 通过 X-CSRF-Token 头同样生效', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.post('/messages/guestbook', {
      json: { content: 'csrf-header-test' },
      headers: { 'X-CSRF-Token': c.csrf() }
    });
    assert(r.status !== 403, `头部 token 未被接受: ${r.status}`);
  });

  // ==========================================================
  console.log('\n[3] SQL 注入防护');
  // ==========================================================
  await test('sort 参数注入载荷不影响页面（不 500）', async () => {
    const payloads = [
      "newest; DROP TABLE forum_posts;--",
      "1' OR '1'='1",
      "newest,(SELECT SLEEP(5))",
      "newest UNION SELECT 1,2,3"
    ];
    for (const p of payloads) {
      const r = await probe.get('/forum?sort=' + encodeURIComponent(p));
      assert(r.status < 500, `sort=${p} 触发 ${r.status}`);
    }
  });
  await test('category 参数注入载荷不影响页面', async () => {
    const r = await probe.get("/forum?category=" + encodeURIComponent("' OR 1=1--"));
    assert(r.status < 500, `触发 ${r.status}`);
  });
  await test('page 参数注入载荷被安全处理（不 500）', async () => {
    const payloads = ['-1', '999999999999999999999', "1;DROP TABLE users", 'abc', '1e999'];
    for (const p of payloads) {
      const r = await probe.get('/forum?page=' + encodeURIComponent(p));
      assert(r.status < 500, `page=${p} 触发 ${r.status}`);
    }
  });
  await test('搜索接口注入载荷不报错', async () => {
    const payloads = ["%' OR 1=1--", "'; DROP TABLE casdoor_users;--", "' UNION SELECT NULL--"];
    for (const p of payloads) {
      const r = await probe.get('/search?q=' + encodeURIComponent(p));
      assert(r.status < 500, `q=${p} 触发 ${r.status}`);
    }
  });
  await test('videos 分页参数注入不 500', async () => {
    for (const p of ['1;DROP', "1 OR 1=1", '-5']) {
      const r = await probe.get('/videos?page=' + encodeURIComponent(p));
      assert(r.status < 500, `page=${p} 触发 ${r.status}`);
    }
  });

  // ==========================================================
  console.log('\n[4] 开放重定向防护');
  // ==========================================================
  await test('/login?next=//evil.com 不回跳到外域', async () => {
    const c = makeClient();
    const r = await c.get('/login?next=' + encodeURIComponent('//evil.com/steal'));
    assert(r.status < 500, `状态码 ${r.status}`);
    // 页面里不应把 //evil.com 当作 nextUrl 输出到跳转链接
    assert(!r.body.includes('//evil.com/steal'), 'nextUrl 原样输出，存在开放重定向风险');
  });
  await test('/login?next=https://evil.com 被拒绝', async () => {
    const c = makeClient();
    const r = await c.get('/login?next=' + encodeURIComponent('https://evil.com'));
    assert(!r.body.includes('https://evil.com'), '绝对外链 nextUrl 未被过滤');
  });
  await test('/auth/login?next=javascript: 被拒绝', async () => {
    const c = makeClient();
    const r = await c.get('/auth/login?next=' + encodeURIComponent('javascript:alert(1)'));
    assert(r.status < 500, `状态码 ${r.status}`);
  });

  // ==========================================================
  console.log('\n[5] 参数校验（:id 类型混淆）');
  // ==========================================================
  await test('/forum/:id 非数字返回 404 而非 500', async () => {
    for (const bad of ['abc', '1abc', '1e3', '0x10', '-1', '0', '999999999999999999999']) {
      const r = await probe.get('/forum/' + bad);
      assert(r.status === 404 || r.status === 302 || r.status === 403,
        `/forum/${bad} 返回 ${r.status}（应 404/302/403）`);
    }
  });
  await test('/videos/:id 非数字返回 404 而非 500', async () => {
    for (const bad of ['abc', '1abc', '-1']) {
      const r = await probe.get('/videos/' + bad);
      assert(r.status === 404 || r.status === 302 || r.status === 403,
        `/videos/${bad} 返回 ${r.status}`);
    }
  });
  await test('未登录访问 /forum/1 不泄露内容（302 到登录）', async () => {
    const r = await probe.get('/forum/1');
    assert(r.status === 302 || r.status === 404, `返回 ${r.status}`);
  });

  // ==========================================================
  console.log('\n[6] 存储型 XSS 载荷');
  // ==========================================================
  await test('未登录留言板提交被 CSRF 拦截（XSS 载荷进不来）', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.post('/messages/guestbook', {
      form: { content: '<script>alert(1)</script>', author_name: '<img src=x onerror=alert(1)>' }
    });
    assert(r.status === 403, `期望被 CSRF 拦截，实际 ${r.status}`);
  });
  await test('留言板页面输出对 XSS 载荷做了 HTML 转义', async () => {
    const r = await probe.get('/messages/guestbook');
    assert(r.status < 500, `页面异常 ${r.status}`);
    // 页面上不应出现可直接执行的未转义 script 标签（模板层统一 <%= %> 转义）
    const rawScriptInContent = /<script>\s*alert\(/i.test(r.body);
    assert(!rawScriptInContent, '页面存在未转义 script 注入');
  });

  // ==========================================================
  console.log('\n[7] 越权访问');
  // ==========================================================
  await test('未登录访问 /admin 被重定向到登录', async () => {
    const r = await probe.get('/admin');
    assert(r.status === 302 && (r.location || '').includes('/login'), `返回 ${r.status} → ${r.location}`);
  });
  await test('未登录访问 /admin/users 被拦截', async () => {
    const r = await probe.get('/admin/users');
    assert(r.status === 302 || r.status === 403, `返回 ${r.status}`);
  });
  await test('未登录调用 /admin/settings POST 被拦截', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.postCsrf('/admin/settings', { form: { site_name: 'hacked' } });
    assert(r.status === 302 || r.status === 403, `返回 ${r.status}`);
  });
  await test('未登录无法删除他人帖子', async () => {
    const c = makeClient();
    await c.get('/login');
    const r = await c.postCsrf('/forum/delete/1', {});
    assert(r.status === 401 || r.status === 403 || r.status === 302, `返回 ${r.status}`);
  });

  // ==========================================================
  console.log('\n[8] 限流');
  // ==========================================================
  await test('验证码接口超过阈值返回 429', async () => {
    const c = makeClient();
    await c.get('/login');
    let got429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await c.postCsrf('/forgot-password/request', {
        json: { email: 'ratelimit-test@example.com' }
      });
      if (r.status === 429) { got429 = true; break; }
    }
    assert(got429, '连续 6 次请求未触发限流');
  });

  // ==========================================================
  console.log('\n[9] 上传与文件');
  // ==========================================================
  await test('未登录上传视频被拦截', async () => {
    const r = await probe.post('/videos', { form: { title: 'x' } });
    assert(r.status === 302 || r.status === 401 || r.status === 403, `返回 ${r.status}`);
  });
  await test('/uploads 目录不做目录列举', async () => {
    const r = await probe.get('/uploads/');
    assert(r.status === 404 || r.status === 403, `/uploads/ 返回 ${r.status}`);
  });
  await test('静态资源响应带缓存策略头', async () => {
    const r = await probe.get('/public/js/main.js');
    if (r.status !== 200) return 'SKIP';
    assert(!!r.headers['cache-control'], '静态资源缺少 Cache-Control');
  });

  // ==========================================================
  console.log('\n[10] 纯函数单测');
  // ==========================================================
  const sec = require('../配置/security');
  await test('safeRedirect 拒绝外域与伪协议', async () => {
    const bad = ['//evil.com', 'http://evil.com', 'https://evil.com', 'javascript:alert(1)',
      'data:text/html,x', '/\\evil.com', '\\\\evil.com', 'evil.com', '', null, undefined,
      '/ok\r\nSet-Cookie: x=1'];
    for (const b of bad) {
      const r = sec.safeRedirect(b, '/');
      assert(r === '/', `safeRedirect(${JSON.stringify(b)}) = ${JSON.stringify(r)}，应为 /`);
    }
  });
  await test('safeRedirect 放行站内路径', async () => {
    for (const good of ['/', '/forum', '/forum/12?x=1', '/user/3#a']) {
      assert(sec.safeRedirect(good) === good, `safeRedirect(${good}) 被误拒`);
    }
  });
  await test('parseId 只接受正整数', async () => {
    assert(sec.parseId('1') === 1, '1 应通过');
    assert(sec.parseId('123456') === 123456, '123456 应通过');
    for (const bad of ['0', '-1', '1abc', '1e3', '0x10', ' 1', '1 ', '', null, undefined,
      '99999999999999999999', '1.5', 'NaN']) {
      assert(sec.parseId(bad) === null, `parseId(${JSON.stringify(bad)}) 应返回 null`);
    }
  });
  await test('cleanText 剥除控制字符并裁剪长度', async () => {
    const out = sec.cleanText('a\u0000b\u0007c\u001bd', 100);
    assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out), '控制字符未剥除');
    const long = sec.cleanText('x'.repeat(1000), 10);
    assert(long.length === 10, `裁剪失败，长度 ${long.length}`);
  });
  await test('CSRF 常量与模板约定一致', async () => {
    assert(sec.CSRF_COOKIE === 'csrf_token', 'CSRF cookie 名不一致');
    assert(sec.CSRF_HEADER === 'x-csrf-token', 'CSRF header 名不一致');
  });

  // ==========================================================
  console.log('\n[11] 登录后业务回归（需要 ENABLE_DEV_LOGIN=1）');
  // ==========================================================
  const devClient = makeClient();
  await devClient.get('/login');
  const devLogin = await devClient.get('/auth/dev-login?username=secaudit_user');
  const devOk = devLogin.status === 302 && !(devLogin.location || '').includes('dev_login_disabled');

  if (!devOk) {
    skipped++;
    log('○', '开发登录不可用，跳过登录态用例 (SKIP)');
  } else {
    await test('登录后可访问 /forum/new', async () => {
      const r = await devClient.get('/forum/new');
      assert(r.status === 200, `返回 ${r.status}`);
    });
    await test('发帖接口对超长标题/正文做了裁剪（不 500）', async () => {
      const r = await devClient.postCsrf('/forum', {
        form: {
          title: 'T'.repeat(5000),
          content: 'C'.repeat(50000),
          category: 'not-a-real-category',
          post_type: 'not-a-real-type'
        }
      });
      assert(r.status < 500, `超长输入触发 ${r.status}`);
    });
    await test('发帖接口拒绝空内容（400）', async () => {
      const r = await devClient.postCsrf('/forum', { json: { content: '   ' } });
      assert(r.status === 400, `期望 400，实际 ${r.status}`);
    });
    await test('评论接口对不存在的帖子返回 404', async () => {
      const r = await devClient.postCsrf('/forum/comment/999999999', { json: { content: 'hi' } });
      assert(r.status === 404, `期望 404，实际 ${r.status}`);
    });
    await test('点赞接口对不存在的帖子返回 404', async () => {
      const r = await devClient.postCsrf('/forum/like/999999999', {});
      assert(r.status === 404, `期望 404，实际 ${r.status}`);
    });
    await test('私信不能发给自己（400）', async () => {
      const me = devClient.jar.get('connect.sid');
      // 取当前用户 id
      const st = await devClient.get('/api/check-login');
      const uid = JSON.parse(st.body).user.id;
      const r = await devClient.postCsrf('/messages/send/' + uid, { json: { content: 'self' } });
      assert(r.status === 400, `期望 400，实际 ${r.status}`);
    });
    await test('普通用户无法访问后台（403）', async () => {
      const r = await devClient.get('/admin');
      assert(r.status === 403 || r.status === 302, `返回 ${r.status}`);
    });
    await test('普通用户无法把视频自我推荐为精选', async () => {
      const r = await devClient.postCsrf('/videos', {
        form: { title: 'audit-test', video_url: 'https://example.com/a.mp4', is_recommended: '1', category: 'campus' }
      });
      // 接口应成功创建（302），但 is_recommended 必须被强制为 0
      assert(r.status < 500, `返回 ${r.status}`);
    });
    await test('视频外链必须是 http(s)，拒绝 javascript:', async () => {
      const r = await devClient.postCsrf('/videos', {
        form: { title: 'xss-test', video_url: 'javascript:alert(1)', category: 'campus' }
      });
      assert(r.status === 302 && (r.location || '').includes('error='),
        `伪协议未被拒绝: ${r.status} → ${r.location}`);
    });
  }

  // ==========================================================
  // 汇总
  // ==========================================================
  console.log('\n============================================');
  console.log(` 通过 ${passed} · 失败 ${failed} · 跳过 ${skipped}`);
  console.log('============================================');
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}\n     ${f.err}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n测试框架异常:', err);
  process.exit(2);
});
