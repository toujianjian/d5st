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

module.exports = {
  findOrCreateCasdoorUser,
  getUserById,
  getUserByCasdoorId,
  getUserByUsername,
  isAdmin,
  syncAllFromCasdoor,
  isAdminFromCasdoor
};

