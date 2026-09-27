// ============================================================
// Casdoor 完整 SDK —— 覆盖 OAuth2/OIDC + Admin API 全套
// 参考：https://casdoor.org/docs/app/quickstart/backend
// ============================================================
const axios = require('axios');

const C = {
  endpoint: (process.env.CASDOOR_ENDPOINT || 'http://localhost:8000').replace(/\/$/, ''),
  // 公网可达的 Casdoor 地址：OAuth authorize URL 会跳给用户浏览器，
  // 必须用浏览器能访问的地址；容器内网地址（如 d5st-casdoor）在这里不可用。
  publicEndpoint: (process.env.CASDOOR_PUBLIC_ENDPOINT || process.env.CASDOOR_ENDPOINT || 'http://localhost:8000').replace(/\/$/, ''),
  clientId: process.env.CASDOOR_CLIENT_ID || 'd5st_client',
  clientSecret: process.env.CASDOOR_CLIENT_SECRET || 'd5st_client_secret_2026',
  organization: process.env.CASDOOR_ORGANIZATION || 'd5st',
  application: process.env.CASDOOR_APPLICATION || 'd5st-app',
  appUrl: (process.env.APP_URL || 'http://localhost:35555').replace(/\/$/, ''),
  adminUser: process.env.CASDOOR_ADMIN_USER || 'admin',
  adminPassword: process.env.CASDOOR_ADMIN_PASSWORD || '123',
  webhookSecret: process.env.CASDOOR_WEBHOOK_SECRET || 'd5st_webhook_secret_2026'
};

// =================== 基础：管理员会话 ===================
// 新版 Casdoor 的 /api/login 返回的是会话 cookie（casdoor_session_id），
// 而不是 JWT；admin API 用该 cookie 鉴权。这里做一次登录并缓存 cookie，
// 避免每次 admin 调用都重新登录。
let _adminCookie = null;
let _adminCookieAt = 0;
const ADMIN_SESSION_TTL = 50 * 60 * 1000; // 略小于 Casdoor 默认会话时长

async function getAdminCookie(force = false) {
  if (!force && _adminCookie && Date.now() - _adminCookieAt < ADMIN_SESSION_TTL) {
    return _adminCookie;
  }
  try {
    const resp = await axios.post(`${C.endpoint}/api/login`, {
      username: C.adminUser,
      password: C.adminPassword,
      // 新版 Casdoor 需要显式 type=login，否则返回 "unknown response type"
      type: 'login',
      organization: 'built-in',
      application: 'app-built-in'
    }, { timeout: 10000 });
    const data = resp.data;
    if (!data || data.status !== 'ok') {
      throw new Error(`Casdoor 登录失败: ${data?.msg || 'unknown'}`);
    }
    const setCookies = resp.headers['set-cookie'] || [];
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('Casdoor 登录未返回会话 cookie');
    _adminCookie = cookie;
    _adminCookieAt = Date.now();
    return cookie;
  } catch (err) {
    _adminCookie = null;
    console.error('[Casdoor] 获取管理员会话失败:', err.message);
    throw err;
  }
}

// 兼容旧调用方：返回会话 cookie（不是 JWT）
const getAdminToken = getAdminCookie;

// =================== 底层：admin 通用请求 ===================
async function admin(action, params = {}) {
  const cookie = await getAdminCookie();
  const qs = new URLSearchParams(params).toString();
  const url = `${C.endpoint}/api/${action}${qs ? '?' + qs : ''}`;
  const { data } = await axios.get(url, {
    headers: { 'Cookie': cookie },
    timeout: 15000
  });
  // Casdoor 语义：status==='ok' 成功，'error' 失败。旧逻辑只看 falsy，
  // 会把 status:'error'（truthy）误判为成功并返回 null，掩盖所有真实错误。
  if (data.status !== 'ok') throw new Error(`Casdoor ${action} 失败: ${data.msg || JSON.stringify(data).slice(0, 200)}`);
  return data.data;
}

async function adminPost(action, body = {}, query = {}) {
  const cookie = await getAdminCookie();
  const qs = new URLSearchParams(query).toString();
  const url = qs ? `${C.endpoint}/api/${action}?${qs}` : `${C.endpoint}/api/${action}`;
  const { data } = await axios.post(url, body, {
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  // Casdoor 语义：status==='ok' 成功，'error' 失败（status 本身 truthy 也表示失败）
  if (data.status !== 'ok') throw new Error(`Casdoor ${action} 失败: ${data.msg || JSON.stringify(data).slice(0, 200)}`);
  return data.data;
}

// =================== OAuth2/OIDC 授权码流 ===================
function getAuthUrl(extra = {}) {
  const redirectUri = encodeURIComponent(`${C.appUrl}/auth/callback`);
  // Casdoor 的 scope 必须在 d5st-app 的 scopes 字段里登记。旧代码把
    // `${C.organization}:${C.application}`（"d5st:d5st-app"，其实是 app 自身标识）
    // 当作 scope 拼进去，不在 allowed 列表，导致 authorize 返回 Invalid scope。
    const scope = encodeURIComponent(`profile email offline_access`);
  // state 必须原样使用：调用方（/auth/login 等）已把它存入 session 做 CSRF 校验，
  // 若在这里追加 '-时间戳'，回调拿到的 state 与 session 不一致，必然报 csrf_failed
  // （此前真实 OAuth 登录一直失败的根因）
  const state = extra.state || Math.random().toString(36).slice(2);
  return `${C.publicEndpoint}/login/oauth/authorize` +
    `?client_id=${C.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scope}` +
    `&state=${state}` +
    `&prompt=${extra.prompt || 'consent'}`;
}

// token 端点用 beego 的 Input().Get() 取参，只解析 query 和 form-urlencoded
// body，不解析 JSON —— 用 JSON 会被当成空参数而报 400
const FORM = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 };

async function getToken(code, redirectUri) {
  const { data } = await axios.post(
    `${C.endpoint}/api/login/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: C.clientId,
      client_secret: C.clientSecret,
      redirect_uri: redirectUri || `${C.appUrl}/auth/callback`
    }),
    FORM
  );
  return data;
}

async function refreshToken(refreshTokenValue) {
  const { data } = await axios.post(
    `${C.endpoint}/api/login/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id: C.clientId,
      client_secret: C.clientSecret,
      redirect_uri: `${C.appUrl}/auth/callback`
    }),
    FORM
  );
  return data;
}

async function getUserInfo(accessToken) {
  const { data } = await axios.get(`${C.endpoint}/api/get-account`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    timeout: 10000
  });
  // /api/get-account 返回包装结构 {status, sub, name, data: <user>}，
  // 真正的用户对象（含 id/name/displayName 等）在 data.data 里
  if (data && data.data && typeof data.data === 'object' && data.data.id) {
    return data.data;
  }
  return data;
}

async function verifyToken(token) {
  try {
    const { data } = await axios.get(`${C.endpoint}/api/validate-token`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 5000
    });
    return data;
  } catch (err) {
    return null;
  }
}

async function revokeToken(accessToken) {
  try {
    await axios.post(`${C.endpoint}/api/login/oauth/revoke`, {
      token: accessToken,
      token_type_hint: 'access_token'
    }, { timeout: 5000 });
    return true;
  } catch (err) {
    return false;
  }
}

async function userLogout(accessToken) {
  try {
    await axios.post(`${C.endpoint}/api/logout`, {}, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 5000
    });
    return true;
  } catch (err) {
    return false;
  }
}

// =================== 组织 / 应用 / 组 ===================
async function getOrganization(name) {
  return admin('get-organization', { organization: name });
}

async function createOrganization(org) {
  return adminPost('add-organization', org);
}

async function updateOrganization(org) {
  return adminPost('update-organization', org);
}

async function listOrganizations() {
  // Casdoor 的列表端点统一用 get-* 复数（org 用 get-organizations），
  // 旧名 list-* 在当前镜像里 404
  return admin('get-organizations', { limit: 100 });
}

async function getApplication(org, app) {
  // Casdoor 的 get-application 端点期望 id 参数（格式 owner/name），
  // 用 organization+application 会让 Casdoor 解析 ID 失败报
  // "GetOwnerAndNameFromId() error, wrong token count for ID:"
  return admin('get-application', { id: `${org}/${app}` });
}

async function createApplication(app) {
  return adminPost('add-application', app);
}

async function updateApplication(app) {
  // Casdoor update-application 端点要求 URL 带 id=owner/name 查询参数
  // （与 get-application 一样），仅靠 body 里的 owner/name 会让 Casdoor 解析 ID 失败
  // 报 "GetOwnerAndNameFromId() error, wrong token count for ID:"
  if (app.id) {
    return adminPost('update-application', app, { id: app.id });
  }
  return adminPost('update-application', app);
}

async function listApplications(org) {
  // Casdoor 列表端点：get-applications，参数 owner（不是 organization）
  return admin('get-applications', { owner: org, limit: 100 });
}

// =================== 用户组（角色/权限映射） ===================
// 注意：新版 Casdoor（:latest）已将用户组端点从 add-user-group / get-user-group /
// list-user-groups 更名为 add-group / get-group / get-groups。
// GET 约定用 id 参数（格式 owner/name），而非旧的 organization + userGroup。
async function getUserGroup(org, group) {
  return admin('get-group', { id: `${org}/${group}` });
}

async function createUserGroup(group) {
  return adminPost('add-group', group);
}

async function listUserGroups(org) {
  // Casdoor 用户组列表端点：get-groups（注释原写的 list-groups 在当前镜像里也 404）
  return admin('get-groups', { owner: org, limit: 100 });
}

// =================== 权限定义 ===================
async function getPermission(org, permission) {
  return admin('get-permission', { organization: org, permission });
}

async function createPermission(p) {
  return adminPost('add-permission', p);
}

// =================== 用户 CRUD ===================
// 注意：新版 Casdoor（:latest）里 get-user 必须用 id 参数（格式 owner/name），
// 传 organization + user 会返回 status=ok 但 data=null，导致「用户明明存在却读不到」。
async function getUser(org, name) {
  return admin('get-user', { id: `${org}/${name}` });
}

async function createUser(user) {
  return adminPost('add-user', user);
}

// 同 get-user：更新也必须显式带 id=owner/name，否则报 Unauthorized operation。
// 注意不能用 user.id —— 那是 UUID 主键，Casdoor 的 GetOwnerAndNameFromId 解析不了。
async function updateUser(user) {
  return adminPost('update-user', user, { id: `${user.owner}/${user.name}` });
}

async function deleteUser(org, name) {
  return adminPost('delete-user', { organization: org, user: name });
}

// 同上：端点已由 list-users 更名为 get-users，参数用 owner 而非 organization
async function listUsers(org, limit = 100, offset = 0) {
  return admin('get-users', { owner: org, limit, offset });
}

async function setPassword(org, name, password, oldPassword = '') {
  return adminPost('set-password', {
    organization: org,
    name,
    password,
    oldPassword,
    change: false
  });
}

// 触发密码重置邮件/短信 —— 官方接口 /api/send-verification-code
// type: reset_password | signup | login | verify_email | verify_phone
async function sendVerificationCode(org, type, email, name) {
  const body = {
    type,
    organization: org,
    application: C.application
  };
  if (email) body.email = email;
  if (name) body.name = name;
  return adminPost('send-verification-code', body);
}

// 用管理员权限直接重置密码（跳过旧密码校验）
async function adminResetPassword(org, name, newPassword) {
  try {
    const user = await getUser(org, name);
    if (!user) throw new Error('用户不存在');
    user.password = newPassword;
    return await updateUser(user);
  } catch (err) {
    console.error('[Casdoor] adminResetPassword 失败:', err.message);
    throw err;
  }
}

// =================== Webhook 管理 ===================
async function getWebhook(org, name) {
  return admin('get-webhook', { organization: org, webhook: name });
}

async function createWebhook(webhook) {
  return adminPost('add-webhook', webhook);
}

async function updateWebhook(webhook) {
  return adminPost('update-webhook', webhook);
}

async function listWebhooks(org) {
  return admin('get-webhooks', { owner: org, limit: 100 });
}

// =================== 认证事件 & 日志 ===================
async function logEvent(event) {
  // event: { organization, application, type, user, message, requestUri, userAgent, ip }
  return adminPost('add-event', event);
}

async function listAuthLogs(org, app, limit = 100) {
  return admin('list-auth-logs', { organization: org, application: app, limit });
}

// =================== Webhook 签名校验 ===================
// Casdoor webhook 请求带 X-Casdoor-Signature = HMAC-SHA256(body, secret)
const crypto = require('crypto');
function verifyWebhookSignature(rawBody, signature, secret = C.webhookSecret) {
  if (!signature) return false;
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch (err) {
    return false;
  }
}

// =================== 健康检查 ===================
function isAvailable() {
  return axios.get(`${C.endpoint}/health`, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
}

module.exports = {
  C,
  // OAuth
  getAuthUrl,
  getToken,
  refreshToken,
  getUserInfo,
  verifyToken,
  revokeToken,
  userLogout,
  // 组织
  getOrganization, createOrganization, updateOrganization, listOrganizations,
  // 应用
  getApplication, createApplication, updateApplication, listApplications,
  // 用户组
  getUserGroup, createUserGroup, listUserGroups,
  // 权限
  getPermission, createPermission,
  // 用户
  getUser, createUser, updateUser, deleteUser, listUsers,
  setPassword, sendVerificationCode, adminResetPassword,
  // Webhook
  getWebhook, createWebhook, updateWebhook, listWebhooks,
  verifyWebhookSignature,
  // 事件
  logEvent, listAuthLogs,
  // 工具
  isAvailable, getAdminToken
};
