// ============================================================
// 测试数据种子脚本
// 用法：
//   node 配置/seed.js           # 仅在表为空时写入
//   node 配置/seed.js --force   # 清空论坛/视频数据后重新写入
// 幂等：版块/用户用 INSERT IGNORE；帖子/视频按需清空重建。
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

const POSTS = [
  {
    title: '【置顶】社区版规与发帖指引（新人必读）',
    content: '欢迎来到 D5ST 校园社区！\n\n1. 友善交流，禁止人身攻击与引战。\n2. 发帖请选择合适的版块，便于他人检索。\n3. 二手交易请标明价格与成色，谨防诈骗。\n4. 遇到问题可在「情感树洞」倾诉，也可以私信管理员。\n\n祝大家在这里玩得开心！',
    category: 'campus', board: 'chat', type: 'normal', tags: '公告 新人 版规',
    is_top: 1, is_hot: 1, user: 0, views: 1892
  },
  {
    title: '图书馆三楼靠窗的位置真的太香了',
    content: '每天早上八点前去三楼，靠窗那一排基本都能占到。阳光刚好，插座也有，复习效率直接翻倍。就是下午会有点晒，建议带个小夹子挂个本子挡一下。',
    category: 'campus', board: 'chat', type: 'normal', tags: '图书馆 学习 日常',
    user: 1, views: 436
  },
  {
    title: '大三下学期，我是怎么把绩点从 2.8 拉到 3.6 的',
    content: '先说结论：不是靠熬夜，是靠「选课 + 复盘」。\n\n第一，选课时优先选给分友好的通识课，把硬核专业课分散开，避免一学期三门硬课同时压。\n\n第二，每门课建立一个错题本，考前只看错题本，不看教材。教材是给平时看的，考前看教材效率极低。\n\n第三，作业一定要自己写第一遍，哪怕写得慢。抄一遍作业，期末就要多花三倍时间补。\n\n第四，找到一到两个固定搭子，互相讲题。「讲给别人听」是真的能发现自己哪里没懂。\n\n最后，绩点重要但不是全部，实习和项目同样关键，别为了 0.1 的绩点把身体搞垮。',
    category: 'study', board: 'study', type: 'long', tags: '绩点 学习方法 考研',
    cover: '/public/images/james1.jpg', is_hot: 1, user: 2, views: 2871
  },
  {
    title: '出一台闲置的 iPad 9 代，64G  WiFi 版',
    content: '用了两年，电池健康 87%，屏幕无划痕（一直贴膜带壳）。配件：原装充电器、第三方保护壳、类纸膜一张。\n\n价格 1350，校内面交，支持当场验机。想要的同学评论区留言或者私信我。',
    category: 'life', board: 'market', type: 'normal', tags: '二手 平板 交易',
    user: 3, views: 762
  },
  {
    title: '在树洞说点不敢发朋友圈的话',
    content: '这学期压力真的很大，家里出了点事，又赶上秋招。每天假装很正常地去上课、去实习，其实晚上经常失眠。\n\n也不敢跟家里说，怕他们更担心。就在这里写下来吧，写完好像好一点了。\n\n如果你也正在经历什么难的事，希望你能撑过去。',
    category: 'emotion', board: 'emotion', type: 'normal', tags: '树洞 压力 倾诉',
    is_hot: 1, user: 4, views: 1348
  },
  {
    title: '秋招复盘：非科班如何拿到第一份后端 offer',
    content: '背景：某双非院校，材料专业，自学后端一年半。\n\n时间线：\n- 3 月：刷完 MySQL 与操作系统八股，整理成自己的笔记。\n- 5 月：做了一个完整的个人项目（博客系统，带评论、搜索、缓存），部署上线。\n- 7 月：投提前批，被拒 6 次，复盘发现是项目讲得太浅。\n- 8 月：把项目的难点重新梳理（缓存一致性、分页优化），再投。\n- 9 月：拿到 2 个 offer。\n\n核心体会：非科班最怕「广度够、深度不够」。与其做五个玩具项目，不如把一个项目做深，能讲清楚每一个技术选型的取舍。',
    category: 'study', board: 'job', type: 'long', tags: '秋招 后端 面试 经验',
    cover: '/public/images/james2.jpg', is_hot: 1, user: 5, views: 3920
  },
  {
    title: '有没有人一起组队参加数学建模？',
    content: '目前两个人，都会一点 Matlab，缺一个写作强的同学（最好是文科或者经管，论文写得好的）。\n\n我们打算报 9 月那场，暑假每周固定讨论两次。有意向的评论区留个联系方式，我加你。',
    category: 'study', board: 'study', type: 'normal', tags: '组队 数学建模 竞赛',
    user: 2, views: 318
  },
  {
    title: '学校后街那家炒酸奶真的绝了',
    content: '芒果+奥利奥，加两块钱的芋圆，13 块钱一份，份量足到两个人吃不完。\n\n阿姨人超好，去晚了会送个小料。营业到晚上十点半，晚自习结束正好去。',
    category: 'life', board: 'chat', type: 'normal', tags: '美食 后街 推荐',
    user: 1, views: 526
  },
  {
    title: '研二学长给本科生的几条建议（血泪版）',
    content: '1. 尽早确定方向：考研、就业、考公，三条路准备方式完全不同，别到大四还在摇摆。\n\n2. 英语别丢：四六级尽早过，很多好岗位的门槛就是六级。\n\n3. 至少参加一次学科竞赛或者做一个完整项目，简历上必须有东西可写。\n\n4. 老师不是敌人，多去办公室问问题，导师推荐的价值远超你的想象。\n\n5. 身体是 1，其余都是 0。我研一熬了半年，现在颈椎不行了。',
    category: 'study', board: 'study', type: 'long', tags: '建议 成长 学长',
    cover: '/public/images/james3.jpg', user: 5, views: 2103
  },
  {
    title: '求推荐适合通勤的降噪耳机',
    content: '预算 500 以内，主要坐地铁和图书馆用。目前看了几款，头戴式和入耳式都在考虑，求真实体验反馈。',
    category: 'life', board: 'market', type: 'normal', tags: '耳机 求推荐 数码',
    user: 4, views: 287
  },
  {
    title: '记录一下第一次参加校园歌手大赛',
    content: '紧张到手抖，唱到第二段忘词了，硬着头皮哼完。没想到最后拿了优秀奖，观众朋友们太宽容了哈哈哈。\n\n明年还来，这次一定背熟歌词。',
    category: 'campus', board: 'chat', type: 'normal', tags: '歌手大赛 活动 记录',
    user: 3, views: 654
  },
  {
    title: '出几本考研专业课教材，便宜出',
    content: '《数据结构》严蔚敏、《操作系统》汤小丹、《计算机网络》谢希仁，都是正版，几乎全新，笔记没写在书上。\n\n三本打包 60，单本 25，校内自提。',
    category: 'study', board: 'market', type: 'normal', tags: '二手 考研 教材',
    user: 2, views: 421
  },
  {
    title: '宿舍好物分享｜住校四年总结的必买清单',
    content: '1. 床帘：遮光+隐私，舍友作息不同必备。\n2. 夹子灯：不占桌面，晚上看书不打扰别人。\n3. 多孔插排：一定要买带独立开关的。\n4. 折叠小桌：冬天在床上吃东西看书神器。\n5. 除湿袋：南方学校必备，衣柜挂两包。',
    category: 'life', board: 'chat', type: 'normal', tags: '宿舍 好物 生活',
    user: 1, views: 934
  },
  {
    title: '英语六级 500+ 的备考路线（附资料）',
    content: '词汇是地基，先花一个月过完核心词，再谈技巧。\n\n听力：每天一篇真题精听，听三遍，第三遍对着原文。\n阅读：先题后文，定位比通读重要。\n写作：背 5 个万能句型，考场上组合使用。\n\n资料我整理了一个压缩包，需要的同学评论区留邮箱。',
    category: 'study', board: 'study', type: 'long', tags: '六级 英语 备考',
    cover: '/public/images/james2.jpg', user: 3, views: 1672
  },
  {
    title: '实习面试被问「你最大的缺点是什么」怎么答？',
    content: '别答「我太追求完美」这种敷衍答案，面试官听腻了。\n\n正确思路：说一个**真实但可改进**的缺点 + 你已经采取的改进动作。\n\n比如：「我以前做项目不太爱写文档，导致交接困难。后来我养成了每个模块写 README 的习惯，上次小组作业交接就顺利很多。」\n\n重点不在缺点本身，而在你有没有自我迭代的能力。',
    category: 'study', board: 'job', type: 'normal', tags: '面试 实习 经验',
    is_hot: 1, user: 5, views: 2453
  },
  {
    title: '有没有一起晨跑的搭子',
    content: '打算每天早上六点半操场跑步，一个人容易赖床，找个搭子互相监督。\n\n配速随意，能坚持就行，跑完一起吃早餐。有意的同学留言！',
    category: 'life', board: 'chat', type: 'normal', tags: '晨跑 运动 搭子',
    user: 4, views: 312
  },
  {
    title: '转专业经验分享｜从化学转到计算机',
    content: '转专业成功一学期了，写点经验给想转的同学。\n\n1. 绩点是硬门槛，先把本专业的课学好，别本末倒置。\n2. 提前自学目标专业的基础课，面试会问。\n3. 找目标专业的学长学姐了解培养方案，别只看官网。\n4. 转过去之后要补修很多课，心理准备要做好，我第一学期巨累。',
    category: 'study', board: 'study', type: 'long', tags: '转专业 经验 成长',
    user: 2, views: 1384
  },
  {
    title: '出一台机械键盘，红轴，用了半年',
    content: 'IKBC 87 键红轴，手感顺滑无连击，键帽无油光。\n\n换静电容了所以出，原价 399，现在 220 出，送一套备用键帽。',
    category: 'life', board: 'market', type: 'normal', tags: '二手 键盘 数码',
    user: 5, views: 267
  },
  {
    title: '深夜树洞｜今天和相处三年的朋友闹掰了',
    content: '起因是一件很小的事，但积攒的情绪一下子爆了。说了很多难听的话，现在很后悔。\n\n不知道还能不能和好，也不确定想不想和好。就写在这里吧。',
    category: 'emotion', board: 'emotion', type: 'normal', tags: '树洞 友情 情绪',
    user: 3, views: 726
  },
  {
    title: '关于毕业设计选题的几点建议',
    content: '选题三原则：\n\n1. 能做出来。别选太前沿的方向，做不出来毕设直接凉。\n2. 有东西可写。纯理论题目写论文会很痛苦，选有系统实现的。\n3. 和导师方向相关。导师熟悉才能给有效指导。\n\n另外，尽早和导师确认选题，别拖到开题前一周。',
    category: 'study', board: 'study', type: 'normal', tags: '毕设 选题 建议',
    user: 5, views: 1092
  },
  {
    title: '学校猫猫图鉴｜第三弹',
    content: '图书馆门口的橘猫又胖了，据说是被同学们喂得太好。\n\n这学期新增两只：一号楼的白猫「汤圆」，和实验楼的三花「花卷」。都挺亲人的，可以摸。',
    category: 'campus', board: 'chat', type: 'normal', tags: '猫 校园 日常',
    user: 1, views: 1583
  }
];

const COMMENTS = [
  { post: 0, user: 1, content: '终于有正式版规了，支持！' },
  { post: 0, user: 3, content: '收藏了，新人报到～' },
  { post: 1, user: 4, content: '三楼确实好，不过我这学期才发现，已经期末了😭' },
  { post: 1, user: 2, content: '补充一下：四楼有插座的位置更多，安静程度也更好。', parent: 0 },
  { post: 2, user: 5, content: '「讲给别人听」这条太对了，费曼学习法诚不欺我。' },
  { post: 2, user: 1, content: '请问错题本是手写还是电子的？', parent: 0 },
  { post: 3, user: 4, content: '想要，请问还在吗？' },
  { post: 4, user: 1, content: '抱抱，会好起来的。' },
  { post: 4, user: 5, content: '如果需要聊聊，随时私信我。', parent: 0 },
  { post: 5, user: 2, content: '非科班刷到这条太及时了，感谢分享！' },
  { post: 5, user: 3, content: '请问项目是怎么部署的？用的什么云？', parent: 0 },
  { post: 6, user: 1, content: '我写作还行，可以聊聊吗？' },
  { post: 7, user: 5, content: '这家我常去，确实量足。' },
  { post: 8, user: 4, content: '第 5 条深有同感，颈椎真的要保护好。' },
  { post: 10, user: 2, content: '优秀奖也很棒了，明年冲前三！' },
  { post: 12, user: 4, content: '除湿袋真的，南方人狂点头。' },
  { post: 12, user: 3, content: '夹子灯我也在用，推荐买充电款的，断电也能用。', parent: 0 },
  { post: 13, user: 1, content: '想要资料，谢谢学长！' },
  { post: 13, user: 5, content: '精听三遍这个方法确实有效。', parent: 0 },
  { post: 14, user: 2, content: '这个回答思路太实用了，收藏。' },
  { post: 15, user: 1, content: '我可以！几点集合？' },
  { post: 16, user: 4, content: '请问转专业需要什么条件？' },
  { post: 16, user: 1, content: '同问，我也在考虑转。', parent: 0 },
  { post: 17, user: 2, content: '红轴打字确实舒服，帮顶。' },
  { post: 18, user: 5, content: '能说出后悔，说明你还在乎这段关系。' },
  { post: 19, user: 3, content: '第 2 条太对了，纯理论题目写起来真的很痛苦。' },
  { post: 20, user: 4, content: '汤圆我摸过！很乖。' },
  { post: 20, user: 1, content: '花卷比较怕人，要多去几次它才亲近你。', parent: 0 }
];

const VIDEOS = [
  {
    title: '校园秋季运动会开幕式航拍',
    description: '无人机视角记录今年运动会的开幕式，方阵入场 + 团体操表演。',
    category: 'campus', duration: 214, views: 1832, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 1
  },
  {
    title: '三分钟带你逛遍图书馆所有自习区',
    description: '从一楼到五楼，每个自习区的插座数量、安静程度、采光情况都拍了。',
    category: 'study', duration: 186, views: 2451, cover: '/public/images/james2.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 2
  },
  {
    title: '毕业季｜我们的四年',
    description: '大四学长学姐的毕业纪念短片，献给每一个在这里度过青春的人。',
    category: 'life', duration: 302, views: 5218, cover: '/public/images/james3.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 3
  },
  {
    title: '校园歌手大赛决赛现场｜冠军演唱',
    description: '决赛现场实录，冠军演唱《起风了》，全场大合唱。',
    category: 'talent', duration: 268, views: 974, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 3
  },
  {
    title: '篮球院系杯决赛最后两分钟',
    description: '最后两分钟连追 8 分，现场解说都喊哑了。',
    category: 'sport', duration: 152, views: 1362, cover: '/public/images/james2.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 4
  },
  {
    title: '期末复习 vlog｜图书馆的一天',
    description: '早上八点到晚上十点，记录一天的复习节奏。',
    category: 'study', duration: 421, views: 688, cover: '/public/images/james3.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 1
  },
  {
    title: '食堂新品测评｜三楼新开的窗口',
    description: '三楼新开了五个窗口，挨个试了一遍，最推荐第三个。',
    category: 'life', duration: 197, views: 1129, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 5
  },
  {
    title: '社团招新｜话剧社片段展演',
    description: '话剧社招新展演片段，欢迎有兴趣的同学加入。',
    category: 'talent', duration: 233, views: 405, cover: '/public/images/james2.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 4
  },
  {
    title: '迎新晚会｜舞蹈串烧完整版',
    description: '今年迎新晚会最炸的一段，舞蹈队同学们排练了一个月。',
    category: 'talent', duration: 341, views: 2876, cover: '/public/images/james3.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 3
  },
  {
    title: '校园春日｜樱花大道实拍',
    description: '四月樱花全开的一周，整条路都是粉色，错过要等一年。',
    category: 'campus', duration: 128, views: 1534, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 1
  },
  {
    title: '计算机学院 ACM 队训练日常',
    description: '记录 ACM 队一次五小时训练赛，看大佬们怎么打比赛。',
    category: 'study', duration: 276, views: 592, cover: '/public/images/james2.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 2
  },
  {
    title: '校足球队夺冠瞬间',
    description: '省赛决赛点球大战，最后一球罚进全场沸腾。',
    category: 'sport', duration: 189, views: 2143, cover: '/public/images/james3.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', recommended: 1, user: 4
  },
  {
    title: '毕业答辩现场｜学长学姐的经验分享',
    description: '答辩完的学长学姐现场分享注意事项，干货很多。',
    category: 'study', duration: 398, views: 871, cover: '/public/images/james1.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 5
  },
  {
    title: '校园夜市｜一整条街的烟火气',
    description: '周五夜市实拍，从街头吃到街尾，人均 20 块吃到撑。',
    category: 'life', duration: 224, views: 1265, cover: '/public/images/james2.jpg',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4', user: 1
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
