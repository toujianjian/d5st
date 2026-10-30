const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../../配置/db');
const { rateLimit, cleanShort } = require('../../配置/security');

// 保密号用密码学安全随机数生成。
// 原实现用 Math.random()，其输出可被预测（V8 的 xorshift128+ 在拿到少量样本后
// 可反推内部状态），等于给「猜别人保密号」留了口子。这里改用 crypto.randomInt。
// 字符集去掉易混淆的 I / O / 0 / 1。
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateSecretCode() {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_CHARS.charAt(crypto.randomInt(0, CODE_CHARS.length));
  }
  return code;
}

router.get('/', async (req, res) => {
  try {
    let secrets = [];
    if (req.session.user) {
      [secrets] = await pool.query('SELECT * FROM user_secrets WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
    }
    res.render('secret/index', { title: '保密号中心', secrets, user: req.session.user });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 限流：保密号是「重新生成」语义，正常用户不会一秒点十次
router.post('/generate', rateLimit({ name: 'secret-gen', window: 60 * 1000, max: 10, keyBy: 'user' }), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  try {
    const code = generateSecretCode();
    // user_id 上有唯一键（一个用户一个保密号），用 upsert 让「重新生成」幂等。
    // 注意方言：MySQL 是 ON DUPLICATE KEY UPDATE，SQLite 是 ON CONFLICT。
    // 原实现只有 MySQL 语法，本地 SQLite 模式下必然 500（near "DUPLICATE"）。
    await pool.query(
      pool.isMysql
        ? `INSERT INTO user_secrets (user_id, secret_code) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE secret_code = VALUES(secret_code), created_at = CURRENT_TIMESTAMP`
        : `INSERT INTO user_secrets (user_id, secret_code) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET secret_code = excluded.secret_code, created_at = datetime('now','localtime')`,
      [req.session.user.id, code]
    );
    res.json({ success: true, code });
  } catch (err) {
    console.error('生成保密号失败:', err);
    res.status(500).json({ error: '生成失败' });
  }
});

router.get('/show', async (req, res) => {
  // 限制长度并统一大写，避免超长字符串打到数据库
  const code = cleanShort(req.query.code, 32).toUpperCase();
  try {
    const [users] = await pool.query(
      `SELECT cu.id, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.nickname, cu.avatar, us.secret_code, us.created_at
       FROM user_secrets us JOIN casdoor_users cu ON us.user_id = cu.id
       WHERE us.secret_code = ?`,
      [code]
    );
    if (users.length === 0) {
      return res.render('secret/show', { title: '查询保密号', user: null, code });
    }
    res.render('secret/show', { title: '查询保密号', user: users[0], code });
  } catch (err) {
    res.status(500).render('errors/500', { title: '查询失败' });
  }
});

module.exports = router;
