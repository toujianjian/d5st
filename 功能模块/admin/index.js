const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const casdoor = require('../../配置/casdoor');
const { reconcileCasdoorUsers } = require('../../配置/user-service');

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
