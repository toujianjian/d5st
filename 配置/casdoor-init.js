// ============================================================
// Casdoor 首次启动初始化：自动创建组织 / 应用 / 组 / Webhook
// 幂等：可重复调用，已存在则跳过
// ============================================================
const casdoor = require('./casdoor');
const C = casdoor.C;

const LOG = (msg) => console.log(`[Casdoor-Init] ${msg}`);
const ERR = (msg) => console.warn(`[Casdoor-Init] ${msg}`);

async function ensureOrganization() {
  try {
    const existing = await casdoor.getOrganization(C.organization);
    if (existing) {
      LOG(`组织 "${C.organization}" 已存在`);
      return existing;
    }
  } catch (e) { /* not found */ }

  LOG(`创建组织 "${C.organization}" ...`);
  const org = {
    owner: 'built-in',
    name: C.organization,
    displayName: 'D5ST 校园社区',
    websiteUrl: C.appUrl,
    favicon: 'https://cdn.jsdelivr.net/gh/nextgis/d5st-logo/d5st-logo.png',
    tags: ['campus', 'community'],
    // 密码策略：至少 8 位
    passwordType: 'Default',
    passwordOptions: {
      minLength: 8,
      complexity: 'Low',
      strengthCheck: true
    },
    // 验证码：默认关闭（Casdoor 本地跑时 SMTP 通常未配置）
    // 若需要邮箱验证，请配置 Email Provider 后再打开
    enableSigninSessionExpiration: true,
    signinSessionTimeout: 21600,
    enableDefaultPassword: false,
    signupApplication: C.application,
    inviteLimit: -1,
    isGlobal: false,
    isDeleted: false
  };
  try {
    const created = await casdoor.createOrganization(org);
    LOG(`组织创建成功: ${created?.name}`);
    return created;
  } catch (err) {
    ERR(`创建组织失败: ${err.message}`);
    throw err;
  }
}

async function ensureApplication() {
  try {
    const existing = await casdoor.getApplication(C.organization, C.application);
    if (existing) {
      LOG(`应用 "${C.application}" 已存在`);
      return existing;
    }
  } catch (e) { /* not found */ }

  LOG(`创建应用 "${C.application}" ...`);
  const app = {
    owner: C.organization,
    name: C.application,
    displayName: 'D5ST 校园社区',
    logo: 'https://cdn.jsdelivr.net/gh/nextgis/d5st-logo/d5st-logo.png',
    organization: C.organization,
    homepageUrl: C.appUrl,
    description: 'D5ST 校园社区网站应用',
    redirectUris: [`${C.appUrl}/auth/callback`],
    // client_id / client_secret 与 .env 保持一致
    clientId: C.clientId,
    clientSecret: C.clientSecret,
    tokenFormat: 'JWT',
    tokenExpireInHours: 24,
    refreshTokenExpireInHours: 720,
    // 支持的登录方式：密码 + 手机/邮箱验证码
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    scopes: ['profile', 'email', 'offline_access'],
    redirectUrl: C.appUrl,
    logoutUrl: `${C.appUrl}/logout`,
    tokenUrl: `${C.endpoint}/api/login/oauth/access_token`,
    userInfoUrl: `${C.endpoint}/api/get-account`,
    // 主题配色（Casdoor 前端）
    theme: 'red',
    enablePassword: true,
    enablePasswordRegistration: true,
    enableEmail: true,
    enablePhone: true,
    enableEmailCode: true,
    enablePhoneCode: true,
    enableSignUp: true,
    enableSignin: true,
    enableForgetPassword: true,
    enableSigninSessionExpiration: true,
    enableAutoSignin: false,
    enableProfile: true,
    enableTermsOfUse: false,
    enableSensitiveWords: false,
    enableWebAuthn: false,
    enablePasswordlessLogin: false,
    // 允许登录方式
    signinMethods: [
      { name: 'Password', title: '密码登录', prompt: '密码', method: 'password', clickToAuth: true }
    ],
    signUpMethods: [
      { name: 'Password', title: '密码注册', prompt: '密码', clickToAuth: true }
    ],
    // 权限/组映射（用于 admin 判断）
    isAdmin: false,
    enablePasswordUpdate: true,
    isDeleted: false
  };
  try {
    const created = await casdoor.createApplication(app);
    LOG(`应用创建成功: ${created?.name}`);
    return created;
  } catch (err) {
    ERR(`创建应用失败: ${err.message}`);
    throw err;
  }
}

// 用户组：d5st-admin / d5st-user / d5st-moderator
async function ensureUserGroup(name, displayName, description) {
  try {
    const existing = await casdoor.getUserGroup(C.organization, name);
    if (existing) {
      LOG(`用户组 "${name}" 已存在`);
      return existing;
    }
  } catch (e) { /* not found */ }

  try {
    const g = {
      owner: C.organization,
      name,
      displayName,
      description,
      roles: [],
      permissions: [],
      isDeleted: false
    };
    await casdoor.createUserGroup(g);
    LOG(`用户组创建成功: ${name}`);
    return g;
  } catch (err) {
    ERR(`创建用户组 ${name} 失败: ${err.message}`);
  }
}

// Webhook：Casdoor 事件 → d5st /api/casdoor/webhook
async function ensureWebhook() {
  const name = 'd5st-webhook';
  try {
    const existing = await casdoor.getWebhook(C.organization, name);
    if (existing) {
      LOG(`Webhook "${name}" 已存在`);
      return existing;
    }
  } catch (e) { /* not found */ }

  try {
    const webhook = {
      owner: C.organization,
      name,
      displayName: 'D5ST 事件接收',
      description: '接收 Casdoor 认证事件回推',
      url: `${C.appUrl}/api/casdoor/webhook`,
      httpMethod: 'POST',
      contentType: 'application/json',
      eventTypes: [
        'User login',
        'User signup',
        'User delete',
        'User update',
        'User logout'
      ],
      // HMAC-SHA256 签名密钥
      secret: C.webhookSecret,
      enabled: true,
      isDeleted: false,
      retryTimes: 3,
      retriesInterval: 5,
      maxRetryDuration: 60
    };
    const created = await casdoor.createWebhook(webhook);
    LOG(`Webhook 创建成功: ${name} -> ${webhook.url}`);
    return created;
  } catch (err) {
    ERR(`创建 Webhook 失败: ${err.message}`);
    throw err;
  }
}

// 主入口：按顺序执行初始化
// 返回值：{ ok, org, app, appClientId, appClientSecret, warnings: [] }
async function initCasdoor() {
  const result = { ok: false, org: null, app: null, appClientId: null, appClientSecret: null, warnings: [] };
  if (!C.endpoint) {
    ERR('未配置 CASDOOR_ENDPOINT，跳过初始化');
    result.warnings.push('endpoint 缺失');
    return result;
  }

  LOG(`连接 ${C.endpoint} ...`);
  const available = await casdoor.isAvailable();
  if (!available) {
    ERR('Casdoor 不可达，跳过初始化（应用仍可启动，登录时再重试）');
    result.warnings.push('Casdoor 不可达');
    return result;
  }

  try {
    await casdoor.getAdminToken();
    LOG('管理员 token 获取成功');
  } catch (err) {
    ERR(`管理员 token 获取失败: ${err.message}（Casdoor 可能未完成首次初始化）`);
    result.warnings.push('admin token 失败');
    return result;
  }

  try {
    result.org = await ensureOrganization();
    result.app = await ensureApplication();
    if (result.app) {
      // Casdoor 会自动生成 client_id/client_secret（32 位随机），
      // 如果 .env 里没有配，就把生成的写回给上层用于提示用户更新 .env
      result.appClientId = result.app.clientId || C.clientId;
      result.appClientSecret = result.app.clientSecret || C.clientSecret;
    }
    await ensureUserGroup('d5st-admin', 'D5ST 管理员', '拥有全部管理权限');
    await ensureUserGroup('d5st-moderator', 'D5ST 版主', '论坛内容审核');
    await ensureUserGroup('d5st-user', 'D5ST 普通用户', '社区普通用户');
    await ensureWebhook();
    result.ok = true;
    LOG('Casdoor 初始化全部完成');
    if (result.appClientId && result.appClientId !== C.clientId) {
      LOG(`⚠ 生成的 client_id: ${result.appClientId}`);
      LOG(`⚠ 生成的 client_secret: ${result.appClientSecret}`);
      LOG('⚠ 请将 .env 中 CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET 更新为上述值并重启');
    }
    return result;
  } catch (err) {
    ERR(`初始化中止: ${err.message}`);
    result.warnings.push(err.message);
    return result;
  }
}

module.exports = { initCasdoor };
