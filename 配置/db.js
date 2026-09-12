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
    timezone: '+08:00'
  });
  _ready = pool.getConnection().then(conn => {
    conn.release();
    console.log('[DB] mysql2 MySQL 就绪: ' + (process.env.MYSQL_HOST || '127.0.0.1') + ':' + (process.env.MYSQL_PORT || '3306'));
    return pool;
  }).catch(err => {
    console.error('[DB] mysql2 连接失败:', err.message);
    throw err;
  });
  _query = (sqlStr, params) => pool.query(sqlStr, params);
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
          const stmt = db.prepare(sqlStr);
          if (params && params.length > 0) stmt.bind(params);
          const trimmed = sqlStr.trim().toLowerCase();
          const isSelect = trimmed.startsWith('select') || trimmed.startsWith('pragma');
          const isInsert = trimmed.startsWith('insert');
          const isUpdate = trimmed.startsWith('update');
          const isDelete = trimmed.startsWith('delete');
          if (isSelect) {
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            stmt.free();
            resolve([rows]);
          } else if (isInsert || isUpdate || isDelete) {
            stmt.step();
            stmt.free();
            save();
            const changes = db.getRowsModified();
            let insertId = null;
            if (isInsert) {
              const pk = db.exec('SELECT last_insert_rowid() as id');
              insertId = pk.length > 0 ? pk[0].values[0][0] : null;
            }
            resolve([[], { insertId, affectedRows: changes }]);
          } else {
            stmt.step();
            stmt.free();
            save();
            resolve([[], { affectedRows: db.getRowsModified() }]);
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
