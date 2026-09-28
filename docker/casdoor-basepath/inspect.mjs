#!/usr/bin/env node
// 逐处打印 window.location.origin 改写前后的上下文，用于人工审查改写正确性。
// 用法：node inspect.mjs --web-dir=./.tmp-web
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB_DIR = (process.argv.find(a => a.startsWith('--web-dir=')) || '--web-dir=./.tmp-web').slice(10);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    statSync(f).isDirectory() ? walk(f, out) : out.push(f);
  }
  return out;
}

const files = walk(WEB_DIR).filter(f => f.endsWith('.js'));
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  let idx = -1;
  let n = 0;
  while ((idx = t.indexOf('window.location.origin', idx + 1)) !== -1) {
    n += 1;
    const before = t.slice(Math.max(0, idx - 70), idx);
    const after = t.slice(idx + 22, idx + 22 + 70);
    console.log(`\n=== ${relative(WEB_DIR, f)} #${n} ===`);
    console.log(`  ...${before}[ORIGIN]${after}...`);
  }
}
