#!/usr/bin/env node
// ============================================================
// Casdoor 前端 base path 补丁器
// ============================================================
// 目的：让官方 casbin/casdoor 镜像的前端产物支持部署在子路径（默认 /casdoor）下，
//       从而与主应用共用同一个 origin + 端口，实现「统一入口」。
//
// ------------------------------------------------------------
// 背景：为什么必须改产物，而不能靠配置
// ------------------------------------------------------------
// Casdoor 前端把若干 URL 硬编码成根路径，且没有环境变量能覆盖：
//
//   1. index.html 的 <script src="/assets/..."> / <link href="/assets/...">
//   2. 全局 API 基址 —— 模块级常量：
//          const se="";  ...  UP({serverUrl:se, appName:Uy});
//      所有请求形如 fetch(`${je.serverUrl}/api/...`)，se="" 即请求 /api/...
//      注：jsonWebConfig cookie 的覆盖函数 qx() 只认 7 个字段
//          (showGithubCorner/isDemoMode/forceLanguage/defaultLanguage/
//           staticBaseUrl/defaultApplication/maxItemsForFlatMenu)，
//          不含 serverUrl，因此 cookie 注入这条路无效。
//   3. OAuth 链接 `${window.location.origin}/login/oauth/authorize`
//   4. 回调地址 `${window.location.origin}/callback`
//   5. 独立入口 AuthCallbackHandler.js / ProviderHintRedirect.js 中的拼接与 fetch
//
// ------------------------------------------------------------
// 关键设计：区分 origin 的「拼接语义」与「值语义」
// ------------------------------------------------------------
// 不能无脑全局替换 window.location.origin —— 部分位置把它当「值」用：
//     - AuthCallbackHandler.js:  if (window.location.origin === realRedirectUrl)
//     - AuthCallbackHandler.js:  function getReactCallbackOrigin() { return origin; }
//     - AuthCallback.tsx:        localStorage.setItem("mfaRedirectUrl", origin)
//     - index.js:                origin === "http://localhost:7002"   // 版本探测
// 这些位置加前缀会破坏语义（比较恒假、存储错值）。
//
// 因此本补丁只改写「明确用于构造 URL」的形态：
//     `${window.location.origin}/xxx`   →  `${window.location.origin}${PREFIX}/xxx`
//     window.location.origin + "/xxx"   →  window.location.origin + PREFIX + "/xxx"
// 其余裸用法原样保留。
//
// ------------------------------------------------------------
// 幂等性：以 MARKER 作哨兵，重复执行不会二次改写。
// ============================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MARKER = '__CASDOOR_BASE_PATH_PATCHED__';

// ---------- 参数 ----------
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const WEB_DIR = argOf('web-dir', '/web/build');
const RAW_PREFIX = argOf('prefix', '/casdoor');
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

// 规范化前缀：确保 leading slash、去掉 trailing slash
let PREFIX = ('/' + RAW_PREFIX).replace(/\/+/g, '/').replace(/\/$/, '');
if (PREFIX === '') PREFIX = '/casdoor';
const NOOP = PREFIX === '/';
const P = JSON.stringify(PREFIX); // 用于注入 JS

// ---------- 统计 ----------
const stats = { scanned: 0, changed: 0, replacements: 0, skipped: 0 };
const hits = {}; // ruleName -> count
const log = (...a) => console.log('[patch-basepath]', ...a);
const warn = (...a) => console.warn('[patch-basepath]', ...a);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 应用规则集，返回 { text, count }。逐条统计命中，便于审查与回归。 */
function applyRules(text, rules, label) {
  let out = text;
  let total = 0;
  for (const rule of rules) {
    let hits_ = 0;
    out = out.replace(rule.re, (...m) => {
      hits_ += 1;
      return typeof rule.to === 'function' ? rule.to(...m) : rule.to;
    });
    if (hits_ > 0) {
      total += hits_;
      hits[rule.name] = (hits[rule.name] || 0) + hits_;
      if (DRY_RUN || VERBOSE) log(`  ${label}: [${rule.name}] x${hits_}`);
    }
  }
  return { text: out, count: total };
}

// ============================================================
// 1. index.html
// ============================================================
function patchIndexHtml(file) {
  let html = readFileSync(file, 'utf8');
  if (html.includes(MARKER)) {
    stats.skipped += 1;
    return;
  }

  const original = html;
  const rules = [
    {
      // <script src="/assets/xxx.js">
      name: 'html:script-src',
      re: /(<script\b[^>]*\bsrc=")\/(assets\/[^"]*)"/g,
      to: (_m, p1, p2) => `${p1}${PREFIX}/${p2}"`,
    },
    {
      // <link rel="stylesheet" href="/assets/xxx.css"> 及其他 <link href="/assets/..">
      // 同时覆盖 modulepreload 的 /assets/... 形式；不匹配 //host 或 http(s): 外链
      name: 'html:link-href',
      re: /(<link\b[^>]*\bhref=")\/((?:assets|static)\/[^"]*)"/g,
      to: (_m, p1, p2) => `${p1}${PREFIX}/${p2}"`,
    },
  ];

  const { text, count } = applyRules(html, rules, 'index.html');

  // 注入运行时前缀常量 + 幂等标记（放在所有 module script 之前）
  const marker = `<script>window.${MARKER}=1;window.CASDOOR_BASE_PATH=${P};</script>\n    `;
  const firstScript = text.search(/<script\b/);
  const out = firstScript === -1 ? text : text.slice(0, firstScript) + marker + text.slice(firstScript);

  stats.scanned += 1;
  if (out !== original) {
    stats.changed += 1;
    stats.replacements += count;
    if (!DRY_RUN) writeFileSync(file, out);
    log(`index.html: ${count} 处资源引用改写 + 运行时前缀注入`);
  } else {
    warn('index.html: 未命中任何规则，Casdoor 产物结构可能已变更，请人工确认');
  }
}

// ============================================================
// 2. 前端产物 JS
// ============================================================
/**
 * 规则设计要点：
 *  - 只匹配「拼接」形态，见文件头说明；
 *  - `window.location.origin` 与模板串/加号的组合是最可靠的拼接信号；
 *  - API 基址常量 se 单独处理（它在模块加载期就被固化，无法靠运行时补丁改）。
 */
function jsRules() {
  return [
    // ---- API 基址：const se=""; UP({serverUrl:se,...}) ----
    // se 是模块级 const，只有这一处定义；改掉它即让所有
    // fetch(`${je.serverUrl}/api/...`) 带上前缀。
    {
      name: 'js:api-base-const',
      re: /const se="",U=zy;/g,
      to: `const se=${P},U=zy;`,
    },

    // ---- 模板串拼接：`${window.location.origin}/xxx` ----
    // 例：`${window.location.origin}/callback`
    //     `${window.location.origin}/login/oauth/authorize`
    {
      name: 'js:template-concat',
      re: /\$\{window\.location\.origin\}(\/)/g,
      to: (_m, slash) => `\${window.location.origin}${PREFIX}${slash}`,
    },

    // ---- 加号拼接：window.location.origin + "/xxx" ----
    // 例：window.location.origin + "/callback"
    //     window.location.origin + "/api/login"
    {
      name: 'js:plus-concat',
      re: /window\.location\.origin\s*\+\s*"/g,
      to: `window.location.origin + ${P} + "`,
    },

    // ---- 三元回退式拼接：? X : window.location.origin ----
    // 形态（Util.js 与 ProviderHintRedirect.js 各一处）：
    //     const l = t.forcedRedirectOrigin ? t.forcedRedirectOrigin : window.location.origin;
    //     let n = `${l}/callback`;
    // 这里 origin 是「拼接用的基址」，必须带前缀，否则回调指回根路径。
    // 只改三元表达式的 else 分支，避免影响 forcedRedirectOrigin 的既有语义。
    {
      name: 'js:ternary-fallback-origin',
      re: /(\?\s*[A-Za-z_$][\w$.]*\s*:\s*)window\.location\.origin\b/g,
      to: (_m, p1) => `${p1}window.location.origin + ${P}`,
    },

    // ---- SPA router basename ----
    // 该版本 Casdoor 未在 createBrowserRouter 里显式传入 basename，而是沿用
    // react-router Router 组件内部的默认值 `basename:t="/"`（见 minified 的
    // function ix(e){let{basename:t="/",...}）。把它改成 PREFIX，使 SPA 在子路径
    // 下正确解析路由、保留 OAuth 授权参数（否则客户端重定向到 /login 会丢参数）。
    {
      name: 'js:router-basename-ix',
      re: /(function ix\(e\)\{let\{basename:t=)"\/"/g,
      to: (_m, p1) => `${p1}${P}`,
    },

    // ---- signinUrl 回跳地址：去掉 basename 前缀，避免 navigate 二次叠加 ----
    // 症状：登录成功后落到 /casdoor/apps 而非回到 OAuth authorize。
    // 根因：pL() 用 window.location.pathname（子路径下含 /casdoor 前缀）写入
    //   sessionStorage.signinUrl，而登录后回跳走 react-router 的 navigate()
    //   （basename 已设为 PREFIX），于是 URL 变成 /casdoor/casdoor/...，
    //   路由不匹配 → 落到默认 /apps。
    // 修复：把回跳地址里的 PREFIX 前缀剥掉，使其成为「路由路径」（不含 basename），
    //   这样 navigate() 叠加 basename 后得到正确的 /casdoor/... 地址。
    // 注：LoginPage 的 useEffect 用 useLocation().pathname（本就不含 basename），
    //   写入的 localStorage.signinUrl 无需处理；此处只修 window.location.pathname
    //   这种「读当前完整路径」的写法。
    {
      name: 'js:signinUrl-strip-prefix',
      re: /sessionStorage\.setItem\("signinUrl",window\.location\.pathname\+window\.location\.search\)/g,
      to: `sessionStorage.setItem("signinUrl",window.location.pathname.replace(new RegExp("^"+${JSON.stringify(PREFIX)}),"")+window.location.search)`,
    },

    // ---- 修复 OAuth 登录后落到 /apps：保留 code 登录类型 ----
    // 症状：在 /login/oauth/authorize 页面用密码登录成功后，SPA 直接跳到 /casdoor/apps，
    //   而不是带着 code 回跳 d5st 的 /auth/callback。
    // 根因：SigninPage 的预处理函数 Se() 里有一句
    //   e.type!=="device" && Nt(t?.redirectUri) && (e.type="login")
    //   当 URL 带 redirect_uri（OAuth 授权场景）时，会把登录结果类型 e.type 从 "code"
    //   强行改成 "login"；随后 se() 按 a==="login" 走 u(Lt())（应用列表 /apps），
    //   于是 OAuth 完成分支 An() 永远到不了。
    //   这正是子路径部署下暴露出来的问题：Nt(redirect_uri) 对 http://localhost:8080/auth/callback
    //   判定为"不合法"，从而回退成普通登录。
    // 修复：禁用“同源 redirect_uri 强制改 login”的覆盖。
    // 根因（已在容器 bundle 中确认）：Nt (=index 里的 eO) 实现为
    //   function eO(e){ if(!e) return !1; try{ return new URL(e).origin===e2() }catch{ return !1 } }
    // 即“redirect_uri 与 casdoor 同源时才算合法/内部跳转”。子路径部署下，
    // d5st 的回调 http://localhost:8080/auth/callback 与 casdoor 同处 localhost:8080（同源），
    // 于是 Nt(redirect_uri) 为真，Se() 把登录结果类型 e.type 从 "code" 强行改成 "login"，
    // 导致 se() 走 a==="login" 分支 u(Lt()) 跳到 /casdoor/apps，OAuth 完成分支 An() 到不了。
    // 正常（非子路径）部署下 casdoor 与业务站在不同源，Nt 返回假，所以没问题。
    // 修复：把该覆盖条件整体置为 &&!1（永远不覆盖），让 e.type 保留响应类型（OAuth 时为 "code"），
    //   从而走 An()/P(h) 带上 code&state 回跳 redirect_uri；普通后台登录（无 redirect_uri，
    //   t 为 null）仍由 `??"login"` 兜底为 "login"，行为不变。
    // 正则不绑定压缩变量名（Nt/t 每次构建会变），只锚定稳定的字面量片段。
    {
      name: 'js:oauth-keep-code-type',
      re: /e\.type!=="device"&&\w+\([^)]*redirectUri[^)]*\)&&\(e\.type="login"\)/g,
      to: `e.type!=="device"&&!1&&(e.type="login")`,
    },
  ];
}

function patchJsFile(file) {
  const label = relative(WEB_DIR, file);
  let text = readFileSync(file, 'utf8');
  if (text.includes(MARKER)) {
    stats.skipped += 1;
    return;
  }

  // 预筛：只处理可能含目标模式的产物，避免无谓 IO 与误伤
  const interesting =
    text.includes('window.location.origin') ||
    text.includes('const se=""') ||
    text.includes('basename:t="') ||
    text.includes('function ix(') ||
    text.includes('redirectUri'); // SigninPage 等含 OAuth 参数处理，无上述标记但需被改写
  if (!interesting) return;

  const original = text;
  const { text: patched, count } = applyRules(text, jsRules(), label);

  stats.scanned += 1;
  if (patched !== original) {
    stats.changed += 1;
    stats.replacements += count;
    if (!DRY_RUN) writeFileSync(file, patched);
    log(`${label}: ${count} 处`);
  }
}

// ============================================================
// 3. 校验
// ============================================================
/**
 * 校验改写结果：所有「拼接形态」的 origin 都应带上前缀。
 * 值语义的裸用法（比较/返回/存储）本就应保留，不视为问题。
 */
function validate() {
  const problems = [];
  const jsFiles = walk(WEB_DIR).filter((f) => f.endsWith('.js'));

  for (const f of jsFiles) {
    const t = readFileSync(f, 'utf8');
    const label = relative(WEB_DIR, f);

    // 未加前缀的模板串拼接。
    // 改写后形态为 ...origin}<PREFIX>/xxx，因此需排除「origin} 后紧跟 PREFIX/」的情况。
    const tplRe = new RegExp(
      String.raw`\$\{window\.location\.origin\}(?!${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)\/`,
      'g'
    );
    const tpl = t.match(tplRe);
    if (tpl) problems.push(`${label}: 模板串拼接未改写 x${tpl.length}`);

    // 未加前缀的加号拼接。改写后形态为 origin + "<PREFIX>" + "/xxx"
    const plusRe = new RegExp(
      String.raw`window\.location\.origin\s*\+\s*"(?!${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`,
      'g'
    );
    const plus = t.match(plusRe);
    if (plus) problems.push(`${label}: 加号拼接未改写 x${plus.length}`);

    // API 基址
    if (t.includes('const se=""')) problems.push(`${label}: API 基址仍为空串`);

    // router basename：react-router Router 默认 `basename:t="/"` 必须被改成前缀
    if (/function ix\(e\)\{let\{basename:t="\/"/.test(t)) problems.push(`${label}: router basename 仍为 "/"`);
  }

  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  if (!html.includes(MARKER)) problems.push('index.html: 缺失补丁标记');
  if (!html.includes(`href="${PREFIX}/assets/`) && !html.includes(`src="${PREFIX}/assets/`)) {
    problems.push('index.html: 资源引用未带前缀');
  }

  return problems;
}

// ============================================================
// 主流程
// ============================================================
function main() {
  log(`web-dir = ${WEB_DIR}`);
  log(`prefix  = ${PREFIX}${NOOP ? '  (根路径，无需改写)' : ''}`);
  log(`mode    = ${DRY_RUN ? 'dry-run（不写入）' : 'write'}`);
  log('');

  if (NOOP) {
    log('前缀为根路径，跳过所有改写。');
    return;
  }

  try {
    statSync(WEB_DIR);
  } catch {
    console.error(`[patch-basepath] 目录不存在: ${WEB_DIR}`);
    process.exit(1);
  }

  // 1) index.html
  patchIndexHtml(join(WEB_DIR, 'index.html'));

  // 2) 全部 JS（含 assets/*.js 与顶层入口 js）
  const jsFiles = walk(WEB_DIR).filter((f) => f.endsWith('.js'));
  log(`扫描 ${jsFiles.length} 个 JS 文件 ...`);
  for (const f of jsFiles) patchJsFile(f);

  // 3) 校验
  if (!DRY_RUN) {
    log('');
    log('校验中 ...');
    const problems = validate();
    if (problems.length) {
      warn('发现未完成改写的项：');
      problems.forEach((p) => warn(`  - ${p}`));
      warn('请人工确认后重新构建；若 Casdoor 版本变更导致结构与预期不符，需更新本脚本规则。');
      process.exit(2);
    }
    log('校验通过');
  }

  log('');
  log(`规则命中统计：`);
  for (const [k, v] of Object.entries(hits).sort()) log(`  ${k.padEnd(24)} ${v}`);
  log('');
  log(`完成：扫描 ${stats.scanned} 个文件，改写 ${stats.changed} 个，共 ${stats.replacements} 处` +
      (stats.skipped ? `，跳过已打补丁 ${stats.skipped} 个` : ''));
  if (DRY_RUN) log('（dry-run，未写入任何文件）');
}

main();
