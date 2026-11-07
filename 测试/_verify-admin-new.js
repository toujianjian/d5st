// 验证新增后台模块：逐页状态码 + 是否渲染出预期内容 + 移动端不溢出
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:35555';
const OUT = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'admin-new');

const PAGES = [
  ['/admin/guestbook', 'guestbook', '留言板管理'],
  ['/admin/messages', 'messages', '私信管理'],
  ['/admin/sponsors', 'sponsors', '赞助记录'],
  ['/admin/tags', 'tags', '标签管理'],
  ['/admin/medals', 'medals', '勋章管理'],
  ['/admin/points', 'points', '积分与签到'],
  ['/admin/secrets', 'secrets', '保密号管理'],
  ['/admin/students', 'students', '学生名册'],
  ['/admin/forum/edit/1', 'forum-edit', '编辑帖子'],
  ['/admin/comments/edit/1', 'comment-edit', '编辑评论'],
  ['/admin/forum', 'forum', '帖子管理'],
  ['/admin/comments', 'comments', '评论管理']
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('JS: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 120)); });

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.goto(BASE + '/auth/dev-login?username=admin&admin=1', { waitUntil: 'domcontentloaded' });

  let pass = 0, fail = 0;
  for (const [url, name, expect] of PAGES) {
    try {
      const resp = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
      const info = await page.evaluate(() => ({
        docW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        hasNav: !!document.querySelector('.admin-nav'),
        navRow: document.querySelector('.admin-nav') ? getComputedStyle(document.querySelector('.admin-nav')).flexDirection : null,
        hasTableScroll: !!document.querySelector('.table-scroll'),
        text: document.body.innerText.slice(0, 400)
      }));
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
      const okStatus = resp.status() === 200 || resp.status() === 302;
      const hasText = expect ? info.text.includes(expect.slice(0, 2)) : true;
      const noOverflow = info.docW <= info.vw + 2;
      const navOk = info.hasNav && info.navRow === 'row';
      if (okStatus && hasText && noOverflow && navOk) {
        pass++;
        console.log(`  ✓ ${url.padEnd(26)} ${resp.status()} | 导航横排=${navOk} | 无溢出=${noOverflow} | 表格滚动容器=${info.hasTableScroll}`);
      } else {
        fail++;
        console.log(`  ✗ ${url.padEnd(26)} 状态=${resp.status()} 文案=${hasText} 溢出=${!noOverflow} 导航=${navOk}`);
        console.log(`     页面片段: ${info.text.replace(/\n/g, ' | ').slice(0, 160)}`);
      }
    } catch (e) {
      fail++;
      console.log(`  ✗ ${url.padEnd(26)} 失败: ${e.message}`);
    }
  }

  if (errors.length) {
    console.log('\n浏览器错误:');
    [...new Set(errors)].slice(0, 10).forEach(e => console.log('  - ' + e));
  }
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  console.log('截图:', OUT);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
