// ============================================================
// Casdoor 完整 SDK —— 覆盖 OAuth2/OIDC + Admin API 全套
// 参考：https://casdoor.org/docs/app/quickstart/backend
// ============================================================
const axios = require('axios');

const C = {
  endpoint: (process.env.CASDOOR_ENDPOINT || 'http://localhost:8000').replace(/\/$/, ''),
  clientId: process.env.CASDOOR_CLIENT_ID || 'd5st_client',
  clientSecret: process.env.CASDOOR_CLIENT_SECRET || 'd5st_client_secret_2026',
  organization: process.env.CASDOOR_ORGANIZATION || 'd5st',
  application: process.env.CASDOOR_APPLICATION || 'd5st-app',
  appUrl: (process.env.APP_URL || 'http://localhost:35555').replace(/\/$/, ''),
  adminUser: process.env.CASDOOR_ADMIN_USER || 'admin',
  adminPassword: process.env.CASDOOR_ADMIN_PASSWORD || 'd5st_admin_2026',
  webhookSecret: process.env.CASDOOR_WEBHOOK_SECRET || 'd5st_webhook_secret_2026'
};

// =================== 基础：管理员 token ===================
// 每次调用 admin API 都拿最新 token，避免过期
async function getAdminToken() {
  try {
    const { data } = await axios.post(`${C.endpoint}/api/login`, {
      username: C.adminUser,
      password: C.adminPassword,
      organizationName: 'built-in',
      applicationName: 'app-built-in'
    }, { timeout: 10000 });
    if (!data || !data.status || !data.data) {
      throw new Error(`Casdoor 登录失败: ${data?.msg || 'unknown'}`);
    }
    return data.data; // jwt string
  } catch (err) {
    console.error('[Casdoor] 获取管理员 token 失败:', err.message);
    throw err;
  }
}

// =================== 底层：admin 通用请求 ===================
async function admin(action, params = {}) {
  const token = await getAdminToken();
  const qs = new URLSearchParams(params).toString();
  const url = `${C.endpoint}/api/${action}${qs ? '?' + qs : ''}`;
  const { data } = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    timeout: 15000
  });
  if (!data.status) throw new Error(`Casdoor ${action} 失败: ${data.msg}`);
  return data.data;
}

async function adminPost(action, body = {}) {
  const token = await getAdminToken();
  const { data } = await axios.post(`${C.endpoint}/api/${action}`, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  if (!data.status) throw new Error(`Casdoor ${action} 失败: ${data.msg}`);
  return data.data;
}

// =================== OAuth2/OIDC 授权码流 ===================
function getAuthUrl(extra = {}) {
  const redirectUri = encodeURIComponent(`${C.appUrl}/auth/callback`);
  const scope = encodeURIComponent(
    `profile email offline_access ${C.organization}:${C.application}`
  );
  const state = (extra.state || Math.random().toString(36).slice(2)) + '-' + Date.now();
  return `${C.endpoint}/login/oauth/authorize` +
    `?client_id=${C.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scope}` +
    `&state=${state}` +
    `&prompt=${extra.prompt || 'consent'}`;
}

async function getToken(code, redirectUri) {
  const { data } = await axios.post(
    `${C.endpoint}/api/login/oauth/access_token`,
    {
      grant_type: 'authorization_code',
      code,
      client_id: C.clientId,
      client_secret: C.clientSecret,
      redirect_uri: redirectUri || `${C.appUrl}/auth/callback`
    },
    { timeout: 10000 }
  );
  return data;
}

async function refreshToken(refreshTokenValue) {
  const { data } = await axios.post(
    `${C.endpoint}/api/login/oauth/access_token`,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id: C.clientId,
      client_secret: C.clientSecret,
      redirect_uri: `${C.appUrl}/auth/callback`
    },
    { timeout: 10000 }
  );
  return data;
}

async function getUserInfo(accessToken) {
  const { data } = await axios.get(`${C.endpoint}/api/get-account`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    timeout: 10000
  });
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
  return admin('list-organizations', { limit: 100 });
}

async function getApplication(org, app) {
  return admin('get-application', { organization: org, application: app });
}

async function createApplication(app) {
  return adminPost('add-application', app);
}

async function updateApplication(app) {
  return adminPost('update-application', app);
}

async function listApplications(org) {
  return admin('list-applications', { organization: org, limit: 100 });
}

// =================== 用户组（角色/权限映射） ===================
async function getUserGroup(org, group) {
  return admin('get-user-group', { organization: org, userGroup: group });
}

async function createUserGroup(group) {
  return adminPost('add-user-group', group);
}

async function listUserGroups(org) {
  return admin('list-user-groups', { organization: org, limit: 100 });
}

// =================== 权限定义 ===================
async function getPermission(org, permission) {
  return admin('get-permission', { organization: org, permission });
}

async function createPermission(p) {
  return adminPost('add-permission', p);
}

// =================== 用户 CRUD ===================
async function getUser(org, name) {
  return admin('get-user', { organization: org, user: name });
}

async function createUser(user) {
  return adminPost('add-user', user);
}

async function updateUser(user) {
  return adminPost('update-user', user);
}

async function deleteUser(org, name) {
  return adminPost('delete-user', { organization: org, user: name });
}

async function listUsers(org, limit = 100, offset = 0) {
  return admin('list-users', { organization: org, limit, offset });
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
  return admin('list-webhooks', { organization: org, limit: 100 });
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
