// 数据库双模式：默认 sql.js SQLite（本地开发），USE_MYSQL=1 切 mysql2（生产/Docker）
const path = require('path');

const USE_MYSQL = process.env.USE_MYSQL === '1';

let _query, _exec, _ready, _close;

if (USE_MYSQL) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'd5st',
    password: process.env.MYSQL_PASSWORD || 'd5st_pass_2026',
    database: process.env.MYSQL_DATABASE || 'd5st',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+08:00',
    multipleStatements: true
  });
  _ready = pool.getConnection().then(conn => {
    conn.release();
    console.log('[DB] mysql2 MySQL 就绪: ' + (process.env.MYSQL_HOST || '127.0.0.1') + ':' + (process.env.MYSQL_PORT || '3306'));
    return pool;
  }).catch(err => {
    console.error('[DB] mysql2 连接失败:', err.message);
    throw err;
  });
  _query = (sqlStr, params) => {
    // 与 SQLite 分支保持一致：undefined 归一成 NULL。
    // mysql2 对 undefined 会当成字符串 'undefined' 或直接报错，都会产生脏数据。
    if (Array.isArray(params) && params.some(v => v === undefined)) {
      console.warn('[DB] 查询参数含 undefined，已按 NULL 处理:', String(sqlStr).replace(/\s+/g, ' ').slice(0, 120));
      params = params.map(v => (v === undefined ? null : v));
    }
    return pool.query(sqlStr, params);
  };
  _exec = (sqlStr) => pool.query(sqlStr);
  _close = () => pool.end();
} else {
  const initSqlJs = require('sql.js');
  const fs = require('fs');
  const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'd5st.db');

  let SQL = null;
  let db = null;

  _ready = initSqlJs().then(SQLModule => {
    SQL = SQLModule;
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }
    console.log('[DB] sql.js SQLite 就绪');
    return db;
  }).catch(err => {
    console.error('[DB] sql.js 初始化失败:', err.message);
    throw err;
  });

  function save() {
    if (!db) return;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
      console.error('[DB] 保存数据库失败:', err.message);
    }
  }

  _query = function (sqlStr, params = []) {
    return new Promise((resolve, reject) => {
      _ready.then(() => {
        try {
          // sql.js 的 bind 遇到 undefined 会抛「unknown type」并让整个查询失败，
          // 业务代码里漏写一处 `|| null` 就会踩到。这里统一归一成 null
          // （SQL NULL 语义），并告警便于定位调用点。
          if (Array.isArray(params) && params.some(v => v === undefined)) {
            console.warn('[DB] 查询参数含 undefined，已按 NULL 处理:', sqlStr.replace(/\s+/g, ' ').slice(0, 120));
            params = params.map(v => (v === undefined ? null : v));
          }
          const stmt = db.prepare(sqlStr);
          if (params && params.length > 0) stmt.bind(params);
          const trimmed = sqlStr.trim().toLowerCase();
          const isSelect = trimmed.startsWith('select') || trimmed.startsWith('pragma');
          const isInsert = trimmed.startsWith('insert');
          const isUpdate = trimmed.startsWith('update');
          const isDelete = trimmed.startsWith('delete');
          // ------------------------------------------------------------
          // 返回值必须与 mysql2 完全同构，否则业务代码在两种数据库下行为不同：
          //   SELECT → [rows, fields]
          //   写操作 → [ResultSetHeader{insertId, affectedRows}, fields]
          // 早期实现把写操作的 meta 放在第二个位置（[[], meta]），
          // 导致 `const [result] = await query(INSERT ...)` 拿到的是空数组，
          // result.insertId 恒为 undefined —— dev-login 建用户时就会
          // 「Cannot read properties of undefined」而失败。
          // ------------------------------------------------------------
          if (isSelect) {
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            stmt.free();
            resolve([rows, undefined]);
          } else if (isInsert || isUpdate || isDelete) {
            stmt.step();
            stmt.free();
            // ⚠️ 顺序至关重要：必须先读 last_insert_rowid() / getRowsModified()，
            // 再调 save()。sql.js 的 db.export() 内部会 close + reopen 底层连接，
            // 重开之后 last_insert_rowid() 与 getRowsModified() 都会归零，
            // 导致 insertId 恒为 0（表现为「发帖成功但跳转到 /forum/0」）。
            const changes = db.getRowsModified();
            let insertId = 0;
            if (isInsert) {
              const pk = db.exec('SELECT last_insert_rowid() as id');
              insertId = (pk.length > 0 && pk[0].values.length > 0) ? pk[0].values[0][0] : 0;
            }
            save();
            resolve([{ insertId, affectedRows: changes }, undefined]);
          } else {
            stmt.step();
            stmt.free();
            const changes = db.getRowsModified();
            save();
            resolve([{ insertId: 0, affectedRows: changes }, undefined]);
          }
        } catch (err) { reject(err); }
      }).catch(reject);
    });
  };

  _exec = function (sqlStr) {
    return _ready.then(() => { db.run(sqlStr); save(); });
  };

  _close = () => db && db.close();
}

module.exports = {
  query: _query,
  exec: _exec,
  ready: _ready,
  close: _close,
  isMysql: USE_MYSQL
};
