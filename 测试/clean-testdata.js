'use strict';
// ============================================================
// 清理测试数据（可重复执行）
// ------------------------------------------------------------
// 用途：测试脚本会向留言板/帖子/勋章等写入真实记录用于验证。
//       正常情况下测试结束会自动清理，但被 Ctrl+C 中断时会留下残留。
//       本脚本把已知的测试痕迹全部删掉。
//
// 用法：
//   BASE=https://你的域名 ADMIN_USER=xxx ADMIN_PASS=xxx node 测试/clean-testdata.js
//   TEST_URL=http://127.0.0.1:35555 node 测试/clean-testdata.js   （本地，需 ENABLE_DEV_LOGIN）
//
// 安全：只删除内容匹配下面 PATTERNS 的记录，不会碰任何正常数据。
//       脚本会先列出将要删除的条目，加 --dry 只预览不删除。
// ============================================================
const http = require('http');
const https = require('https');

const BASE = process.env.BASE || process.env.TEST_URL || 'http://127.0.0.1:35555';
const DRY = process.argv.includes('--dry');
const U = new URL(BASE);
const isHttps = U.protocol === 'https:';

// 所有测试脚本使用的内容特征
const PATTERNS = [
  'csrf-ok-test', 'csrf-header-test', 'csrf-test',
  'brute-guestbook-test', 'brute-',
  '后台删除测试', '冒烟测试留言', 'selftest-',
  'csrf ok', 'csrf ok test'
];

function makeClient() {
  const jar = new Map();
  const agent = isHttps ? https : http;
  const ck = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
    for (const c of (res.headers['set-cookie'] || [])) {
      const [p] = c.split(';'); const i = p.indexOf('=');
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const call = (method, path, opts = {}) => new Promise((resolve, reject) => {
    const headers = Object.assign({ Cookie: ck() }, opts.headers || {});
    let body = opts.form ? new URLSearchParams(opts.form).toString() : null;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = agent.request({
      hostname: U.hostname, port: U.port || (isHttps ? 443 : 80),
      path, method, headers, timeout: 20000,
      rejectUnauthorized: false
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { store(res); resolve({ status: res.statusCode, body: d, location: res.headers.location }); });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  return {
    jar, get: (p) => call('GET', p),
    post: (p, o) => call('POST', p, o),
    csrf: () => jar.get('csrf_token') || '',
    async login(username) {
      await call('GET', '/login');
      await call('GET', '/auth/dev-login?username=' + encodeURIComponent(username) + '&admin=1').catch(() => {});
      const st = await call('GET', '/api/check-login');
      return /"loggedIn":true/.test(st.body);
    },
    async postCsrf(p, o = {}) {
      const form = Object.assign({ _csrf: jar.get('csrf_token') || '' }, o.form || {});
      return call('POST', p, { form });
    }
  };
}

(async () => {
  console.log('\n清理测试数据');
  console.log('目标:', BASE);
  console.log('模式:', DRY ? '预览（不删除）' : '实际删除');
  console.log('─'.repeat(60));

  const c = makeClient();
  const user = process.env.ADMIN_USER || 'd5stadmin';
  const ok = await c.login(user);
  if (!ok) {
    console.error(`\n无法以管理员身份登录（${user}）。`);
    console.error('请确认：');
    console.error('  - 本地环境需要 ENABLE_DEV_LOGIN=1');
    console.error('  - 生产环境请用 BASE=https://域名 并确保该账号存在');
    process.exit(2);
  }
  console.log('已登录:', user);

  // 收集所有待删条目
  const found = [];
  for (const p of PATTERNS) {
    const page = await c.get('/admin/guestbook?q=' + encodeURIComponent(p));
    const re = /\/admin\/guestbook\/delete\/(\d+)[\s\S]{0,400}?<td[^>]*>([\s\S]{0,200}?)<\/td>/g;
    const ids = [...page.body.matchAll(/\/admin\/guestbook\/delete\/(\d+)/g)].map(m => m[1]);
    for (const id of ids) {
      if (!found.some(f => f.id === id)) found.push({ id, pattern: p });
    }
  }

  if (!found.length) {
    console.log('\n没有发现测试数据残留 ✓');
    process.exit(0);
  }

  console.log(`\n发现 ${found.length} 条测试留言：`);
  found.forEach(f => console.log(`  id=${f.id}  (匹配: ${f.pattern})`));

  if (DRY) {
    console.log('\n预览模式，未删除。去掉 --dry 执行实际删除。');
    process.exit(0);
  }

  console.log('');
  let removed = 0, failed = 0;
  for (const f of found) {
    const r = await c.postCsrf('/admin/guestbook/delete/' + f.id, {});
    if (r.status === 302 || r.status === 200) { removed++; }
    else { failed++; console.log(`  ✗ id=${f.id} 删除失败 (${r.status})`); }
  }

  console.log(`\n已删除 ${removed} 条${failed ? `，失败 ${failed} 条` : ''}`);

  // 复查
  const check = await c.get('/admin/guestbook');
  const remain = PATTERNS.some(p => check.body.includes(p));
  console.log(remain ? '⚠ 仍检测到测试数据特征，请人工复核' : '复查：留言板已无测试数据 ✓');
  console.log('');
})();
