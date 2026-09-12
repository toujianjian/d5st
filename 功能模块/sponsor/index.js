const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

router.get('/', (req, res) => {
  res.render('sponsor/index', { title: '赞助支持' });
});

router.post('/', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0 || amount > 10000) {
    return res.status(400).render('sponsor/index', { title: '赞助支持', error: '金额无效' });
  }
  const points = Math.floor(amount * 100);
  try {
    await pool.query('INSERT INTO sponsor_transactions (user_id, amount_yuan, points_added) VALUES (?, ?, ?)', [req.session.user.id, amount, points]);
    await pool.query('UPDATE casdoor_users SET points = points + ? WHERE id = ?', [points, req.session.user.id]);
    res.render('sponsor/done', { title: '赞助成功', amount, points });
  } catch (err) {
    res.status(500).render('sponsor/index', { title: '赞助支持', error: '处理失败' });
  }
});

module.exports = router;
