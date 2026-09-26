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
    // 密码策略：留空使用 Casdoor 默认值（旧代码传 passwordOptions 对象，
    // 但当前 casdoor:latest 镜像要求 passwordOptions 是 []string，
    // 会让 add-organization 返回 status:'error' 被静默吞掉）
    passwordType: 'Default',
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
    // 容错：Duplicate entry 说明组织实际已存在（getOrganization 端点参数
    // 可能不匹配导致没检测到）。视为成功，避免 init 中止。
    if (/Duplicate entry/i.test(err.message)) {
      LOG(`组织 "${C.organization}" 已存在（Duplicate，忽略）`);
      return null;
    }
    ERR(`创建组织失败: ${err.message}`);
    throw err;
  }
}

// 注册表单必填配置：Email 和 Display name 设为非必填（本地开发无强制要求）
// Casdoor 的 Application 没有 Require* 顶层字段，通过 SignupItem.required 控制必填星号
const SIGNUP_ITEMS = [
  { name: 'Username',     visible: true, required: true,  prompted: true, type: 'text',     label: '用户名',     placeholder: '请输入用户名' },
  { name: 'Password',     visible: true, required: true,  prompted: true, type: 'password', label: '密码',       placeholder: '请输入密码' },
  { name: 'Email',        visible: true, required: false, prompted: false, type: 'text',     label: '邮箱',       placeholder: '选填' },
  { name: 'Display name', visible: true, required: false, prompted: false, type: 'text',     label: '显示名称', placeholder: '选填' }
];

async function ensureApplication() {
  // 探测已有应用：先 get-application，失败则回退 list-applications
  // （get-application 在容器启动初期或并发场景会偶发返回 null/throw，
  //  list-applications 经我们修复后端点稳定）
  let existing = null;
  try {
    existing = await casdoor.getApplication(C.organization, C.application);
  } catch (e) { /* ignore */ }
  if (!existing) {
    try {
      const apps = await casdoor.listApplications(C.organization);
      existing = apps.find(a => a.name === C.application) || null;
    } catch (e) { /* ignore */ }
  }
  if (existing) {
      // 同步 URL 类字段到当前 APP_URL：避免本地/线上切换后 Casdoor 库里残留
      // 旧域名的 redirectUris 导致回调校验失败（典型表现：登录跳转到远程域名）
      const desiredRedirect = `${C.appUrl}/auth/callback`;
      // 检测 signupItems 里 Email / Display name 是否仍 required（若仍 true 就同步）
      const items = existing.signupItems || [];
      const stillRequiresEmail = items.some(i => i.name === 'Email' && i.required);
      const stillRequiresDisplayName = items.some(i => i.name === 'Display name' && i.required);
      const needSync =
        !(existing.redirectUris || []).includes(desiredRedirect) ||
        existing.homepageUrl !== C.appUrl ||
        existing.logoutUrl !== `${C.appUrl}/logout` ||
        existing.redirectUrl !== C.appUrl ||
        stillRequiresEmail ||
        stillRequiresDisplayName;
      if (needSync) {
        existing.redirectUris = [desiredRedirect];
        existing.homepageUrl = C.appUrl;
        existing.logoutUrl = `${C.appUrl}/logout`;
        existing.redirectUrl = C.appUrl;
        // 只翻转 Email / Display name 的 required 为 false，保留 Casdoor 的其他默认项
        // （Confirm password / Agreement / Tag 等）不被覆盖
        existing.signupItems = (existing.signupItems || []).map(i =>
          (i.name === 'Email' || i.name === 'Display name') ? { ...i, required: false } : i
        );
        // Casdoor update-application 端点要从 id 解析 owner/name，
        // listApplications 返回的对象 id 可能为空，显式补上
        existing.id = `${C.organization}/${C.application}`;
        await casdoor.updateApplication(existing);
        LOG(`应用 "${C.application}" URL + signupItems 已同步到当前配置`);
      } else {
        LOG(`应用 "${C.application}" 已存在`);
      }
      return existing;
  }

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
    // Casdoor 当前镜像要求 scopes 是对象数组（ScopeItem），不是字符串数组。
    // 旧格式 ['profile','email'] 会让 add-application 返回 status:'error' 并被
    // 静默吞掉，导致 d5st-app 实际未创建、OAuth 报"无效的ClientId"。
    scopes: [{ name: 'profile' }, { name: 'email' }, { name: 'offline_access' }],
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
    // 注册表单必填：Email / Display name 非必填（参见顶部 SIGNUP_ITEMS 常量）
    signupItems: SIGNUP_ITEMS,
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
    // 容错：Duplicate entry 说明应用实际已存在，视为成功
    if (/Duplicate entry/i.test(err.message)) {
      LOG(`应用 "${C.application}" 已存在（Duplicate，忽略）`);
      return null;
    }
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
    // 容错：Duplicate entry 说明 webhook 实际已存在（通常是 getWebhook
    // 端点参数不匹配导致没检测到，重复触发 add-webhook 撞主键）。
    // 视为成功，避免 init 中止。
    if (/Duplicate entry/i.test(err.message)) {
      LOG(`Webhook "${name}" 已存在（Duplicate，忽略）`);
      return null;
    }
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
