'use strict';
/**
 * 敏感词过滤（Node.js 实现，算法/API 设计借鉴 https://github.com/houbb/sensitive-word）
 *
 * 说明：houbb/sensitive-word 是 Java 库，本项目运行环境为 Node.js + Express，
 * 无法直接引入 JVM 依赖。这里用「DFA + 忽略干扰字符」的思路实现等价的过滤能力：
 *   - 支持从数据库动态加载词库（管理员可随时增删，无需重启）
 *   - contains(text)        是否包含敏感词
 *   - findAll(text)         返回所有命中（含原文与位置）
 *   - replace(text, char)   将命中的字符替换为掩码（默认 *）
 *   - reload()              从 DB 重新加载词库到内存
 *
 * 忽略干扰字符：命中过程中允许词与词之间穿插空格 / 标点 / 特殊符号，
 * 例如「敏*感*词」「敏 感 词」都能被识别，避免被轻易绕过。
 */

const pool = require('./db');

// 命中过程中可被跳过的干扰字符（词与词之间穿插这些字符仍算命中）
const IGNORE_CHARS = new Set([
  ' ', '　', '*', '·', '.', '。', '．', '-', '_', '~', '!', '！', '@', '#', '$', '%', '^',
  '&', '，', '、', '：', '；', ':', ';', '(', ')', '（', '）', '[', ']', '【', '】',
  '+', '=', '?', '？', '/', '\\', '|', '<', '>', '《', '》', '"', "'", '`', '~'
]);

let wordTrie = null;   // 已构建的 DFA 根节点
let wordList = [];      // 原始词库（用于展示/计数）
let lastLoaded = 0;

function buildTrie(words) {
  const root = {};
  for (const raw of words) {
    const w = String(raw).trim();
    if (!w) continue;
    let node = root;
    for (const ch of w) {
      if (!node[ch]) node[ch] = {};
      node = node[ch];
    }
    node._end = true;
  }
  return root;
}

// 从数据库加载词库到内存；表不存在时安全降级为空词库
async function reload() {
  try {
    const [rows] = await pool.query(
      'SELECT word FROM sensitive_words WHERE is_disabled = 0 OR is_disabled IS NULL'
    );
    wordList = rows.map(r => String(r.word).trim()).filter(Boolean);
    wordTrie = buildTrie(wordList);
    lastLoaded = Date.now();
    console.log(`[敏感词] 词库已加载，共 ${wordList.length} 条`);
  } catch (e) {
    // 表尚未创建时退化为空词库，不阻塞启动
    wordTrie = {};
    wordList = [];
    console.warn('[敏感词] 词库加载跳过（表可能未就绪）:', e.message);
  }
}

function getTrie() {
  if (!wordTrie) wordTrie = {};
  return wordTrie;
}

// 扫描文本，返回所有命中的词（去重前保留原始片段与位置）
function findAll(text) {
  if (!text || typeof text !== 'string') return [];
  const trie = getTrie();
  const results = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let node = trie[text[i]];
    if (!node) continue;
    let start = i;
    let end = i;
    let hitNode = node._end ? node : null;
    let j = i + 1;
    let skip = 0;
    while (j < n) {
      const ch = text[j];
      if (node[ch]) {
        node = node[ch];
        end = j;
        if (node._end) hitNode = node;
        j++;
        skip = 0;
      } else if (IGNORE_CHARS.has(ch) && skip < 4) {
        // 跳过干扰字符，最多连续 4 个
        j++;
        skip++;
      } else {
        break;
      }
    }
    if (hitNode) {
      results.push({ word: text.slice(start, end + 1), startIndex: start, endIndex: end });
      i = end; // 不重叠，继续向后
    }
  }
  return results;
}

function contains(text) {
  return findAll(text).length > 0;
}

// 将命中的真实字符替换为 replaceChar（干扰字符本身不替换，仅掩盖敏感字）
function replace(text, replaceChar = '*') {
  const hits = findAll(text);
  if (!hits.length) return text;
  const chars = text.split('');
  for (const h of hits) {
    for (let k = h.startIndex; k <= h.endIndex; k++) {
      if (!IGNORE_CHARS.has(chars[k])) chars[k] = replaceChar;
    }
  }
  return chars.join('');
}

module.exports = {
  reload,
  findAll,
  contains,
  replace,
  buildTrie,
  getTrie,
  getWords: () => wordList,
  get lastLoaded() { return lastLoaded; }
};
