const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

router.get('/', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const userId = req.session.user.id;
  try {
    const [conversations] = await pool.query(
      `SELECT
          CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AS other_id,
          MAX(m.created_at) AS last_time
        FROM messages m
        WHERE m.sender_id = ? OR m.receiver_id = ?
        GROUP BY other_id
        ORDER BY last_time DESC`,
      [userId, userId, userId]
    );

    const decorated = [];
    for (const c of conversations) {
      const otherId = c.other_id;
      const [others] = await pool.query(
        'SELECT id, username, real_name, avatar FROM casdoor_users WHERE id = ?',
        [otherId]
      );
      const other = others[0];
      if (!other) continue;
      const [lastMsgs] = await pool.query(
        `SELECT content FROM messages
          WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
          ORDER BY created_at DESC LIMIT 1`,
        [userId, otherId, otherId, userId]
      );
      const [unrows] = await pool.query(
        'SELECT COUNT(*) as cnt FROM messages WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
        [userId, otherId]
      );
      decorated.push({
        other_id: otherId,
        other_name: other.real_name || other.username || '用户',
        other_avatar: other.avatar,
        last_time: c.last_time,
        last_message: lastMsgs[0]?.content || '',
        unread_count: unrows[0].cnt || 0
      });
    }

    res.render('messages/index', { title: '私信', conversations: decorated });
  } catch (err) {
    console.error('私信列表加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/chat/:userId', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const myId = req.session.user.id;
  const otherId = req.params.userId;
  try {
    const [messages] = await pool.query(
      `SELECT * FROM messages 
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC`,
      [myId, otherId, otherId, myId]
    );
    // 标记为已读
    await pool.query(
      'UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
      [myId, otherId]
    );
    const [otherUser] = await pool.query(
      'SELECT id, username, real_name, avatar FROM casdoor_users WHERE id = ?',
      [otherId]
    );
    res.render('messages/chat', { 
      title: (otherUser[0]?.real_name) || (otherUser[0]?.username) || '聊天', 
      messages, 
      otherUser: otherUser[0] || { id: otherId },
      otherId 
    });
  } catch (err) {
    console.error('聊天加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/send/:userId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const myId = req.session.user.id;
  const receiverId = req.params.userId;
  const { content } = req.body;
  if (!content || content.trim().length < 1) {
    return res.status(400).json({ error: '内容不能为空' });
  }
  try {
    await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
      [myId, receiverId, content.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '发送失败' });
  }
});

router.get('/guestbook', async (req, res) => {
  try {
    const [messages] = await pool.query(
      'SELECT * FROM guestbook ORDER BY created_at DESC LIMIT 100'
    );
    res.render('messages/guestbook', { title: '留言板', messages });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/guestbook', async (req, res) => {
  const { content, author_name } = req.body;
  if (!content || !content.trim()) return res.redirect('/messages/guestbook');
  const authorId = req.session.user?.id || null;
  const name = authorId ? (req.session.user.real_name || req.session.user.username) : (author_name || '匿名用户');
  try {
    await pool.query('INSERT INTO guestbook (author_id, author_name, content) VALUES (?, ?, ?)', [authorId, name, content.trim()]);
    res.redirect('/messages/guestbook');
  } catch (err) {
    res.redirect('/messages/guestbook');
  }
});

module.exports = router;
