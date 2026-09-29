const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

// 安全计数：表/字段缺失时返回 0，避免首页整体 500
async function safeCount(sql) {
  try {
    const [rows] = await pool.query(sql);
    return (rows && rows[0] && rows[0].cnt) || 0;
  } catch (e) {
    return 0;
  }
}

async function safeQuery(sql, params) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  } catch (e) {
    return [];
  }
}

router.get('/', async (req, res) => {
  try {
    const [banners] = await pool.query('SELECT * FROM home_banners WHERE is_active = 1 ORDER BY sort_order ASC');
    const [links] = await pool.query('SELECT * FROM home_links WHERE is_active = 1 ORDER BY sort_order ASC');
    const [posts] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name, cu.avatar,
        (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = fp.id AND pc.is_deleted = 0) as comment_count
       FROM forum_posts fp
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       WHERE fp.is_deleted = 0
       ORDER BY fp.is_top DESC, fp.created_at DESC LIMIT 6`
    );

    // 首页视频预览
    const videos = await safeQuery(
      `SELECT * FROM video_posts WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 4`
    );

    const [settings] = await pool.query('SELECT * FROM system_settings');
    const siteSettings = {};
    settings.forEach(s => { siteSettings[s.setting_key] = s.setting_value; });

    // 站点统计（AstroWind 风格的数据条）
    const stats = {
      posts: await safeCount('SELECT COUNT(*) as cnt FROM forum_posts WHERE is_deleted = 0'),
      videos: await safeCount('SELECT COUNT(*) as cnt FROM video_posts WHERE is_deleted = 0'),
      users: await safeCount('SELECT COUNT(*) as cnt FROM casdoor_users'),
      comments: await safeCount('SELECT COUNT(*) as cnt FROM post_comments WHERE is_deleted = 0')
    };

    res.render('home/index', {
      layout: 'layout-home',
      title: siteSettings.site_name || 'D5ST 校园社区',
      banners,
      links,
      posts: posts.map(p => ({
        ...p,
        author: p.real_name || p.username || '匿名',
        comments_count: p.comment_count || 0
      })),
      videos,
      stats,
      siteSettings
    });
  } catch (err) {
    console.error('首页加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

module.exports = router;
