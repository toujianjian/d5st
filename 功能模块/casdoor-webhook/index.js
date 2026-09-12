// ============================================================
// Casdoor Webhook 接收器
// 处理 Casdoor 认证事件回推：User login / signup / update / delete / logout
// 签名校验：X-Casdoor-Signature = HMAC-SHA256(rawBody, secret)
// 参考：https://casdoor.org/docs/provider/webhook
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const casdoor = require('../../配置/casdoor');
const userService = require('../../配置/user-service');

const WEBHOOK_SECRET = process.env.CASDOOR_WEBHOOK_SECRET || 'd5st_webhook_secret_2026';

// 事件类型 → 本地处理
async function handleEvent(event) {
  const type = event.type;
  const casdoorUser = event.data; // Casdoor 侧的 user 对象
  if (!casdoorUser || !casdoorUser.name) return;

  switch (type) {
    case 'User login': {
      await userService.findOrCreateCasdoorUser(casdoorUser);
      console.log(`[Casdoor Webhook] 用户登录: ${casdoorUser.name}`);
      break;
    }
    case 'User signup': {
      await userService.findOrCreateCasdoorUser(casdoorUser);
      console.log(`[Casdoor Webhook] 新用户注册: ${casdoorUser.name}`);
      break;
    }
    case 'User update': {
      await userService.findOrCreateCasdoorUser(casdoorUser);
      console.log(`[Casdoor Webhook] 用户更新: ${casdoorUser.name}`);
      break;
    }
    case 'User delete': {
      const local = await userService.getUserByCasdoorId(casdoorUser.id || casdoorUser.name);
      if (local) {
        await userService.disableLocalUser(casdoorUser.id || casdoorUser.name);
        console.log(`[Casdoor Webhook] 用户禁用: ${casdoorUser.name}`);
      }
      break;
    }
    case 'User logout': {
      // 仅记录，本地 session 由前端销毁
      console.log(`[Casdoor Webhook] 用户登出: ${casdoorUser.name}`);
      break;
    }
    default:
      console.log(`[Casdoor Webhook] 未处理事件类型: ${type}`);
  }
}

// 主入口 —— 接收 Casdoor POST
// 需要解析 raw body 才能校验签名，这里单独走 express.raw
router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['x-casdoor-signature'];

  // 1. 签名校验
  if (!signature) {
    return res.status(401).json({ status: 'error', msg: 'missing signature' });
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const valid = sigBuf.length === expBuf.length &&
    crypto.timingSafeEqual(sigBuf, expBuf);
  if (!valid) {
    console.warn('[Casdoor Webhook] 签名校验失败');
    return res.status(401).json({ status: 'error', msg: 'invalid signature' });
  }

  // 2. 解析事件
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf-8'));
  } catch (err) {
    return res.status(400).json({ status: 'error', msg: 'invalid json' });
  }

  // 3. 处理
  try {
    await handleEvent(event);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Casdoor Webhook] 处理失败:', err.message);
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

// 供管理后台查询最近的认证日志
router.get('/events', async (req, res) => {
  try {
    const logs = await casdoor.listAuthLogs(
      casdoor.C.organization,
      casdoor.C.application,
      50
    );
    res.json(logs || []);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
