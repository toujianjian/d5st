const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const { scan, logHit } = require('../sensitive-check');

// 分类文案（兼容旧数据）
const CATEGORY_LABELS = {
  life: '☕ 生活', study: '📚 学习', emotion: '💗 情感',
  campus: '🏫 校园', other: '✨ 其他', general: '✨ 其他'
};

// 帖子类型（参考 linfeng-community：图文帖 / 长文贴 / 短视频）
const POST_TYPES = {
  normal: { label: '图文帖', icon: '🖼️' },
  long: { label: '长文贴', icon: '📝' },
  video: { label: '视频贴', icon: '🎬' }
};

const PAGE_SIZE = 10;

// MySQL 用 INSERT IGNORE，SQLite 用 INSERT OR IGNORE
const IGNORE = pool.isMysql ? 'INSERT IGNORE' : 'INSERT OR IGNORE';

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
      tagId = (insert && insert.insertId)
        ? insert.insertId
        : (await pool.query('SELECT id FROM tags WHERE name = ?', [name]))[0][0].id;
    }
    await pool.query(
      `${IGNORE} INTO post_tags (post_id, tag_id) VALUES (?, ?)`,
      [postId, tagId]
    );
  }
}

async function getPostTagNames(postId) {
  try {
    const [rows] = await pool.query(
      `SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name`,
      [postId]
    );
    return rows.map(r => r.name);
  } catch (e) {
    return [];
  }
}

// 版块列表（圈子）
async function getBoards() {
  try {
    const [boards] = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM forum_posts p WHERE p.board_id = b.id AND p.is_deleted = 0) as post_count
       FROM forum_boards b WHERE b.is_active = 1
       ORDER BY b.sort_order ASC, b.id ASC`
    );
    return boards;
  } catch (e) {
    return [];
  }
}

// 构造帖子查询条件
function buildWhere({ boardId, category, tag }) {
  let where = 'WHERE fp.is_deleted = 0';
  const params = [];
  if (boardId) {
    where += ' AND fp.board_id = ?';
    params.push(boardId);
  }
  if (category && category !== 'all') {
    where += ' AND fp.category = ?';
    params.push(category);
  }
  if (tag) {
    where += ' AND fp.tags LIKE ?';
    params.push('%' + tag + '%');
  }
  return { where, params };
}

function buildOrder(sort) {
  // 置顶始终优先（对应后台「置顶」管理）
  if (sort === 'hot') return 'fp.is_top DESC, like_count DESC, fp.created_at DESC';
  if (sort === 'essence') return 'fp.is_top DESC, fp.is_hot DESC, fp.created_at DESC';
  return 'fp.is_top DESC, fp.created_at DESC';
}

const POST_SELECT = `
  SELECT fp.*, cu.username, cu.real_name, cu.avatar,
    (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = fp.id AND pc.is_deleted = 0) as comment_count,
    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = fp.id) as like_count
  FROM forum_posts fp
  LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
`;

function decorate(posts) {
  return posts.map(p => ({
    ...p,
    author: p.real_name || p.username || '匿名',
    likes: p.like_count || 0,
    comments_count: p.comment_count || 0,
    category_label: CATEGORY_LABELS[p.category] || p.category,
    type_label: (POST_TYPES[p.post_type] || POST_TYPES.normal).label,
    type_icon: (POST_TYPES[p.post_type] || POST_TYPES.normal).icon
  }));
}

// 组装列表页公共数据（版块、热门标签、活跃用户、签到状态）
async function buildSidebar(req) {
  const boards = await getBoards();

  let popularTags = [];
  try {
    const [tagsRows] = await pool.query(
      `SELECT t.name, COUNT(*) as cnt FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       GROUP BY t.id ORDER BY cnt DESC LIMIT 15`
    );
    popularTags = tagsRows;
  } catch (e) { /* 表不存在时忽略 */ }

  let activeUsers = [];
  try {
    const [rows] = await pool.query(
      `SELECT cu.id, cu.username, cu.real_name, cu.avatar, COUNT(fp.id) as post_count
       FROM casdoor_users cu
       JOIN forum_posts fp ON fp.user_id = cu.id AND fp.is_deleted = 0
       GROUP BY cu.id ORDER BY post_count DESC LIMIT 5`
    );
    activeUsers = rows;
  } catch (e) { /* ignore */ }

  // 今日是否已签到（linfeng 签到体系）
  let checkedIn = false;
  if (req.session.user) {
    try {
      const [rows] = await pool.query(
        'SELECT 1 FROM user_checkins WHERE user_id = ? AND checkin_date = CURDATE() LIMIT 1',
        [req.session.user.id]
      );
      checkedIn = rows && rows.length > 0;
    } catch (e) { /* ignore */ }
  }

  return { boards, popularTags, activeUsers, checkedIn };
}

// ============ 帖子列表 ============
router.get('/', async (req, res) => {
  try {
    const boardSlug = req.query.board || '';
    const category = req.query.category || '';
    const sort = req.query.sort || 'newest';
    const tag = req.query.tag || '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let board = null;
    let boardId = null;
    if (boardSlug) {
      const [b] = await pool.query('SELECT * FROM forum_boards WHERE slug = ? LIMIT 1', [boardSlug]);
      if (b && b.length > 0) {
        board = b[0];
        boardId = board.id;
      }
    }

    const { where, params } = buildWhere({ boardId, category, tag });

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM forum_posts fp ${where}`, params
    );
    const total = totalRows[0].cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const offset = (page - 1) * PAGE_SIZE;

    const [posts] = await pool.query(
      `${POST_SELECT} ${where} ORDER BY ${buildOrder(sort)} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    const sidebar = await buildSidebar(req);

    res.render('forum/index', {
      title: board ? board.name : '校园贴吧',
      posts: decorate(posts),
      board,
      activeCategory: category || 'all',
      activeSort: sort,
      activeTag: tag,
      page, totalPages, total,
      postTypes: POST_TYPES,
      ...sidebar
    });
  } catch (err) {
    console.error('贴吧加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// ============ 发帖页 ============
router.get('/new', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const boards = await getBoards();
  res.render('forum/new', {
    title: '发布帖子',
    boards,
    postTypes: POST_TYPES,
    categories: CATEGORY_LABELS
  });
});

// ============ 发布 ============
router.post('/', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { title, content, category, tags, post_type, cover_image, board_id } = req.body;
  if (!content || content.trim().length < 2) {
    return res.status(400).json({ error: '内容不能为空（至少 2 字）' });
  }
  const titleVal = (title && title.trim()) ? title.trim() : content.trim().slice(0, 30);
  const catVal = (category || 'general').trim();
  const tagsVal = tags ? String(tags).trim() : null;
  const typeVal = POST_TYPES[post_type] ? post_type : 'normal';
  const coverVal = (cover_image && cover_image.trim()) ? cover_image.trim() : null;
  const boardVal = board_id ? Number(board_id) : null;
  // 敏感词：标题与正文都扫描，命中则屏蔽并留记录
  const tScan = scan(titleVal);
  const cScan = scan(content.trim());
  const matched = [...new Set([...tScan.matched, ...cScan.matched])];
  const safeTitle = tScan.filtered;
  const safeContent = cScan.filtered;
  try {
    const [result] = await pool.query(
      `INSERT INTO forum_posts (user_id, title, content, category, tags, post_type, cover_image, board_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.session.user.id, safeTitle, safeContent, catVal, tagsVal, typeVal, coverVal, boardVal]
    );
    let postId = result && result.insertId;
    if (!postId) {
      const [r] = await pool.query('SELECT LAST_INSERT_ID() as id');
      postId = r[0].id;
    }
    if (tagsVal) await syncPostTags(postId, tagsVal);
    // 命中敏感词：留下审计记录（原文 + 命中词 + 触发者）
    if (matched.length) {
      await logHit({
        userId: req.session.user.id,
        username: req.session.user.username,
        contentType: 'post',
        contentId: postId,
        matched,
        rawContent: `标题：${titleVal}\n正文：${content.trim()}`
      });
    }
    // 发帖奖励积分（linfeng 积分体系）
    try {
      await pool.query(
        `INSERT INTO user_points (user_id, points, exp) VALUES (?, 5, 5)
         ON DUPLICATE KEY UPDATE points = points + 5, exp = exp + 5`,
        [req.session.user.id]
      );
      await pool.query('UPDATE casdoor_users SET points = points + 5 WHERE id = ?', [req.session.user.id]);
    } catch (e) { /* ignore */ }
    res.redirect('/forum/' + postId);
  } catch (err) {
    console.error('发帖失败:', err);
    res.status(500).json({ error: '发布失败' });
  }
});

// ============ 每日签到 ============
router.post('/checkin', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const userId = req.session.user.id;
  try {
    const [done] = await pool.query(
      'SELECT 1 FROM user_checkins WHERE user_id = ? AND checkin_date = CURDATE() LIMIT 1',
      [userId]
    );
    if (done && done.length > 0) {
      return res.json({ success: false, msg: '今天已经签到过了' });
    }
    await pool.query(
      'INSERT INTO user_checkins (user_id, checkin_date, points) VALUES (?, CURDATE(), 10)',
      [userId]
    );
    await pool.query(
      `INSERT INTO user_points (user_id, points, exp) VALUES (?, 10, 10)
       ON DUPLICATE KEY UPDATE points = points + 10, exp = exp + 10`,
      [userId]
    );
    await pool.query('UPDATE casdoor_users SET points = points + 10 WHERE id = ?', [userId]);
    res.json({ success: true, points: 10, msg: '签到成功，积分 +10' });
  } catch (err) {
    res.status(500).json({ error: '签到失败' });
  }
});

// ============ 帖子详情 ============
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(
      `SELECT fp.*, cu.username, cu.real_name, cu.avatar, b.name as board_name, b.slug as board_slug
       FROM forum_posts fp
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       LEFT JOIN forum_boards b ON fp.board_id = b.id
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
      const [l] = await pool.query(
        'SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', [id, req.session.user.id]
      );
      liked = l && l.length > 0;
    }

    // 楼中楼：按 parent_id 组装成树
    const decorated = comments.map(c => ({
      ...c,
      author: c.real_name || c.username || '匿名',
      replies: []
    }));
    const byId = {};
    decorated.forEach(c => { byId[c.id] = c; });
    const roots = [];
    decorated.forEach(c => {
      if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(c);
      else roots.push(c);
    });

    // 上一篇 / 下一篇
    const [prevRows] = await pool.query(
      'SELECT id, title FROM forum_posts WHERE id < ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1', [id]
    );
    const [nextRows] = await pool.query(
      'SELECT id, title FROM forum_posts WHERE id > ? AND is_deleted = 0 ORDER BY id ASC LIMIT 1', [id]
    );

    const structuredTags = await getPostTagNames(post.id);

    // 是否可删除：本人或管理员
    const isOwner = !!req.session.user && (
      String(req.session.user.id) === String(post.user_id) ||
      req.session.user.is_admin === 1
    );

    res.render('forum/show', {
      title: post.title || '帖子详情',
      isOwner,
      post: {
        ...post,
        author: post.real_name || post.username || '匿名',
        category_label: CATEGORY_LABELS[post.category] || post.category,
        type_label: (POST_TYPES[post.post_type] || POST_TYPES.normal).label,
        type_icon: (POST_TYPES[post.post_type] || POST_TYPES.normal).icon,
        likes: likeCount,
        comments: roots,
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

// ============ 点赞 / 取消 ============
router.post('/like/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const userId = req.session.user.id;
  try {
    const [existing] = await pool.query(
      'SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]
    );
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

// ============ 评论 ============
router.post('/comment/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const { content, parent_id } = req.body;
  if (!content || content.trim().length < 1) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }
  const raw = content.trim();
  const { filtered, matched } = scan(raw);
  try {
    const [result] = await pool.query(
      'INSERT INTO post_comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [postId, req.session.user.id, filtered, parent_id ? Number(parent_id) : null]
    );
    let commentId = result && result.insertId;
    if (!commentId) {
      const [r] = await pool.query('SELECT LAST_INSERT_ID() as id');
      commentId = r[0].id;
    }
    if (matched.length) {
      await logHit({
        userId: req.session.user.id,
        username: req.session.user.username,
        contentType: 'comment',
        contentId: commentId,
        matched,
        rawContent: raw
      });
    }
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
    res.json(comments.map(c => ({ ...c, real_name: c.real_name || c.username || '匿名' })));
  } catch (err) {
    res.json([]);
  }
});

// ============ 举报 ============
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

// ============ 删除自己的帖子（软删除，进回收站） ============
router.post('/delete/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const id = req.params.id;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM forum_posts WHERE id = ? AND is_deleted = 0 LIMIT 1', [id]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: '帖子不存在' });
    const post = rows[0];
    const isOwner = String(post.user_id) === String(req.session.user.id);
    const isAdmin = req.session.user.is_admin === 1;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: '只能删除自己的帖子' });

    await pool.query('UPDATE forum_posts SET is_deleted = 1 WHERE id = ?', [id]);
    // 记入回收站，便于后台恢复
    try {
      await pool.query(
        'INSERT INTO deleted_items (item_type, item_id, deleted_by, data) VALUES (?, ?, ?, ?)',
        ['forum_post', Number(id), req.session.user.id, JSON.stringify({
          title: post.title, content: post.content, user_id: post.user_id
        })]
      );
    } catch (e) { /* 回收站写入失败不影响删除结果 */ }
    res.json({ success: true });
  } catch (err) {
    console.error('删除帖子失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

module.exports = router;
