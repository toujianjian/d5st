/**
 * 等级与积分展示口径（全站统一）
 *
 * 为什么要有这个文件：
 * 原先 app.js 用 `Math.floor((帖子数 + 评论数) / 5) + 1` 估算「等级」，
 * 而积分来自另一套来源（发帖 +5、签到 +10、赞助 1 元 = 100 分，落在 casdoor_users.points）。
 * 两套口径互不相干，会出现「积分 2000 却还是 1 级」这种自相矛盾的展示。
 * 现在统一为：**等级完全由积分推导**，积分就是唯一经验值。
 *
 * 积分展示：达到 K_THRESHOLD 后缩写为 k（1000 → 1k，1200 → 1.2k，15400 → 15.4k）。
 */

// 积分缩写阈值（k = 千）。
// 想改成「超过 100 就缩写」把这里设为 100 即可，但 150 会显示成 0.2k，通常不好看，故默认 1000。
const K_THRESHOLD = 1000;

// 等级阶梯。min = 本级起始积分（含）。
// 升级需要的积分跨度逐级拉大，避免高等级过快刷满。
const LEVELS = [
  { level: 1, name: '初来乍到', min: 0 },
  { level: 2, name: '校园新人', min: 100 },
  { level: 3, name: '活跃同学', min: 300 },
  { level: 4, name: '小有名气', min: 600 },
  { level: 5, name: '论坛达人', min: 1000 },
  { level: 6, name: '社区骨干', min: 2000 },
  { level: 7, name: '风云人物', min: 3500 },
  { level: 8, name: '校园红人', min: 6000 },
  { level: 9, name: '传奇前辈', min: 10000 },
  { level: 10, name: '荣誉元老', min: 20000 }
];

/** 当前等级阶（含下一级信息与本级进度），供页面展示 */
function getLevelInfo(rawPoints) {
  const points = Math.max(0, Math.floor(Number(rawPoints) || 0));

  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) idx = i;
  }

  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;

  const info = {
    level: cur.level,
    name: cur.name,
    min: cur.min,
    points,
    pointsText: formatPoints(points),
    isMax: !next,
    nextLevel: next ? next.level : null,
    nextName: next ? next.name : null,
    nextMin: next ? next.min : null,
    remaining: next ? Math.max(0, next.min - points) : 0,
    progress: 100
  };

  if (next) {
    const span = next.min - cur.min;
    info.progress = span > 0
      ? Math.min(100, Math.max(0, Math.round(((points - cur.min) / span) * 100)))
      : 100;
  }
  return info;
}

/** 积分展示：≥ K_THRESHOLD 时缩写为 k；千位以上保留 1 位小数，10 万以上取整 */
function formatPoints(rawPoints) {
  const n = Math.max(0, Math.floor(Number(rawPoints) || 0));
  if (n < K_THRESHOLD) return String(n);
  const k = n / 1000;
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return rounded + 'k';
}

/**
 * 把等级相关字段一次性写进 res.locals，模板里可直接使用：
 * userPoints / userPointsText / userLevel / userLevelName /
 * levelProgress / levelRemaining / levelNextName / levelIsMax
 */
function applyToLocals(res, rawPoints) {
  const lv = getLevelInfo(rawPoints);
  res.locals.userPoints = lv.points;
  res.locals.userPointsText = formatPoints(lv.points);
  res.locals.userLevel = lv.level;
  res.locals.userLevelName = lv.name;
  res.locals.levelProgress = lv.progress;
  res.locals.levelRemaining = lv.remaining;
  res.locals.levelNextName = lv.nextName;
  res.locals.levelIsMax = lv.isMax;
  return lv;
}

module.exports = { LEVELS, K_THRESHOLD, getLevelInfo, formatPoints, applyToLocals };
