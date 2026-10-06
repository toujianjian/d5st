// ============================================================
// 登录触发的「防抖」用户同步
// ------------------------------------------------------------
// 需求：有人登录后，等待 1 分钟自动与 Casdoor 对账一次。
// 设计：
//   - 防抖：同一时间只保留一个待执行任务（多次登录不会堆积）
//   - 冷却：两次实际对账之间至少间隔 1 分钟
//   - 安全：reconcileCasdoorUsers 已改为「只正向、不删除本地用户」，
//          因此这里的自动同步不会造成数据丢失
// ============================================================
const { reconcileCasdoorUsers } = require('./user-service');

const DELAY_MS = 60 * 1000;        // 登录后等待 1 分钟
const MIN_INTERVAL_MS = 60 * 1000; // 两次对账最小间隔

let pending = null;
let lastRunAt = 0;
let running = false;

async function run(casdoor) {
  if (running) return;
  running = true;
  lastRunAt = Date.now();
  try {
    const r = await reconcileCasdoorUsers(casdoor);
    console.log(
      `[用户同步] 登录后自动对账：同步 ${r.synced}/${r.total}，删除 ${r.removed}（自动删除已禁用）` +
      (r.reason ? `（${r.reason}）` : '')
    );
  } catch (e) {
    console.warn('[用户同步] 自动对账失败:', e.message);
  } finally {
    running = false;
  }
}

function scheduleSync(casdoor) {
  if (pending) return;                       // 已有待执行任务，直接跳过
  if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return; // 冷却中
  pending = setTimeout(() => {
    pending = null;
    run(casdoor);
  }, DELAY_MS);
  if (pending.unref) pending.unref();        // 不阻止进程退出
  console.log('[用户同步] 已安排登录后 1 分钟自动对账');
}

module.exports = { scheduleSync };
