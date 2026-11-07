// 桌面端后台检查：导航、布局、表格、无溢出
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:35555';
const OUT = path.join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'admin-desktop');

const PAGES = [
  ['/admin', 'dashboard'],
  ['/admin/forum', 'forum'],
  ['/admin/users', 'users'],
  ['/admin/tags', 'tags'],
  ['/admin/points', 'points']
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Chromium 可能已被清理，回退到系统 Edge（两者都是 Chromium 内核）
  const candidates = [
    process.env.CHROME_PATH,
    require('path').join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  const exe = candidates.find(p => fs.existsSync(p));
  if (!exe) { console.error('找不到可用浏览器'); process.exit(2); }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.goto(BASE + '/auth/dev-login?username=admin&admin=1', { waitUntil: 'domcontentloaded' });

  let pass = 0, fail = 0;
  for (const [url, name] of PAGES) {
    const resp = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
    const info = await page.evaluate(() => {
      const sb = document.querySelector('.admin-sidebar');
      const nav = document.querySelector('.admin-nav');
      const content = document.querySelector('.admin-content');
      return {
        vw: window.innerWidth,
        docW: document.documentElement.scrollWidth,
        sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
        sidebarH: sb ? Math.round(sb.getBoundingClientRect().height) : 0,
        navDir: nav ? getComputedStyle(nav).flexDirection : null,
        contentW: content ? Math.round(content.getBoundingClientRect().width) : 0,
        navItems: document.querySelectorAll('.admin-nav-item').length
      };
    });
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    const okLayout = info.sidebarW >= 200 && info.sidebarW <= 280 && info.navDir === 'column' && info.docW <= info.vw + 2;
    if (resp.status() === 200 && okLayout) {
      pass++;
      console.log(`  ✓ ${url.padEnd(18)} 侧栏 ${info.sidebarW}px 竖排 · 内容 ${info.contentW}px · 导航项 ${info.navItems}`);
    } else {
      fail++;
      console.log(`  ✗ ${url.padEnd(18)} 状态=${resp.status()} 侧栏=${info.sidebarW}px 方向=${info.navDir} 文档宽=${info.docW}/${info.vw}`);
    }
  }
  if (errs.length) console.log('\nJS 错误:', [...new Set(errs)].slice(0, 5));
  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
