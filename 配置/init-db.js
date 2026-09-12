const pool = require('./db');
const initSchema = require('./init-schema');

let initialized = false;

async function initDatabase() {
  if (initialized) return;
  try {
    await pool.exec(initSchema);
    console.log('[DB] SQLite 数据库初始化完成');
    initialized = true;
  } catch (err) {
    console.error('[DB] 初始化失败:', err.message);
    throw err;
  }
}

module.exports = initDatabase;
