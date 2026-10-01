const { chromium } = require('playwright');
const BASE = 'http://localhost:8080';

async function gotoRetry(page, url, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 }); return true; }
    catch { await page.waitForTimeout(1000); }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const log = m => console.log(m);
  const ts = Date.now().toString().slice(-6);
  const USER = 'fix' + ts;
  const PASS = 'Test123456';
  let ok = true;

  try {
    // 1) /register 按钮 href
    if (!await gotoRetry(page, BASE + '/register')) { log('ERR: /register 打不开'); process.exit(1); }
    await page.waitForSelector('a.casdoor-login-btn', { timeout: 8000 });
    const href = await page.locator('a.casdoor-login-btn').getAttribute('href');
    log('STEP1 注册按钮 href = ' + href);
    if (!href || !href.includes('/casdoor/signup/d5st-app')) { log('FAIL: 按钮未指向 d5st-app 注册表单'); ok = false; }

    // 2) 点击 → 应直达 d5st-app 注册表单，不弹回登录页
    await page.locator('a.casdoor-login-btn').first().click();
    await page.waitForTimeout(2500);
    log('STEP2 点击后 URL = ' + page.url());
    const hasConfirm = await page.locator('#confirm').count();
    const hasUsername = await page.locator('#username').count();
    log('  #username=' + hasUsername + ' #confirm=' + hasConfirm + ' (注册表单标志)');
    if (!hasConfirm || !hasUsername) { log('FAIL: 未到达 d5st-app 注册表单'); ok = false; }
    else log('PASS: 直达注册表单，断点已消除');

    // 3) 填表注册
    await page.locator('#username').click();
    await page.keyboard.type(USER, { delay: 40 });
    await page.locator('#name').click();
    await page.keyboard.type('修复验证', { delay: 30 });
    await page.locator('#password').click();
    await page.keyboard.type(PASS, { delay: 30 });
    await page.locator('#confirm').click();
    await page.keyboard.type(PASS, { delay: 30 });
    const agree = page.locator('button[role=checkbox], label:has(input[type=checkbox])').first();
    if (await agree.count() > 0) await agree.click({ timeout: 5000 }).catch(() => {});
    await page.locator('button:has-text("注册")').first().click();
    await page.waitForTimeout(3000);
    const regBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 120);
    log('STEP3 注册后: URL=' + page.url() + ' | ' + regBody);
    if (!regBody.includes('已成功创建')) { log('FAIL: 注册未成功'); ok = false; }
    else log('PASS: 注册成功');

    // 4) result 页「登录」→ d5st /login
    const loginBtn = page.locator('button:has-text("登录"), a:has-text("登录")').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      await page.waitForTimeout(2500);
      log('STEP4 点登录后 URL = ' + page.url());
    }

    // 5) d5st /login → 「使用 Casdoor 登录」→ Casdoor 登录页（注册后已有 session，通常预填）
    if (page.url().includes('/login')) {
      await page.locator('a:has-text("使用 Casdoor 登录"), a.login-btn').first().click();
      await page.locator('#username').waitFor({ state: 'visible', timeout: 12000 });
      log('STEP5 到 Casdoor 登录页: ' + page.url());
      const prefill = await page.locator('#username').inputValue().catch(() => '');
      if (!prefill) {
        await page.locator('#username').click();
        await page.keyboard.type(USER, { delay: 40 });
        await page.locator('#password').click();
        await page.keyboard.type(PASS, { delay: 30 });
      } else {
        log('STEP5 Casdoor 已预填用户名: ' + prefill);
      }
      await page.locator('button[type=submit]:has-text("登录")').first().click();
      await page.waitForTimeout(3500);
      log('STEP6 登录后 URL = ' + page.url());
      const b = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 120);
      log('  页面文本: ' + b);
      const ck = await page.evaluate(() => fetch('/api/check-login').then(r => r.json()).catch(() => null));
      log('STEP6 check-login: ' + JSON.stringify(ck));
      if (!(ck && ck.loggedIn)) { log('FAIL: 闭环登录未成功'); ok = false; }
      else log('PASS: 新账号登录 d5st 闭环成功, username=' + ck.user.username);
    }
  } catch (e) {
    log('FATAL: ' + e.message);
    ok = false;
  }
  await browser.close();
  log(ok ? '\n==== 修复验证全部通过 ====' : '\n==== 存在失败项 ====');
  log('账号: ' + USER + ' / ' + PASS);
  process.exit(ok ? 0 : 1);
})();
