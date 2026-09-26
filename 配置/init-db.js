const fs = require('fs');
const path = require('path');
const pool = require('./db');
const initSchema = require('./init-schema');

let initialized = false;

// ============================================================
// MySQL 幂等迁移
// 说明：db-schema.sql 里的 CREATE TABLE IF NOT EXISTS 只能建新表，
// 对「已存在的旧表」不会补字段。历史数据卷里的 forum_posts 缺
// title/category/is_top/is_hot 等字段，会导致帖子页 500。
// 这里按 information_schema 检测后 ALTER，保证新旧库都能自愈。
// ============================================================

// 需要保证存在的列：表 -> { 列名: 列定义 }
const REQUIRED_COLUMNS = {
  forum_posts: {
    title: 'VARCHAR(255) DEFAULT NULL',
    category: "VARCHAR(50) NOT NULL DEFAULT 'general'",
    board_id: 'INT DEFAULT NULL',
    post_type: "VARCHAR(20) NOT NULL DEFAULT 'normal'",
    cover_image: 'VARCHAR(500) DEFAULT NULL',
    is_top: 'TINYINT(1) NOT NULL DEFAULT 0',
    is_hot: 'TINYINT(1) NOT NULL DEFAULT 0',
    updated_at: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
  },
  post_comments: {
    parent_id: 'INT DEFAULT NULL'
  },
  video_posts: {
    duration: 'INT NOT NULL DEFAULT 0',
    is_recommended: 'TINYINT(1) NOT NULL DEFAULT 0'
  },
  home_banners: {
    description: 'VARCHAR(255) DEFAULT NULL'
  }
};

async function tableExists(table) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table]
  );
  return rows && rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column]
  );
  return rows && rows.length > 0;
}

// 幂等补列：缺则 ALTER，已有则跳过
async function ensureColumn(table, column, ddl) {
  if (!await tableExists(table)) return false;
  if (await columnExists(table, column)) return false;
  try {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
    console.log(`[DB] 补列 ${table}.${column}`);
    return true;
  } catch (err) {
    console.error(`[DB] 补列失败 ${table}.${column}:`, err.message);
    return false;
  }
}

async function runMigrations() {
  let changed = 0;
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [column, ddl] of Object.entries(columns)) {
      if (await ensureColumn(table, column, ddl)) changed++;
    }
  }
  if (changed > 0) console.log(`[DB] 迁移完成，补充 ${changed} 个字段`);
}

// ============================================================
// 编码自愈
// 历史库由 docker-entrypoint-initdb.d 以 latin1 客户端执行 db-schema.sql，
// 脚本里 INSERT 的中文被写成「双重编码」（如 系统管理员 -> ç³»ç»Ÿç®¡ç†å'˜）。
// 这里把已知的默认数据改回正确的 UTF-8；仅命中乱码行时更新，
// 不会覆盖用户后来改过的值。
// ============================================================
const ENCODING_FIXES = [
  { table: 'system_settings', column: 'setting_value', where: "setting_key='site_name'", value: 'D5ST 校园社区' },
  { table: 'system_settings', column: 'setting_value', where: "setting_key='site_description'", value: '连接每一位同学，共享校园生活' },
  { table: 'system_settings', column: 'description', where: "setting_key='site_name'", value: '网站名称' },
  { table: 'system_settings', column: 'description', where: "setting_key='site_description'", value: '网站描述' },
  { table: 'system_settings', column: 'description', where: "setting_key='enable_registration'", value: '是否开放注册' },
  { table: 'system_settings', column: 'description', where: "setting_key='default_points'", value: '新用户默认积分' },
  { table: 'home_links', column: 'title', where: "url='/forum'", value: '校园贴吧' },
  { table: 'home_links', column: 'title', where: "url='/secret'", value: '保密号中心' },
  { table: 'home_links', column: 'title', where: "url='/user'", value: '个人中心' },
  { table: 'home_links', column: 'title', where: "url='/sponsor'", value: '赞助支持' },
  { table: 'home_banners', column: 'title', where: "image_path='/public/images/banner1.jpg'", value: '欢迎来到 D5ST' },
  { table: 'casdoor_users', column: 'real_name', where: "username='admin'", value: '系统管理员' }
];

// ============================================================
// 重复种子数据自愈
// db-schema.sql 每次启动都会执行一遍，里面的 INSERT IGNORE 只有在
// 撞到唯一键时才会跳过。home_links / home_banners 原本没有唯一键，
// 导致每重启一次就重复插入一批（首页链接会不断翻倍）。
// 这里：先按 title 去重，再补唯一键，之后 INSERT IGNORE 才真正幂等。
// ============================================================
const DEDUPE_TABLES = [
  { table: 'home_links', column: 'title', index: 'uniq_home_links_title' },
  { table: 'home_banners', column: 'title', index: 'uniq_home_banners_title' }
];

async function indexExists(table, index) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return rows && rows.length > 0;
}

async function dedupeAndIndex() {
  for (const t of DEDUPE_TABLES) {
    if (!await tableExists(t.table) || !await columnExists(t.table, t.column)) continue;
    try {
      // 保留 id 最小的一条，删除重复的
      const [res] = await pool.query(
        `DELETE t1 FROM \`${t.table}\` t1
         JOIN \`${t.table}\` t2 ON t1.\`${t.column}\` = t2.\`${t.column}\` AND t1.id > t2.id`
      );
      if (res && res.affectedRows > 0) {
        console.log(`[DB] 去重 ${t.table}，删除 ${res.affectedRows} 条重复数据`);
      }
    } catch (err) {
      console.error(`[DB] 去重失败 ${t.table}:`, err.message);
      continue;
    }
    try {
      if (!await indexExists(t.table, t.index)) {
        await pool.query(`ALTER TABLE \`${t.table}\` ADD UNIQUE KEY \`${t.index}\` (\`${t.column}\`)`);
        console.log(`[DB] 补唯一键 ${t.table}.${t.column}`);
      }
    } catch (err) {
      console.error(`[DB] 补唯一键失败 ${t.table}:`, err.message);
    }
  }
}

async function repairEncoding() {
  let fixed = 0;
  for (const f of ENCODING_FIXES) {
    if (!await tableExists(f.table)) continue;
    if (!await columnExists(f.table, f.column)) continue;
    // 双重编码的 UTF-8 经 utf8mb4 读出来会带 ç / Ã / â 特征字符，
    // 用它们做判定，保证只修乱码行，不覆盖用户后续改过的正常值
    const moji = "`%s` LIKE '%%ç%%' OR `%s` LIKE '%%Ã%%' OR `%s` LIKE '%%â%%'"
      .replace(/%s/g, f.column);
    try {
      const sql = `UPDATE \`${f.table}\` SET \`${f.column}\` = ? WHERE ${f.where} AND (${moji})`;
      const [res] = await pool.query(sql, [f.value]);
      if (res && res.affectedRows > 0) fixed += res.affectedRows;
    } catch (err) {
      console.error(`[DB] 编码修复失败 ${f.table}.${f.column}:`, err.message);
    }
  }
  if (fixed > 0) console.log(`[DB] 编码自愈完成，修复 ${fixed} 行乱码数据`);
}

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
      // 建表后补历史库缺失的列
      await runMigrations();
      // 修复历史库中被双重编码污染的中文默认数据
      await repairEncoding();
      // 清理重复种子数据并补唯一键，保证 INSERT IGNORE 真正幂等
      await dedupeAndIndex();
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
