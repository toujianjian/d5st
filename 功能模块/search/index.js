const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

router.get('/', async (req, res) => {
  const keyword = (req.query.q || '').trim();
  let results = { posts: [], users: [] };
  
  if (keyword.length > 0) {
    try {
      if (req.session.user?.id) {
        await pool.query('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)', [req.session.user.id, keyword]);
      }
      const [posts] = await pool.query(
        `SELECT fp.*, cu.username, cu.real_name FROM forum_posts fp 
         LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
         WHERE fp.is_deleted = 0 AND (fp.content LIKE ? OR fp.tags LIKE ?)
         ORDER BY fp.created_at DESC LIMIT 30`,
        [`%${keyword}%`, `%${keyword}%`]
      );
      const [users] = await pool.query(
        'SELECT id, username, real_name, avatar FROM casdoor_users WHERE username LIKE ? OR real_name LIKE ? LIMIT 20',
        [`%${keyword}%`, `%${keyword}%`]
      );
      results = { posts, users };
    } catch (err) {
      console.error('搜索失败:', err);
    }
  }
  
  res.render('search/index', { title: '搜索', keyword, ...results });
});

module.exports = router;
