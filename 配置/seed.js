// ============================================================
// 测试数据种子脚本
// 用法：
//   node 配置/seed.js           # 仅在表为空时写入
//   node 配置/seed.js --force   # 清空论坛/视频数据后重新写入
// 幂等：版块/用户用 INSERT IGNORE；帖子/视频按需清空重建。
// 说明：默认只保留「一篇帖子 + 两条评论 + 一个视频」作为演示内容，
//       其余批量测试数据已移除，避免首页被大量示例内容淹没。
//       （db-schema.sql 里也有一份等价的默认数据，供新库初始化使用。）
// ============================================================
const pool = require('./db');

const FORCE = process.argv.includes('--force');
const IG = pool.isMysql ? 'INSERT IGNORE' : 'INSERT OR IGNORE';

// ---------- 静态数据 ----------
const BOARDS = [
  { name: '校园闲聊', slug: 'chat', icon: '💬', description: '校园日常，随便聊聊', sort_order: 1 },
  { name: '学习交流', slug: 'study', icon: '📚', description: '课程、考研、干货分享', sort_order: 2 },
  { name: '情感树洞', slug: 'emotion', icon: '💗', description: '倾诉与倾听的角落', sort_order: 3 },
  { name: '二手交易', slug: 'market', icon: '🛒', description: '闲置流转，校内交易', sort_order: 4 },
  { name: '求职实习', slug: 'job', icon: '💼', description: '实习、校招、简历经验', sort_order: 5 }
];

// 首页横幅：图片使用静态资源里真实存在的文件，
// 避免沿用 schema 里默认的 banner1.jpg（该文件并不存在，会 404）
const BANNERS = [
  { title: '校园风光', description: '记录四季变换的校园角落', image_path: '/public/images/james1.jpg', link_url: '/videos', sort_order: 1 },
  { title: '学习交流', description: '分享知识与备考经验', image_path: '/public/images/james2.jpg', link_url: '/forum?board=study', sort_order: 2 },
  { title: '生活日常', description: '吃喝玩乐与二手闲置', image_path: '/public/images/james3.jpg', link_url: '/forum?board=chat', sort_order: 3 }
];

const USERS = [
  { casdoor_user_id: 'seed_admin', username: 'admin', real_name: '系统管理员', is_admin: 1, points: 999 },
  { casdoor_user_id: 'seed_u1', username: 'linxiaoman', real_name: '林小满', grade: '大三', class_name: '计科2班', points: 268 },
  { casdoor_user_id: 'seed_u2', username: 'chenyiming', real_name: '陈一鸣', grade: '大二', class_name: '软工1班', points: 195 },
  { casdoor_user_id: 'seed_u3', username: 'suxiaoyue', real_name: '苏晓月', grade: '大四', class_name: '英语3班', points: 342 },
  { casdoor_user_id: 'seed_u4', username: 'zhouzihan', real_name: '周子涵', grade: '大一', class_name: '数学1班', points: 88 },
  { casdoor_user_id: 'seed_u5', username: 'zhengsiyuan', real_name: '郑思远', grade: '研二', class_name: '电子1班', points: 421 }
];

// 默认演示帖（user 为 USERS 的下标）
const POSTS = [
  {
    title: '图书馆三楼靠窗的位置真的太香了',
    content: '每天早上八点前去三楼，靠窗那一排基本都能占到。阳光刚好，插座也有，复习效率直接翻倍。就是下午会有点晒，建议带个小夹子挂个本子挡一下。',
    category: 'campus', board: 'chat', type: 'normal', tags: '图书馆 学习 日常',
    user: 1, views: 436
  }
];

// 评论（post 为 POSTS 下标，user 为 USERS 下标，parent 指向同帖内第几条评论）
const COMMENTS = [
  { post: 0, user: 4, content: '三楼确实好，不过我这学期才发现，已经期末了😭' },
  { post: 0, user: 2, content: '补充一下：四楼有插座的位置更多，安静程度也更好。', parent: 0 }
];

// 默认演示视频
const VIDEOS = [
  {
    title: '校园秋季运动会开幕式航拍',
    description: '无人机视角记录今年运动会的开幕式，方阵入场 + 团体操表演。',
    category: 'campus', duration: 214, views: 1832, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 1
  }
];

// ---------- 素材清理 ----------
// 仓库自带的 james1/2/3.jpg 是他人肖像照片，作为校园社区配图不合适，
// 这里统一去掉封面，让前端回退到渐变占位（视觉上更干净一致）。
POSTS.forEach(p => { delete p.cover; });
VIDEOS.forEach(v => { delete v.cover; });
BANNERS.forEach(b => { b.image_path = ''; });

// ---------- 辅助 ----------
async function count(sql) {
  try {
    const [r] = await pool.query(sql);
    return r[0].cnt || 0;
  } catch (e) {
    return 0;
  }
}

async function seed() {
  console.log('[Seed] 开始写入测试数据…');

  // 用户
  for (const u of USERS) {
    await pool.query(
      `${IG} INTO casdoor_users (casdoor_user_id, username, real_name, is_admin, grade, class_name, points)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.casdoor_user_id, u.username, u.real_name, u.is_admin || 0, u.grade || null, u.class_name || null, u.points || 0]
    );
  }
  const [users] = await pool.query('SELECT id, username FROM casdoor_users');
  const userBy = {};
  users.forEach(u => { userBy[u.username] = u.id; });
  console.log(`[Seed] 用户 ${users.length} 个`);

  // 版块
  for (const b of BOARDS) {
    await pool.query(
      `${IG} INTO forum_boards (name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?)`,
      [b.name, b.slug, b.icon, b.description, b.sort_order]
    );
  }
  const [boards] = await pool.query('SELECT id, slug FROM forum_boards');
  const boardBy = {};
  boards.forEach(b => { boardBy[b.slug] = b.id; });
  console.log(`[Seed] 版块 ${boards.length} 个`);

  // 帖子（--force 时先清空相关数据，保证可重复执行）
  const postCount = await count('SELECT COUNT(*) as cnt FROM forum_posts');
  if (FORCE || postCount === 0) {
    if (FORCE) {
      await pool.query('DELETE FROM post_likes');
      await pool.query('DELETE FROM post_comments');
      await pool.query('DELETE FROM post_tags');
      await pool.query('DELETE FROM forum_posts');
      console.log('[Seed] --force：已清空旧帖子数据');
    }
    const postIds = [];
    for (const p of POSTS) {
      const userId = userBy[Object.keys(userBy)[p.user]] || users[0].id;
      const [r] = await pool.query(
        `INSERT INTO forum_posts (user_id, title, content, category, tags, post_type, cover_image, board_id, is_top, is_hot, views)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId, p.title, p.content, p.category, p.tags, p.type,
          p.cover || null, boardBy[p.board] || null, p.is_top || 0, p.is_hot || 0, p.views || 0
        ]
      );
      postIds.push(r.insertId);

      // 标签同步
      if (p.tags) {
        for (const name of p.tags.split(/\s+/).filter(Boolean)) {
          await pool.query(`${IG} INTO tags (name) VALUES (?)`, [name]);
          const [t] = await pool.query('SELECT id FROM tags WHERE name = ?', [name]);
          if (t.length) {
            await pool.query(`${IG} INTO post_tags (post_id, tag_id) VALUES (?, ?)`, [r.insertId, t[0].id]);
          }
        }
      }
    }

    // 评论（含楼中楼）
    for (const c of COMMENTS) {
      const postId = postIds[c.post];
      if (!postId) continue;
      const [cm] = await pool.query(
        'SELECT id FROM post_comments WHERE post_id = ? ORDER BY id', [postId]
      );
      const parentId = (c.parent !== undefined && cm[c.parent]) ? cm[c.parent].id : null;
      await pool.query(
        'INSERT INTO post_comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
        [postId, userBy[Object.keys(userBy)[c.user]] || users[0].id, c.content, parentId]
      );
    }

    // 点赞
    for (let i = 0; i < postIds.length; i++) {
      const likes = (i * 3) % 7 + 1;
      for (let k = 0; k < likes && k < users.length; k++) {
        await pool.query(
          `${IG} INTO post_likes (post_id, user_id) VALUES (?, ?)`, [postIds[i], users[k].id]
        );
      }
    }
    console.log(`[Seed] 帖子 ${postIds.length} 篇 + 评论 ${COMMENTS.length} 条`);
  } else {
    console.log('[Seed] 已有帖子数据，跳过（如需重建请加 --force）');
  }

  // 视频
  const videoCount = await count('SELECT COUNT(*) as cnt FROM video_posts');
  if (FORCE || videoCount === 0) {
    if (FORCE) {
      await pool.query('DELETE FROM video_posts');
      console.log('[Seed] --force：已清空旧视频数据');
    }
    for (const v of VIDEOS) {
      await pool.query(
        `INSERT INTO video_posts (user_id, title, description, video_url, cover_url, duration, views, category, is_recommended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userBy[Object.keys(userBy)[v.user]] || users[0].id,
          v.title, v.description, v.url, v.cover, v.duration, v.views, v.category, v.recommended || 0
        ]
      );
    }
    console.log(`[Seed] 视频 ${VIDEOS.length} 个`);
  } else {
    console.log('[Seed] 已有视频数据，跳过（如需重建请加 --force）');
  }

  // 首页横幅：把指向不存在的 banner1.jpg 的历史数据清空，前端回退为渐变 + 图标
  await pool.query(`UPDATE home_banners SET image_path='' WHERE image_path='/public/images/banner1.jpg'`);
  const bannerCount = await count('SELECT COUNT(*) as cnt FROM home_banners');
  if (FORCE || bannerCount === 0) {
    if (FORCE) await pool.query('DELETE FROM home_banners');
    for (const b of BANNERS) {
      await pool.query(
        `INSERT INTO home_banners (title, description, image_path, link_url, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [b.title, b.description, b.image_path, b.link_url, b.sort_order]
      );
    }
    console.log(`[Seed] 首页横幅 ${BANNERS.length} 条`);
  }

  console.log('[Seed] ✅ 测试数据写入完成');
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[Seed] 失败:', err.message);
    process.exit(1);
  });
