const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

router.get('/', async (req, res) => {
  try {
    const [banners] = await pool.query('SELECT * FROM home_banners WHERE is_active = 1 ORDER BY sort_order ASC');
    const [links] = await pool.query('SELECT * FROM home_links WHERE is_active = 1 ORDER BY sort_order ASC');
    const [posts] = await pool.query(
      'SELECT fp.*, cu.username, cu.real_name, cu.avatar FROM forum_posts fp LEFT JOIN casdoor_users cu ON fp.user_id = cu.id WHERE fp.is_deleted = 0 ORDER BY fp.created_at DESC LIMIT 10'
    );
    const [settings] = await pool.query('SELECT * FROM system_settings');
    const siteSettings = {};
    settings.forEach(s => { siteSettings[s.setting_key] = s.setting_value; });
    
    res.render('home/index', {
      title: siteSettings.site_name || 'D5ST 校园社区',
      banners,
      links,
      posts,
      siteSettings
    });
  } catch (err) {
    console.error('首页加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

module.exports = router;
