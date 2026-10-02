const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

// 赞助入口开关：system_settings.sponsor_enabled（0 或缺失 = 暂停）
async function isSponsorEnabled() {
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'sponsor_enabled' LIMIT 1"
    );
    return rows.length > 0 && String(rows[0].setting_value) === '1';
  } catch (e) {
    return false;
  }
}

router.get('/', async (req, res) => {
  const enabled = await isSponsorEnabled();
  let sponsors = [];
  try {
    const [rows] = await pool.query(
      `SELECT cu.real_name, cu.username, SUM(st.amount_yuan) as amount
       FROM sponsor_transactions st
       JOIN casdoor_users cu ON st.user_id = cu.id
       WHERE st.status = 'success'
       GROUP BY st.user_id
       ORDER BY amount DESC LIMIT 12`
    );
    sponsors = rows;
  } catch (e) { /* 表可能不存在，忽略 */ }
  res.render('sponsor/index', { title: '赞助支持', enabled, sponsors });
});

router.post('/', async (req, res) => {
  const enabled = await isSponsorEnabled();
  if (!enabled) {
    return res.status(403).render('sponsor/index', {
      title: '赞助支持', enabled: false, sponsors: [], error: '赞助功能暂停中'
    });
  }
  if (!req.session.user) return res.redirect('/login');
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0 || amount > 10000) {
    return res.status(400).render('sponsor/index', { title: '赞助支持', enabled: true, sponsors: [], error: '金额无效' });
  }
  const points = Math.floor(amount * 100);
  try {
    await pool.query('INSERT INTO sponsor_transactions (user_id, amount_yuan, points_added) VALUES (?, ?, ?)', [req.session.user.id, amount, points]);
    await pool.query('UPDATE casdoor_users SET points = points + ? WHERE id = ?', [points, req.session.user.id]);
    res.render('sponsor/done', { title: '赞助成功', amount, points });
  } catch (err) {
    res.status(500).render('sponsor/index', { title: '赞助支持', enabled: true, sponsors: [], error: '处理失败' });
  }
});

module.exports = router;
