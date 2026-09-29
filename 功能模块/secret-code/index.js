const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

function generateSecretCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
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

router.post('/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  try {
    const code = generateSecretCode();
    // 表上有 UNIQUE KEY (user_id)，一个用户只允许一个保密号。
    // 用 upsert 让「重新生成」幂等，避免第二次生成撞唯一键后直接 500。
    await pool.query(
      `INSERT INTO user_secrets (user_id, secret_code) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE secret_code = VALUES(secret_code), created_at = CURRENT_TIMESTAMP`,
      [req.session.user.id, code]
    );
    res.json({ success: true, code });
  } catch (err) {
    console.error('生成保密号失败:', err);
    res.status(500).json({ error: '生成失败' });
  }
});

router.get('/show', async (req, res) => {
  const code = req.query.code || '';
  try {
    const [users] = await pool.query(
      `SELECT cu.id, cu.username, cu.real_name, cu.nickname, cu.avatar, us.secret_code, us.created_at
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
