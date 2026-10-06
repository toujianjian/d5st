const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const { videoUpload } = require('../../配置/upload');

// 分类定义（meyho 走马灯分类导航）
const CATEGORIES = {
  campus: { label: '校园风光', icon: '🏫' },
  life: { label: '生活日常', icon: '☕' },
  study: { label: '学习干货', icon: '📚' },
  talent: { label: '才艺展示', icon: '🎤' },
  sport: { label: '运动赛事', icon: '⚽' },
  other: { label: '其他', icon: '✨' }
};

const PAGE_SIZE = 12;

// 分类浏览量统计（用于走马灯分类导航）
async function getCategoryStats() {
  try {
    const [rows] = await pool.query(
      `SELECT category, COUNT(*) as cnt, SUM(views) as total_views
       FROM video_posts WHERE is_deleted = 0
       GROUP BY category ORDER BY cnt DESC`
    );
    return rows.map(r => ({
      key: r.category,
      label: (CATEGORIES[r.category] || CATEGORIES.other).label,
      icon: (CATEGORIES[r.category] || CATEGORIES.other).icon,
      count: r.cnt,
      views: r.total_views || 0
    }));
  } catch (e) {
    return [];
  }
}

// 推荐轮播（meyho 走马灯幻灯片）
async function getRecommended(limit = 5) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM video_posts
       WHERE is_deleted = 0 AND is_recommended = 1
       ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
    if (rows.length > 0) return rows;
    // 没有标记推荐时，退化为「热门」：按浏览量取
    const [hot] = await pool.query(
      `SELECT * FROM video_posts WHERE is_deleted = 0 ORDER BY views DESC LIMIT ?`,
      [limit]
    );
    return hot;
  } catch (e) {
    return [];
  }
}

// ============ 视频列表（推荐页 + 列表页） ============
router.get('/', async (req, res) => {
  try {
    const category = req.query.category || '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let where = 'WHERE vp.is_deleted = 0';
    const params = [];
    if (category && category !== 'all') {
      where += ' AND vp.category = ?';
      params.push(category);
    }

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM video_posts vp ${where}`, params
    );
    const total = totalRows[0].cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const offset = (page - 1) * PAGE_SIZE;

    const [videos] = await pool.query(
      `SELECT vp.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar FROM video_posts vp
       LEFT JOIN casdoor_users cu ON vp.user_id = cu.id
       ${where} ORDER BY vp.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    const [recommended, categoryStats] = await Promise.all([
      getRecommended(5),
      getCategoryStats()
    ]);

    res.render('videos/index', {
      title: '视频',
      videos: videos.map(v => ({
        ...v,
        author: v.real_name || v.username || '匿名',
        category_label: (CATEGORIES[v.category] || CATEGORIES.other).label,
        category_icon: (CATEGORIES[v.category] || CATEGORIES.other).icon
      })),
      recommended,
      categoryStats,
      categories: CATEGORIES,
      activeCategory: category || 'all',
      page, totalPages, total
    });
  } catch (err) {
    console.error('视频列表加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// ============ 上传页 ============
router.get('/new', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('videos/new', { title: '上传视频', categories: CATEGORIES, error: req.query.error || null });
});

// ============ 发布视频（本地上传 或 外链 URL，二选一）============
router.post('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  videoUpload.single('video_file')(req, res, async (upErr) => {
    const backErr = (msg) => res.redirect('/videos/new?error=' + encodeURIComponent(msg));

    if (upErr) {
      const msg = upErr.code === 'LIMIT_FILE_SIZE'
        ? '视频超过 100MB 限制'
        : (upErr.message || '上传失败');
      console.error('视频上传失败:', msg);
      return backErr(msg);
    }

    const { title, description, video_url, cover_url, category, duration, is_recommended } = req.body || {};
    // 本地文件优先；未选文件时用外链
    const fileUrl = req.file ? '/uploads/videos/' + req.file.filename : '';
    const finalUrl = fileUrl || String(video_url || '').trim();

    if (!title || !finalUrl) {
      if (req.file) { try { require('fs').unlink(req.file.path, () => {}); } catch (e) { /* 忽略 */ } }
      return backErr('标题必填，且需上传视频文件或填写视频地址');
    }

    try {
      const [result] = await pool.query(
        `INSERT INTO video_posts (user_id, title, description, video_url, cover_url, category, duration, is_recommended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.session.user.id,
          String(title).trim(),
          String(description || '').trim(),
          finalUrl,
          String(cover_url || '').trim(),
          category || 'campus',
          parseInt(duration, 10) || 0,
          is_recommended ? 1 : 0
        ]
      );
      const id = result && result.insertId;
      res.redirect(id ? '/videos/' + id : '/videos');
    } catch (err) {
      console.error('视频入库失败:', err);
      if (req.file) { try { require('fs').unlink(req.file.path, () => {}); } catch (e) { /* 忽略 */ } }
      backErr('上传失败，请重试');
    }
  });
});

// ============ 播放页 ============
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(
      `SELECT vp.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar FROM video_posts vp
       LEFT JOIN casdoor_users cu ON vp.user_id = cu.id
       WHERE vp.id = ? AND vp.is_deleted = 0 LIMIT 1`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).render('errors/404', { title: '视频不存在' });
    const video = rows[0];
    await pool.query('UPDATE video_posts SET views = views + 1 WHERE id = ?', [id]);

    // 相关推荐（同分类 + 兜底最新）
    let [related] = await pool.query(
      `SELECT * FROM video_posts WHERE is_deleted = 0 AND id != ? AND category = ?
       ORDER BY created_at DESC LIMIT 8`,
      [id, video.category]
    );
    if (!related || related.length === 0) {
      [related] = await pool.query(
        `SELECT * FROM video_posts WHERE is_deleted = 0 AND id != ?
         ORDER BY created_at DESC LIMIT 8`,
        [id]
      );
    }

    res.render('videos/show', {
      title: video.title,
      video: {
        ...video,
        author: video.real_name || video.username || '匿名',
        category_label: (CATEGORIES[video.category] || CATEGORIES.other).label,
        category_icon: (CATEGORIES[video.category] || CATEGORIES.other).icon
      },
      related: related || [],
      categories: CATEGORIES
    });
  } catch (err) {
    console.error('视频详情加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

module.exports = router;
