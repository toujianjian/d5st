'use strict';
// ============================================================
// 后台扩展管理模块
// ------------------------------------------------------------
// 补齐原后台缺失的管理能力（原先只有 15 个入口，很多表在后台完全看不到）：
//   留言板 / 私信 / 赞助记录 / 标签 / 勋章 / 积分与签到 / 保密号 / 学生名册
// 另外补上帖子与评论的「编辑」（原后台只能删）。
//
// 约定：
//   - 本路由在 admin/index.js 里以 router.use(require('./extra')) 挂载，
//     因此已经继承了 requireAdmin 鉴权与后台限流，这里不重复实现。
//   - 同时兼容 MySQL 与 SQLite（本地开发），避免出现只有一半功能能用。
// ============================================================
const express = require('express');
const router = express.Router();
const pool = require('../../配置/db');
const { requireId, cleanShort, cleanText, parsePage } = require('../../配置/security');

const IS_MYSQL = pool.isMysql;
const PAGE_SIZE = 30;

// 统一的分页参数解析
function pageParams(req, size = PAGE_SIZE) {
  const page = parsePage(req.query.page, 10000);
  return { page, size, offset: (page - 1) * size };
}

// 安全的 LIKE 片段。
// 注意：这里**不**把 % _ 反斜杠转义成 `\_` 那种写法 ——
// 「反斜杠是否算转义符」在 MySQL 与 SQLite 下行为不同：
//   MySQL 默认把 `\` 当转义符，SQLite 默认不当（要显式 ESCAPE）。
// 之前统一加 `\` 前缀，结果 SQLite 下带下划线的关键词（如 audit_123）永远搜不到。
// 现在改为：用 ESCAPE '!' 显式声明转义符，两个引擎行为一致，
// 且不会依赖反斜杠的方言差异。
function likeOf(kw) {
  const s = String(kw == null ? '' : kw).replace(/[!%_]/g, c => '!' + c);
  return '%' + s + '%';
}
// 需要在 SQL 里配合 LIKE ? ESCAPE '!' 使用

// 回跳时保留提示信息
function backWith(res, path, key, msg) {
  res.redirect(path + '?' + key + '=' + encodeURIComponent(msg));
}

// 目标记录是否存在（用于删除前校验，避免静默成功）
async function exists(table, id) {
  try {
    const [rows] = await pool.query(`SELECT id FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
    return rows && rows.length > 0;
  } catch (e) { return false; }
}

// ------------------------------------------------------------
// 留言板
// ------------------------------------------------------------
router.get('/guestbook', async (req, res) => {
  try {
    const { page, size, offset } = pageParams(req);
    const kw = cleanShort(req.query.q, 100);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE g.content LIKE ? ESCAPE '!' OR g.author_name LIKE ? ESCAPE '!'";
      params.push(likeOf(kw), likeOf(kw));
    }
    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM guestbook g ${where}`, params);
    const total = (countRows[0] && countRows[0].cnt) || 0;
    const [rows] = await pool.query(
      `SELECT g.*, cu.username FROM guestbook g
       LEFT JOIN casdoor_users cu ON g.author_id = cu.id
       ${where} ORDER BY g.created_at DESC LIMIT ? OFFSET ?`,
      params.concat([size, offset])
    );
    res.render('admin/guestbook', {
      title: '留言板管理',
      messages: rows,
      q: kw,
      page, total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('留言板管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/guestbook/delete/:id', requireId('id'), async (req, res) => {
  try {
    if (!await exists('guestbook', req.params.id)) {
      return backWith(res, '/admin/guestbook', 'ok', '留言不存在（可能已被删除）');
    }
    await pool.query('DELETE FROM guestbook WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/guestbook', 'ok', '已删除 1 条留言');
  } catch (err) {
    console.error('删除留言失败:', err);
    backWith(res, '/admin/guestbook', 'ok', '删除失败');
  }
});

// ------------------------------------------------------------
// 私信
// ------------------------------------------------------------
router.get('/messages', async (req, res) => {
  try {
    const { page, size, offset } = pageParams(req);
    const kw = cleanShort(req.query.q, 100);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE m.content LIKE ? ESCAPE '!'";
      params.push(likeOf(kw));
    }
    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM messages m ${where}`, params);
    const total = (countRows[0] && countRows[0].cnt) || 0;

    // 一条 SQL 带上收发双方名字，避免 N+1
    const [rows] = await pool.query(
      `SELECT m.*,
         su.username AS sender_name, COALESCE(NULLIF(su.nickname,''), NULLIF(su.real_name,''), su.username) AS sender_show,
         ru.username AS receiver_name, COALESCE(NULLIF(ru.nickname,''), NULLIF(ru.real_name,''), ru.username) AS receiver_show
       FROM messages m
       LEFT JOIN casdoor_users su ON m.sender_id = su.id
       LEFT JOIN casdoor_users ru ON m.receiver_id = ru.id
       ${where}
       ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      params.concat([size, offset])
    );

    const [statRows] = await pool.query(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM messages'
    );
    const stat = statRows[0] || { total: 0, unread: 0 };

    res.render('admin/messages', {
      title: '私信管理',
      messages: rows,
      q: kw,
      page, total, stat,
      totalPages: Math.max(1, Math.ceil(total / size)),
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('私信管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/messages/delete/:id', requireId('id'), async (req, res) => {
  try {
    if (!await exists('messages', req.params.id)) {
      return backWith(res, '/admin/messages', 'ok', '私信不存在');
    }
    await pool.query('DELETE FROM messages WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/messages', 'ok', '已删除 1 条私信');
  } catch (err) {
    console.error('删除私信失败:', err);
    backWith(res, '/admin/messages', 'ok', '删除失败');
  }
});

// ------------------------------------------------------------
// 赞助记录
// ------------------------------------------------------------
router.get('/sponsors', async (req, res) => {
  try {
    const { page, size, offset } = pageParams(req);
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM sponsor_transactions');
    const total = (countRows[0] && countRows[0].cnt) || 0;

    const [rows] = await pool.query(
      `SELECT st.*, cu.username,
         COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS user_show
       FROM sponsor_transactions st
       LEFT JOIN casdoor_users cu ON st.user_id = cu.id
       ORDER BY st.created_at DESC LIMIT ? OFFSET ?`,
      [size, offset]
    );

    const [sumRows] = await pool.query(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(amount_yuan), 0) AS amount,
              COALESCE(SUM(points_added), 0) AS points
       FROM sponsor_transactions WHERE status = 'success'`
    );
    const summary = sumRows[0] || { cnt: 0, amount: 0, points: 0 };

    res.render('admin/sponsors', {
      title: '赞助记录',
      sponsors: rows,
      summary,
      page, total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('赞助记录加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/sponsors/delete/:id', requireId('id'), async (req, res) => {
  try {
    if (!await exists('sponsor_transactions', req.params.id)) {
      return backWith(res, '/admin/sponsors', 'ok', '记录不存在');
    }
    await pool.query('DELETE FROM sponsor_transactions WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/sponsors', 'ok', '已删除 1 条赞助记录（不会自动扣减用户积分）');
  } catch (err) {
    console.error('删除赞助记录失败:', err);
    backWith(res, '/admin/sponsors', 'ok', '删除失败');
  }
});

// ------------------------------------------------------------
// 标签
// ------------------------------------------------------------
router.get('/tags', async (req, res) => {
  try {
    const kw = cleanShort(req.query.q, 50);
    let where = '';
    const params = [];
    if (kw) { where = "WHERE t.name LIKE ? ESCAPE '!'"; params.push(likeOf(kw)); }

    const [rows] = await pool.query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM post_tags pt
           JOIN forum_posts fp ON fp.id = pt.post_id AND fp.is_deleted = 0
         WHERE pt.tag_id = t.id) AS used_count
       FROM tags t ${where}
       ORDER BY used_count DESC, t.id DESC LIMIT 300`,
      params
    );
    res.render('admin/tags', {
      title: '标签管理',
      tags: rows,
      q: kw,
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('标签管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/tags/delete/:id', requireId('id'), async (req, res) => {
  try {
    const id = req.params.id;
    if (!await exists('tags', id)) {
      return backWith(res, '/admin/tags', 'ok', '标签不存在');
    }
    await pool.query('DELETE FROM post_tags WHERE tag_id = ?', [id]);
    await pool.query('DELETE FROM tags WHERE id = ?', [id]);
    backWith(res, '/admin/tags', 'ok', '已删除标签及其关联');
  } catch (err) {
    console.error('删除标签失败:', err);
    backWith(res, '/admin/tags', 'ok', '删除失败');
  }
});

// 合并标签：把 from 的全部关联转到 to，再删掉 from
router.post('/tags/merge', async (req, res) => {
  const from = parseInt(req.body.from_id, 10);
  const to = parseInt(req.body.to_id, 10);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= 0) {
    return backWith(res, '/admin/tags', 'ok', '请填写两个有效的标签 ID');
  }
  if (from === to) return backWith(res, '/admin/tags', 'ok', '源标签和目标标签不能相同');
  try {
    if (!await exists('tags', from) || !await exists('tags', to)) {
      return backWith(res, '/admin/tags', 'ok', '标签 ID 不存在');
    }
    // 先尝试迁移关联；重复关联（同一帖子同一标签）直接忽略
    const IGNORE = IS_MYSQL ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    const [links] = await pool.query('SELECT post_id FROM post_tags WHERE tag_id = ?', [from]);
    for (const row of links) {
      await pool.query(`${IGNORE} INTO post_tags (post_id, tag_id) VALUES (?, ?)`, [row.post_id, to]);
    }
    await pool.query('DELETE FROM post_tags WHERE tag_id = ?', [from]);
    await pool.query('DELETE FROM tags WHERE id = ?', [from]);
    backWith(res, '/admin/tags', 'ok', `已把 ${links.length} 条关联合并到标签 #${to}，并删除 #${from}`);
  } catch (err) {
    console.error('合并标签失败:', err);
    backWith(res, '/admin/tags', 'ok', '合并失败');
  }
});

// ------------------------------------------------------------
// 勋章
// ------------------------------------------------------------
router.get('/medals', async (req, res) => {
  try {
    const kw = cleanShort(req.query.q, 100);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE um.medal_name LIKE ? ESCAPE '!' OR um.medal_type LIKE ? ESCAPE '!' OR cu.username LIKE ? ESCAPE '!'";
      params.push(likeOf(kw), likeOf(kw), likeOf(kw));
    }
    const [rows] = await pool.query(
      `SELECT um.*, cu.username,
         COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS user_show
       FROM user_medals um
       LEFT JOIN casdoor_users cu ON um.user_id = cu.id
       ${where} ORDER BY um.earned_at DESC LIMIT 300`,
      params
    );
    // 现有勋章类型（供表单下拉）
    const [types] = await pool.query(
      'SELECT medal_type, medal_name, COUNT(*) AS cnt FROM user_medals GROUP BY medal_type, medal_name ORDER BY cnt DESC'
    );
    res.render('admin/medals', {
      title: '勋章管理',
      medals: rows,
      types,
      q: kw,
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('勋章管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 授予勋章
router.post('/medals/grant', async (req, res) => {
  const userId = parseInt(req.body.user_id, 10);
  const type = cleanShort(req.body.medal_type, 50);
  const name = cleanShort(req.body.medal_name, 100);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return backWith(res, '/admin/medals', 'ok', '用户 ID 无效');
  }
  if (!type || !name) return backWith(res, '/admin/medals', 'ok', '勋章类型与名称都要填');
  try {
    const [u] = await pool.query('SELECT id FROM casdoor_users WHERE id = ? LIMIT 1', [userId]);
    if (!u || u.length === 0) return backWith(res, '/admin/medals', 'ok', '用户不存在');
    // user_medals 上 (user_id, medal_type) 唯一 —— 重复授予应当幂等而非报错
    const [dup] = await pool.query(
      'SELECT id FROM user_medals WHERE user_id = ? AND medal_type = ? LIMIT 1', [userId, type]
    );
    if (dup && dup.length > 0) {
      await pool.query('UPDATE user_medals SET medal_name = ? WHERE id = ?', [name, dup[0].id]);
      return backWith(res, '/admin/medals', 'ok', '该用户已有此勋章，已更新名称');
    }
    await pool.query(
      'INSERT INTO user_medals (user_id, medal_type, medal_name) VALUES (?, ?, ?)', [userId, type, name]
    );
    backWith(res, '/admin/medals', 'ok', '已授予勋章');
  } catch (err) {
    console.error('授予勋章失败:', err);
    backWith(res, '/admin/medals', 'ok', '授予失败');
  }
});

router.post('/medals/delete/:id', requireId('id'), async (req, res) => {
  try {
    await pool.query('DELETE FROM user_medals WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/medals', 'ok', '已撤销勋章');
  } catch (err) {
    console.error('撤销勋章失败:', err);
    backWith(res, '/admin/medals', 'ok', '撤销失败');
  }
});

// ------------------------------------------------------------
// 积分与签到
// ------------------------------------------------------------
router.get('/points', async (req, res) => {
  try {
    const { page, size, offset } = pageParams(req, 50);
    const kw = cleanShort(req.query.q, 100);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE cu.username LIKE ? ESCAPE '!' OR cu.nickname LIKE ? ESCAPE '!' OR cu.real_name LIKE ? ESCAPE '!'";
      params.push(likeOf(kw), likeOf(kw), likeOf(kw));
    }
    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM casdoor_users cu ${where}`, params);
    const total = (countRows[0] && countRows[0].cnt) || 0;

    const [users] = await pool.query(
      `SELECT cu.id, cu.username, cu.points,
         COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS user_show,
         (SELECT COUNT(*) FROM user_checkins c WHERE c.user_id = cu.id) AS checkin_days,
         (SELECT MAX(checkin_date) FROM user_checkins c WHERE c.user_id = cu.id) AS last_checkin
       FROM casdoor_users cu
       ${where} ORDER BY cu.points DESC, cu.id ASC LIMIT ? OFFSET ?`,
      params.concat([size, offset])
    );

    // 最近签到流水
    const [checkins] = await pool.query(
      `SELECT c.*, cu.username FROM user_checkins c
       LEFT JOIN casdoor_users cu ON c.user_id = cu.id
       ORDER BY c.id DESC LIMIT 30`
    ).catch(() => [[]]);

    res.render('admin/points', {
      title: '积分与签到',
      users,
      checkins,
      q: kw,
      page, total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('积分页加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 调整积分：delta 可正可负，同步 casdoor_users 与 user_points 两张表
router.post('/points/adjust', async (req, res) => {
  const userId = parseInt(req.body.user_id, 10);
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) return backWith(res, '/admin/points', 'ok', '用户 ID 无效');
  if (!Number.isSafeInteger(delta) || delta === 0) return backWith(res, '/admin/points', 'ok', '调整值必须是非零整数');
  if (Math.abs(delta) > 1000000) return backWith(res, '/admin/points', 'ok', '单次调整幅度过大（上限 100 万）');
  try {
    const [u] = await pool.query('SELECT id, points FROM casdoor_users WHERE id = ? LIMIT 1', [userId]);
    if (!u || u.length === 0) return backWith(res, '/admin/points', 'ok', '用户不存在');

    // 不允许扣成负数
    const next = Math.max(0, (Number(u[0].points) || 0) + delta);
    await pool.query('UPDATE casdoor_users SET points = ? WHERE id = ?', [next, userId]);
    // user_points 是另一套计数（发帖/签到在写），同步累加，失败不影响主流程
    try {
      const [up] = await pool.query('SELECT user_id FROM user_points WHERE user_id = ? LIMIT 1', [userId]);
      if (up && up.length > 0) {
        await pool.query('UPDATE user_points SET points = MAX(0, points + ?) WHERE user_id = ?', [delta, userId]);
      } else {
        await pool.query('INSERT INTO user_points (user_id, points, exp) VALUES (?, ?, 0)', [userId, Math.max(0, delta)]);
      }
    } catch (e) { /* user_points 表可能不存在 */ }

    backWith(res, '/admin/points', 'ok', `已调整 ${delta > 0 ? '+' : ''}${delta} 分，当前 ${next}`);
  } catch (err) {
    console.error('调整积分失败:', err);
    backWith(res, '/admin/points', 'ok', '调整失败');
  }
});

// ------------------------------------------------------------
// 保密号
// ------------------------------------------------------------
router.get('/secrets', async (req, res) => {
  try {
    const kw = cleanShort(req.query.q, 50);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE us.secret_code LIKE ? ESCAPE '!' OR cu.username LIKE ? ESCAPE '!'";
      params.push(likeOf(kw.toUpperCase()), likeOf(kw));
    }
    const [rows] = await pool.query(
      `SELECT us.*, cu.username,
         COALESCE(NULLIF(cu.nickname,''), NULLIF(cu.real_name,''), cu.username) AS user_show
       FROM user_secrets us
       LEFT JOIN casdoor_users cu ON us.user_id = cu.id
       ${where} ORDER BY us.created_at DESC LIMIT 300`,
      params
    );
    res.render('admin/secrets', {
      title: '保密号管理',
      secrets: rows,
      q: kw,
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('保密号管理加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 重置保密号（把旧号作废并生成一个新的）
router.post('/secrets/reset/:id', requireId('id'), async (req, res) => {
  try {
    const crypto = require('crypto');
    const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += CHARS.charAt(crypto.randomInt(0, CHARS.length));
    const [rows] = await pool.query('SELECT id FROM user_secrets WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows || rows.length === 0) return backWith(res, '/admin/secrets', 'ok', '记录不存在');
    await pool.query('UPDATE user_secrets SET secret_code = ? WHERE id = ?', [code, req.params.id]);
    backWith(res, '/admin/secrets', 'ok', '已重置为 ' + code);
  } catch (err) {
    console.error('重置保密号失败:', err);
    backWith(res, '/admin/secrets', 'ok', '重置失败');
  }
});

router.post('/secrets/delete/:id', requireId('id'), async (req, res) => {
  try {
    await pool.query('DELETE FROM user_secrets WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/secrets', 'ok', '已删除保密号');
  } catch (err) {
    console.error('删除保密号失败:', err);
    backWith(res, '/admin/secrets', 'ok', '删除失败');
  }
});

// ------------------------------------------------------------
// 学生名册（ys_students）
// ------------------------------------------------------------
router.get('/students', async (req, res) => {
  try {
    const { page, size, offset } = pageParams(req, 50);
    const kw = cleanShort(req.query.q, 100);
    let where = '';
    const params = [];
    if (kw) {
      where = "WHERE grade LIKE ? ESCAPE '!' OR class_name LIKE ? ESCAPE '!' OR student_no LIKE ? ESCAPE '!' OR real_name LIKE ? ESCAPE '!'";
      params.push(likeOf(kw), likeOf(kw), likeOf(kw), likeOf(kw));
    }
    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM ys_students ${where}`, params)
      .catch(() => [[{ cnt: 0 }]]);
    const total = (countRows[0] && countRows[0].cnt) || 0;

    const [rows] = await pool.query(
      `SELECT * FROM ys_students ${where} ORDER BY grade, class_name, student_no LIMIT ? OFFSET ?`,
      params.concat([size, offset])
    ).catch(() => [[]]);

    res.render('admin/students', {
      title: '学生名册',
      students: rows,
      q: kw,
      page, total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('学生名册加载失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

// 粘贴 CSV 导入：年级,班级,学号,姓名,钉钉ID
router.post('/students/import', async (req, res) => {
  const raw = cleanText(req.body.csv, 200000);
  if (!raw.trim()) return backWith(res, '/admin/students', 'ok', '内容为空');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0, failed = 0;
  for (const line of lines) {
    const cols = line.split(/[,\t]/).map(s => s.trim());
    if (cols.length < 4) { skipped++; continue; }
    const [grade, className, studentNo, realName, dingId] = cols;
    // 跳过表头
    if (/^(年级|grade)$/i.test(grade)) { skipped++; continue; }
    try {
      const [dup] = await pool.query(
        'SELECT id FROM ys_students WHERE student_no = ? LIMIT 1', [studentNo]
      );
      if (dup && dup.length > 0) {
        await pool.query(
          'UPDATE ys_students SET grade = ?, class_name = ?, real_name = ?, ding_id = ? WHERE id = ?',
          [grade, className, realName, dingId || null, dup[0].id]
        );
        added++;
      } else {
        await pool.query(
          'INSERT INTO ys_students (grade, class_name, student_no, real_name, ding_id) VALUES (?, ?, ?, ?, ?)',
          [grade, className, studentNo, realName, dingId || null]
        );
        added++;
      }
    } catch (e) { failed++; }
  }
  backWith(res, '/admin/students', 'ok', `导入完成：新增/更新 ${added}，跳过 ${skipped}，失败 ${failed}`);
});

router.post('/students/delete/:id', requireId('id'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ys_students WHERE id = ?', [req.params.id]);
    backWith(res, '/admin/students', 'ok', '已删除');
  } catch (err) {
    backWith(res, '/admin/students', 'ok', '删除失败');
  }
});

// ------------------------------------------------------------
// 帖子 / 评论编辑（原后台只能删）
// ------------------------------------------------------------
router.get('/forum/edit/:id', requireId('id'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM forum_posts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows || rows.length === 0) return res.redirect('/admin/forum');
    const [boards] = await pool.query('SELECT id, name FROM forum_boards WHERE is_active = 1 ORDER BY sort_order')
      .catch(() => [[]]);
    res.render('admin/forum-edit', {
      title: '编辑帖子',
      post: rows[0],
      boards,
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('加载帖子编辑页失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/forum/edit/:id', requireId('id'), async (req, res) => {
  const b = req.body || {};
  try {
    const [rows] = await pool.query('SELECT id FROM forum_posts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows || rows.length === 0) return res.redirect('/admin/forum');

    const title = cleanShort(b.title, 200);
    const content = cleanText(b.content, 20000).trim();
    if (!content) return backWith(res, '/admin/forum/edit/' + req.params.id, 'ok', '正文不能为空');

    const boardId = b.board_id ? parseInt(b.board_id, 10) : null;
    await pool.query(
      `UPDATE forum_posts
       SET title = ?, content = ?, category = ?, tags = ?, board_id = ?,
           is_top = ?, is_hot = ?, is_deleted = ?
       WHERE id = ?`,
      [
        title || null,
        content,
        cleanShort(b.category, 50) || 'general',
        cleanShort(b.tags, 500) || null,
        Number.isSafeInteger(boardId) && boardId > 0 ? boardId : null,
        b.is_top ? 1 : 0,
        b.is_hot ? 1 : 0,
        b.is_deleted ? 1 : 0,
        req.params.id
      ]
    );
    backWith(res, '/admin/forum/edit/' + req.params.id, 'ok', '已保存');
  } catch (err) {
    console.error('保存帖子失败:', err);
    backWith(res, '/admin/forum/edit/' + req.params.id, 'ok', '保存失败');
  }
});

router.get('/comments/edit/:id', requireId('id'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM post_comments WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows || rows.length === 0) return res.redirect('/admin/comments');
    res.render('admin/comment-edit', {
      title: '编辑评论',
      comment: rows[0],
      notice: req.query.ok ? String(req.query.ok) : null
    });
  } catch (err) {
    console.error('加载评论编辑页失败:', err);
    res.status(500).render('errors/500', { title: '加载失败' });
  }
});

router.post('/comments/edit/:id', requireId('id'), async (req, res) => {
  try {
    const content = cleanText(req.body.content, 5000).trim();
    if (!content) return backWith(res, '/admin/comments/edit/' + req.params.id, 'ok', '内容不能为空');
    await pool.query(
      'UPDATE post_comments SET content = ?, is_deleted = ? WHERE id = ?',
      [content, req.body.is_deleted ? 1 : 0, req.params.id]
    );
    backWith(res, '/admin/comments/edit/' + req.params.id, 'ok', '已保存');
  } catch (err) {
    console.error('保存评论失败:', err);
    backWith(res, '/admin/comments/edit/' + req.params.id, 'ok', '保存失败');
  }
});

module.exports = router;
