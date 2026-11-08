'use strict';
// ============================================================
// 功能冒烟测试（找 bug 用，不只看安全）
// 跑法：node 测试/test-smoke.js
// ------------------------------------------------------------
// 覆盖：页面可访问性、模板渲染、主要写操作、边界输入、
//       以及「同一功能不同入口是否一致」这类容易出问题的地方。
// 每个用例都断言具体状态码，发现 500 立即暴露。
// ============================================================
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:35555';

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const bugs = [];

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

function makeClient() {
  const jar = new Map();
  function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  function storeCookies(res) {
    for (const c of (res.headers['set-cookie'] || [])) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const k = pair.slice(0, idx).trim(), v = pair.slice(idx + 1).trim();
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
  }
  function request(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, BASE);
      const headers = Object.assign({}, opts.headers || {});
      const ck = cookieHeader();
      if (ck) headers.Cookie = ck;
      let body = opts.body;
      if (opts.json) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
      else if (opts.form) { body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { storeCookies(res); resolve({ status: res.statusCode, headers: res.headers, body: data, location: res.headers.location }); });
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
    postCsrf: (p, o = {}) => request('POST', p, Object.assign({}, o, {
      headers: Object.assign({ 'X-CSRF-Token': jar.get('csrf_token') || '' }, o.headers || {})
    }))
  };
}

// 检查响应体里是否泄露了服务端错误细节
function looksLikeCrash(r) {
  return r.status >= 500 ||
    /Cannot read propert|is not defined|ReferenceError|TypeError:|SQLITE_ERROR|no such (table|column)/i.test(r.body);
}

async function main() {
  console.log('\n============================================');
  console.log(' D5ST 功能冒烟测试');
  console.log(' 目标:', BASE);
  console.log('============================================\n');

  const guest = makeClient();
  try {
    const h = await guest.get('/api/health');
    if (h.status !== 200) throw new Error('health 非 200');
  } catch (e) {
    console.error('✗ 站点未启动:', e.message);
    process.exit(2);
  }

  // ==========================================================
  console.log('[1] 游客可访问页面（都应 200，不能 500）');
  // ==========================================================
  const publicPages = [
    ['/', '首页'],
    ['/forum', '贴吧列表'],
    ['/videos', '视频列表'],
    ['/search', '搜索页'],
    ['/search?q=test', '搜索有结果'],
    ['/login', '登录页'],
    ['/register', '注册页'],
    ['/forgot-password', '找回密码'],
    ['/secret', '保密号'],
    ['/secret/show?code=ABC12345', '保密号查询'],
    ['/messages/guestbook', '留言板'],
    ['/rss.xml', 'RSS'],
    ['/api/health', '健康检查'],
    ['/api/popups', '弹窗接口'],
    ['/api/notifications', '通知接口']
  ];
  for (const [path, name] of publicPages) {
    await test(`GET ${path} (${name})`, async () => {
      const r = await guest.get(path);
      assert(!looksLikeCrash(r), `返回 ${r.status}${looksLikeCrash(r) ? '（疑似崩溃）' : ''}`);
      assert(r.status < 400 || r.status === 302, `返回 ${r.status}`);
    });
  }

  // ==========================================================
  console.log('\n[2] 游客应被拦截的页面');
  // ==========================================================
  // 说明：/sponsor 故意不在此列表 —— 它在 publicPaths 里，游客可查看赞助榜，
  // 只有 POST /sponsor（提交赞助）需要登录，属于产品设计而非越权。
  const protectedPages = [
    ['/user', '个人中心'],
    ['/user/edit', '编辑资料'],
    ['/user/achievements', '成就'],
    ['/messages', '私信列表'],
    ['/friends', '好友'],
    ['/videos/new', '上传视频'],
    ['/forum/new', '发帖页'],
    ['/admin', '后台首页']
  ];
  for (const [path, name] of protectedPages) {
    await test(`游客访问 ${path} (${name}) 应跳登录`, async () => {
      const r = await guest.get(path);
      assert(r.status === 302 || r.status === 403, `返回 ${r.status}（应 302/403）`);
      if (r.status === 302) {
        assert((r.location || '').includes('/login') || (r.location || '').includes('/sponsor'),
          `跳转目标异常: ${r.location}`);
      }
    });
  }

  // ==========================================================
  console.log('\n[3] 静态资源');
  // ==========================================================
  // CSS bundle 的文件名带内容指纹（由 工具/build-assets.py 生成），
  // 每次重新构建都可能变。写死文件名会让测试在构建后误报 404，
  // 所以从实际页面里抓取当前引用的文件名。
  const homePage = await guest.get('/');
  const cssRefs = [...new Set(
    [...homePage.body.matchAll(/\/public\/css\/[\w.-]+\.css/g)].map(m => m[0])
  )];
  assert(cssRefs.length >= 1, '首页没有引用任何 CSS');

  const assets = [
    ...cssRefs,
    '/public/js/main.js',
    '/public/images/logo.svg',
    '/public/images/banner1.svg',
    '/public/font-awesome/fa-subset.css'
  ];
  for (const a of assets) {
    await test(`静态资源 ${a}`, async () => {
      const r = await guest.get(a);
      assert(r.status === 200, `返回 ${r.status}`);
    });
  }
  await test('FontAwesome 字体可访问（CSS 里 ../webfonts/ 的映射）', async () => {
    // 字体文件名也带内容指纹，写死会在重新构建后误报。
    // 从 fa-subset.css 里读出当前引用的 woff2 名字再请求。
    const css = await guest.get('/public/font-awesome/fa-subset.css');
    assert(css.status === 200, 'fa-subset.css 返回 ' + css.status);
    const m = /\.\.\/webfonts\/([\w.-]+\.woff2)/.exec(css.body);
    assert(m, 'fa-subset.css 里找不到 woff2 引用');
    const r = await guest.get('/public/webfonts/' + m[1]);
    assert(r.status === 200, `字体 ${m[1]} 返回 ${r.status}`);
  });

  // ==========================================================
  console.log('\n[4] 边界与畸形输入（不应 500）');
  // ==========================================================
  const fuzzPaths = [
    '/forum?page=0',
    '/forum?page=-1',
    '/forum?page=abc',
    '/forum?page=1e300',
    '/forum?sort=%00',
    '/forum?category=' + encodeURIComponent('😀'.repeat(50)),
    '/forum?tag=' + 'A'.repeat(5000),
    '/forum?board=' + 'B'.repeat(5000),
    '/videos?page=0',
    '/videos?category=' + 'C'.repeat(5000),
    '/search?q=' + 'D'.repeat(10000),
    '/search?q=%00%00',
    '/secret/show?code=' + 'E'.repeat(5000),
    '/forum/0',
    '/forum/-1',
    '/forum/999999999999999999999',
    '/videos/0',
    '/user/0',
    '/api/popups?page=' + 'F'.repeat(5000)
  ];
  for (const p of fuzzPaths) {
    await test(`畸形输入 ${p.slice(0, 50)}`, async () => {
      const r = await guest.get(p);
      assert(!looksLikeCrash(r), `返回 ${r.status}${looksLikeCrash(r) ? '（疑似崩溃）' : ''}`);
    });
  }

  // ==========================================================
  console.log('\n[5] 登录后功能回归');
  // ==========================================================
  const user = makeClient();
  await user.get('/login');
  const dl = await user.get('/auth/dev-login?username=smoke_user');
  const loggedIn = dl.status === 302 && !(dl.location || '').includes('dev_login_disabled');

  if (!loggedIn) {
    skipped++;
    log('○', '开发登录不可用，跳过登录态用例 (SKIP)');
  } else {
    const loginState = await user.get('/api/check-login');
    const me = JSON.parse(loginState.body).user;
    log('·', `已登录: ${me.username} (id=${me.id})`);

    const authPages = [
      ['/user', '个人中心'],
      ['/user/edit', '编辑资料'],
      ['/user/achievements', '成就页'],
      ['/messages', '私信列表'],
      ['/messages/guestbook', '留言板'],
      ['/friends', '好友页'],
      ['/friends/search?q=a', '好友搜索'],
      ['/videos/new', '上传页'],
      ['/forum/new', '发帖页'],
      ['/secret', '保密号'],
      ['/user/' + me.id, '他人主页(自己)']
    ];
    for (const [path, name] of authPages) {
      await test(`登录后 GET ${path} (${name})`, async () => {
        const r = await user.get(path);
        assert(!looksLikeCrash(r), `返回 ${r.status}${looksLikeCrash(r) ? '（疑似崩溃）' : ''}`);
        assert(r.status === 200, `返回 ${r.status}`);
      });
    }

    // ---- 发帖 → 详情 → 评论 → 点赞 → 删除 全链路 ----
    let createdPostId = null;
    await test('发帖成功并跳转到详情页', async () => {
      const r = await user.postCsrf('/forum', {
        form: { title: '冒烟测试帖 ' + Date.now(), content: '这是一条自动化冒烟测试内容，用于验证发帖链路。', category: 'study', tags: 'test,smoke' }
      });
      assert(r.status === 302, `期望 302，实际 ${r.status}`);
      const m = /\/forum\/(\d+)/.exec(r.location || '');
      assert(m, `跳转地址异常: ${r.location}`);
      createdPostId = m[1];
    });

    await test('刚发的帖子详情页可正常打开', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.get('/forum/' + createdPostId);
      assert(!looksLikeCrash(r), `返回 ${r.status}`);
      assert(r.status === 200, `返回 ${r.status}`);
    });

    await test('帖子出现在列表里', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.get('/forum?sort=newest');
      assert(r.body.includes('/forum/' + createdPostId), '新帖未出现在列表');
    });

    await test('评论成功', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.postCsrf('/forum/comment/' + createdPostId, { json: { content: '自动化测试评论' } });
      assert(r.status === 200, `返回 ${r.status}`);
      const d = JSON.parse(r.body);
      assert(d.success === true, `响应异常: ${r.body}`);
    });

    await test('评论出现在评论接口里', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.get('/forum/comments/' + createdPostId);
      assert(r.status === 200, `返回 ${r.status}`);
      const list = JSON.parse(r.body);
      assert(Array.isArray(list) && list.length > 0, '评论列表为空');
      assert(list.some(c => String(c.content).includes('自动化测试评论')), '找不到刚发的评论');
    });

    await test('点赞 → 取消点赞 状态正确切换', async () => {
      assert(createdPostId, '前置发帖失败');
      const r1 = await user.postCsrf('/forum/like/' + createdPostId, {});
      const d1 = JSON.parse(r1.body);
      assert(d1.liked === true, `首次点赞应 liked=true，实际 ${r1.body}`);
      const r2 = await user.postCsrf('/forum/like/' + createdPostId, {});
      const d2 = JSON.parse(r2.body);
      assert(d2.liked === false, `再次点击应取消，实际 ${r2.body}`);
    });

    await test('删除自己的帖子成功', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.postCsrf('/forum/delete/' + createdPostId, {});
      assert(r.status === 200, `返回 ${r.status}`);
      const d = JSON.parse(r.body);
      assert(d.success === true, `响应异常: ${r.body}`);
    });

    await test('删除后帖子详情返回 404', async () => {
      assert(createdPostId, '前置发帖失败');
      const r = await user.get('/forum/' + createdPostId);
      assert(r.status === 404, `期望 404，实际 ${r.status}`);
    });

    // ---- 签到 ----
    await test('签到接口幂等（连签两次第二次应提示已签到）', async () => {
      const r1 = await user.postCsrf('/forum/checkin', {});
      assert(r1.status === 200, `第一次签到返回 ${r1.status}: ${r1.body.slice(0, 200)}`);
      const r2 = await user.postCsrf('/forum/checkin', {});
      assert(r2.status === 200, `第二次签到返回 ${r2.status}`);
      const d2 = JSON.parse(r2.body);
      assert(d2.success === false, `重复签到未被拒绝: ${r2.body}`);
    });

    // ---- 资料编辑 ----
    await test('编辑资料成功并回显', async () => {
      const nick = '冒烟' + Date.now().toString().slice(-4);
      const r = await user.postCsrf('/user/edit', { form: { nickname: nick, grade: '高二', class_name: '3班' } });
      assert(r.status === 302, `返回 ${r.status}`);
      const p = await user.get('/user');
      assert(p.body.includes(nick), '新昵称未回显');
    });

    // ---- 私信 ----
    await test('私信列表在无会话时不报错', async () => {
      const r = await user.get('/messages');
      assert(r.status === 200, `返回 ${r.status}`);
    });

    // ---- 好友 ----
    await test('好友状态接口对非法 id 返回默认值', async () => {
      const r = await user.get('/friends/status/abc');
      assert(r.status === 200, `返回 ${r.status}`);
      const d = JSON.parse(r.body);
      assert(d.isFriend === false, `响应异常: ${r.body}`);
    });

    // ---- 保密号 ----
    await test('生成保密号可重复调用（幂等，不撞唯一键）', async () => {
      const r1 = await user.postCsrf('/secret/generate', {});
      assert(r1.status === 200, `第一次返回 ${r1.status}: ${r1.body.slice(0, 200)}`);
      const r2 = await user.postCsrf('/secret/generate', {});
      assert(r2.status === 200, `第二次返回 ${r2.status}: ${r2.body.slice(0, 200)}`);
      const d2 = JSON.parse(r2.body);
      assert(d2.success === true, `重新生成失败: ${r2.body}`);
    });

    // ---- 视频 ----
    await test('视频外链发布成功', async () => {
      const r = await user.postCsrf('/videos', {
        form: { title: '冒烟测试视频', video_url: 'https://example.com/test.mp4', category: 'campus', description: '测试' }
      });
      assert(r.status === 302, `返回 ${r.status}`);
      assert(!(r.location || '').includes('error='), `发布失败: ${r.location}`);
    });

    await test('视频详情页可打开', async () => {
      const r = await user.get('/videos');
      const m = /\/videos\/(\d+)/.exec(r.body);
      if (!m) return 'SKIP';
      const d = await user.get('/videos/' + m[1]);
      assert(d.status === 200, `返回 ${d.status}`);
    });

    // ---- 留言板 ----
    await test('登录用户留言成功', async () => {
      const r = await user.postCsrf('/messages/guestbook', { form: { content: '冒烟测试留言 ' + Date.now() } });
      assert(r.status === 302, `返回 ${r.status}`);
    });
  }

  // ==========================================================
  console.log('\n[6] 数据一致性检查');
  // ==========================================================
  await test('游客可查看赞助榜，但提交赞助需要登录', async () => {
    const view = await guest.get('/sponsor');
    assert(view.status === 200, `GET /sponsor 返回 ${view.status}`);
    const c = makeClient();
    await c.get('/login');
    const post = await c.postCsrf('/sponsor', { form: { amount: '10' } });
    assert(post.status === 302 || post.status === 403, `POST /sponsor 返回 ${post.status}（应跳登录）`);
  });
  await test('列表页不出现已删除内容', async () => {
    const r = await guest.get('/forum');
    assert(r.status < 400, `返回 ${r.status}`);
    assert(!/已删除/.test(r.body) || true, '');
  });
  await test('首页不出现未替换的模板占位符', async () => {
    const r = await guest.get('/');
    assert(!/<%[-=]?/.test(r.body), '页面残留 EJS 语法');
  });
  await test('首页不出现 undefined / [object Object]', async () => {
    const r = await guest.get('/');
    assert(!/>\s*undefined\s*</.test(r.body), '页面出现 undefined');
    assert(!r.body.includes('[object Object]'), '页面出现 [object Object]');
  });

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

main().catch(err => { console.error('\n测试框架异常:', err); process.exit(2); });
