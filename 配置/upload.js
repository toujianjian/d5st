// ============================================================
// 上传基础设施（multer）
// ------------------------------------------------------------
// - 视频：落磁盘 /app/uploads/videos（由 docker-compose 挂宿主 ./uploads 持久化）
// - 头像：读入内存后写入数据库（user_avatars），迁移随 mysqldump 走
// 说明：/app/uploads 目录在容器内，宿主通过 volumes 映射，重建不丢文件。
// ============================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const ROOT = path.join(__dirname, '..', 'uploads');
const VIDEO_DIR = path.join(ROOT, 'videos');

for (const d of [ROOT, VIDEO_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
}

const VIDEO_MAX = 100 * 1024 * 1024; // 100MB（与 Cloudflare 免费版上传上限对齐）
const IMAGE_MAX = 3 * 1024 * 1024;   // 3MB

const VIDEO_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
};
const IMAGE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

function rand() {
  return crypto.randomBytes(16).toString('hex');
}

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_DIR),
  filename: (req, file, cb) => {
    const ext = VIDEO_EXT[file.mimetype] || path.extname(file.originalname) || '.mp4';
    cb(null, `${Date.now()}-${rand()}${ext}`);
  }
});

const videoUpload = multer({
  storage: videoStorage,
  limits: { fileSize: VIDEO_MAX },
  fileFilter: (req, file, cb) => {
    if (VIDEO_EXT[file.mimetype]) return cb(null, true);
    cb(new Error('仅支持 mp4 / webm / mov 格式的视频'));
  }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX },
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT[file.mimetype]) return cb(null, true);
    cb(new Error('仅支持 jpg / png / webp / gif 格式的图片'));
  }
});

module.exports = {
  videoUpload,
  avatarUpload,
  ROOT,
  VIDEO_DIR,
  IMAGE_EXT,
  VIDEO_MAX,
  IMAGE_MAX
};
