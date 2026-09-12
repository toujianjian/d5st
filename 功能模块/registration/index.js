const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const casdoor = require('../../配置/casdoor');
const userService = require('../../配置/user-service');

const LOG = (msg) => console.log(`[Auth] ${msg}`);
const ERR = (msg) => console.warn(`[Auth] ${msg}`);

// ============ 内部工具 ============

// 生成短 state（用于 CSRF 校验），存入 session
function genState() {
  return crypto.randomBytes(16).toString('hex');
}

// 记录登录事件到 Casdoor（尽力而为，不影响主流程）
async function logAuthEvent(type, username, message, req) {
  try {
    await casdoor.logEvent({
      owner: casdoor.C.organization,
      organization: casdoor.C.organization,
      application: casdoor.C.application,
      type,
      user: username || '',
      message,
      requestUri: req?.originalUrl || '',
      userAgent: req?.headers['user-agent'] || '',
      ip: req?.ip || ''
    });
  } catch (err) {
    ERR(`logEvent 失败: ${err.message}`);
  }
}

// 判断 Casdoor 用户是否为 d5st-admin 组
async function isCasdoorAdmin(casdoorUser) {
  try {
    const groups = casdoorUser.groups || casdoorUser.groupNames || [];
    return groups.includes('d5st-admin');
  } catch { return false; }
}

// ============ 路由 ============

// 登录页
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const state = genState();
  req.session.csrfState = state;
  req.session.nextUrl = req.query.next || '/';
  const authUrl = casdoor.getAuthUrl({ state });
  res.render('registration/login', {
    title: '登录 D5ST',
    authUrl,
    error: req.query.error,
    endpoint: casdoor.C.endpoint,
    nextUrl: req.session.nextUrl
  });
});

// 注册页（Casdoor 处理注册，d5st 只提供引导）
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const state = genState();
  req.session.csrfState = state;
  req.session.nextUrl = req.query.next || '/';
  const authUrl = casdoor.getAuthUrl({ state, prompt: 'consent' });
  res.render('registration/register', {
    title: '注册 D5ST',
    authUrl,
    error: req.query.error,
    endpoint: casdoor.C.endpoint
  });
});

// 找回密码 —— 邮件/短信验证码由 Casdoor 发送
router.get('/forgot-password', (req, res) => {
  res.render('registration/forgot-password', {
    title: '找回密码',
    casdoorEndpoint: casdoor.C.endpoint,
    organization: casdoor.C.organization,
    application: casdoor.C.application
  });
});

// 请求密码重置验证码（走 Casdoor send-verification-code）
router.post('/forgot-password/request', async (req, res) => {
  const { email, name } = req.body || {};
  if (!email && !name) {
    return res.status(400).json({ success: false, msg: '请提供邮箱或用户名' });
  }
  try {
    await casdoor.sendVerificationCode(
      casdoor.C.organization,
      'reset_password',
      email,
      name
    );
    await logAuthEvent('Send verification code', name || email, '发送密码重置验证码', req);
    res.json({ success: true, msg: '验证码已发送，请查收邮件/短信' });
  } catch (err) {
    ERR(`发送验证码失败: ${err.message}`);
    res.json({ success: false, msg: err.message });
  }
});

// 直接跳转 Casdoor 登录（先探活，不可达时友好提示）
router.get('/auth/login', async (req, res) => {
  const state = genState();
  req.session.csrfState = state;
  req.session.nextUrl = req.query.next || '/';

  const available = await casdoor.isAvailable();
  if (!available) {
    LOG('Casdoor 不可达，展示友好提示页');
    const allowDevLogin = process.env.ENABLE_DEV_LOGIN === '1';
    return res.render('registration/login', {
      title: '登录 D5ST',
      authUrl: casdoor.getAuthUrl({ state }),
      endpoint: casdoor.C.endpoint,
      casdoorUnavailable: true,
      allowDevLogin,
      error: null,
      nextUrl: req.session.nextUrl
    });
  }

  const authUrl = casdoor.getAuthUrl({ state });
  res.redirect(authUrl);
});

// 开发演示登录 —— 仅在 ENABLE_DEV_LOGIN=1 时可用
// 用于 Casdoor 未启动时验证前端功能（跳过 OAuth）
router.get('/auth/dev-login', async (req, res) => {
  if (process.env.ENABLE_DEV_LOGIN !== '1') {
    return res.redirect('/login?error=dev_login_disabled');
  }
  const name = (req.query.username || 'dev_user').slice(0, 30);
  const isAdmin = req.query.admin === '1' ? 1 : 0;
  const casdoorPayload = {
    id: 'dev-' + name,
    name,
    displayName: name,
    email: name + '@dev.local',
    groups: isAdmin ? ['d5st-admin'] : []
  };
  // 若本地已存在同名用户（如种子管理员 admin），直接复用该账号
  const existingByName = await userService.getUserByUsername(name).catch(() => null);
  const loginUser = existingByName || await userService.findOrCreateCasdoorUser(casdoorPayload);
  if (existingByName && isAdmin) {
    const pool = require('../../配置/db');
    await pool.query('UPDATE casdoor_users SET is_admin = 1 WHERE id = ?', [existingByName.id]);
    loginUser.is_admin = 1;
  }
  try {
    req.session.user = {
      id: loginUser.id,
      casdoor_user_id: loginUser.casdoor_user_id,
      username: loginUser.username,
      real_name: loginUser.real_name || loginUser.username,
      avatar: loginUser.avatar,
      email: loginUser.email,
      phone: loginUser.phone,
      is_admin: (loginUser.is_admin || (isAdmin ? 1 : 0)) ? 1 : 0,
      accessToken: null,
      refreshToken: null,
      tokenType: 'dev',
      tokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
      loginAt: Date.now()
    };
    LOG(`开发登录: ${name} (admin=${isAdmin})`);
    res.redirect(req.session.nextUrl || '/');
  } catch (err) {
    ERR(`开发登录失败: ${err.message}`);
    res.redirect('/login?error=dev_login_error');
  }
});

// OAuth 回调
router.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    await logAuthEvent('Auth error', null, `${error}: ${error_description}`, req);
    return res.redirect('/login?error=' + encodeURIComponent(error));
  }
  if (!code) return res.redirect('/login?error=missing_code');

  // CSRF 校验
  if (state && req.session.csrfState && state !== req.session.csrfState) {
    ERR('CSRF state 不匹配，可能遭 CSRF 攻击');
    return res.redirect('/login?error=csrf_failed');
  }

  try {
    const tokenData = await casdoor.getToken(code);
    if (!tokenData || !tokenData.access_token) {
      return res.redirect('/login?error=auth_failed');
    }

    const {
      access_token, refresh_token, expires_in, token_type
    } = tokenData;

    // 换取用户信息
    const casdoorUser = await casdoor.getUserInfo(access_token);
    if (!casdoorUser || !casdoorUser.id) {
      return res.redirect('/login?error=auth_failed');
    }

    // 判断角色
    const isAdmin = await isCasdoorAdmin(casdoorUser);

    // 同步到本地
    const localUser = await userService.findOrCreateCasdoorUser({
      ...casdoorUser,
      is_admin: isAdmin ? 1 : 0
    });

    // 写入 session
    req.session.user = {
      id: localUser.id,
      casdoor_user_id: localUser.casdoor_user_id,
      username: localUser.username,
      real_name: localUser.real_name,
      avatar: localUser.avatar,
      email: localUser.email,
      phone: localUser.phone,
      is_admin: (localUser.is_admin || (isAdmin ? 1 : 0)) ? 1 : 0,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenType: token_type,
      tokenExpiresAt: Date.now() + (expires_in || 86400) * 1000,
      loginAt: Date.now()
    };
    req.session.csrfState = null;

    await logAuthEvent('User login', localUser.username, '用户登录成功', req);
    LOG(`用户登录: ${localUser.username} (admin=${isAdmin})`);

    const nextUrl = req.session.nextUrl || '/';
    req.session.nextUrl = null;
    res.redirect(nextUrl);
  } catch (err) {
    ERR(`Casdoor 回调处理失败: ${err.message}`);
    res.redirect('/login?error=auth_error');
  }
});

// 登出 —— 先登出 Casdoor，再销毁本地 session
router.get('/logout', async (req, res) => {
  const token = req.session.user?.accessToken;
  if (token) {
    try {
      await casdoor.userLogout(token);
    } catch (err) {
      ERR(`Casdoor 登出失败: ${err.message}`);
    }
  }
  await logAuthEvent('User logout', req.session.user?.username, '用户登出', req);

  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// 刷新 token（会话保持）
router.post('/auth/refresh', async (req, res) => {
  const token = req.session.user?.refreshToken;
  if (!token) return res.json({ success: false, msg: '无 refresh token' });
  try {
    const data = await casdoor.refreshToken(token);
    req.session.user.accessToken = data.access_token;
    req.session.user.refreshToken = data.refresh_token || token;
    req.session.user.tokenExpiresAt = Date.now() + (data.expires_in || 86400) * 1000;
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

// 检查当前 token 是否仍有效（Casdoor 侧）
router.get('/auth/status', async (req, res) => {
  const token = req.session.user?.accessToken;
  if (!token) return res.json({ valid: false, msg: 'no token' });
  const verified = await casdoor.verifyToken(token);
  res.json({ valid: !!verified });
});

module.exports = router;
