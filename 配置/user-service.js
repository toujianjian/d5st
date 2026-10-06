// ============================================================
// 用户服务 —— Casdoor 用户 ↔ d5st 本地用户映射
// ============================================================
const pool = require('./db');

// 从 Casdoor 用户对象里识别 d5st-admin 权限组
function isAdminFromCasdoor(casdoorUser) {
  const groups = casdoorUser.groups || casdoorUser.groupNames || [];
  return groups.includes('d5st-admin') ? 1 : 0;
}

async function findOrCreateCasdoorUser(casdoorUser) {
  const casdoorUserId = String(casdoorUser.id || casdoorUser.name);

  const [rows] = await pool.query(
    'SELECT * FROM casdoor_users WHERE casdoor_user_id = ?',
    [casdoorUserId]
  );

  if (rows.length > 0) {
    await pool.query(
      `UPDATE casdoor_users 
       SET username = ?, 
           real_name = COALESCE(?, real_name), 
           avatar = CASE WHEN avatar LIKE '/avatar/%' THEN avatar ELSE COALESCE(?, avatar) END,
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           is_admin = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE casdoor_user_id = ?`,
      [
        casdoorUser.name,
        casdoorUser.displayName || casdoorUser.friendlyName || null,
        casdoorUser.avatar || null,
        casdoorUser.email || null,
        casdoorUser.phone || null,
        isAdminFromCasdoor(casdoorUser),
        casdoorUserId
      ]
    );
    const [updated] = await pool.query(
      'SELECT * FROM casdoor_users WHERE casdoor_user_id = ?',
      [casdoorUserId]
    );
    return updated[0];
  }

  const isAdmin = isAdminFromCasdoor(casdoorUser);

  // 账号关联：本地可能已有同名用户（如 dev-login/种子数据创建的账号），
  // casdoor_users.username 有唯一键，直接 INSERT 会撞 uniq_username。
  // 此时把既有账号的 casdoor_user_id 绑定为本次 OAuth 身份，视为同一账号。
  const [existingByName] = await pool.query(
    'SELECT * FROM casdoor_users WHERE username = ? LIMIT 1',
    [casdoorUser.name]
  );
  if (existingByName.length > 0) {
    await pool.query(
      `UPDATE casdoor_users
       SET casdoor_user_id = ?,
           real_name = COALESCE(?, real_name),
           avatar = CASE WHEN avatar LIKE '/avatar/%' THEN avatar ELSE COALESCE(?, avatar) END,
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           is_admin = GREATEST(is_admin, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        casdoorUserId,
        casdoorUser.displayName || casdoorUser.friendlyName || null,
        casdoorUser.avatar || null,
        casdoorUser.email || null,
        casdoorUser.phone || null,
        isAdmin,
        existingByName[0].id
      ]
    );
    const [linked] = await pool.query(
      'SELECT * FROM casdoor_users WHERE id = ?',
      [existingByName[0].id]
    );
    return linked[0];
  }

  const [result] = await pool.query(
    `INSERT INTO casdoor_users 
     (casdoor_user_id, username, real_name, avatar, email, phone, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      casdoorUserId,
      casdoorUser.name,
      casdoorUser.displayName || casdoorUser.friendlyName || null,
      casdoorUser.avatar || null,
      casdoorUser.email || null,
      casdoorUser.phone || null,
      isAdmin
    ]
  );

  const [newUser] = await pool.query(
    'SELECT * FROM casdoor_users WHERE id = ?',
    [result.insertId]
  );
  return newUser[0];
}

async function getUserById(id) {
  const [rows] = await pool.query(
    'SELECT * FROM casdoor_users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

async function getUserByCasdoorId(casdoorUserId) {
  const [rows] = await pool.query(
    'SELECT * FROM casdoor_users WHERE casdoor_user_id = ?',
    [casdoorUserId]
  );
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const [rows] = await pool.query(
    'SELECT * FROM casdoor_users WHERE username = ?',
    [username]
  );
  return rows[0] || null;
}

// 禁用/禁用本地映射（用于 Casdoor 用户删除事件）
async function disableLocalUser(casdoorUserId) {
  await pool.query(
    'UPDATE casdoor_users SET is_admin = 0, updated_at = CURRENT_TIMESTAMP WHERE casdoor_user_id = ?',
    [casdoorUserId]
  );
}

async function isAdmin(userId) {
  const user = await getUserById(userId);
  return user ? user.is_admin === 1 : false;
}

// 批量拉取 Casdoor 用户同步到本地（管理后台触发）
async function syncAllFromCasdoor(casdoor) {
  const users = await casdoor.listUsers(casdoor.C.organization, 200, 0);
  let updated = 0;
  for (const u of (users || [])) {
    await findOrCreateCasdoorUser(u);
    updated++;
  }
  return { synced: updated, total: users?.length || 0 };
}

// 删除本地用户映射（用于 Casdoor 侧删除用户后的同步清理）
async function removeLocalUser(casdoorUserId) {
  const [r] = await pool.query(
    'DELETE FROM casdoor_users WHERE casdoor_user_id = ?',
    [String(casdoorUserId)]
  );
  return (r && r.affectedRows) || 0;
}

// 与 Casdoor 对账，让本地 casdoor_users 与 Casdoor(d5st 组织) 保持一致：
//   1) 正向：以 Casdoor 为准，把用户补齐 / 更新到本地
//   2) 反向：删除本地表中「Casdoor 已不存在」的用户
//      （涵盖 seed.js 演示账号、dev-login 账号，以及已在 Casdoor 后台删除的用户）
// 安全护栏：Casdoor 返回空时不清理，避免异常导致本地被清空。
// 注意：删除 casdoor_users 行会级联删除其帖子/评论/私信等内容。
async function reconcileCasdoorUsers(casdoor) {
  const result = { ok: false, synced: 0, removed: 0, total: 0, reason: '' };

  let users;
  try {
    users = await casdoor.listUsers(casdoor.C.organization, 500, 0);
  } catch (e) {
    result.reason = '拉取 Casdoor 用户失败: ' + e.message;
    return result;
  }
  if (!users || users.length === 0) {
    result.reason = 'Casdoor 未返回用户，跳过对账';
    return result;
  }
  result.total = users.length;

  // 正向：Casdoor → 本地（新增 / 更新资料与权限）
  for (const u of users) {
    try {
      await findOrCreateCasdoorUser(u);
      result.synced++;
    } catch (e) { /* 单个用户失败不影响整体 */ }
  }

  // 反向清理（危险，默认关闭）：本地存在但 Casdoor 已无 → 删除。
  // 之前这里会 DELETE 本地用户，而 casdoor_users 是帖子/评论/私信的父表，
  // 级联删除会连用户内容一起清掉；Casdoor 抖动或分页截断时极易误删。
  // 现改为「绝不自动删除」。如需清理，走 casdoor-webhook 的删除事件（精确、单用户）。
  result.removed = 0;

  result.ok = true;
  return result;
}

module.exports = {
  findOrCreateCasdoorUser,
  getUserById,
  getUserByCasdoorId,
  getUserByUsername,
  isAdmin,
  syncAllFromCasdoor,
  reconcileCasdoorUsers,
  removeLocalUser,
  isAdminFromCasdoor
};

