const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.is_admin !== 1) return res.status(403).render('errors/404', { title: '无权限' });
  next();
}

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const [userCount] = await pool.query('SELECT COUNT(*) as cnt FROM casdoor_users');
    const [postCount] = await pool.query('SELECT COUNT(*) as cnt FROM forum_posts WHERE is_deleted = 0');
    const [reportCount] = await pool.query("SELECT COUNT(*) as cnt FROM reports WHERE status = 'pending'");
    const [messageCount] = await pool.query('SELECT COUNT(*) as cnt FROM messages');
    res.render('admin/index', { 
      title: '管理后台', 
      stats: {
        users: userCount[0].cnt,
        posts: postCount[0].cnt,
        pendingReports: reportCount[0].cnt,
        messages: messageCount[0].cnt
      }
    });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/forum', async (req, res) => {
  try {
    const [posts] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name FROM forum_posts fp 
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       ORDER BY fp.created_at DESC LIMIT 100`
    );
    res.render('admin/forum', { title: '帖子管理', posts });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/forum/delete/:id', async (req, res) => {
  try {
    await pool.query('UPDATE forum_posts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 评论管理
router.get('/comments', async (req, res) => {
  try {
    const [comments] = await pool.query(
      `SELECT pc.*, cu.username, cu.real_name, fp.title as post_title, fp.id as post_id
       FROM post_comments pc
       LEFT JOIN casdoor_users cu ON pc.user_id = cu.id
       LEFT JOIN forum_posts fp ON pc.post_id = fp.id
       ORDER BY pc.created_at DESC LIMIT 200`
    );
    res.render('admin/comments', { title: '评论管理', comments });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/comments/delete/:id', async (req, res) => {
  try {
    await pool.query('UPDATE post_comments SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

router.post('/forum/toggle-top/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT is_top FROM forum_posts WHERE id = ?', [req.params.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: '帖子不存在' });
    const next = rows[0].is_top ? 0 : 1;
    await pool.query('UPDATE forum_posts SET is_top = ? WHERE id = ?', [next, req.params.id]);
    res.json({ success: true, is_top: next });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/forum/toggle-hot/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT is_hot FROM forum_posts WHERE id = ?', [req.params.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: '帖子不存在' });
    const next = rows[0].is_hot ? 0 : 1;
    await pool.query('UPDATE forum_posts SET is_hot = ? WHERE id = ?', [next, req.params.id]);
    res.json({ success: true, is_hot: next });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const [reports] = await pool.query(
      `SELECT r.*, cu.username as reporter_name, fp.content as post_content 
       FROM reports r 
       LEFT JOIN casdoor_users cu ON r.reporter_id = cu.id
       LEFT JOIN forum_posts fp ON r.post_id = fp.id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    res.render('admin/reports', { title: '举报管理', reports });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/reports/:id/handle', async (req, res) => {
  const { action } = req.body;
  try {
    await pool.query('UPDATE reports SET status = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?', [action || 'resolved', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '处理失败' });
  }
});

router.get('/notifications', async (req, res) => {
  const [notifications] = await pool.query('SELECT * FROM global_notifications ORDER BY created_at DESC');
  res.render('admin/notifications', { title: '通知管理', notifications });
});

router.post('/notifications', async (req, res) => {
  const { title, content, action_url, action_text, start_time, end_time } = req.body;
  try {
    await pool.query(
      `INSERT INTO global_notifications (title, content, action_url, action_text, start_time, end_time)
       VALUES (?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))`,
      [title, content, action_url || null, action_text || null, start_time || null, end_time || null]
    );
    res.redirect('/admin/notifications');
  } catch (err) {
    res.redirect('/admin/notifications?error=create_failed');
  }
});

router.get('/popups', async (req, res) => {
  const [popups] = await pool.query('SELECT * FROM popups ORDER BY sort_order ASC, id DESC');
  res.render('admin/popups', { title: '弹窗管理', popups });
});

router.post('/popups', async (req, res) => {
  const { title, content, type, target_pages, show_once, start_time, end_time, sort_order } = req.body;
  try {
    await pool.query(
      `INSERT INTO popups (title, content, type, target_pages, show_once, start_time, end_time, sort_order)
       VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)`,
      [title, content, type || 'info', target_pages || 'all', show_once ? 1 : 0, start_time || null, end_time || null, sort_order || 0]
    );
    res.redirect('/admin/popups');
  } catch (err) {
    res.redirect('/admin/popups?error=create_failed');
  }
});

router.get('/popups/edit/:id', async (req, res) => {
  const [popups] = await pool.query('SELECT * FROM popups WHERE id = ?', [req.params.id]);
  if (popups.length === 0) return res.redirect('/admin/popups');
  res.render('admin/popups-edit', { title: '编辑弹窗', popup: popups[0] });
});

router.post('/popups/edit/:id', async (req, res) => {
  const { title, content, type, target_pages, show_once, start_time, end_time, sort_order, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE popups SET title=?, content=?, type=?, target_pages=?, show_once=?, start_time=NULLIF(?, ''), end_time=NULLIF(?, ''), sort_order=?, is_active=? WHERE id=?`,
      [title, content, type || 'info', target_pages || 'all', show_once ? 1 : 0, start_time || null, end_time || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
    );
    res.redirect('/admin/popups');
  } catch (err) {
    res.redirect('/admin/popups?error=update_failed');
  }
});

router.get('/home-links', async (req, res) => {
  const [links] = await pool.query('SELECT * FROM home_links ORDER BY sort_order ASC');
  res.render('admin/home-links', { title: '首页链接管理', links });
});

router.post('/home-links', async (req, res) => {
  const { title, url, icon, sort_order } = req.body;
  try {
    await pool.query('INSERT INTO home_links (title, url, icon, sort_order) VALUES (?, ?, ?, ?)', [title, url, icon || null, sort_order || 0]);
    res.redirect('/admin/home-links');
  } catch (err) {
    res.redirect('/admin/home-links?error=create_failed');
  }
});

router.post('/home-links/delete/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM home_links WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

router.get('/home-banners', async (req, res) => {
  const [banners] = await pool.query('SELECT * FROM home_banners ORDER BY sort_order ASC');
  res.render('admin/home-banners', { title: '首页横幅管理', banners });
});

router.post('/home-banners', async (req, res) => {
  const { title, image_path, link_url, sort_order } = req.body;
  try {
    await pool.query('INSERT INTO home_banners (title, image_path, link_url, sort_order) VALUES (?, ?, ?, ?)', [title, image_path, link_url || null, sort_order || 0]);
    res.redirect('/admin/home-banners');
  } catch (err) {
    res.redirect('/admin/home-banners?error=create_failed');
  }
});

router.post('/home-banners/delete/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM home_banners WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

router.get('/path-redirects', async (req, res) => {
  const [redirects] = await pool.query('SELECT * FROM path_redirects ORDER BY created_at DESC');
  res.render('admin/path-redirects', { title: '路径重定向', redirects });
});

router.post('/path-redirects', async (req, res) => {
  const { path, redirect_url, path_desc } = req.body;
  try {
    await pool.query('INSERT INTO path_redirects (path, redirect_url, path_desc) VALUES (?, ?, ?)', [path, redirect_url, path_desc || null]);
    res.redirect('/admin/path-redirects');
  } catch (err) {
    res.redirect('/admin/path-redirects?error=create_failed');
  }
});

router.post('/path-redirects/delete/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM path_redirects WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

router.get('/recycle-bin', async (req, res) => {
  try {
    const [items] = await pool.query('SELECT * FROM deleted_items WHERE is_restored = 0 ORDER BY deleted_at DESC LIMIT 100');
    res.render('admin/recycle-bin', { title: '回收站', items });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/export-users', async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, real_name, grade, class_name, student_no, points, is_admin, created_at FROM casdoor_users ORDER BY id');
    res.render('admin/export-users', { title: '导出用户数据', users });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/settings', async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT * FROM system_settings');
    res.render('admin/settings', { title: '系统设置', settings });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      const [existing] = await pool.query(
        'SELECT id FROM system_settings WHERE setting_key = ?', [key]
      );
      if (existing && existing.length > 0) {
        await pool.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
      } else {
        await pool.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
      }
    }
    res.redirect('/admin/settings');
  } catch (err) {
    res.redirect('/admin/settings?error=save_failed');
  }
});

module.exports = router;
