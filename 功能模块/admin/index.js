const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const casdoor = require('../../配置/casdoor');
const { reconcileCasdoorUsers } = require('../../配置/user-service');
const { avatarUpload } = require('../../配置/upload');

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
    // 评论数此前误取私信表(messages)，导致仪表盘「评论数」恒为 0，这里改为统计真实评论
    const [commentCount] = await pool.query('SELECT COUNT(*) as cnt FROM post_comments WHERE is_deleted = 0');
    const [videoCount] = await pool.query('SELECT COUNT(*) as cnt FROM video_posts WHERE is_deleted = 0');
    res.render('admin/index', {
      title: '管理后台',
      syncResult: req.query.sync ? {
        status: req.query.sync,
        synced: parseInt(req.query.synced, 10) || 0,
        removed: parseInt(req.query.removed, 10) || 0
      } : null,
      stats: {
        users: userCount[0].cnt,
        posts: postCount[0].cnt,
        comments: commentCount[0].cnt,
        videos: videoCount[0].cnt,
        pendingReports: reportCount[0].cnt,
        messages: messageCount[0].cnt
      }
    });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 手动触发「与 Casdoor 用户对账」（正向同步 + 清理演示/开发账号）
router.post('/sync-users', async (req, res) => {
  try {
    const r = await reconcileCasdoorUsers(casdoor);
    res.redirect(`/admin?sync=${r.ok ? 'ok' : 'fail'}&synced=${r.synced}&removed=${r.removed}`);
  } catch (e) {
    res.redirect('/admin?sync=fail');
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
    const [rows] = await pool.query('SELECT * FROM forum_posts WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '帖子不存在' });
    await pool.query('UPDATE forum_posts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    await moveToRecycleBin('post', req.params.id, rows[0], req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 写入回收站：软删内容同时快照原数据到 deleted_items，
// 使 /admin/recycle-bin 的恢复/彻底删除真正可用（此前该表从不被写入，回收站永远为空）
async function moveToRecycleBin(itemType, itemId, rowData, req) {
  await pool.query(
    'DELETE FROM deleted_items WHERE item_type = ? AND item_id = ? AND is_restored = 0',
    [itemType, itemId]
  );
  await pool.query(
    'INSERT INTO deleted_items (item_type, item_id, deleted_by, data) VALUES (?, ?, ?, ?)',
    [itemType, itemId, req.session?.user?.id || null, JSON.stringify(rowData)]
  );
}

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
    const [rows] = await pool.query('SELECT * FROM post_comments WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '评论不存在' });
    await pool.query('UPDATE post_comments SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    await moveToRecycleBin('comment', req.params.id, rows[0], req);
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

// ============ 视频管理（融合「校园风采」视频站） ============
router.get('/videos', async (req, res) => {
  try {
    const [videos] = await pool.query(
      `SELECT vp.*, cu.username, cu.real_name FROM video_posts vp
       LEFT JOIN casdoor_users cu ON vp.user_id = cu.id
       ORDER BY vp.created_at DESC LIMIT 200`
    );
    res.render('admin/videos', { title: '视频管理', videos });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/videos/delete/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM video_posts WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '视频不存在' });
    await pool.query('UPDATE video_posts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    await moveToRecycleBin('video', req.params.id, rows[0], req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/videos/toggle-recommend/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT is_recommended FROM video_posts WHERE id = ?', [req.params.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: '视频不存在' });
    const next = rows[0].is_recommended ? 0 : 1;
    await pool.query('UPDATE video_posts SET is_recommended = ? WHERE id = ?', [next, req.params.id]);
    res.json({ success: true, is_recommended: next });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

// ============ 版块管理（融合论坛「圈子/版块」） ============
router.get('/boards', async (req, res) => {
  try {
    const [boards] = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM forum_posts p WHERE p.board_id = b.id AND p.is_deleted = 0) as post_count
       FROM forum_boards b ORDER BY b.sort_order ASC, b.id ASC`
    );
    res.render('admin/boards', { title: '版块管理', boards });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/boards', async (req, res) => {
  const { name, slug, icon, description, sort_order } = req.body;
  if (!name || !slug) return res.redirect('/admin/boards?error=missing');
  try {
    await pool.query(
      `INSERT INTO forum_boards (name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), slug.trim(), (icon || '💬').trim(), (description || '').trim(), parseInt(sort_order, 10) || 0]
    );
    res.redirect('/admin/boards');
  } catch (err) {
    res.redirect('/admin/boards?error=duplicate');
  }
});

router.post('/boards/toggle/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT is_active FROM forum_boards WHERE id = ?', [req.params.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: '版块不存在' });
    const next = rows[0].is_active ? 0 : 1;
    await pool.query('UPDATE forum_boards SET is_active = ? WHERE id = ?', [next, req.params.id]);
    res.json({ success: true, is_active: next });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/boards/delete/:id', async (req, res) => {
  try {
    // 先解绑该版块下的帖子，再删除版块，避免帖子变成孤儿数据
    await pool.query('UPDATE forum_posts SET board_id = NULL WHERE board_id = ?', [req.params.id]);
    await pool.query('DELETE FROM forum_boards WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '操作失败' });
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

// 启用 / 停用全局通知
router.post('/notifications/toggle/:id', async (req, res) => {
  try {
    await pool.query('UPDATE global_notifications SET is_active = 1 - is_active WHERE id = ?', [req.params.id]);
    res.redirect('/admin/notifications');
  } catch (err) {
    res.redirect('/admin/notifications?error=toggle_failed');
  }
});

// 删除全局通知
router.post('/notifications/delete/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM global_notifications WHERE id = ?', [req.params.id]);
    res.redirect('/admin/notifications');
  } catch (err) {
    res.redirect('/admin/notifications?error=delete_failed');
  }
});

// 弹窗「目标页面」可选值。
// key 必须与前端 currentPageKey()（页面模板/layout.ejs）的约定一致：
// 首页为 home，其余取路径第一段（所以 /messages/guestbook 归到 messages）。
const POPUP_PAGES = [
  { key: 'all', label: '全部页面' },
  { key: 'home', label: '首页' },
  { key: 'forum', label: '贴吧论坛' },
  { key: 'videos', label: '视频' },
  { key: 'secret', label: '保密号' },
  { key: 'messages', label: '私信 / 留言板' },
  { key: 'friends', label: '好友' },
  { key: 'user', label: '个人中心' },
  { key: 'search', label: '搜索' },
  { key: 'sponsor', label: '赞助' },
  { key: 'login', label: '登录页' },
  { key: 'register', label: '注册页' },
  { key: 'forgot-password', label: '找回密码' }
];
const POPUP_PAGE_LABELS = POPUP_PAGES.reduce((m, p) => { m[p.key] = p.label; return m; }, {});

// 把勾选框提交的值规范成入库字符串。
// 勾选「全部页面」或一个都没勾 → all（避免出现永远不显示的弹窗）
function normalizeTargetPages(input) {
  const arr = (Array.isArray(input) ? input : String(input == null ? '' : input).split(','))
    .map(s => String(s).trim())
    .filter(Boolean);
  if (arr.length === 0 || arr.includes('all')) return 'all';
  return [...new Set(arr)].join(',');
}

router.get('/popups', async (req, res) => {
  const [popups] = await pool.query('SELECT * FROM popups ORDER BY sort_order ASC, id DESC');
  res.render('admin/popups', {
    title: '弹窗管理',
    popups,
    pages: POPUP_PAGES,
    pageLabels: POPUP_PAGE_LABELS
  });
});

router.post('/popups', async (req, res) => {
  const { title, content, type, target_pages, show_once, start_time, end_time, sort_order } = req.body;
  try {
    await pool.query(
      `INSERT INTO popups (title, content, type, target_pages, show_once, start_time, end_time, sort_order)
       VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)`,
      [title, content, type || 'info', normalizeTargetPages(target_pages), show_once ? 1 : 0, start_time || null, end_time || null, sort_order || 0]
    );
    res.redirect('/admin/popups');
  } catch (err) {
    res.redirect('/admin/popups?error=create_failed');
  }
});

router.get('/popups/edit/:id', async (req, res) => {
  const [popups] = await pool.query('SELECT * FROM popups WHERE id = ?', [req.params.id]);
  if (popups.length === 0) return res.redirect('/admin/popups');
  res.render('admin/popups-edit', {
    title: '编辑弹窗',
    popup: popups[0],
    pages: POPUP_PAGES,
    pageLabels: POPUP_PAGE_LABELS
  });
});

router.post('/popups/edit/:id', async (req, res) => {
  const { title, content, type, target_pages, show_once, start_time, end_time, sort_order, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE popups SET title=?, content=?, type=?, target_pages=?, show_once=?, start_time=NULLIF(?, ''), end_time=NULLIF(?, ''), sort_order=?, is_active=? WHERE id=?`,
      [title, content, type || 'info', normalizeTargetPages(target_pages), show_once ? 1 : 0, start_time || null, end_time || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
    );
    res.redirect('/admin/popups');
  } catch (err) {
    res.redirect('/admin/popups?error=update_failed');
  }
});

// 删除弹窗（此前没有该路由，后台列表也没有删除按钮，弹窗建了就删不掉）
router.post('/popups/delete/:id', async (req, res) => {
  const id = req.params.id;
  try {
    // SQLite 未建外键级联，先清理关闭记录，避免残留脏数据（MySQL 侧有 CASCADE，冗余无害）
    try {
      await pool.query('DELETE FROM popup_views WHERE popup_id = ?', [id]);
    } catch (e) { /* 表不存在时忽略 */ }
    await pool.query('DELETE FROM popups WHERE id = ?', [id]);
    res.redirect('/admin/popups');
  } catch (err) {
    console.error('删除弹窗失败:', err.message);
    res.redirect('/admin/popups?error=delete_failed');
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

// 回收站：恢复已删除的帖子/视频/评论
router.post('/recycle-bin/restore/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM deleted_items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });
    const item = rows[0];
    const map = {
      post: ['forum_posts', 'is_deleted = 0'],
      video: ['video_posts', 'is_deleted = 0'],
      comment: ['post_comments', 'is_deleted = 0']
    };
    const target = map[item.item_type];
    if (!target) return res.status(400).json({ error: '不支持的恢复类型' });
    await pool.query(`UPDATE \`${target[0]}\` SET ${target[1]} WHERE id = ?`, [item.item_id]);
    await pool.query('UPDATE deleted_items SET is_restored = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '恢复失败' });
  }
});

// 回收站：永久删除（真正删除原始记录及其标签关联，不可恢复）
// 说明：原实现只删 deleted_items 行，原始帖子仍停留在 is_deleted=1 的软删状态，
//       其标签关联（post_tags，旧库无外键级联）会继续残留并污染「热门话题」。
router.post('/recycle-bin/purge/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM deleted_items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });
    const item = rows[0];
    const id = item.item_id;

    if (item.item_type === 'post') {
      // 先删标签关联（旧库无外键），再删帖子本体；评论/点赞/举报由外键级联清理
      await pool.query('DELETE FROM post_tags WHERE post_id = ?', [id]);
      await pool.query('DELETE FROM forum_posts WHERE id = ?', [id]);
      // 清理不再被任何帖子引用的标签
      await pool.query('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)');
    } else if (item.item_type === 'video') {
      await pool.query('DELETE FROM video_posts WHERE id = ?', [id]);
    } else if (item.item_type === 'comment') {
      await pool.query('DELETE FROM post_comments WHERE id = ?', [id]);
    }

    await pool.query('DELETE FROM deleted_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('回收站彻底删除失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// ============ 违禁词管理（参考 houbb/sensitive-word 的 DFA 过滤思路） ============
const sensitiveWord = require('../../配置/sensitive-word');

// 词库列表
router.get('/sensitive-words', async (req, res) => {
  try {
    const [words] = await pool.query('SELECT * FROM sensitive_words ORDER BY id DESC');
    const [count] = await pool.query('SELECT COUNT(*) as cnt FROM sensitive_word_logs');
    res.render('admin/sensitive-words', {
      title: '违禁词管理',
      words,
      logCount: count[0] ? count[0].cnt : 0,
      lastLoaded: sensitiveWord.lastLoaded
        ? new Date(sensitiveWord.lastLoaded).toLocaleString('zh-CN')
        : '未加载'
    });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 新增违禁词（支持逗号/空格分隔批量）
router.post('/sensitive-words', async (req, res) => {
  const raw = (req.body.word || '').toString();
  const category = (req.body.category || 'default').toString().trim() || 'default';
  const list = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return res.redirect('/admin/sensitive-words?error=empty');
  let added = 0;
  for (const w of list) {
    try {
      await pool.query(
        'INSERT INTO sensitive_words (word, category) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_disabled = 0, category = ?',
        [w, category, category]
      );
      added++;
    } catch (e) { /* 跳过异常词 */ }
  }
  if (added > 0) await sensitiveWord.reload(); // 即时刷新内存词库
  res.redirect('/admin/sensitive-words?added=' + added);
});

// 删除违禁词
router.post('/sensitive-words/delete/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sensitive_words WHERE id = ?', [req.params.id]);
    await sensitiveWord.reload();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 命中记录（审计日志）
router.get('/sensitive-logs', async (req, res) => {
  try {
    const [logs] = await pool.query(
      'SELECT * FROM sensitive_word_logs ORDER BY created_at DESC LIMIT 200'
    );
    res.render('admin/sensitive-logs', { title: '违禁词拦截记录', logs });
  } catch (err) {
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 清空命中记录
router.post('/sensitive-logs/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM sensitive_word_logs');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '清空失败' });
  }
});

// ============================================================================
// 全库导出：把 d5st 与 casdoor 两个库的全部数据汇成「同一个 CSV」
//
// 为什么是长表：两个库的表结构毫无关系（d5st 35 表 / casdoor 47 表），
// 无法拼成一张宽表，所以采用「库/表/行号/字段/值」的长表格式，
// 同一 (库, 表, 行号) 的多条记录即原始的一行，用数据透视即可还原。
//
// 列：库, 表, 行号, 字段, 值, 是否为空
//   - 行号：该行在表内的 1-based 序号，配合「库+表」唯一确定一行
//   - 是否为空：1 表示该字段是 SQL NULL（此时「值」为空），0 表示有值
//     这样可区分 NULL 与空字符串，导出后仍可还原
// ============================================================================
const CSV_HEADERS = ['库', '表', '行号', '字段', '值', '是否为空'];

// 主库与 Casdoor 库名（可用环境变量覆盖，跟随实际部署）
const MAIN_DB_NAME = process.env.MYSQL_DATABASE || 'd5st';
const CASDOOR_DB_NAME = process.env.CASDOOR_DB_NAME || 'casdoor';

function csvEscape(v) {
  return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
}

function formatDateValue(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 把驱动返回的值规整成可写入 CSV 的文本
function normalizeCell(v) {
  if (v === null || v === undefined) return { text: '', isNull: 1 };
  if (Buffer.isBuffer(v)) return { text: '0x' + v.toString('hex'), isNull: 0 };
  if (v instanceof Date) return { text: formatDateValue(v), isNull: 0 };
  if (typeof v === 'object') return { text: JSON.stringify(v), isNull: 0 };
  return { text: String(v), isNull: 0 };
}

// 列出可导出的「库 + 表」。MySQL 模式只取业务库（排除系统库），
// 且把主库 d5st 与 casdoor 排在前面，便于阅读。
async function listExportTables() {
  const targets = [];
  if (pool.isMysql) {
    const [dbRows] = await pool.query(
      `SELECT schema_name AS db FROM information_schema.schemata
        WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')
        ORDER BY schema_name`
    );
    const found = dbRows.map(r => r.db);
    const preferred = [MAIN_DB_NAME, CASDOOR_DB_NAME].filter(d => found.indexOf(d) > -1);
    const others = found.filter(d => preferred.indexOf(d) === -1);
    for (const database of preferred.concat(others)) {
      // 注意：别名不能叫 rows（MySQL 8 保留字，会语法报错）
      const [tRows] = await pool.query(
        `SELECT table_name AS t, table_rows AS row_count FROM information_schema.tables
          WHERE table_schema = ? AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [database]
      );
      for (const t of tRows) {
        targets.push({ database, table: t.t, approxRows: Number(t.row_count) || 0 });
      }
    }
  } else {
    // SQLite 模式（本地开发）：只有一个本地库，Casdoor 不在其中
    const [tRows] = await pool.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    for (const t of tRows) {
      targets.push({ database: 'sqlite', table: t.name, approxRows: 0 });
    }
  }
  return targets;
}

// 取表内字段顺序（按建表顺序），并顺带取主键用于稳定排序
async function getTableMeta(target) {
  if (pool.isMysql) {
    const [cols] = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [target.database, target.table]
    );
    const [pk] = await pool.query(
      `SELECT column_name AS name FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
        ORDER BY ordinal_position`,
      [target.database, target.table]
    );
    return { columns: cols.map(c => c.name), pk: pk.map(c => c.name) };
  }
  const [info] = await pool.query(`PRAGMA table_info(\`${target.table}\`)`);
  return {
    columns: info.map(c => c.name),
    pk: info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name)
  };
}

// 把「全库数据」以 CSV 流式写出（边读边写，避免把整库拼成一个大字符串）
async function streamAllDataCsv(res, onlyDatabases) {
  const all = await listExportTables();
  const targets = onlyDatabases && onlyDatabases.length
    ? all.filter(t => onlyDatabases.indexOf(t.database) > -1)
    : all;

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="d5st-all-databases-' + stamp + '.csv"');
  // BOM：Excel 打开中文不乱码
  res.write('\uFEFF' + CSV_HEADERS.join(',') + '\r\n');

  for (const target of targets) {
    const meta = await getTableMeta(target);
    if (meta.columns.length === 0) continue;

    const colList = meta.columns.map(c => '`' + c + '`').join(',');
    const from = pool.isMysql
      ? '`' + target.database + '`.`' + target.table + '`'
      : '`' + target.table + '`';
    // 有主键就按主键排序，保证每次导出顺序一致（便于 diff）
    const order = meta.pk.length
      ? ' ORDER BY ' + meta.pk.map(c => '`' + c + '`').join(', ')
      : '';

    const [rows] = await pool.query('SELECT ' + colList + ' FROM ' + from + order);

    // 空表：显式写一行标记（行号 0），否则该表在 CSV 里完全没有痕迹，
    // 无法分辨「表不存在」还是「表存在但没数据」。
    if (rows.length === 0) {
      res.write([
        csvEscape(target.database),
        csvEscape(target.table),
        csvEscape(0),
        csvEscape('(空表，无数据)'),
        csvEscape(''),
        csvEscape('')
      ].join(',') + '\r\n');
      continue;
    }

    let rowNo = 0;
    for (const row of rows) {
      rowNo++;
      for (const col of meta.columns) {
        const cell = normalizeCell(row[col]);
        res.write([
          csvEscape(target.database),
          csvEscape(target.table),
          csvEscape(rowNo),
          csvEscape(col),
          csvEscape(cell.text),
          csvEscape(cell.isNull)
        ].join(',') + '\r\n');
      }
    }
  }
  res.end();
}

router.get('/export-all', async (req, res) => {
  try {
    const targets = await listExportTables();

    if ((req.query.format || '').toLowerCase() === 'csv') {
      const dbs = [].concat(req.query.db || []).filter(Boolean);
      return await streamAllDataCsv(res, dbs);
    }

    // 按库聚合出预览统计
    const byDb = {};
    for (const t of targets) {
      if (!byDb[t.database]) byDb[t.database] = { database: t.database, tables: 0, rows: 0 };
      byDb[t.database].tables++;
      byDb[t.database].rows += t.approxRows;
    }

    res.render('admin/export-all', {
      title: '导出全部数据',
      databases: Object.keys(byDb).map(k => byDb[k]),
      targets,
      tableCount: targets.length,
      approxRows: targets.reduce((s, t) => s + t.approxRows, 0),
      isMysql: pool.isMysql,
      mainDb: MAIN_DB_NAME,
      casdoorDb: CASDOOR_DB_NAME
    });
  } catch (err) {
    console.error('导出全部数据失败:', err.message);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// ============================================================
// 用户管理
// ------------------------------------------------------------
// 昵称 / 头像 / 年级 / 班级 / 学号 / 积分 / 管理员 —— 这些字段 Casdoor 里
// 没有对应项（Casdoor 只认 username、displayName、avatar、email、phone），
// 只能在本站维护。此前后台完全没有入口，管理员改不了，只能让用户自己去个人中心改。
// ============================================================
const USER_COLUMNS = 'id, username, nickname, real_name, avatar, email, phone, grade, class_name, student_no, points, is_admin, created_at';

router.get('/users', async (req, res) => {
  try {
    const kw = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PAGE_SIZE = 50;
    const offset = (page - 1) * PAGE_SIZE;

    let where = '';
    const params = [];
    if (kw) {
      where = 'WHERE username LIKE ? OR nickname LIKE ? OR real_name LIKE ? OR student_no LIKE ?';
      const like = '%' + kw + '%';
      params.push(like, like, like, like);
    }

    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM casdoor_users ${where}`, params);
    const total = (countRows[0] && countRows[0].cnt) || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const [users] = await pool.query(
      `SELECT ${USER_COLUMNS},
        (SELECT COUNT(*) FROM forum_posts fp WHERE fp.user_id = casdoor_users.id AND fp.is_deleted = 0) as post_count
       FROM casdoor_users ${where}
       ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    // 哪些用户在本站传过头像（user_avatars）
    let avatarIds = new Set();
    try {
      const [rows] = await pool.query('SELECT user_id FROM user_avatars');
      avatarIds = new Set(rows.map(r => r.user_id));
    } catch (e) { /* 表可能不存在，忽略 */ }

    res.render('admin/users', {
      title: '用户管理',
      users: users.map(u => ({ ...u, has_avatar: avatarIds.has(u.id) })),
      q: kw,
      page, totalPages, total,
      notice: req.query.ok ? String(req.query.ok) : null,
      errorMsg: req.query.error ? String(req.query.error) : null
    });
  } catch (err) {
    console.error('用户管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 保存管理员修改的用户资料（本地字段）
router.post('/users/edit/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/users?error=' + encodeURIComponent('参数错误'));

  const b = req.body || {};
  const nickname = String(b.nickname || '').trim() || null;
  const realName = String(b.real_name || '').trim() || null;
  const grade = String(b.grade || '').trim() || null;
  const className = String(b.class_name || '').trim() || null;
  const studentNo = String(b.student_no || '').trim() || null;
  const points = Math.max(0, parseInt(b.points, 10) || 0);
  let adminFlag = b.is_admin ? 1 : 0;

  try {
    // 先确认用户存在：否则 UPDATE 影响 0 行却仍提示「已保存」，会误导管理员
    // （不能用 affectedRows 判断 —— 数据没变化时 MySQL 同样返回 0）
    const [exists] = await pool.query('SELECT id FROM casdoor_users WHERE id = ? LIMIT 1', [id]);
    if (!exists || exists.length === 0) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('用户不存在（id ' + id + '）'));
    }

    // 防呆：不能把最后一个管理员降权（否则没人能进后台了）
    if (adminFlag === 0) {
      const [cntRows] = await pool.query('SELECT COUNT(*) as cnt FROM casdoor_users WHERE is_admin = 1');
      if (((cntRows[0] && cntRows[0].cnt) || 0) <= 1) adminFlag = 1;
    }

    await pool.query(
      `UPDATE casdoor_users
       SET nickname = ?, real_name = ?, grade = ?, class_name = ?, student_no = ?, points = ?, is_admin = ?
       WHERE id = ?`,
      [nickname, realName, grade, className, studentNo, points, adminFlag, id]
    );

    // 改到的是当前登录管理员自己时，同步刷新 session，避免顶栏还是旧值
    if (req.session.user && req.session.user.id === id) {
      req.session.user.nickname = nickname;
      req.session.user.real_name = realName || req.session.user.username;
      req.session.user.is_admin = adminFlag;
    }

    res.redirect('/admin/users?ok=' + encodeURIComponent('已保存') + '#u' + id);
  } catch (err) {
    console.error('用户资料保存失败:', err);
    res.redirect('/admin/users?error=' + encodeURIComponent('保存失败') + '#u' + id);
  }
});

// 管理员代传头像（与个人中心同一套：存 user_avatars 表 + avatar 指向本地输出地址）
router.post('/users/avatar/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/users?error=' + encodeURIComponent('参数错误'));

  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '头像不能超过 3MB' : (err.message || '上传失败');
      return res.redirect('/admin/users?error=' + encodeURIComponent(msg) + '#u' + id);
    }
    if (!req.file) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('请先选择图片文件') + '#u' + id);
    }
    try {
      await pool.query(
        `INSERT INTO user_avatars (user_id, mime, data) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
        [id, req.file.mimetype, req.file.buffer]
      );
      await pool.query('UPDATE casdoor_users SET avatar = ? WHERE id = ?', ['/avatar/' + id, id]);
      if (req.session.user && req.session.user.id === id) req.session.user.avatar = '/avatar/' + id;
      res.redirect('/admin/users?ok=' + encodeURIComponent('头像已更新') + '#u' + id);
    } catch (e) {
      console.error('管理员保存头像失败:', e);
      res.redirect('/admin/users?error=' + encodeURIComponent('头像保存失败') + '#u' + id);
    }
  });
});

// 删除用户的本地头像（只清本站上传的，不动 Casdoor 自带的外链头像）
router.post('/users/avatar/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/admin/users?error=' + encodeURIComponent('参数错误'));
  try {
    await pool.query('DELETE FROM user_avatars WHERE user_id = ?', [id]);
    await pool.query("UPDATE casdoor_users SET avatar = NULL WHERE id = ? AND avatar LIKE '/avatar/%'", [id]);
    if (req.session.user && req.session.user.id === id) req.session.user.avatar = null;
    res.redirect('/admin/users?ok=' + encodeURIComponent('头像已删除') + '#u' + id);
  } catch (e) {
    console.error('删除头像失败:', e);
    res.redirect('/admin/users?error=' + encodeURIComponent('删除失败') + '#u' + id);
  }
});

router.get('/export-users', async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, real_name, grade, class_name, student_no, points, is_admin, created_at FROM casdoor_users ORDER BY id');
    // ?format=csv 时直接返回 CSV 文件下载（带 Excel 友好的 BOM，避免中文乱码）
    if ((req.query.format || '').toLowerCase() === 'csv') {
      const headers = ['ID', '用户名', '真实姓名', '年级', '班级', '学号', '积分', '管理员', '注册时间'];
      const escape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [headers.join(',')];
      for (const u of users) {
        lines.push([
          u.id, u.username, u.real_name, u.grade, u.class_name, u.student_no,
          u.points || 0, u.is_admin ? '是' : '否',
          new Date(u.created_at).toLocaleString('zh-CN')
        ].map(escape).join(','));
      }
      const csv = '\uFEFF' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="d5st-users-' + new Date().toISOString().slice(0, 10) + '.csv"');
      return res.send(csv);
    }
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
