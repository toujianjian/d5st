const { chromium } = require('playwright');
const BASE = 'http://localhost:35545';
let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log('  PASS ' + n + (e ? ' | ' + e : ''))) : (fail++, console.log('  FAIL ' + n + (e ? ' | ' + e : ''))); };

// 极简 CSV 解析（只处理带引号转义的标准写法）
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1366, height: 1000 } });
  p.on('dialog', d => d.accept());

  await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.locator('a.login-btn').first().click();
  await p.waitForSelector('#username', { timeout: 12000 });
  await p.fill('#username', 'd5stadmin');
  await p.fill('#password', 'd5stpassword');
  await p.locator('button[type=submit]:has-text("登录")').first().click();
  await p.waitForTimeout(3000);

  // ---------- 页面 ----------
  const resp = await p.goto(BASE + '/admin/export-all', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  check('导出页可访问（200）', resp.status() === 200, 'status=' + resp.status());
  const pageText = (await p.locator('.admin-content').innerText()).replace(/\s+/g, ' ');
  console.log('  页面摘要 = ' + pageText.slice(0, 150));
  check('页面列出两个库', /d5st（\d+ 张表/.test(pageText) && /casdoor（\d+ 张表/.test(pageText));
  check('页面提示含敏感数据', /含敏感数据/.test(pageText));
  const rowsInTable = await p.locator('.card:last-child tbody tr').count();
  check('表清单已渲染', rowsInTable > 60, '行数=' + rowsInTable);
  check('侧栏有「导出全部数据」入口', await p.locator('a[href="/admin/export-all"]').count() >= 1);
  await p.screenshot({ path: '测试/_ex-page.png' });

  // ---------- 下载两库合并 CSV ----------
  const url = BASE + '/admin/export-all?format=csv&db=d5st&db=casdoor';
  const r = await p.context().request.get(url);
  const body = await r.body();
  const text = body.toString('utf8');
  console.log('  CSV 大小 = ' + (body.length / 1024).toFixed(1) + ' KB');
  check('下载返回 200', r.status() === 200, 'status=' + r.status());
  check('Content-Type 为 text/csv', /text\/csv/.test(r.headers()['content-type'] || ''), r.headers()['content-type']);
  check('附件文件名正确', /attachment.*d5st-all-databases-.*\.csv/.test(r.headers()['content-disposition'] || ''), r.headers()['content-disposition']);
  check('带 UTF-8 BOM', text.charCodeAt(0) === 0xFEFF);

  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = rows[0];
  console.log('  表头 = ' + JSON.stringify(header));
  check('表头为 库/表/行号/字段/值/是否为空', header.join(',') === '库,表,行号,字段,值,是否为空');

  const data = rows.slice(1);
  const dbs = Array.from(new Set(data.map(x => x[0]))).sort();
  check('两个库都在同一个 CSV 里', dbs.join(',') === 'casdoor,d5st', dbs.join(','));
  const tables = new Set(data.map(x => x[0] + '.' + x[1]));
  console.log('  包含表数 = ' + tables.size + '，数据行 = ' + data.length);
  check('表清单与预览一致（82 张）', tables.size === rowsInTable, 'tables=' + tables.size + ' 预览=' + rowsInTable);
  check('空表也有标记行（行号=0）', data.some(x => x[2] === '0' && x[3] === '(空表，无数据)'));
  check('包含 d5st.system_settings', tables.has('d5st.system_settings'));
  check('包含 casdoor.user（Casdoor 用户表）', tables.has('casdoor.user'));

  // 已知值校验
  const siteName = data.find(x => x[0] === 'd5st' && x[1] === 'system_settings' && x[3] === 'setting_value' && x[4] === 'D5ST 校园社区');
  check('能读到已知值（site_name = D5ST 校园社区）', !!siteName, siteName ? JSON.stringify(siteName) : '未找到');
  const casdoorUser = data.find(x => x[0] === 'casdoor' && x[1] === 'user' && x[3] === 'name' && x[4] === 'd5stadmin');
  check('能读到 Casdoor 用户数据（d5stadmin）', !!casdoorUser, casdoorUser ? JSON.stringify(casdoorUser) : '未找到');

  // 行号成组还原：取一张表，检查同一行号的字段数一致
  const posts = data.filter(x => x[0] === 'd5st' && x[1] === 'forum_boards');
  const colsOfRow1 = posts.filter(x => x[2] === '1').map(x => x[3]);
  check('同一行号可聚合回原始行（forum_boards 第 1 行字段数 > 3）', colsOfRow1.length > 3, colsOfRow1.join(','));

  // NULL 区分
  const nullCount = data.filter(x => x[5] === '1').length;
  check('有 SQL NULL 被标记（是否为空=1）', nullCount > 0, 'NULL 单元格数=' + nullCount);

  // 中文/换行等特殊字符被正确转义（能找到含中文的值）
  check('中文值正常（无乱码）', data.some(x => /[\u4e00-\u9fa5]/.test(x[4])), '');

  // ---------- 只导一个库 ----------
  const r2 = await p.context().request.get(BASE + '/admin/export-all?format=csv&db=casdoor');
  const rows2 = parseCsv((await r2.body()).toString('utf8').replace(/^\uFEFF/, '')).slice(1);
  const dbs2 = Array.from(new Set(rows2.map(x => x[0])));
  check('单选 casdoor 时只导出 casdoor', dbs2.length === 1 && dbs2[0] === 'casdoor', dbs2.join(','));

  await b.close();
  console.log('\n==== ' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail === 0 ? 0 : 1);
})();
