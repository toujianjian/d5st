// 真实 OAuth 登录端到端测试（Playwright）
// 跑法：node 测试/test-e2e-login.js
// 依赖：根目录 npm install（playwright）
// 环境变量：
//   BASE         站点地址（默认 http://127.0.0.1:35545）
//   ADMIN_USER   本站默认管理员（默认 d5stadmin）
//   ADMIN_PASS   对应密码（默认 d5stpassword）
// 说明：本脚本会真的打开浏览器、走 Casdoor 登录页、回到站点并验证会话，
//       用于确认「改了安全中间件之后登录链路没被打断」。
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:35545';
const USER = process.env.ADMIN_USER || 'd5stadmin';
const PASS = process.env.ADMIN_PASS || 'd5stpassword';

let passed = 0, failed = 0;
function ok(n) { passed++; console.log('  ✓ ' + n); }
function bad(n, e) { failed++; console.log('  ✗ ' + n + ' — ' + e); }
function assert(c, m) { if (!c) throw new Error(m); }

(async () => {
  console.log('\n============================================');
  console.log(' OAuth 登录 E2E');
  console.log(' 站点:', BASE, '| 用户:', USER);
  console.log('============================================\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  try {
    // 1) 打开登录页
    try {
      const resp = await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
      assert(resp && resp.status() === 200, '登录页状态 ' + (resp && resp.status()));
      ok('打开 /login（200）');
    } catch (e) { bad('打开 /login', e.message); }

    // 2) 点登录按钮 → 应跳到 Casdoor
    try {
      const btn = page.locator('a.login-btn[href="/auth/login"]').first();
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await Promise.all([
        page.waitForURL(/casdoor|authorize|login\/oauth/i, { timeout: 25000 }),
        btn.click()
      ]);
      ok('跳转到 Casdoor 授权页');
      console.log('     URL: ' + page.url().slice(0, 120));
    } catch (e) { bad('跳转 Casdoor', e.message); }

    // 3) 填账号密码并提交
    // 注意：Casdoor 登录页的输入框 id 是 username/password（name 为空），
    // 用 #username / #password 定位最稳；placeholder 兜底以防 Casdoor 改版。
    try {
      const userInput = page.locator('#username, input[placeholder*="用户名"], input[placeholder*="user" i]').first();
      await userInput.waitFor({ state: 'visible', timeout: 20000 });
      await userInput.fill(USER);
      const passInput = page.locator('#password, input[type="password"]').first();
      await passInput.fill(PASS);
      ok('填入账号密码');

      const submit = page.locator('button[type="submit"], button:has-text("登录"), button:has-text("Login")').first();
      // 关键：必须等「离开 Casdoor」的导航完成，再断言会话。
      // 只等 startsWith(BASE) 不够 —— 提交瞬间 URL 还在 /casdoor 下。
      await Promise.all([
        page.waitForURL((u) => !/\/casdoor\//i.test(u.toString()), { timeout: 40000 }),
        submit.click()
      ]);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      ok('提交登录表单并跳回站点');
      console.log('     URL: ' + page.url().slice(0, 120));
    } catch (e) { bad('提交登录', e.message); }

    // 4) 等待回到站点并确认会话
    try {
      await page.waitForURL((u) => u.toString().startsWith(BASE), { timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const state = await page.evaluate(async () => {
        const r = await fetch('/api/check-login', { credentials: 'same-origin' });
        return { status: r.status, body: await r.json() };
      });
      assert(state.status === 200 && state.body.loggedIn === true, 'check-login: ' + JSON.stringify(state.body));
      ok('会话已建立（/api/check-login = loggedIn）');
      console.log('     用户: ' + state.body.user.username + ' | admin=' + state.body.user.is_admin);
    } catch (e) { bad('确认会话', e.message); }

    // 5) 管理员应能进后台（用最终 URL 判断，不能只看 status —— 未登录时会被 302 到 /login，
    //    跟随重定向后的 status 同样是 200，会造成假通过）
    try {
      await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const finalUrl = page.url();
      assert(finalUrl.includes('/admin'), '被重定向到 ' + finalUrl.replace(BASE, '') + '（说明未登录或非管理员）');
      const hasAdmin = await page.locator('body').innerText();
      assert(!/无权限|页面未找到/.test(hasAdmin), '后台提示无权限');
      ok('管理员可进入 /admin');
    } catch (e) { bad('进入 /admin', e.message); }

    // 6) CSRF：页面表单里应已注入 _csrf
    try {
      await page.goto(BASE + '/user/edit', { waitUntil: 'domcontentloaded', timeout: 20000 });
      assert(page.url().includes('/user/edit'), '未登录，被重定向到 ' + page.url());
      // main.js 在 DOMContentLoaded 后注入，给它一点时间
      await page.waitForTimeout(500);
      const tokenCount = await page.locator('input[name="_csrf"]').count();
      assert(tokenCount > 0, '页面表单未注入 _csrf（共 ' + tokenCount + ' 个）');
      ok('页面表单已自动注入 CSRF token（' + tokenCount + ' 个）');
    } catch (e) { bad('CSRF 注入检查', e.message); }

    // 7) 站内发帖（验证 CSRF 放行 + 业务写入）
    try {
      await page.goto(BASE + '/forum/new', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = 'E2E登录测试 ' + Date.now();
      const titleInput = page.locator('input[name="title"]').first();
      if (await titleInput.count()) await titleInput.fill(title);
      const contentInput = page.locator('textarea[name="content"], textarea').first();
      await contentInput.fill('这是登录态端到端测试自动发布的内容。');
      const submit = page.locator('button[type="submit"], .submit-btn, button:has-text("发布")').first();
      await Promise.all([
        page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
        submit.click()
      ]);
      const url = page.url();
      assert(/\/forum\/\d+/.test(url), '发帖后未跳转到详情页: ' + url);
      ok('登录态发帖成功 → ' + url.replace(BASE, ''));
    } catch (e) { bad('登录态发帖', e.message); }

  } finally {
    await browser.close();
  }

  console.log('\n============================================');
  console.log(' 通过 ' + passed + ' · 失败 ' + failed);
  console.log('============================================\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('E2E 框架异常:', e); process.exit(2); });
