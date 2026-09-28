#!/usr/bin/env node
// 打印指定文件在 window.location.origin 附近的上下文，用于人工审查改写结果。
// 用法：node peek.mjs <相对路径> [...]
import { readFileSync } from 'node:fs';
for (const rel of process.argv.slice(2)) {
  const t = readFileSync(rel, 'utf8');
  let i = -1, n = 0;
  while ((i = t.indexOf('window.location.origin', i + 1)) !== -1) {
    n += 1;
    console.log(`\n=== ${rel} #${n} ===`);
    console.log('...' + t.slice(Math.max(0, i - 90), i + 110) + '...');
  }
}
