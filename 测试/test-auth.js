const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:35555';
let passed = 0;
let failed = 0;
const results = [];

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name} — ${err.message}`);
    console.log(`  ❌ ${name} — ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || '断言失败');
}

async function runTests() {
  console.log('\n🔍 D5ST 系统测试\n' + '='.repeat(50));
  console.log(`目标地址: ${BASE}\n`);

  console.log('📡 基础连通性');
  await test('健康检查 API 响应', async () => {
    const res = await request('GET', '/api/health');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
    const json = JSON.parse(res.body);
    assert(json.status === 'ok', '状态应为 ok');
  });

  await test('首页可访问', async () => {
    const res = await request('GET', '/');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
    assert(res.body.includes('D5ST'), '页面应包含 D5ST');
  });

  await test('静态资源服务正常', async () => {
    const res = await request('GET', '/public/css/main.css');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
    assert(res.headers['content-type'].includes('text/css'), '应为 CSS 类型');
  });

  console.log('\n🔐 认证流程');
  await test('登录页面包含 Casdoor 入口', async () => {
    const res = await request('GET', '/login');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
    assert(res.body.includes('Casdoor'), '应包含 Casdoor 登录按钮');
  });

  await test('注册页面可访问', async () => {
    const res = await request('GET', '/register');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  await test('auth/login 重定向到 Casdoor', async () => {
    const res = await request('GET', '/auth/login');
    assert(res.status === 302, `期望 302 重定向，得到 ${res.status}`);
    assert(res.headers.location.includes('casdoor') || res.headers.location.includes('oauth'), '应重定向到认证地址');
  });

  await test('auth/callback 无 code 返回错误', async () => {
    const res = await request('GET', '/auth/callback');
    assert(res.status === 302, `期望 302，得到 ${res.status}`);
    assert(res.headers.location.includes('login'), '应重定向回登录页');
  });

  console.log('\n📱 页面公开访问');
  await test('贴吧列表页无需登录', async () => {
    const res = await request('GET', '/forum');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  await test('搜索页无需登录', async () => {
    const res = await request('GET', '/search?q=test');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  await test('赞助页无需登录', async () => {
    const res = await request('GET', '/sponsor');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  await test('保密号页无需登录', async () => {
    const res = await request('GET', '/secret');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  await test('留言板无需登录', async () => {
    const res = await request('GET', '/messages/guestbook');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
  });

  console.log('\n🔒 需登录页面保护');
  await test('个人中心未登录重定向', async () => {
    const res = await request('GET', '/user');
    assert(res.status === 302, `期望 302，得到 ${res.status}`);
    assert(res.headers.location === '/login', `应重定向到 /login`);
  });

  await test('私信未登录重定向', async () => {
    const res = await request('GET', '/messages');
    assert(res.status === 302, `期望 302，得到 ${res.status}`);
  });

  console.log('\n🛡️ 管理后台保护');
  await test('管理后台未登录重定向', async () => {
    const res = await request('GET', '/admin');
    assert(res.status === 302, `期望 302，得到 ${res.status}`);
  });

  console.log('\n📡 API 接口');
  await test('弹窗 API 可访问', async () => {
    const res = await request('GET', '/api/popups?page=home');
    assert(res.status === 200, `期望 200，得到 ${res.status}`);
    JSON.parse(res.body);
  });

  await test('未登录 check-login 返回 401', async () => {
    const res = await request('GET', '/api/check-login');
    assert(res.status === 401, `期望 401，得到 ${res.status}`);
    const json = JSON.parse(res.body);
    assert(json.loggedIn === false, 'loggedIn 应为 false');
  });

  console.log('\n🌐 路由完整性');
  const publicPaths = ['/', '/login', '/register', '/forum', '/search', '/secret', '/sponsor', '/messages/guestbook', '/forgot-password'];
  for (const p of publicPaths) {
    await test(`路径 ${p} 可访问`, async () => {
      const res = await request('GET', p);
      assert(res.status === 200 || res.status === 302, `${p} 状态码 ${res.status}`);
    });
  }

  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 测试结果: ${passed} 通过, ${failed} 失败\n`);
  
  if (failed > 0) {
    console.log('❌ 部分测试未通过，请检查系统配置和 Casdoor 连接。');
    process.exit(1);
  } else {
    console.log('✅ 所有测试通过！D5ST 系统运行正常。');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
