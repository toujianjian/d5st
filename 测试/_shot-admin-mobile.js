// 后台手机端截图诊断：登录后按移动端尺寸逐页截图，并检测横向溢出
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:35555';
const OUT = process.env.OUT || path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'admin-shots');

const PAGES = [
  ['/admin', 'dashboard'],
  ['/admin/forum', 'forum'],
  ['/admin/comments', 'comments'],
  ['/admin/reports', 'reports'],
  ['/admin/videos', 'videos'],
  ['/admin/boards', 'boards'],
  ['/admin/users', 'users'],
  ['/admin/notifications', 'notifications'],
  ['/admin/popups', 'popups'],
  ['/admin/home-banners', 'banners'],
  ['/admin/home-links', 'links'],
  ['/admin/sensitive-words', 'sensitive'],
  ['/admin/recycle-bin', 'recycle'],
  ['/admin/settings', 'settings']
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // 手机视口
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await ctx.newPage();

  // 登录（dev-login）
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.goto(BASE + '/auth/dev-login?username=admin&admin=1', { waitUntil: 'domcontentloaded' });
  const st = await page.evaluate(async () => {
    const r = await fetch('/api/check-login'); return r.json();
  });
  console.log('登录状态:', JSON.stringify(st).slice(0, 120));
  if (!st.loggedIn) { console.log('登录失败，退出'); await browser.close(); return; }

  const report = [];
  for (const [url, name] of PAGES) {
    try {
      const resp = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
      const info = await page.evaluate(() => {
        const de = document.documentElement;
        // 找出所有超出视口宽度的元素
        const vw = window.innerWidth;
        const overflow = [];
        document.querySelectorAll('body *').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > vw + 2 && r.height > 0 && getComputedStyle(el).display !== 'none') {
            overflow.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 40),
              w: Math.round(r.width)
            });
          }
        });
        // 去重取最宽的 5 个
        const uniq = [];
        const seen = new Set();
        for (const o of overflow.sort((a, b) => b.w - a.w)) {
          const k = o.tag + '.' + o.cls;
          if (seen.has(k)) continue;
          seen.add(k); uniq.push(o);
          if (uniq.length >= 5) break;
        }
        return {
          docScrollW: de.scrollWidth,
          viewportW: vw,
          hasHScroll: de.scrollWidth > vw + 2,
          overflow: uniq,
          tables: document.querySelectorAll('table').length,
          cards: document.querySelectorAll('[class*="admin-card"],[class*="admin-stat"]').length
        };
      });
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
      report.push({ name, url, status: resp.status(), ...info });
      console.log(`\n[${name}] ${resp.status()} | 横向滚动: ${info.hasHScroll ? '是 ⚠️' : '否'} | 文档宽 ${info.docScrollW} / 视口 ${info.viewportW} | 表格 ${info.tables}`);
      if (info.overflow.length) info.overflow.forEach(o => console.log(`     溢出: <${o.tag} class="${o.cls}"> 宽 ${o.w}px`));
    } catch (e) {
      console.log(`\n[${name}] 失败: ${e.message}`);
      report.push({ name, url, error: e.message });
    }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n截图目录:', OUT);
  console.log('横向溢出的页面:', report.filter(r => r.hasHScroll).map(r => r.name).join(', ') || '无');

  await browser.close();
})();
