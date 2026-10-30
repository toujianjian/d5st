const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const { scan, logHit } = require('../sensitive-check');
const { rateLimit, requireId, cleanShort, cleanText, parsePage } = require('../../配置/security');

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
// 方言差异：MySQL 的 ON DUPLICATE KEY UPDATE / CURDATE() 在 SQLite 下不可用，
// 本地开发（SQLite）会用整条语句报错，所以按驱动分支。
const IS_MYSQL = pool.isMysql;
const TODAY = IS_MYSQL ? 'CURDATE()' : "date('now','localtime')";
// 取刚插入行的自增 id（SQLite 用 last_insert_rowid()）
const LAST_ID_SQL = IS_MYSQL ? 'SELECT LAST_INSERT_ID() as id' : 'SELECT last_insert_rowid() as id';

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
function buildWhere({ boardId, category, tag, onlyFeatured }) {
  let where = 'WHERE fp.is_deleted = 0';
  const params = [];
  // 未登录访客只能看「精选」= 后台标记的置顶 / 精华帖
  if (onlyFeatured) {
    where += ' AND (fp.is_top = 1 OR fp.is_hot = 1)';
  }
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
  // 白名单：sort 来自 query，绝不能直接拼进 SQL。
  // 之前虽已用 if 分支兜底，这里改为显式映射表，杜绝后续加分支时误拼。
  const ORDERS = {
    newest: 'fp.is_top DESC, fp.created_at DESC',
    hot: 'fp.is_top DESC, like_count DESC, fp.created_at DESC',
    essence: 'fp.is_top DESC, fp.is_hot DESC, fp.created_at DESC'
  };
  return ORDERS[sort] || ORDERS.newest;
}

const POST_SELECT = `
  SELECT fp.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar,
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
    // 只统计「存在且未删除」的帖子：否则帖子被删后残留的标签关联
    // （post_tags 无外键级联、或帖子被软删）会让热门话题显示已不存在的标签。
    const [tagsRows] = await pool.query(
      `SELECT t.name, COUNT(*) as cnt FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN forum_posts fp ON fp.id = pt.post_id AND fp.is_deleted = 0
       GROUP BY t.id ORDER BY cnt DESC LIMIT 15`
    );
    popularTags = tagsRows;
  } catch (e) { /* 表不存在时忽略 */ }

  let activeUsers = [];
  try {
    const [rows] = await pool.query(
      `SELECT cu.id, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar, COUNT(fp.id) as post_count
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
        `SELECT 1 FROM user_checkins WHERE user_id = ? AND checkin_date = ${TODAY} LIMIT 1`,
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
    const page = parsePage(req.query.page);

    let board = null;
    let boardId = null;
    if (boardSlug) {
      const [b] = await pool.query('SELECT * FROM forum_boards WHERE slug = ? LIMIT 1', [boardSlug]);
      if (b && b.length > 0) {
        board = b[0];
        boardId = board.id;
      }
    }

    // 未登录访客只看精选（置顶/精华）
    const isGuest = !req.session.user;
    const { where, params } = buildWhere({ boardId, category, tag, onlyFeatured: isGuest });

    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM forum_posts fp ${where}`, params
    );
    const total = totalRows[0].cnt || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const offset = (page - 1) * PAGE_SIZE;

    const [posts] = await pool.query(
      `${POST_SELECT} ${where} ORDER BY ${buildOrder(sort)} LIMIT ? OFFSET ?`,
      params.concat([PAGE_SIZE, offset])
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
      isGuest,
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
// 限流：每用户 10 分钟最多 10 帖，防刷屏/灌水
router.post('/', rateLimit({ name: 'post-create', window: 10 * 60 * 1000, max: 10, keyBy: 'user' }), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { title, content, category, tags, post_type, cover_image, board_id } = req.body;
  // 统一裁剪长度并剥除控制字符（数据库列宽有限，超长会直接 500）
  const contentRaw = cleanText(content, 20000);
  if (!contentRaw || contentRaw.trim().length < 2) {
    return res.status(400).json({ error: '内容不能为空（至少 2 字）' });
  }
  const titleRaw = cleanShort(title, 200);
  const titleVal = titleRaw || contentRaw.trim().slice(0, 30);
  // 分类必须是已知值，否则列表页筛选与样式都会错乱
  const catVal = CATEGORY_LABELS[category] ? category : 'general';
  const tagsVal = tags ? cleanShort(tags, 500) : null;
  const typeVal = POST_TYPES[post_type] ? post_type : 'normal';
  const coverVal = (cover_image && String(cover_image).trim()) ? cleanShort(cover_image, 500) : null;
  const boardNum = board_id ? parseInt(board_id, 10) : null;
  const boardVal = Number.isSafeInteger(boardNum) && boardNum > 0 ? boardNum : null;
  // 敏感词：标题与正文都扫描，命中则屏蔽并留记录
  const tScan = scan(titleVal);
  const cScan = scan(contentRaw.trim());
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
      const [r] = await pool.query(LAST_ID_SQL);
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
        rawContent: `标题：${titleVal}\n正文：${contentRaw.trim()}`
      });
    }
    // 发帖奖励积分（linfeng 积分体系）
    try {
      await pool.query(
        IS_MYSQL
          ? `INSERT INTO user_points (user_id, points, exp) VALUES (?, 5, 5)
             ON DUPLICATE KEY UPDATE points = points + 5, exp = exp + 5`
          : `INSERT INTO user_points (user_id, points, exp) VALUES (?, 5, 5)
             ON CONFLICT(user_id) DO UPDATE SET points = points + 5, exp = exp + 5`,
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
      `SELECT 1 FROM user_checkins WHERE user_id = ? AND checkin_date = ${TODAY} LIMIT 1`,
      [userId]
    );
    if (done && done.length > 0) {
      return res.json({ success: false, msg: '今天已经签到过了' });
    }
    await pool.query(
      `INSERT INTO user_checkins (user_id, checkin_date, points) VALUES (?, ${TODAY}, 10)`,
      [userId]
    );
    await pool.query(
      IS_MYSQL
        ? `INSERT INTO user_points (user_id, points, exp) VALUES (?, 10, 10)
           ON DUPLICATE KEY UPDATE points = points + 10, exp = exp + 10`
        : `INSERT INTO user_points (user_id, points, exp) VALUES (?, 10, 10)
           ON CONFLICT(user_id) DO UPDATE SET points = points + 10, exp = exp + 10`,
      [userId]
    );
    await pool.query('UPDATE casdoor_users SET points = points + 10 WHERE id = ?', [userId]);
    res.json({ success: true, points: 10, msg: '签到成功，积分 +10' });
  } catch (err) {
    console.error('签到失败:', err.message);
    res.status(500).json({ error: '签到失败' });
  }
});

// ============ 帖子详情 ============
router.get('/:id', requireId('id'), async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(
      `SELECT fp.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar, b.name as board_name, b.slug as board_slug
       FROM forum_posts fp
       LEFT JOIN casdoor_users cu ON fp.user_id = cu.id
       LEFT JOIN forum_boards b ON fp.board_id = b.id
       WHERE fp.id = ? AND fp.is_deleted = 0 LIMIT 1`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).render('errors/404', { title: '帖子不存在' });
    const post = rows[0];

    // 未登录访客只能看精选帖（后台标记的置顶/精华），其余引导登录
    if (!req.session.user && !post.is_top && !post.is_hot) {
      return res.redirect('/login?next=' + encodeURIComponent('/forum/' + id));
    }

    await pool.query('UPDATE forum_posts SET views = views + 1 WHERE id = ?', [id]);

    const [comments] = await pool.query(
      `SELECT pc.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar FROM post_comments pc
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
router.post('/like/:id', requireId('id'), rateLimit({ name: 'like', window: 60 * 1000, max: 60, keyBy: 'user' }), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const userId = req.session.user.id;
  try {
    // 先确认帖子存在且未删除，避免给任意 id 刷点赞记录（脏数据/枚举）
    const [p] = await pool.query('SELECT id FROM forum_posts WHERE id = ? AND is_deleted = 0 LIMIT 1', [postId]);
    if (!p || p.length === 0) return res.status(404).json({ error: '帖子不存在' });
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
router.post('/comment/:id', requireId('id'), rateLimit({ name: 'comment', window: 60 * 1000, max: 20, keyBy: 'user' }), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const postId = req.params.id;
  const { content, parent_id } = req.body;
  const raw = cleanText(content, 5000).trim();
  if (!raw) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }
  const { filtered, matched } = scan(raw);
  // parent_id 必须是正整数，且确实属于同一帖子（防止跨帖引用与类型混淆）
  let parentVal = null;
  if (parent_id !== undefined && parent_id !== null && parent_id !== '') {
    const p = parseInt(parent_id, 10);
    if (Number.isSafeInteger(p) && p > 0) {
      const [pc] = await pool.query(
        'SELECT id FROM post_comments WHERE id = ? AND post_id = ? LIMIT 1', [p, postId]
      );
      if (pc && pc.length > 0) parentVal = p;
    }
  }
  try {
    const [postRows] = await pool.query(
      'SELECT id FROM forum_posts WHERE id = ? AND is_deleted = 0 LIMIT 1', [postId]
    );
    if (!postRows || postRows.length === 0) return res.status(404).json({ error: '帖子不存在' });
    const [result] = await pool.query(
      'INSERT INTO post_comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [postId, req.session.user.id, filtered, parentVal]
    );
    let commentId = result && result.insertId;
    if (!commentId) {
      const [r] = await pool.query(LAST_ID_SQL);
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

router.get('/comments/:id', requireId('id'), async (req, res) => {
  try {
    const [comments] = await pool.query(
      `SELECT pc.*, cu.username, COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS real_name, cu.avatar FROM post_comments pc
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
router.post('/report/:id', requireId('id'), rateLimit({ name: 'report', window: 60 * 60 * 1000, max: 20, keyBy: 'user' }), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  const { reason } = req.body;
  const reasonVal = cleanShort(reason, 500) || '';
  try {
    // 校验目标帖子存在，避免向 reports 灌入指向不存在帖子的脏记录
    const [p] = await pool.query(
      'SELECT id FROM forum_posts WHERE id = ? AND is_deleted = 0 LIMIT 1', [req.params.id]
    );
    if (!p || p.length === 0) return res.status(404).json({ error: '帖子不存在' });
    // 同一用户对同一帖子重复举报无意义，直接幂等返回
    const [dup] = await pool.query(
      'SELECT id FROM reports WHERE post_id = ? AND reporter_id = ? LIMIT 1',
      [req.params.id, req.session.user.id]
    );
    if (dup && dup.length > 0) return res.json({ success: true, duplicate: true });
    await pool.query(
      'INSERT INTO reports (post_id, reporter_id, reason) VALUES (?, ?, ?)',
      [req.params.id, req.session.user.id, reasonVal]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '举报失败' });
  }
});

// ============ 删除自己的帖子（软删除，进回收站） ============
router.post('/delete/:id', requireId('id'), async (req, res) => {
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
