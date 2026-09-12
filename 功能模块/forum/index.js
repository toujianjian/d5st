const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');

const CATEGORY_LABELS = {
  life: '☕ 生活', study: '📚 学习', emotion: '💗 情感',
  campus: '🏫 校园', other: '✨ 其他', general: '其他'
};

const PAGE_SIZE = 10;

// 解析标签字符串 → 去重后的数组
function parseTags(str) {
  if (!str) return [];
  return String(str).split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
}

// 同步标签到结构化表
async function syncPostTags(postId, tagNames) {
  const names = parseTags(tagNames);
  if (!names.length) return;
  for (const name of names) {
    const [existing] = await pool.query('SELECT id FROM tags WHERE name = ?', [name]);
    let tagId;
    if (existing && existing.length > 0) {
      tagId = existing[0].id;
    } else {
      const [insert] = await pool.query('INSERT INTO tags (name) VALUES (?)', [name]);
      tagId = insert && insert.insertId ? insert.insertId : (await pool.query('SELECT id FROM tags WHERE name = ?', [name]))[0][0].id;
    }
    await pool.query(
      'INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)',
      [postId, tagId]
    );
  }
}

// 获取一篇帖子关联的所有标签名称
async function getPostTagNames(postId) {
  const [rows] = await pool.query(
    `SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name`,
    [postId]
  );
  return rows.map(r => r.name);
}

router.get('/', async (req, res) => {
  try {
    const category = req.query.category || '';
    const sort = req.query.sort || 'newest';
    const tag = req.query.tag || '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let where = 'WHERE fp.is_deleted = 0';
    const params = [];

    if (category && category !== 'all') {
      where += ' AND fp.category = ?';
      params.push(category);
    }
    if (tag) {
      where += ' AND fp.tags LIKE ?';
      params.push('%' + tag + '%');
    }

    // 总数
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM forum_posts fp ${where}`,
      params
    );
    const total = totalRows[0].cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const offset = (page - 1) * PAGE_SIZE;

    // 排序
    let orderBy = 'fp.is_top DESC, fp.created_at DESC';
    if (sort === 'hot') {
      orderBy = '(SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = fp.id) DESC, fp.is_top DESC, fp.created_at DESC';
    } else if (sort === 'essence') {
      orderBy = 'fp.is_hot DESC, fp.is_top DESC, fp.created_at DESC';
    }

    const [posts] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name, cu.avatar,
        (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = fp.id AND pc.is_deleted = 0) as comment_count,
        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = fp.id) as like_count
       FROM forum_posts fp 
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id 
       ${where}
       ORDER BY ${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    const decorated = posts.map(p => ({
      ...p,
      author: p.real_name || p.username || '匿名',
      likes: p.like_count || 0,
      comments_count: p.comment_count || 0,
      category: CATEGORY_LABELS[p.category] || p.category
    }));

    // 所有活跃标签（按出现次数倒取前 15）
  const [tagsRows] = await pool.query(
    `SELECT t.name, COUNT(*) as cnt
     FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     GROUP BY t.id
     ORDER BY cnt DESC`
  );
  const tagMap = {};
  for (const row of tagsRows) {
    tagMap[row.name] = row.cnt;
  }
  const popularTags = Object.entries(tagMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

    // 活跃用户（发帖数前 5）
    const [activeUsers] = await pool.query(
      `SELECT cu.id, cu.username, cu.real_name, cu.avatar, COUNT(fp.id) as post_count
       FROM casdoor_users cu
       JOIN forum_posts fp ON fp.user_id = cu.id AND fp.is_deleted = 0
       GROUP BY cu.id
       ORDER BY post_count DESC LIMIT 5`
    );

    res.render('forum/index', {
      title: '校园贴吧',
      posts: decorated,
      activeCategory: category || 'all',
      activeSort: sort,
      activeTag: tag,
      page, totalPages, total,
      popularTags,
      activeUsers
    });
  } catch (err) {
    console.error('贴吧加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.get('/new', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('forum/new', { title: '发帖' });
});

router.post('/', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { title, content, category, tags } = req.body;
  if (!content || content.trim().length < 2) {
    return res.status(400).json({ error: '内容不能为空（至少 2 字）' });
  }
  const titleVal = (title && title.trim()) ? title.trim() : content.trim().slice(0, 30);
  const catVal = (category || 'general').trim();
  const tagsVal = tags ? String(tags).trim() : null;
  try {
    const [result] = await pool.query(
      'INSERT INTO forum_posts (user_id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)',
      [req.session.user.id, titleVal, content.trim(), catVal, tagsVal]
    );
    const postId = result && result.insertId ? result.insertId : (await pool.query('SELECT last_insert_rowid() as id'))[0][0].id;
    if (tagsVal) await syncPostTags(postId, tagsVal);
    res.redirect('/forum');
  } catch (err) {
    console.error('发帖失败:', err);
    res.status(500).json({ error: '发布失败' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name, cu.avatar FROM forum_posts fp
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       WHERE fp.id = ? AND fp.is_deleted = 0 LIMIT 1`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).render('errors/404', { title: '帖子不存在' });
    const post = rows[0];
    await pool.query('UPDATE forum_posts SET views = views + 1 WHERE id = ?', [id]);

    const [comments] = await pool.query(
      `SELECT pc.*, cu.username, cu.real_name, cu.avatar FROM post_comments pc
       LEFT JOIN casdoor_users cu ON pc.user_id = cu.id
       WHERE pc.post_id = ? AND pc.is_deleted = 0
       ORDER BY pc.created_at ASC`,
      [id]
    );

    const [likes] = await pool.query('SELECT COUNT(*) as cnt FROM post_likes WHERE post_id = ?', [id]);
    const likeCount = likes[0].cnt || 0;

    let liked = false;
    if (req.session.user) {
      const [l] = await pool.query('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', [id, req.session.user.id]);
      liked = l && l.length > 0;
    }

    const catLabel = CATEGORY_LABELS[post.category] || post.category;

    // 上一篇/下一篇
    const [prevRows] = await pool.query(
      'SELECT id, title FROM forum_posts WHERE id < ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1', [id]
    );
    const [nextRows] = await pool.query(
      'SELECT id, title FROM forum_posts WHERE id > ? AND is_deleted = 0 ORDER BY id ASC LIMIT 1', [id]
    );

    const structuredTags = await getPostTagNames(post.id);

    res.render('forum/show', {
      title: post.title || '帖子详情',
      post: {
        ...post,
        author: post.real_name || post.username || '匿名',
        category_label: catLabel,
        likes: likeCount,
        comments: comments.map(c => ({
          ...c,
          author: c.real_name || c.username || '匿名'
        })),
        liked,
        prev: prevRows[0] || null,
        next: nextRows[0] || null
      },
      structuredTags
    });
  } catch (err) {
    console.error('帖子详情加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/like/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const userId = req.session.user.id;
  try {
    const [existing] = await pool.query('SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    if (existing.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    res.json({ liked: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/comment/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const { content, parent_id } = req.body;
  if (!content || content.trim().length < 1) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }
  try {
    await pool.query(
      'INSERT INTO post_comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [postId, req.session.user.id, content.trim(), parent_id ? Number(parent_id) : null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '评论失败' });
  }
});

router.get('/comments/:id', async (req, res) => {
  try {
    const [comments] = await pool.query(
      `SELECT pc.*, cu.username, cu.real_name, cu.avatar FROM post_comments pc
       LEFT JOIN casdoor_users cu ON pc.user_id = cu.id
       WHERE pc.post_id = ? AND pc.is_deleted = 0
       ORDER BY pc.created_at ASC`,
      [req.params.id]
    );
    res.json(comments.map(c => ({
      ...c,
      real_name: c.real_name || c.username || '匿名'
    })));
  } catch (err) {
    res.json([]);
  }
});

router.post('/report/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { reason } = req.body;
  try {
    await pool.query(
      'INSERT INTO reports (post_id, reporter_id, reason) VALUES (?, ?, ?)',
      [req.params.id, req.session.user.id, reason || '']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '举报失败' });
  }
});

module.exports = router;
