'use strict';
// 业务功能测试（覆盖之前没测的模块：赞助/好友/关注/私信/保密号/资料/搜索/元信息）
//
// 用法：
//   TEST_URL=http://127.0.0.1:35555 node 测试/test-features.js
//
// 需要 ENABLE_DEV_LOGIN=1 才能测多用户相关用例，否则相关段落会跳过。
// 注意：/auth/login 有限流（30 次/分钟），反复运行前最好间隔 60 秒，
//       否则开发登录会返回 429 导致后续用例跳过。
const http = require('http');

const BASE = process.env.TEST_URL || 'http://127.0.0.1:35555';
const U = new URL(BASE);

let pass = 0, fail = 0, skip = 0;
const failures = [];

function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, e) { fail++; failures.push({ m, e }); console.log('  ✗ ' + m + ' — ' + e); }
function skipped(m) { skip++; console.log('  ○ ' + m + ' (跳过)'); }
function assert(c, m) { if (!c) throw new Error(m); }

function makeClient() {
  const jar = new Map();
  function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  function store(res) {
    for (const c of (res.headers['set-cookie'] || [])) {
      const [p] = c.split(';'); const i = p.indexOf('=');
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  }
  function call(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ Cookie: cookieHeader() }, opts.headers || {});
      let body = opts.body;
      if (opts.form) {
        body = new URLSearchParams(opts.form).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (opts.json) {
        body = JSON.stringify(opts.json);
        headers['Content-Type'] = 'application/json';
      }
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      const r = http.request({
        hostname: U.hostname, port: U.port || 80,
        path, method, headers, timeout: 20000, agent: false
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          store(res);
          resolve({ status: res.statusCode, headers: res.headers, body: d, location: res.headers.location });
        });
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }
  const client = {
    jar,
    get: (p, o) => call('GET', p, o),
    post: (p, o) => call('POST', p, o),
    csrf: () => jar.get('csrf_token') || '',
    async login(name) {
      await call('GET', '/login');
      const r = await call('GET', '/auth/dev-login?username=' + encodeURIComponent(name));
      const st = await call('GET', '/api/check-login');
      let uid = null;
      try { uid = JSON.parse(st.body).user?.id ?? null; } catch (e) {}
      return { ok: /"loggedIn":true/.test(st.body), uid, status: r.status };
    },
    postCsrf(p, o = {}) {
      return call('POST', p, Object.assign({}, o, {
        headers: Object.assign({ 'X-CSRF-Token': client.csrf() }, o.headers || {})
      }));
    }
  };
  return client;
}

// 从好友页里取「接受」按钮的请求 id。
// 模板里是 <button class="u-btn primary js-accept" data-id="N">，
// class 与 data-id 之间可能有别的属性，所以用 [^>]* 而不是要求紧邻。
function findAcceptId(html) {
  const m = /class="[^"]*js-accept[^"]*"[^>]*?data-id="(\d+)"/.exec(html);
  return m ? m[1] : null;
}

(async () => {
  console.log('\n============================================');
  console.log(' D5ST 业务功能测试');
  console.log(' 目标:', BASE);
  console.log('============================================\n');

  const guest = makeClient();
  try {
    const r = await guest.get('/api/health');
    assert(r.status === 200, 'health ' + r.status);
  } catch (e) { console.error('目标不可达:', e.message); process.exit(2); }

  // ============ 1. 赞助 ============
  console.log('[1] 赞助功能');

  const alice = makeClient();
  const aliceLogin = await alice.login('feat_alice');
  const bob = makeClient();
  const bobLogin = await bob.login('feat_bob');

  if (!aliceLogin.ok || !bobLogin.ok) {
    skipped('赞助积分测试（需要 ENABLE_DEV_LOGIN=1 与两个用户）');
    if (aliceLogin.status === 429) console.log('     提示：开发登录被限流，请等 60 秒后重跑');
  } else {
    try {
      const r = await alice.postCsrf('/sponsor', { form: { amount: '10' } });
      if (r.status === 403) {
        ok('赞助入口默认关闭，POST 被 403 拒绝');
      } else {
        const page = await alice.get('/user/' + aliceLogin.uid);
        const before = (/积分[^0-9]{0,20}(\d+)/.exec(page.body) || [])[1];
        const r2 = await alice.postCsrf('/sponsor', { form: { amount: '10' } });
        const page2 = await alice.get('/user/' + aliceLogin.uid);
        const after = (/积分[^0-9]{0,20}(\d+)/.exec(page2.body) || [])[1];
        if (r2.status === 200 && before && after && Number(after) > Number(before)) {
          bad('赞助可白嫖积分', `未支付即到账：${before} → ${after}`);
        } else {
          ok('赞助未直接加分');
        }
      }
    } catch (e) { bad('赞助入口检查', e.message); }

    try {
      const cases = ['-100', '0', '999999', 'abc', '', '1e9', 'NaN'];
      for (const amount of cases) {
        const r = await alice.postCsrf('/sponsor', { form: { amount } });
        if (r.status === 200 && /赞助成功/.test(r.body)) {
          throw new Error(`amount=${JSON.stringify(amount)} 返回了成功页`);
        }
      }
      ok('非法金额（负数/0/超大/非数字）全部被拒');
    } catch (e) { bad('金额校验', e.message); }
  }

  // ============ 2. 好友 ============
  console.log('\n[2] 好友功能');

  if (!aliceLogin.ok || !bobLogin.ok) {
    skipped('好友功能（需要两个用户）');
  } else {
    const aliceId = aliceLogin.uid;
    const bobId = bobLogin.uid;

    try {
      const r = await alice.postCsrf('/friends/request/' + aliceId, { json: { message: 'self' } });
      assert(r.status !== 200 || !/"success":true/.test(r.body), '加自己返回成功');
      ok('不能添加自己为好友');
    } catch (e) { bad('加自己为好友', e.message); }

    // 测试隔离：先把双方关系彻底清干净（解除好友 + 清掉历史 pending 请求）。
    // 否则上一轮留下的 pending 会让本次「发送请求」被当作重复请求忽略，
    // 状态接口随之返回 requestSent=false，看起来像功能坏了。
    async function resetFriendState() {
      // 解除好友（双向）
      await alice.postCsrf('/friends/remove/' + bobId, {}).catch(() => {});
      // 清掉 bob 那边所有待处理请求
      for (let i = 0; i < 5; i++) {
        const l = await bob.get('/friends?tab=requests').catch(() => null);
        if (!l) break;
        const id = findAcceptId(l.body);
        if (!id) break;
        await bob.postCsrf('/friends/reject/' + id, {}).catch(() => {});
      }
    }
    await resetFriendState();

    try {
      const r = await alice.postCsrf('/friends/request/' + bobId, { json: { message: '交个朋友' } });
      // 被限流时必须明确报出来，不能当成“功能坏了”
      if (r.status === 429) throw new Error('好友请求接口被限流（429），请等待限流窗口后重跑');
      assert(r.status < 500, '状态 ' + r.status);
      const st = await alice.get('/friends/status/' + bobId);
      const d = JSON.parse(st.body);
      assert(d.requestSent === true || d.isFriend === true,
        '发送后状态未记录: ' + st.body);
      ok('发送好友请求成功（状态接口已记录 requestSent）');
    } catch (e) { bad('发送好友请求', e.message); }

    try {
      const r2 = await alice.postCsrf('/friends/request/' + bobId, { json: { message: '再来一次' } });
      assert(r2.status < 500, '重复请求返回 ' + r2.status);
      ok('重复好友请求不导致 5xx');
    } catch (e) { bad('重复好友请求', e.message); }

    try {
      const r = await alice.get('/friends/status/' + bobId);
      const d = JSON.parse(r.body);
      assert(typeof d.isFriend === 'boolean', '响应缺 isFriend');
      assert('requestSent' in d || 'requestReceived' in d, '响应缺少请求状态字段');
      ok('好友状态接口返回结构化数据');
    } catch (e) { bad('好友状态接口', e.message); }

    // 接受请求
    // 注意：好友页默认在「我的好友」标签，收到的请求只在 ?tab=requests 下渲染，
    // 直接访问 /friends 是看不到接受按钮的。
    try {
      const list = await bob.get('/friends?tab=requests');
      const reqId = findAcceptId(list.body);
      if (!reqId) {
        skipped('接受好友请求（bob 的请求列表为空）');
      } else {
        const r = await bob.postCsrf('/friends/accept/' + reqId, {});
        assert(r.status < 500, '状态 ' + r.status);
        const st = await alice.get('/friends/status/' + bobId);
        const d = JSON.parse(st.body);
        assert(d.isFriend === true, '接受后 isFriend 仍为 false');
        ok('接受好友请求后双方成为好友');
      }
    } catch (e) { bad('接受好友请求', e.message); }

    // 越权：第三方不能接受
    try {
      const carol = makeClient();
      const cl = await carol.login('feat_carol');
      if (!cl.ok) throw new Error('carol 登录失败（' + cl.status + '）');

      // 关键：先解除已有好友关系，否则再次发请求会被「已是好友」拦下，
      // 导致 bob 的请求列表为空、这条用例永远被跳过。
      await alice.postCsrf('/friends/remove/' + bobId, {});
      const reReq = await alice.postCsrf('/friends/request/' + bobId, { json: { message: 'for-carol' } });
      assert(reReq.status < 500, '重建请求失败 ' + reReq.status);

      const bobList = await bob.get('/friends?tab=requests');
      const reqId = findAcceptId(bobList.body);
      if (!reqId) {
        skipped('越权接受好友请求（bob 的请求列表为空）');
      } else {
        const badResult = await carol.postCsrf('/friends/accept/' + reqId, {});
        const st = await alice.get('/friends/status/' + bobId);
        const d = JSON.parse(st.body);
        // carol 不是接收方：要么请求被拒，要么好友关系压根没建立
        assert(d.isFriend !== true,
          'carol 接受了不属于自己的请求，好友关系被建立（返回 ' + badResult.status + '）');
        ok('他人无法接受别人的好友请求（越权防护）');
      }
    } catch (e) { bad('越权接受好友请求', e.message); }

    try {
      const r = await alice.postCsrf('/friends/remove/' + bobId, {});
      assert(r.status < 500, '状态 ' + r.status);
      const st = await alice.get('/friends/status/' + bobId);
      const d = JSON.parse(st.body);
      assert(d.isFriend === false, '解除后 isFriend 仍为 true');
      ok('解除好友生效');
    } catch (e) { bad('解除好友', e.message); }
  }

  // ============ 3. 关注 ============
  console.log('\n[3] 关注功能');

  if (!aliceLogin.ok || !bobLogin.ok) {
    skipped('关注功能（需要两个用户）');
  } else {
    try {
      const a = await alice.postCsrf('/user/' + bobLogin.uid + '/follow', {});
      assert(a.status < 500, '关注返回 ' + a.status);
      const c = await alice.postCsrf('/user/' + bobLogin.uid + '/follow', {});
      assert(c.status < 500, '取消关注返回 ' + c.status);
      ok('关注 / 取消关注切换正常');
    } catch (e) { bad('关注功能', e.message); }

    try {
      const r = await alice.postCsrf('/user/' + aliceLogin.uid + '/follow', {});
      assert(r.status < 500, '状态 ' + r.status);
      ok('关注自己不会导致 5xx');
    } catch (e) { bad('关注自己', e.message); }

    try {
      const r = await alice.get('/user/following/list');
      assert(r.status === 200, '状态 ' + r.status);
      assert(/关注|粉丝/.test(r.body), '页面内容不像关注列表');
      ok('关注列表页面正常');
    } catch (e) { bad('关注列表', e.message); }
  }

  // ============ 4. 私信 ============
  console.log('\n[4] 私信');

  if (!aliceLogin.ok || !bobLogin.ok) {
    skipped('私信（需要两个用户）');
  } else {
    try {
      const r = await alice.postCsrf('/messages/send/' + bobLogin.uid, { json: { content: '你好 bob' } });
      assert(r.status === 200, '状态 ' + r.status);
      assert(JSON.parse(r.body).success === true, '发送未成功');
      ok('私信发送成功');
    } catch (e) { bad('私信发送', e.message); }

    try {
      const r = await alice.postCsrf('/messages/send/' + aliceLogin.uid, { json: { content: 'self' } });
      assert(r.status === 400, '状态 ' + r.status);
      ok('不能给自己发私信');
    } catch (e) { bad('私信发给自己', e.message); }

    try {
      for (const c of ['', '   ', '\n\n', '\t']) {
        const r = await alice.postCsrf('/messages/send/' + bobLogin.uid, { json: { content: c } });
        assert(r.status === 400, `content=${JSON.stringify(c)} 返回 ${r.status}`);
      }
      ok('空内容 / 纯空白私信被拒');
    } catch (e) { bad('空私信', e.message); }

    try {
      const r = await bob.get('/messages');
      assert(r.status === 200, '状态 ' + r.status);
      assert(/你好 bob|feat_alice/.test(r.body), '接收方看不到会话');
      ok('接收方能看到会话');
    } catch (e) { bad('接收方查看', e.message); }

    try {
      const carol = makeClient();
      const cl = await carol.login('feat_carol2');
      if (!cl.ok) throw new Error('carol2 登录失败（' + cl.status + '）');
      const r = await carol.get('/messages/chat/' + bobLogin.uid);
      assert(!/你好 bob/.test(r.body), 'carol 读到了 alice 发给 bob 的私信内容');
      ok('第三方无法读取他人私信内容');
    } catch (e) { bad('私信越权', e.message); }
  }

  // ============ 5. 搜索 ============
  console.log('\n[5] 搜索');

  try {
    const r = await guest.get('/search?q=' + encodeURIComponent('测试'));
    assert(r.status === 200, '状态 ' + r.status);
    ok('搜索页正常');
  } catch (e) { bad('搜索页', e.message); }

  try {
    for (const q of ['%', '_', '\\', '"', "'", '<', '>', '&', '#']) {
      const r = await guest.get('/search?q=' + encodeURIComponent(q));
      assert(r.status < 500, `q=${q} 返回 ${r.status}`);
    }
    ok('搜索通配符 / 特殊字符不报错');
  } catch (e) { bad('搜索特殊字符', e.message); }

  // ============ 6. 保密号 ============
  console.log('\n[6] 保密号');

  if (!aliceLogin.ok) {
    skipped('保密号（需要登录）');
  } else {
    try {
      const g1 = await alice.postCsrf('/secret/generate', {});
      assert(g1.status === 200, '状态 ' + g1.status);
      const code1 = JSON.parse(g1.body).code;
      assert(/^[A-Z0-9]{8}$/.test(code1), '保密号格式异常: ' + code1);

      const g2 = await alice.postCsrf('/secret/generate', {});
      assert(g2.status === 200, '第二次生成状态 ' + g2.status);
      const code2 = JSON.parse(g2.body).code;
      assert(/^[A-Z0-9]{8}$/.test(code2), '第二次格式异常: ' + code2);
      assert(code1 !== code2, '两次生成得到同一个号（随机性可疑）');
      ok(`保密号生成与重生成正常（${code1} → ${code2}）`);

      const show = await guest.get('/secret/show?code=' + encodeURIComponent(code2));
      assert(show.status === 200, '状态 ' + show.status);
      assert(/feat_alice|alice/i.test(show.body), '查不到对应用户');
      ok('保密号可反查用户');
    } catch (e) { bad('保密号', e.message); }
  }

  // ============ 7. 资料编辑 ============
  console.log('\n[7] 资料编辑');

  if (!aliceLogin.ok) {
    skipped('资料编辑（需要登录）');
  } else {
    try {
      const long = '昵'.repeat(500);
      const r = await alice.postCsrf('/user/edit', { form: { nickname: long, grade: '高一', class_name: '1班' } });
      assert(r.status === 302, '状态 ' + r.status);
      const page = await alice.get('/user/edit');
      const m = /name="nickname"[^>]*value="([^"]*)"/.exec(page.body);
      if (m) {
        assert(m[1].length <= 32, '昵称未裁剪，长度 ' + m[1].length);
        ok(`超长昵称被裁剪（500 → ${m[1].length} 字符）`);
      } else {
        ok('超长昵称未导致 5xx');
      }
    } catch (e) { bad('超长昵称', e.message); }

    try {
      await alice.postCsrf('/user/edit', { form: { nickname: '<img src=x onerror=alert(1)>' } });
      const page = await alice.get('/user');
      assert(!/<img\s+src=x\s+onerror/i.test(page.body), '昵称里的 XSS 未被转义');
      ok('昵称中的 XSS 载荷被转义');
    } catch (e) { bad('昵称 XSS', e.message); }
  }

  // ============ 8. 分页边界 ============
  console.log('\n[8] 分页边界');

  try {
    const cases = [
      '/forum?page=1', '/forum?page=0', '/forum?page=-1', '/forum?page=99999',
      '/videos?page=0'
    ];
    for (const p of cases) {
      const r = await guest.get(p);
      assert(r.status < 500, p + ' 返回 ' + r.status);
    }
    ok('分页边界值（0/负数/超大）均不报错');
  } catch (e) { bad('分页边界', e.message); }

  // ============ 9. 站点元信息 ============
  console.log('\n[9] 站点元信息');

  try {
    const rss = await guest.get('/rss.xml');
    assert(rss.status === 200, 'RSS ' + rss.status);
    assert(/<rss|<feed/.test(rss.body), 'RSS 格式异常');
    ok('RSS 输出正常');

    const sm = await guest.get('/sitemap.xml');
    assert(sm.status === 200 && /<urlset/.test(sm.body), 'sitemap 异常');
    ok('sitemap 输出正常');

    const rb = await guest.get('/robots.txt');
    assert(rb.status === 200 && /User-agent/i.test(rb.body), 'robots 异常');
    assert(/Disallow:\s*\/admin/.test(rb.body), 'robots 未屏蔽 /admin');
    ok('robots.txt 正常且屏蔽后台');
  } catch (e) { bad('站点元信息', e.message); }

  // ============ 10. 错误处理 ============
  console.log('\n[10] 错误处理');

  try {
    const r404 = await guest.get('/this-page-does-not-exist-' + Date.now());
    assert(r404.status === 404, '状态 ' + r404.status + '（应为 404 而非重定向）');
    assert(!/Cannot read|TypeError|at Object\./.test(r404.body), '404 页泄露了堆栈');
    ok('不存在的路径返回 404（不再误重定向到 /login）');
  } catch (e) { bad('404 页面', e.message); }

  try {
    const r = await guest.get('/user');
    assert(r.status === 302 && /\/login/.test(r.location || ''), '需要登录的页面未重定向: ' + r.status);
    ok('需要登录的页面仍正确重定向到 /login');
  } catch (e) { bad('登录重定向', e.message); }

  try {
    const r = await guest.get('/api/nonexistent-endpoint');
    assert(r.status === 404 || r.status === 302, '状态 ' + r.status);
    ok('未知 API 路径处理正常（' + r.status + '）');
  } catch (e) { bad('未知 API', e.message); }

  console.log('\n============================================');
  console.log(` 通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`);
  console.log('============================================');
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.m}\n     ${f.e}`));
  }
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
})();
