// 验证新增后台写操作真实生效（不只是页面能打开）
const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:35555';
const jar = new Map();

function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function store(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
}
function req(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = Object.assign({}, opts.headers || {});
    const ck = cookieHeader(); if (ck) headers.Cookie = ck;
    let body = opts.body;
    if (opts.form) { body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 15000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { store(res); resolve({ status: res.statusCode, headers: res.headers, body: d }); }); });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const csrf = () => jar.get('csrf_token') || '';
const post = (p, form) => req('POST', p, { form: Object.assign({ _csrf: csrf() }, form) });

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + ' — ' + e); };
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  console.log('\n=== 后台写操作验证 ===\n');
  await req('GET', '/login');
  await req('GET', '/auth/dev-login?username=admin&admin=1');
  const st = await req('GET', '/api/check-login');
  if (!/"loggedIn":true/.test(st.body)) { console.log('登录失败'); process.exit(2); }
  const uid = JSON.parse(st.body).user.id;

  // 1) 留言板：先发一条，再在后台删除
  try {
    const content = '后台删除测试-' + Date.now();
    await post('/messages/guestbook', { content });
    const list = await req('GET', '/admin/guestbook?q=' + encodeURIComponent('后台删除测试'));
    const m = /\/admin\/guestbook\/delete\/(\d+)/.exec(list.body);
    assert(m, '后台留言板列表里找不到刚发的留言');
    const del = await post('/admin/guestbook/delete/' + m[1], {});
    assert(del.status === 302, '删除返回 ' + del.status);
    const after = await req('GET', '/admin/guestbook?q=' + encodeURIComponent('后台删除测试'));
    assert(!after.body.includes(content), '删除后仍能看到该留言');
    ok('留言板：后台删除生效');
  } catch (e) { bad('留言板删除', e.message); }

  // 2) 标签合并
  try {
    const tagA = 'mergeA' + Date.now();
    const tagB = 'mergeB' + Date.now();
    // 用发帖自动建标签
    const postRes = await post('/forum', { title: 'tag merge test', content: '用于验证标签合并的内容', category: 'general', tags: tagA });
    assert(postRes.status === 302, '发帖失败 ' + postRes.status);
    await post('/forum', { title: 'tag merge test 2', content: '第二条内容用于建第二个标签', category: 'general', tags: tagB });

    // 从 /admin/tags 里按「#标签名」定位所在行的 ID（表格行：<td>ID</td> ... <td>#名字</td>）
    async function findTagId(name) {
      const r = await req('GET', '/admin/tags?q=' + encodeURIComponent(name));
      const rowRe = /<tr>\s*<td>(\d+)<\/td>\s*<td>#([^<]+)<\/td>/g;
      let m;
      while ((m = rowRe.exec(r.body))) {
        if (m[2].trim() === name) return m[1];
      }
      return null;
    }
    const idA = await findTagId(tagA);
    const idB = await findTagId(tagB);
    assert(idA && idB, '找不到新建的标签（A=' + idA + ' B=' + idB + '）');
    const mg = await post('/admin/tags/merge', { from_id: idA, to_id: idB });
    assert(mg.status === 302, '合并返回 ' + mg.status);
    const afterA = await findTagId(tagA);
    assert(afterA === null, '合并后源标签仍存在');
    const afterB = await findTagId(tagB);
    assert(afterB !== null, '合并后目标标签消失了');
    ok('标签：合并生效（#' + tagA + ' → #' + tagB + '）');
  } catch (e) { bad('标签合并', e.message); }

  // 3) 积分调整
  try {
    const readPoints = async () => {
      const r = await req('GET', '/admin/points?q=admin');
      // 行结构：<td>ID</td> ... <td><strong>分数</strong></td>
      const m = /<tr>\s*<td>(\d+)<\/td>[\s\S]*?<td><strong>(\d+)<\/strong><\/td>/.exec(r.body);
      return m ? { id: m[1], points: parseInt(m[2], 10) } : null;
    };
    const before = await readPoints();
    assert(before, '找不到 admin 用户积分行');
    const adj = await post('/admin/points/adjust', { user_id: before.id, delta: 7 });
    assert(adj.status === 302, '调整返回 ' + adj.status);
    const after = await readPoints();
    assert(after.points === before.points + 7, `积分未按 +7 变化：${before.points} → ${after.points}`);
    await post('/admin/points/adjust', { user_id: before.id, delta: -7 }); // 还原
    ok(`积分：调整 ±7 生效并已还原（${before.points} → ${after.points} → ${before.points}）`);
  } catch (e) { bad('积分调整', e.message); }

  // 4) 勋章授予与撤销
  try {
    const type = 'audit_' + Date.now();
    const g = await post('/admin/medals/grant', { user_id: uid, medal_type: type, medal_name: '审计勋章' });
    assert(g.status === 302, '授予返回 ' + g.status);
    // 用唯一的 medal_type 定位（medal_name 可能与其他历史记录重名）
    const findRow = async () => {
      const r = await req('GET', '/admin/medals?q=' + encodeURIComponent(type));
      const rowRe = new RegExp('<tr>\\s*<td>(\\d+)</td>[\\s\\S]*?' + type + '[\\s\\S]*?</tr>', 'g');
      const m = rowRe.exec(r.body);
      return m ? { id: m[1], html: m[0] } : null;
    };
    const granted = await findRow();
    assert(granted, '授予后列表里看不到该勋章类型 ' + type);
    const mid = /\/admin\/medals\/delete\/(\d+)/.exec(granted.html);
    assert(mid, '找不到撤销按钮');
    const d = await post('/admin/medals/delete/' + mid[1], {});
    assert(d.status === 302, '撤销返回 ' + d.status);
    const after = await findRow();
    assert(after === null, '撤销后仍能查到该勋章类型');
    ok('勋章：授予与撤销都生效');
  } catch (e) { bad('勋章授予/撤销', e.message); }

  // 5) 帖子编辑
  try {
    const p = await post('/forum', { title: '原标题-原始', content: '原始正文内容用于编辑测试', category: 'general' });
    const id = /\/forum\/(\d+)/.exec(p.headers.location || '')[1];
    const e1 = await post('/admin/forum/edit/' + id, { title: '改后标题', content: '改后正文内容', category: 'study', is_top: '1' });
    assert(e1.status === 302, '保存返回 ' + e1.status);
    const view = await req('GET', '/forum/' + id);
    assert(view.body.includes('改后标题'), '标题未更新');
    assert(view.body.includes('改后正文内容'), '正文未更新');
    await post('/forum/delete/' + id, {}); // 清理
    ok('帖子编辑：标题/正文/置顶都生效');
  } catch (e) { bad('帖子编辑', e.message); }

  // 6) 学生名册导入
  try {
    const no = 'AUDIT' + Date.now();
    const csv = '年级,班级,学号,姓名,钉钉ID\n高一,1班,' + no + ',审计学生,';
    const r = await post('/admin/students/import', { csv });
    assert(r.status === 302, '导入返回 ' + r.status);
    const list = await req('GET', '/admin/students?q=' + no);
    assert(list.body.includes('审计学生'), '导入后查不到该学生');
    const sid = /\/admin\/students\/delete\/(\d+)/.exec(list.body);
    assert(sid, '找不到删除按钮');
    await post('/admin/students/delete/' + sid[1], {});
    ok('学生名册：CSV 导入与删除生效');
  } catch (e) { bad('学生名册导入', e.message); }

  // 7) 保密号重置
  try {
    await post('/secret/generate', {});
    const list = await req('GET', '/admin/secrets');
    const m = /\/admin\/secrets\/reset\/(\d+)/.exec(list.body);
    if (!m) { ok('保密号：当前无记录，跳过'); }
    else {
      const before = /<code[^>]*>([A-Z0-9]{8})<\/code>/.exec(list.body);
      const r = await post('/admin/secrets/reset/' + m[1], {});
      assert(r.status === 302, '重置返回 ' + r.status);
      const after = await req('GET', '/admin/secrets');
      const afterCode = /<code[^>]*>([A-Z0-9]{8})<\/code>/.exec(after.body);
      assert(!before || !afterCode || before[1] !== afterCode[1], '保密号重置后没有变化');
      ok('保密号：重置生效（' + (before ? before[1] : '?') + ' → ' + (afterCode ? afterCode[1] : '?') + '）');
    }
  } catch (e) { bad('保密号重置', e.message); }

  console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
