'use strict';
/**
 * 敏感词集成助手
 * 在内容写入处统一调用 scan() 做「屏蔽 + 留记录」：
 *   - scan(rawContent)            返回 { filtered, matched:[词...] }，filtered 为屏蔽后的文本
 *   - logHit({...})               把一次命中写入 sensitive_word_logs（谁、在哪、命中了什么、原文）
 *
 * 调用方职责：
 *   1. 用 scan() 拿到 filtered 写入数据库（展示给所有人的是被屏蔽后的文本）
 *   2. 拿到刚写入记录的 id 后，若 matched 非空，调用 logHit() 留下审计记录
 */

const sw = require('../配置/sensitive-word');
const pool = require('../配置/db');

// 扫描并屏蔽；matched 为去重后的命中词列表
function scan(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return { filtered: rawContent || '', matched: [] };
  if (!sw.contains(rawContent)) return { filtered: rawContent, matched: [] };
  const hits = sw.findAll(rawContent);
  const matched = [...new Set(hits.map(h => (h.word || '').trim()).filter(Boolean))];
  return { filtered: sw.replace(rawContent), matched };
}

// 记录一次敏感词命中（审计日志）
async function logHit({ userId = null, username = null, contentType, contentId = null, matched = [], rawContent = '' }) {
  if (!matched || matched.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO sensitive_word_logs
         (user_id, username, content_type, content_id, matched_words, raw_content)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        username,
        contentType,
        contentId,
        JSON.stringify(matched),
        rawContent
      ]
    );
  } catch (e) {
    console.error('[敏感词] 记录命中日志失败:', e.message);
  }
}

module.exports = { scan, logHit };
