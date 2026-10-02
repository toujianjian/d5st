const { chromium } = require('playwright');
const BASE = 'http://localhost:35545';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', d => d.accept());

  try {
    // 1) 开发登录（管理员）
    await page.goto(BASE + '/auth/dev-login?admin=1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    console.log('STEP1 登录后 URL=' + page.url());
    const ck = await page.evaluate(() => fetch('/api/check-login').then(r => r.json()).catch(() => null));
    check('开发登录成功', ck && ck.loggedIn, ck && ck.user ? ck.user.username : 'null');

    // 2) 首页赞助暂停态
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const homeText = await page.locator('body').innerText();
    check('首页显示 赞助（暂停）', /赞助（暂停）/.test(homeText));
    check('首页显示好友入口', /好友/.test(homeText));
    await page.screenshot({ path: '测试/vf-1-home.png' });

    // 3) 侧栏统计（/forum 用 layout.ejs）
    await page.goto(BASE + '/forum', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const forumText = await page.locator('body').innerText();
    check('侧栏含积分统计', /积分/.test(forumText));
    check('侧栏含好友入口', /好友/.test(forumText));
    await page.screenshot({ path: '测试/vf-2-forum.png' });

    // 4) 好友系统
    await page.goto(BASE + '/friends', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    let fText = await page.locator('body').innerText();
    check('好友页可打开', /好友/.test(fText) && /发现同学/.test(fText));
    await page.screenshot({ path: '测试/vf-3-friends.png' });

    // 搜索并发送好友请求
    await page.goto(BASE + '/friends/search?q=d5st', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const addBtn = page.locator('.js-add').first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(1500);
      fText = await page.locator('body').innerText();
      check('发送好友请求后显示已申请/已是好友', /已申请|已是好友/.test(fText));
    } else {
      // 搜索结果若都已申请/已是好友，也是正确状态（说明此前已发送过）
      fText = await page.locator('body').innerText();
      check('搜索结果按钮状态正确(已申请/已是好友)', /已申请|已是好友/.test(fText));
    }
    await page.screenshot({ path: '测试/vf-4-friend-search.png' });

    // 5) 发帖 + 删除自己的帖子
    await page.goto(BASE + '/forum/new', { waitUntil: 'networkidle' });
    await page.fill('#title', '功能验证测试帖');
    await page.fill('#content', '这是一条用于验证发帖与删帖流程的测试内容。');
    await Promise.all([
      page.waitForNavigation({ timeout: 12000 }).catch(() => {}),
      page.locator('.btn-submit').click()
    ]);
    await page.waitForTimeout(1500);
    const postUrl = page.url();
    console.log('STEP5 发帖后 URL=' + postUrl);
    check('发帖后进入帖子详情', /\/forum\/\d+/.test(postUrl), postUrl);
    const hasDel = await page.locator('#deleteBtn').count();
    check('详情页出现删除按钮（作者本人）', hasDel > 0);
    await page.screenshot({ path: '测试/vf-5-post-detail.png' });

    if (hasDel > 0) {
      await Promise.all([
        page.waitForNavigation({ timeout: 12000 }).catch(() => {}),
        page.locator('#deleteBtn').click()
      ]);
      await page.waitForTimeout(1200);
      check('删除后回到论坛列表', /\/forum(\?|$)/.test(page.url()), page.url());
      // 再次访问原帖应 404
      const resp = await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      check('已删除帖子不可访问', resp && resp.status() === 404, 'status=' + (resp && resp.status()));
    }

    // 6) 私信页
    await page.goto(BASE + '/messages', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const msgText = await page.locator('body').innerText();
    check('私信页可打开', /私信/.test(msgText));
    await page.screenshot({ path: '测试/vf-6-messages.png' });

    // 7) 赞助暂停
    await page.goto(BASE + '/sponsor', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const spText = await page.locator('body').innerText();
    check('赞助页显示暂停', /暂停/.test(spText));
    await page.screenshot({ path: '测试/vf-7-sponsor.png' });

  } catch (e) {
    console.log('FATAL: ' + e.message);
    fail++;
  }

  await browser.close();
  console.log('\n==== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail === 0 ? 0 : 1);
})();
