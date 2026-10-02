const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

// MySQL 用 INSERT IGNORE，SQLite 用 INSERT OR IGNORE
const IGNORE = pool.isMysql ? 'INSERT IGNORE' : 'INSERT OR IGNORE';

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
}
function requireLoginPage(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

async function areFriends(a, b) {
  const [rows] = await pool.query(
    'SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? LIMIT 1',
    [a, b]
  );
  return rows && rows.length > 0;
}

// 接受某条好友请求：置为 accepted，并双向建立好友关系
async function acceptRequest(requestId, me) {
  const [rows] = await pool.query(
    "SELECT * FROM friend_requests WHERE id = ? AND status = 'pending'",
    [requestId]
  );
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  if (String(r.to_user_id) !== String(me)) return null;
  await pool.query(
    "UPDATE friend_requests SET status = 'accepted', handled_at = CURRENT_TIMESTAMP WHERE id = ?",
    [requestId]
  );
  await pool.query(
    `${IGNORE} INTO user_friends (user_id, friend_id) VALUES (?, ?)`,
    [r.from_user_id, r.to_user_id]
  );
  await pool.query(
    `${IGNORE} INTO user_friends (user_id, friend_id) VALUES (?, ?)`,
    [r.to_user_id, r.from_user_id]
  );
  // 清理反向残留请求，避免两端各留一条 pending
  await pool.query(
    "DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
    [r.to_user_id, r.from_user_id]
  );
  return r;
}

// 汇总好友页所需数据（好友/收到请求/发出请求/推荐）
async function loadFriendPage(me) {
  const [friends] = await pool.query(
    `SELECT cu.id, cu.username, cu.real_name, cu.avatar, cu.points, uf.created_at
     FROM user_friends uf JOIN casdoor_users cu ON uf.friend_id = cu.id
     WHERE uf.user_id = ? ORDER BY uf.created_at DESC`,
    [me]
  );
  const [incoming] = await pool.query(
    `SELECT fr.id, fr.from_user_id, fr.message, fr.created_at,
            cu.username, cu.real_name, cu.avatar
     FROM friend_requests fr JOIN casdoor_users cu ON fr.from_user_id = cu.id
     WHERE fr.to_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
    [me]
  );
  const [outgoing] = await pool.query(
    `SELECT fr.id, fr.to_user_id, fr.created_at,
            cu.username, cu.real_name, cu.avatar
     FROM friend_requests fr JOIN casdoor_users cu ON fr.to_user_id = cu.id
     WHERE fr.from_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
    [me]
  );
  const [suggestions] = await pool.query(
    `SELECT cu.id, cu.username, cu.real_name, cu.avatar, cu.points
     FROM casdoor_users cu
     WHERE cu.id <> ?
       AND cu.id NOT IN (SELECT friend_id FROM user_friends WHERE user_id = ?)
       AND cu.id NOT IN (SELECT to_user_id FROM friend_requests WHERE from_user_id = ? AND status = 'pending')
       AND cu.id NOT IN (SELECT from_user_id FROM friend_requests WHERE to_user_id = ? AND status = 'pending')
     ORDER BY cu.points DESC, cu.id DESC LIMIT 12`,
    [me, me, me, me]
  );
  return { friends, incoming, outgoing, suggestions };
}

// 好友主页
router.get('/', requireLoginPage, async (req, res) => {
  const me = req.session.user.id;
  try {
    const data = await loadFriendPage(me);
    res.render('friends/index', {
      title: '好友',
      ...data,
      activeTab: req.query.tab || 'friends',
      keyword: '',
      searchResults: null
    });
  } catch (err) {
    console.error('好友页加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 搜索用户（用于添加好友）
router.get('/search', requireLoginPage, async (req, res) => {
  const me = req.session.user.id;
  const kw = (req.query.q || '').trim();
  try {
    const data = await loadFriendPage(me);
    let searchResults = [];
    if (kw) {
      const like = '%' + kw + '%';
      const [rows] = await pool.query(
        `SELECT id, username, real_name, avatar, points
         FROM casdoor_users
         WHERE id <> ? AND (username LIKE ? OR real_name LIKE ?)
         ORDER BY points DESC, id DESC LIMIT 30`,
        [me, like, like]
      );
      const [fids] = await pool.query('SELECT friend_id FROM user_friends WHERE user_id = ?', [me]);
      const fset = new Set(fids.map(r => String(r.friend_id)));
      const [sent] = await pool.query(
        "SELECT to_user_id FROM friend_requests WHERE from_user_id = ? AND status = 'pending'",
        [me]
      );
      const sset = new Set(sent.map(r => String(r.to_user_id)));
      searchResults = rows.map(r => ({
        ...r,
        isFriend: fset.has(String(r.id)),
        requestSent: sset.has(String(r.id))
      }));
    }
    res.render('friends/index', {
      title: '好友 · 搜索',
      ...data,
      activeTab: 'search',
      keyword: kw,
      searchResults
    });
  } catch (err) {
    console.error('好友搜索失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 好友状态（供帖子页/个人主页按钮查询）
router.get('/status/:id', requireLogin, async (req, res) => {
  const me = req.session.user.id;
  const target = parseInt(req.params.id, 10);
  if (isNaN(target)) return res.json({ isFriend: false, requestSent: false, requestReceived: false });
  try {
    const isFriend = await areFriends(me, target);
    let requestSent = false;
    let requestReceived = false;
    let requestId = null;
    const [sent] = await pool.query(
      "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
      [me, target]
    );
    if (sent.length) { requestSent = true; requestId = sent[0].id; }
    const [recv] = await pool.query(
      "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
      [target, me]
    );
    if (recv.length) { requestReceived = true; requestId = recv[0].id; }
    res.json({ isFriend, requestSent, requestReceived, requestId });
  } catch (e) {
    res.json({ isFriend: false, requestSent: false, requestReceived: false });
  }
});

// 发送好友请求
router.post('/request/:id', requireLogin, async (req, res) => {
  const me = req.session.user.id;
  const target = parseInt(req.params.id, 10);
  if (isNaN(target) || target === me) return res.status(400).json({ error: '非法操作' });
  try {
    const [t] = await pool.query('SELECT id FROM casdoor_users WHERE id = ?', [target]);
    if (!t || t.length === 0) return res.status(404).json({ error: '用户不存在' });
    if (await areFriends(me, target)) return res.json({ status: 'friend' });

    // 对方已向我发起请求 → 直接互加
    const [reverse] = await pool.query(
      "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
      [target, me]
    );
    if (reverse.length) {
      await acceptRequest(reverse[0].id, me);
      return res.json({ status: 'friend' });
    }

    const msg = (req.body && req.body.message ? String(req.body.message) : '').slice(0, 255) || null;
    const [existing] = await pool.query(
      'SELECT id, status FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?',
      [me, target]
    );
    if (existing.length) {
      if (existing[0].status === 'pending') return res.json({ status: 'requested' });
      await pool.query(
        "UPDATE friend_requests SET status = 'pending', message = ?, created_at = CURRENT_TIMESTAMP, handled_at = NULL WHERE id = ?",
        [msg, existing[0].id]
      );
      return res.json({ status: 'requested' });
    }
    await pool.query(
      'INSERT INTO friend_requests (from_user_id, to_user_id, message) VALUES (?, ?, ?)',
      [me, target, msg]
    );
    res.json({ status: 'requested' });
  } catch (err) {
    console.error('发送好友请求失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 接受好友请求
router.post('/accept/:id', requireLogin, async (req, res) => {
  const me = req.session.user.id;
  try {
    const r = await acceptRequest(req.params.id, me);
    if (!r) return res.status(404).json({ error: '请求不存在' });
    res.json({ success: true });
  } catch (err) {
    console.error('接受好友请求失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 拒绝好友请求
router.post('/reject/:id', requireLogin, async (req, res) => {
  const me = req.session.user.id;
  try {
    const [rows] = await pool.query(
      "SELECT id FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'",
      [req.params.id, me]
    );
    if (!rows.length) return res.status(404).json({ error: '请求不存在' });
    await pool.query(
      "UPDATE friend_requests SET status = 'rejected', handled_at = CURRENT_TIMESTAMP WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

// 删除好友（双向解除）
router.post('/remove/:id', requireLogin, async (req, res) => {
  const me = req.session.user.id;
  const target = parseInt(req.params.id, 10);
  if (isNaN(target)) return res.status(400).json({ error: '非法操作' });
  try {
    await pool.query(
      `DELETE FROM user_friends
       WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
      [me, target, target, me]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

module.exports = router;
