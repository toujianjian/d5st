const fs = require('fs');
const path = require('path');
const pool = require('./db');
const initSchema = require('./init-schema');

let initialized = false;

async function initDatabase() {
  if (initialized) return;
  try {
    if (pool.isMysql) {
      // MySQL 模式：使用 db-schema.sql（MySQL 方言，IF NOT EXISTS + INSERT IGNORE 幂等）
      let sql = fs.readFileSync(path.join(__dirname, '..', 'db-schema.sql'), 'utf8');
      // 连接池已指定 database，去掉库级语句避免 USE 切换库
      sql = sql.split('\n').filter(line => !/^\s*(CREATE DATABASE|USE\s+\w+)\s*;/i.test(line)).join('\n');
      await pool.exec(sql);
      console.log('[DB] MySQL 数据库初始化完成');
    } else {
      await pool.exec(initSchema);
      console.log('[DB] SQLite 数据库初始化完成');
    }
    initialized = true;
  } catch (err) {
    console.error('[DB] 初始化失败:', err.message);
    throw err;
  }
}

module.exports = initDatabase;
