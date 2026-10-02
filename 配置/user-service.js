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
           avatar = COALESCE(?, avatar),
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
           avatar = COALESCE(?, avatar),
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

// 本地映射表中"并非 Casdoor 用户"的演示/开发账号特征：
//   seed!_%  → 配置/seed.js 写入的演示用户（casdoor_user_id 形如 seed_u1）
//   dev-!_%  → 开发登录后门写入（casdoor_user_id 形如 dev-dev_user）
//   dev_user → 开发登录默认账号
// 用 '!' 作转义符，MySQL / SQLite 都支持。
const NON_CASDOOR_PATTERNS = [
  "casdoor_user_id LIKE 'seed!_%' ESCAPE '!'",
  "casdoor_user_id LIKE 'dev-!_%' ESCAPE '!'",
  "username = 'dev_user'"
];

// 与 Casdoor 对账，让本地 casdoor_users 与 Casdoor(d5st 组织) 保持一致：
//   1) 正向：以 Casdoor 为准，把用户补齐 / 更新到本地
//   2) 清理：删除本地表中来源为 seed.js / dev-login 的演示账号（它们不在 Casdoor）
// 注意：删除 casdoor_users 行会级联删除其帖子/评论/私信等内容，
//       因此这里只删「特征明确」的演示/开发账号，绝不按"未知账号"批量删除。
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
    // Casdoor 返回空可能是异常（或确实没用户）；此时不清理，避免误删本地数据
    result.reason = 'Casdoor 未返回用户，跳过对账';
    return result;
  }
  result.total = users.length;

  for (const u of users) {
    try {
      await findOrCreateCasdoorUser(u);
      result.synced++;
    } catch (e) { /* 单个用户失败不影响整体 */ }
  }

  try {
    const [del] = await pool.query(
      `DELETE FROM casdoor_users WHERE ${NON_CASDOOR_PATTERNS.join(' OR ')}`
    );
    result.removed = (del && del.affectedRows) || 0;
  } catch (e) {
    result.reason = '清理演示账号失败: ' + e.message;
  }

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
  isAdminFromCasdoor
};

