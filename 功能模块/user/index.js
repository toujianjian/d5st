const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

router.get('/', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [posts] = await pool.query(
      'SELECT * FROM forum_posts WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 20',
      [userId]
    );
    const [medals] = await pool.query('SELECT * FROM user_medals WHERE user_id = ?', [userId]);
    const [secrets] = await pool.query('SELECT * FROM user_secrets WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]);
    const [transactions] = await pool.query('SELECT * FROM sponsor_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]);

    const [followers] = await pool.query('SELECT COUNT(*) as cnt FROM user_follows WHERE following_id = ?', [userId]);
    const [following] = await pool.query('SELECT COUNT(*) as cnt FROM user_follows WHERE follower_id = ?', [userId]);

    const user = req.session.user;
    res.render('user/index', {
      title: '个人中心',
      user,
      posts,
      medals,
      secrets,
      transactions,
      followerCount: followers[0].cnt || 0,
      followingCount: following[0].cnt || 0,
      isSelf: true
    });
  } catch (err) {
    console.error('个人中心加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 查看他人主页
router.get('/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) return res.status(404).render('errors/404', { title: '用户不存在' });

    const [users] = await pool.query('SELECT id, username, real_name, avatar, grade, class_name, points FROM casdoor_users WHERE id = ?', [targetId]);
    if (!users || users.length === 0) return res.status(404).render('errors/404', { title: '用户不存在' });
    const target = users[0];

    const [posts] = await pool.query(
      'SELECT * FROM forum_posts WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 20',
      [targetId]
    );

    const [followers] = await pool.query('SELECT COUNT(*) as cnt FROM user_follows WHERE following_id = ?', [targetId]);
    const [following] = await pool.query('SELECT COUNT(*) as cnt FROM user_follows WHERE follower_id = ?', [targetId]);

    let isFollowing = false;
    let isSelf = false;
    if (req.session.user) {
      isSelf = req.session.user.id === targetId;
      const [check] = await pool.query(
        'SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?',
        [req.session.user.id, targetId]
      );
      isFollowing = check && check.length > 0;
    }

    res.render('user/profile', {
      title: (target.real_name || target.username) + ' 的主页',
      user: target,
      posts,
      followerCount: followers[0].cnt || 0,
      followingCount: following[0].cnt || 0,
      isFollowing,
      isSelf
    });
  } catch (err) {
    console.error('用户主页加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 关注 / 取消关注（API）
router.post('/:id/follow', requireLogin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId) || targetId === req.session.user.id) {
    return res.status(400).json({ error: '非法操作' });
  }
  try {
    const [target] = await pool.query('SELECT id FROM casdoor_users WHERE id = ?', [targetId]);
    if (!target || target.length === 0) return res.status(404).json({ error: '用户不存在' });

    const [existing] = await pool.query(
      'SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?',
      [req.session.user.id, targetId]
    );
    if (existing.length > 0) {
      await pool.query(
        'DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?',
        [req.session.user.id, targetId]
      );
      return res.json({ following: false });
    }
    await pool.query(
      'INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?)',
      [req.session.user.id, targetId]
    );
    res.json({ following: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

// 关注列表
router.get('/following/list', requireLogin, async (req, res) => {
  try {
    const [following] = await pool.query(
      `SELECT cu.* FROM user_follows uf
       JOIN casdoor_users cu ON uf.following_id = cu.id
       WHERE uf.follower_id = ?
       ORDER BY uf.created_at DESC`,
      [req.session.user.id]
    );
    const [followers] = await pool.query(
      `SELECT cu.* FROM user_follows uf
       JOIN casdoor_users cu ON uf.follower_id = cu.id
       WHERE uf.following_id = ?
       ORDER BY uf.created_at DESC`,
      [req.session.user.id]
    );
    res.render('user/follows', {
      title: '我的关注',
      following,
      followers
    });
  } catch (err) {
    console.error('关注列表加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/edit', requireLogin, async (req, res) => {
  const [user] = await pool.query('SELECT * FROM casdoor_users WHERE id = ?', [req.session.user.id]);
  res.render('user/edit', { title: '编辑资料', user: user[0] });
});

router.post('/edit', requireLogin, async (req, res) => {
  const { nickname, grade, class_name, student_no } = req.body;
  try {
    await pool.query(
      'UPDATE casdoor_users SET nickname = ?, grade = ?, class_name = ?, student_no = ? WHERE id = ?',
      [nickname || null, grade || null, class_name || null, student_no || null, req.session.user.id]
    );
    res.redirect('/user');
  } catch (err) {
    res.redirect('/user/edit?error=update_failed');
  }
});

router.get('/achievements', requireLogin, async (req, res) => {
  try {
    const [medals] = await pool.query('SELECT * FROM user_medals WHERE user_id = ? ORDER BY earned_at DESC', [req.session.user.id]);
    res.render('user/achievements', { title: '我的成就', medals });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

module.exports = router;
