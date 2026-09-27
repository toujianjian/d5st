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
    // 注意：此镜像版本的 Casdoor 里 organization 行的 owner 固定为 'admin'
    // （built-in 组织也是 owner=admin）。写 'built-in' 会导致 add-user 等
    // API 校验 getOrganization('admin', owner) 时报 "organization does not exist"
    owner: 'admin',
    name: C.organization,
    displayName: 'D5ST 校园社区',
    websiteUrl: C.appUrl,
    favicon: 'https://cdn.jsdelivr.net/gh/nextgis/d5st-logo/d5st-logo.png',
    tags: ['campus', 'community'],
    // 密码策略：留空使用 Casdoor 默认值（旧代码传 passwordOptions 对象，
    // 但当前 casdoor:latest 镜像要求 passwordOptions 是 []string，
    // 会让 add-organization 返回 status:'error' 被静默吞掉）
    // 注意：Casdoor 新版本把 passwordType 字段重命名为 passwordObfuscatorType，
    // 旧字段名会被静默忽略，导致前端 React 包加载时校验失败
    // （错误："passwordObfuscatorType should not be undefined"）
    // 登录校验只支持具体算法名，'Default' 会报 "unsupported password type"
    passwordType: 'bcrypt',
    passwordObfuscatorType: 'Plain',
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
  // 注意：该镜像里 application 行的 owner 固定为 'admin'（与 organization 一致，
  // 见下方 update 分支的说明）。若这里传 C.organization（'d5st'）会永远查不到，
  // 导致每次启动都重复「创建」应用、且后续读取恒为空。
  let existing = null;
  try {
    existing = await casdoor.getApplication('admin', C.application);
  } catch (e) { /* ignore */ }
  if (!existing) {
    try {
      // list-applications 需按 owner 过滤，同样用 'admin'
      const apps = await casdoor.listApplications('admin');
      existing = (apps || []).find(a => a.name === C.application) || null;
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
        // owner 固定 'admin'（见上方 create 分支说明）
        existing.id = `admin/${C.application}`;
        await casdoor.updateApplication(existing);
        LOG(`应用 "${C.application}" URL + signupItems 已同步到当前配置`);
      } else {
        LOG(`应用 "${C.application}" 已存在`);
      }
      return existing;
  }

  LOG(`创建应用 "${C.application}" ...`);
  const app = {
    // 此镜像版本约定：application 是全局资源，owner 固定 'admin'，
    // 通过 organization 字段关联组织（同 app-built-in 的存储方式）
    owner: 'admin',
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
    // 字段名必须是 expireInHours / refreshExpireInHours：
    // 旧写法 tokenExpireInHours 不被当前镜像识别，会存成 NULL → token 立即过期
    expireInHours: 24,
    refreshExpireInHours: 168,
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

// 默认管理员账号/密码：在 d5st 组织下创建本地管理员。
// 没有 d5st 组织用户时，d5st-app 的登录页（默认登 d5st 组织）输入 built-in 的
// admin 会因为查无此人而静默失败——这是之前 OAuth 登录卡住的真正原因。
//
// 账号密码可用环境变量覆盖（DEFAULT_ADMIN_USER / DEFAULT_ADMIN_PASSWORD），
// 未配置时用下列默认值。生产环境请务必改掉默认密码。
const ADMIN_NAME = process.env.DEFAULT_ADMIN_USER || 'd5stadmin';
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'd5stpassword';
// 必须加入该组，本站 user-service 才认其为管理员（isAdminFromCasdoor）
const ADMIN_GROUP = 'd5st-admin';

// get-user 端点在本镜像里不稳定（新建用户后立刻查询常返回 null），
// 统一走这里：先 get-user，取不到再用 list-users 兜底。
async function findUser(org, name) {
  try {
    const u = await casdoor.getUser(org, name);
    if (u) return u;
  } catch (e) { /* 回退 list-users */ }
  try {
    const users = await casdoor.listUsers(org);
    return (users || []).find(u => u.name === name) || null;
  } catch (e) {
    return null;
  }
}

async function ensureAdminUser() {
  const name = ADMIN_NAME;
  const existing = await findUser(C.organization, name);

  if (existing) {
    LOG(`用户 "${C.organization}/${name}" 已存在，同步密码与管理员组`);
  } else {
    try {
      await casdoor.createUser({
        owner: C.organization,
        name,
        displayName: '系统管理员',
        type: 'normal-user',
        password: ADMIN_PASSWORD,
        email: `${name}@d5st.local`,
        signupApplication: C.application,
        isForbidden: false,
        isDeleted: false
      });
      LOG(`用户 "${C.organization}/${name}" 创建成功`);
    } catch (err) {
      if (!/Duplicate entry|already exists/i.test(err.message)) {
        ERR(`创建用户失败: ${err.message}`);
        throw err;
      }
      LOG(`用户 "${C.organization}/${name}" 已存在（Duplicate，忽略）`);
    }
  }

  // add-user 会把 password 字段原样入库（不哈希），这里用 bcrypt 预哈希后
  // 再 update，保证登录校验（bcrypt 比对）可以通过。
  try {
    const bcrypt = require('bcryptjs');
    // 刚创建的用户可能尚未可读，重试几次再放弃
    let user = null;
    for (let i = 0; i < 5 && !user; i++) {
      // eslint-disable-next-line no-await-in-loop
      user = await findUser(C.organization, name);
      if (!user) await new Promise(r => setTimeout(r, 500));
    }
    if (!user) {
      ERR(`用户 "${C.organization}/${name}" 读取失败，无法写入密码`);
    } else {
      user.password = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      await casdoor.updateUser(user);
      LOG(`用户 "${C.organization}/${name}" 密码已写入`);
    }
  } catch (e) {
    ERR(`写入密码失败: ${e.message}`);
  }

  // 组关系不走 API：当前 Casdoor 版本里 update-user 改 groups 会返回
  // "Unauthorized operation"（字段级权限校验拦掉了，只改 password 却可以）。
  // 直接更新 casdoor.user.groups 是可行的——写库后 Casdoor 的 get-user / userinfo
  // 都能正确回读该组，本站据此授予管理员权限。
  try {
    const pool = require('./db');
    await pool.query(
      'UPDATE casdoor.user SET `groups` = ? WHERE owner = ? AND name = ?',
      [JSON.stringify([ADMIN_GROUP]), C.organization, name]
    );
    LOG(`用户 "${C.organization}/${name}" 已加入组 "${ADMIN_GROUP}"`);
  } catch (e) {
    ERR(`写入管理员组失败: ${e.message}`);
  }

  const finalUser = await findUser(C.organization, name);

  // 历史遗留：早期版本在此组织下创建过 username='admin' 的账号，
  // 与新的默认管理员并存会造成困惑，这里做一次性清理。
  // 注意 built-in 组织的 admin 是 Casdoor 自身管理员，绝不能动。
  try {
    const pool = require('./db');
    if (name !== 'admin') {
      const [delMap] = await pool.query(
        "DELETE FROM casdoor_users WHERE username = 'admin'"
      );
      if (delMap.affectedRows > 0) LOG(`已清理本站映射表中的旧账号 "admin"`);
      await casdoor.deleteUser(C.organization, 'admin').catch(() => {});
      const [delCas] = await pool.query(
        'DELETE FROM casdoor.user WHERE owner = ? AND name = ?',
        [C.organization, 'admin']
      );
      if (delCas.affectedRows > 0) LOG(`已清理 Casdoor 中的旧账号 "${C.organization}/admin"`);
    }
    // 把映射表的占位 id 换成真实 Casdoor id，便于后续按 id 精确匹配
    if (finalUser) {
      await pool.query(
        'UPDATE casdoor_users SET casdoor_user_id = ? WHERE username = ? AND casdoor_user_id = ?',
        [String(finalUser.id), name, 'd5st_admin_seed']
      );
    }
  } catch (e) {
    ERR(`清理旧账号失败: ${e.message}`);
  }

  return finalUser;
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
    await ensureAdminUser();
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
