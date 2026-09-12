const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

router.get('/', async (req, res) => {
  try {
    const category = req.query.category || '';
    let where = 'WHERE is_deleted = 0';
    const params = [];
    if (category && category !== 'all') {
      where += ' AND category = ?';
      params.push(category);
    }
    const [videos] = await pool.query(
      `SELECT vp.*, cu.username, cu.real_name FROM video_posts vp
       LEFT JOIN casdoor_users cu ON vp.user_id = cu.id
       ${where} ORDER BY vp.created_at DESC LIMIT 50`,
      params
    );
    res.render('videos/index', {
      title: '校园风采',
      videos: videos.map(v => ({ ...v, author: v.real_name || v.username || '匿名' })),
      activeCategory: category
    });
  } catch (err) {
    console.error('视频列表加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/new', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('videos/new', { title: '上传视频' });
});

router.post('/', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { title, description, video_url, cover_url, category } = req.body;
  if (!title || !video_url) {
    return res.status(400).json({ error: '标题和视频地址必填' });
  }
  try {
    await pool.query(
      `INSERT INTO video_posts (user_id, title, description, video_url, cover_url, category)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.user.id, title.trim(), (description || '').trim(), video_url.trim(), (cover_url || '').trim(), category || 'campus']
    );
    res.redirect('/videos');
  } catch (err) {
    console.error('视频上传失败:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(
      `SELECT vp.*, cu.username, cu.real_name FROM video_posts vp
       LEFT JOIN casdoor_users cu ON vp.user_id = cu.id
       WHERE vp.id = ? AND vp.is_deleted = 0 LIMIT 1`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).render('errors/404', { title: '视频不存在' });
    const video = rows[0];
    await pool.query('UPDATE video_posts SET views = views + 1 WHERE id = ?', [id]);

    const [related] = await pool.query(
      `SELECT * FROM video_posts WHERE is_deleted = 0 AND id != ? AND category = ?
       ORDER BY created_at DESC LIMIT 8`,
      [id, video.category]
    );

    res.render('videos/show', {
      title: video.title,
      video: { ...video, author: video.real_name || video.username || '匿名' },
      related
    });
  } catch (err) {
    console.error('视频详情加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

module.exports = router;
