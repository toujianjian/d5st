const { chromium } = require('playwright');
const BASE = 'http://localhost:8080';
const USER = 'd5stadmin';
const PASS = 'd5stpassword';

let pass = 0, fail = 0; const fails = [];
function rec(name, cond, extra = '') {
  const tag = cond ? '[OK]' : '[X ]';
  if (cond) pass++; else { fail++; fails.push(name); }
  console.log(`  ${tag} ${name}${extra ? '  (' + extra + ')' : ''}`);
}
const section = (t) => console.log(`\n== ${t} ==`);

async function api(page, url, opts) {
  return await page.evaluate(async ({ url, opts }) => {
    try {
      const r = await fetch(url, opts);
      const ct = r.headers.get('content-type') || '';
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch { }
      return { status: r.status, ct, text: t, json: j };
    } catch (e) { return { status: -1, error: String(e) }; }
  }, { url, opts });
}
const bodyText = (page) => page.locator('body').innerText().then(t => t.replace(/\s+/g, ' '));
async function gotoRetry(page, url, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 6000 }); return true; }
    catch { await page.waitForTimeout(800); }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ================= 匿名 =================
  section('匿名访问（未登录）');
  const c1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p1 = await c1.newPage();
  p1.on('pageerror', e => console.log('  [pageerror] ' + e.message));
  await gotoRetry(p1, BASE + '/');

  let r = await api(p1, '/api/health');
  rec('GET /api/health 200 ok', r.status === 200 && r.json && r.json.status === 'ok', 'status=' + r.status);
  r = await api(p1, '/api/check-login');
  rec('GET /api/check-login 未登录 401', r.status === 401 && r.json && r.json.loggedIn === false, 'status=' + r.status);
  r = await api(p1, '/api/popups?page=home');
  rec('GET /api/popups 200 数组', r.status === 200 && Array.isArray(r.json), 'status=' + r.status);
  r = await api(p1, '/rss.xml');
  rec('GET /rss.xml 200 RSS', r.status === 200 && r.text.includes('<rss'), 'status=' + r.status);
  r = await api(p1, '/public/css/main.css');
  rec('GET /public/css/main.css 200', r.status === 200 && r.ct.includes('text/css'), 'ct=' + r.ct.slice(0, 20));
  r = await api(p1, '/public/webfonts/fa-solid-900.woff2');
  rec('GET /public/webfonts/* 字体映射 200', r.status === 200, 'status=' + r.status);
  r = await api(p1, '/public/font-awesome/all.min.css');
  rec('GET /public/font-awesome/all.min.css 200', r.status === 200, 'status=' + r.status);
  await gotoRetry(p1, BASE + '/');
  rec('首页 GET / 渲染', (await bodyText(p1)).includes('D5ST'));
  for (const [u, needle, name] of [
    ['/forum', '', 'GET /forum 200'],
    ['/videos', '', 'GET /videos 200'],
    ['/search?q=测试', '', 'GET /search?q= 200'],
    ['/messages/guestbook', '留言', 'GET /messages/guestbook 200'],
    ['/secret', '保密号', 'GET /secret 200'],
    ['/sponsor', '赞助', 'GET /sponsor 200'],
    ['/login', 'Casdoor', 'GET /login 200 含 Casdoor'],
    ['/forgot-password', '', 'GET /forgot-password 200'],
  ]) {
    await p1.goto(BASE + u);
    const t = await bodyText(p1);
    rec(name, t.length > 0 && (!needle || t.includes(needle)));
  }
  await p1.goto(BASE + '/register');
  {
    const t = await bodyText(p1);
    const href = await p1.locator('a.casdoor-login-btn').getAttribute('href').catch(() => '');
    rec('GET /register + 入口指向 signup/d5st-app', t.includes('创建账号') && (href || '').includes('/casdoor/signup/'), 'href=' + href);
  }

  await gotoRetry(p1, BASE + '/auth/login');
  rec('GET /auth/login 302→Casdoor', p1.url().includes('oauth/authorize'), 'url=' + p1.url().slice(0, 70));
  await p1.goto(BASE + '/auth/callback');
  rec('GET /auth/callback 无 code→/login', p1.url().includes('/login'));
  for (const [u, name] of [['/user', '未登录 /user→/login'], ['/messages', '未登录 /messages→/login'], ['/admin', '未登录 /admin→/login'], ['/forum/new', '未登录 /forum/new→/login'], ['/videos/new', '未登录 /videos/new→/login']]) {
    await p1.goto(BASE + u);
    rec(name, p1.url().includes('/login') || p1.url().includes('/admin/login'), 'url=' + p1.url().slice(0, 60));
  }
  // dev-login 由环境变量控制（本环境 ENABLE_DEV_LOGIN=1），放最后测，避免污染上面的匿名断言
  await p1.goto(BASE + '/auth/dev-login');
  const dl = await api(p1, '/api/check-login');
  rec('GET /auth/dev-login 开发登录可用', dl.json && dl.json.loggedIn === true, 'user=' + (dl.json && dl.json.user && dl.json.user.username));
  await c1.close();

  // ================= 登录 =================
  section('登录（真实点击 OAuth）');
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c2.newPage();
  p.on('pageerror', e => console.log('  [pageerror] ' + e.message));
  await gotoRetry(p, BASE + '/login');
  await p.locator('a.login-btn, a:has-text("使用 Casdoor 登录")').first().click();
  await p.locator('#username').waitFor({ state: 'visible', timeout: 15000 });
  await p.locator('#username').click(); await p.keyboard.type(USER, { delay: 30 });
  await p.locator('#password').click(); await p.keyboard.type(PASS, { delay: 25 });
  await p.locator('button[type=submit]:has-text("登录")').first().click();
  await p.waitForTimeout(3500);
  let clg = await api(p, '/api/check-login');
  rec('登录成功', clg.json && clg.json.loggedIn === true, 'user=' + (clg.json && clg.json.user && clg.json.user.username));

  // ================= 登录后 =================
  section('登录后 · 全局 API');
  let r2 = await api(p, '/api/notifications');
  rec('GET /api/notifications 200 数组', r2.status === 200 && Array.isArray(r2.json));
  const pop = await api(p, '/api/popups?page=home');
  const pid = Array.isArray(pop.json) && pop.json[0] ? pop.json[0].id : 0;
  r2 = await api(p, '/api/popups/' + pid + '/close', { method: 'POST' });
  rec('POST /api/popups/:id/close', r2.status === 200 && r2.json && typeof r2.json.success === 'boolean',
    pid ? ('pid=' + pid + ' success=' + (r2.json && r2.json.success)) : '无弹窗数据（表空），仅验证接口可响应');
  r2 = await api(p, '/api/notifications/1/read', { method: 'POST' });
  rec('POST /api/notifications/:id/read', r2.json && r2.json.success === true);
  r2 = await api(p, '/auth/status');
  rec('GET /auth/status', r2.status === 200 && r2.json && typeof r2.json.valid === 'boolean');
  r2 = await api(p, '/auth/refresh', { method: 'POST' });
  rec('POST /auth/refresh 200', r2.status === 200);
  await p.goto(BASE + '/user');
  rec('GET /user 个人中心 200', !p.url().includes('/login'));
  r2 = await api(p, '/no-such-page-xyz');
  rec('未知路径 404（登录态）', r2.status === 404, 'status=' + r2.status);

  section('论坛');
  await p.goto(BASE + '/forum/new'); await p.waitForSelector('#content');
  await p.fill('#title', '自动化测试帖子');
  await p.fill('#content', '自动化测试正文，含敏感词 测试违禁词 用于验证掩码是否生效。');
  await p.fill('#tags', '测试 自动化');
  await p.locator('button[type=submit].btn-submit').first().click();
  await p.waitForURL(/\/forum\/\d+/, { timeout: 12000 }).catch(() => { });
  const postUrl = p.url();
  const postId = (postUrl.match(/\/forum\/(\d+)/) || [])[1];
  rec('发帖 → 跳详情页', /\/forum\/\d+/.test(postUrl), 'url=' + postUrl);
  if (postId) {
    const dt = await bodyText(p);
    rec('敏感词被掩码（详情不含原文）', !dt.includes('测试违禁词'));
    rec('详情正文可见', dt.includes('自动化测试正文'));
    let lk = await api(p, '/forum/like/' + postId, { method: 'POST' });
    rec('点赞', lk.json && lk.json.liked === true);
    lk = await api(p, '/forum/like/' + postId, { method: 'POST' });
    rec('取消点赞', lk.json && lk.json.liked === false);
    const cm = await api(p, '/forum/comment/' + postId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '自动化测试评论' }) });
    rec('评论', cm.json && cm.json.success === true);
    const cl = await api(p, '/forum/comments/' + postId);
    rec('评论 JSON 列表', cl.status === 200 && Array.isArray(cl.json) && cl.json.some(c => String(c.content).includes('自动化测试评论')));
    const rp = await api(p, '/forum/report/' + postId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '自动化测试举报' }) });
    rec('举报', rp.json && rp.json.success === true);
  }
  const ck = await api(p, '/forum/checkin', { method: 'POST' });
  rec('签到', ck.json && (ck.json.success === true || /签到/.test(ck.json.msg || '')), JSON.stringify(ck.json));
  await p.goto(BASE + '/forum?sort=hot');
  rec('GET /forum?sort=hot 200', (await bodyText(p)).length > 0);
  await p.goto(BASE + '/forum?category=study');
  rec('GET /forum?category= 200', (await bodyText(p)).length > 0);

  section('消息 / 留言');
  const ms = await api(p, '/messages/send/15', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '自动化测试私信内容' }) });
  rec('发私信', ms.json && ms.json.success === true, JSON.stringify(ms.json));
  await p.goto(BASE + '/messages');
  rec('GET /messages 会话列表 200', (await bodyText(p)).length > 0 && !p.url().includes('/login'));
  await p.goto(BASE + '/messages/chat/15');
  rec('GET /messages/chat/:id 200', (await bodyText(p)).includes('自动化测试私信内容'));
  await p.goto(BASE + '/messages/guestbook'); await p.waitForSelector('textarea[name=content]');
  await p.fill('textarea[name=content]', '自动化测试留言');
  await p.locator('button[type=submit]').first().click();
  await p.waitForLoadState('domcontentloaded'); await p.waitForTimeout(800);
  rec('留言板提交', (await bodyText(p)).includes('自动化测试留言'));

  section('搜索 / 保密号 / 赞助 / 视频');
  await p.goto(BASE + '/search?q=自动化');
  {
    const t = await bodyText(p);
    rec('搜索命中刚发帖子（正文片段）', !t.includes('没有找到') && (t.includes('自动化测试正文') || t.includes('帖子')), '');
  }
  const sg = await api(p, '/secret/generate', { method: 'POST' });
  rec('生成保密号', sg.json && sg.json.success === true && !!sg.json.code, JSON.stringify(sg.json));
  if (sg.json && sg.json.code) {
    await p.goto(BASE + '/secret/show?code=' + sg.json.code);
    const t = await bodyText(p);
    rec('按保密号查询用户', t.includes('系统管理员') || t.includes('d5stadmin'));
  }
  await p.goto(BASE + '/sponsor'); await p.waitForSelector('#amount-input');
  await p.fill('#amount-input', '5');
  await p.locator('button[type=submit].primary').first().click();
  await p.waitForLoadState('domcontentloaded'); await p.waitForTimeout(600);
  rec('赞助提交 → 成功页', (await bodyText(p)).includes('感谢你的支持'));
  await p.goto(BASE + '/videos/new'); await p.waitForSelector('#video_url');
  await p.fill('#title', '自动化测试视频');
  await p.fill('#video_url', 'https://example.com/test.mp4');
  await p.locator('button[type=submit].btn-submit').first().click();
  await p.waitForURL(/\/videos\/\d+/, { timeout: 12000 }).catch(() => { });
  rec('上传视频 → 跳播放页', /\/videos\/\d+/.test(p.url()), 'url=' + p.url());
  await p.goto(BASE + '/videos');
  rec('GET /videos 列表含新视频', (await bodyText(p)).includes('自动化测试视频'));
  await p.goto(BASE + '/videos?category=campus');
  rec('GET /videos?category= 200', (await bodyText(p)).length > 0);

  await c2.close();
  await browser.close();

  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fails.length) console.log('失败项: ' + fails.join(' ; '));
  process.exit(fail > 0 ? 1 : 0);
})();
