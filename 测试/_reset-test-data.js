// 重置本地测试环境的好友/私信/关注数据，并提示需要等待的限流时间。
// 仅用于本地 sql.js 开发库，不要在生产环境运行。
const initSqlJs = require('sql.js');
const fs = require('fs');

const TEST_USERS = ['feat_alice', 'feat_bob', 'feat_carol', 'feat_carol2'];

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('d5st.db'));

  const ids = [];
  const r = db.exec('SELECT id, username FROM casdoor_users');
  if (r.length) {
    for (const [id, name] of r[0].values) {
      if (TEST_USERS.includes(name)) ids.push(id);
    }
  }
  if (ids.length === 0) {
    console.log('没有找到测试用户，无需清理');
    return;
  }
  const list = ids.join(',');
  console.log('清理测试用户:', ids.join(', '));

  const run = (sql, label) => {
    try {
      db.run(sql);
      const c = db.getRowsModified();
      console.log(`  ${label}: 影响 ${c} 行`);
    } catch (e) { console.log(`  ${label}: 跳过 (${e.message})`); }
  };

  run(`DELETE FROM friend_requests WHERE from_user_id IN (${list}) OR to_user_id IN (${list})`, '好友请求');
  run(`DELETE FROM user_friends WHERE user_id IN (${list}) OR friend_id IN (${list})`, '好友关系');
  run(`DELETE FROM messages WHERE sender_id IN (${list}) OR receiver_id IN (${list})`, '私信');
  run(`DELETE FROM user_follows WHERE follower_id IN (${list}) OR following_id IN (${list})`, '关注');
  run(`DELETE FROM guestbook WHERE content LIKE 'brute-%' OR content LIKE '%后台删除测试%'`, '测试留言');

  fs.writeFileSync('d5st.db', Buffer.from(db.export()));
  console.log('\n已写回 d5st.db');
  console.log('\n注意：限流计数在进程内存里，重启服务或等待窗口即可重置。');
  console.log('  - 开发登录 /auth/login: 30 次/分钟');
  console.log('  - 好友请求 /friends/request: 20 次/10 分钟');
});
