# -*- coding: utf-8 -*-
"""
静态资源构建：FontAwesome 子集化 + CSS 合并 + 内容指纹

用法：
    python 工具/build-assets.py

做四件事：
  1) 扫描全仓库实际用到的 fa-xxx 图标（模板 + 后端模块 + 配置 + 前端 js）
  2) 只保留用到图标的字形，裁剪 fa-solid-900 / fa-regular-400（woff2）
  3) 只保留用到图标的 CSS 规则，再按 layout 合并成单个 bundle
  4) 把 bundle 以「内容指纹」命名写入 静态资源/css/，并改写两个 layout 的 <link>

设计要点：
  - 不修改 all.min.css 与原始字体文件，随时可回滚
  - bundle 文件名带 10 位内容哈希，配合 app.js 里的 immutable 长缓存
  - 末尾做断言：任何图标缺规则 / 缺字形都会直接失败，不会静默产出残废包

注意：给模板新增图标后，请重新运行本脚本，否则新图标不在子集里（会显示为空格）。
"""
import os
import re
import sys
import json
import gzip
import glob
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FA_DIR = ROOT / "静态资源" / "font-awesome"
WEBFONTS = FA_DIR / "webfonts"
CSS_DIR = ROOT / "静态资源" / "css"
TPL_DIR = ROOT / "页面模板"

SCAN_DIRS = ["页面模板", "功能模块", "配置", "静态资源/js"]
EXTS = (".ejs", ".js")

STYLE_MAP = {
    "fas": "solid", "fa-solid": "solid",
    "far": "regular", "fa-regular": "regular",
    "fab": "brands", "fa-brands": "brands",
    "fal": "light", "fa-light": "light",
    "fad": "duotone", "fa-duotone": "duotone",
    "fat": "thin", "fa-thin": "thin",
}

PAIR = re.compile(
    r'\b(fas|far|fab|fal|fad|fat|fa-solid|fa-regular|fa-brands|fa-light|fa-duotone|fa-thin)\b'
    r'[^"\'<>]{0,40}?\b(fa-[a-z0-9-]+)\b'
)
PAIR_REV = re.compile(
    r'\b(fa-[a-z0-9-]+)\b[^"\'<>]{0,40}?\b(fas|far|fab|fal|fad|fat)\b'
)
BARE = re.compile(r'\b(fa-[a-z0-9-]+)\b')

NOT_ICON = set("""
fa-solid fa-regular fa-brands fa-light fa-duotone fa-thin fa-sharp fa-classic
fa-2x fa-3x fa-4x fa-5x fa-lg fa-sm fa-xs fa-1x fa-fw fa-ul fa-li fa-border
fa-pull-left fa-pull-right fa-spin fa-pulse fa-rotate-90 fa-rotate-180 fa-rotate-270
fa-flip-horizontal fa-flip-vertical fa-flip-both fa-stack fa-stack-1x fa-stack-2x
fa-inverse fa-layers fa-layers-text fa-layers-counter fa-beat fa-fade fa-beat-fade
fa-bounce fa-shake fa-spin-pulse fa-spin-reverse fa-rotate-by fa-swap-opacity
fa-font-awesome fa-icons fa-icon
""".split())


def h8(b):
    return hashlib.sha256(b).hexdigest()[:10]


def parse_css():
    css = (FA_DIR / "all.min.css").read_text(encoding="utf-8", errors="replace")
    cmap = {}
    for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
        sel, body = m.group(1), m.group(2)
        cm = re.search(r'content\s*:\s*"\\([0-9a-fA-F]{1,6})"', body)
        if not cm:
            continue
        cp = int(cm.group(1), 16)
        for name in re.findall(r'\.(fa-[a-z0-9-]+)', sel):
            cmap.setdefault(name, cp)
    return cmap, css


def scan_used(cmap):
    used = {}
    for d in SCAN_DIRS:
        for p in (ROOT / d).rglob("*"):
            if not (p.is_file() and p.suffix in EXTS):
                continue
            try:
                txt = p.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            if "fa-" not in txt:
                continue
            for m in PAIR.finditer(txt):
                name = m.group(2)
                if name in NOT_ICON:
                    continue
                used.setdefault(name, set()).add(STYLE_MAP.get(m.group(1), "solid"))
            for m in PAIR_REV.finditer(txt):
                name = m.group(1)
                if name in NOT_ICON:
                    continue
                used.setdefault(name, set()).add(STYLE_MAP.get(m.group(2), "solid"))
            # 兜底：动态拼接的图标名（如 JS 常量 { icon: 'fa-file-alt' }）
            # 成对正则抓不到，这里把所有在码位表里的 fa-xxx 都算已用，宁多勿漏。
            for m in BARE.finditer(txt):
                name = m.group(1)
                if name in NOT_ICON or name not in cmap:
                    continue
                used.setdefault(name, set()).add("solid")
    return used


def pick_source(label):
    """优先 woff2；其 glyf 表损坏时（本仓库 fa-regular-400.woff2 就是）回退到完好的 ttf。"""
    from fontTools.ttLib import TTFont
    w2 = WEBFONTS / (label + ".woff2")
    try:
        f = TTFont(str(w2), lazy=False)
        f["glyf"]
        f.close()
        return w2, False
    except Exception:
        return WEBFONTS / (label + ".ttf"), True


def make_subset(src, unicodes, label):
    from fontTools import subset
    opts = subset.Options()
    opts.flavor = "woff2"
    font = subset.load_font(str(src), opts)
    s = subset.Subsetter(options=opts)
    s.populate(unicodes=unicodes)
    s.subset(font)
    tmp = str(WEBFONTS / "_tmp.woff2")
    subset.save_font(font, tmp, opts)
    font.close()
    raw = Path(tmp).read_bytes()
    os.remove(tmp)
    name = "%s.%s.woff2" % (label, h8(raw))
    (WEBFONTS / name).write_bytes(raw)
    return name, len(raw)


def main():
    # 放在函数最前面：后面的多处报告都要用它计算 gzip 体积，
    # 如果定义在中途会出现 "referenced before assignment"
    def gz(b):
        return len(gzip.compress(b, 9))

    cmap, raw_css = parse_css()
    used = scan_used(cmap)
    by_style = {"solid": [], "regular": [], "brands": []}
    for n, styles in used.items():
        if n not in cmap:
            continue
        for s in styles:
            if s in by_style:
                by_style[s].append(n)

    solid_names = sorted(set(by_style["solid"]))
    regular_names = sorted(set(by_style["regular"]))
    solid_cps = sorted({cmap[n] for n in solid_names})
    regular_cps = sorted({cmap[n] for n in regular_names})

    # 清理上一次生成的子集字体
    for old in glob.glob(str(WEBFONTS / "fa-solid-900.*.woff2")) + \
               glob.glob(str(WEBFONTS / "fa-regular-400.*.woff2")):
        if re.search(r'fa-(solid|regular)-\d+\.[0-9a-f]{10}\.woff2$', old):
            os.remove(old)

    solid_src, solid_fb = pick_source("fa-solid-900")
    regular_src, regular_fb = pick_source("fa-regular-400")
    solid_file, solid_size = make_subset(solid_src, solid_cps, "fa-solid-900")
    regular_file, regular_size = make_subset(regular_src, regular_cps, "fa-regular-400")

    # 校验字形
    from fontTools.ttLib import TTFont
    def cps_of(p):
        f = TTFont(str(p))
        s = set()
        for t in f["cmap"].tables:
            s |= set(t.cmap.keys())
        f.close()
        return s
    have_solid = cps_of(WEBFONTS / solid_file)
    have_regular = cps_of(WEBFONTS / regular_file)
    miss_solid = [n for n in solid_names if cmap[n] not in have_solid]
    miss_regular = [n for n in regular_names if cmap[n] not in have_regular]

    # 过滤图标规则
    out, last = [], 0
    for m in re.finditer(r'([^{}]*?)\{(content\s*:\s*"\\([0-9a-fA-F]{1,6})"[^{}]*)\}', raw_css):
        names = re.findall(r'\.(fa-[a-z0-9-]+)', m.group(1))
        if names and not any(n in used for n in names):
            out.append(raw_css[last:m.start()])
            last = m.end()
    out.append(raw_css[last:])
    css = "".join(out)

    # 丢弃原有 @font-face，改为显式声明我们真正产出的字体
    FF = ('@font-face{font-family:"%s";font-style:normal;font-weight:%s;'
          'font-display:block;src:url(../webfonts/%s) format("woff2")}')
    ff = []
    for fam in ("Font Awesome 6 Free", "Font Awesome 5 Free"):
        ff.append(FF % (fam, "900", solid_file))
        ff.append(FF % (fam, "400", regular_file))
    for fam in ("Font Awesome 6 Brands", "Font Awesome 5 Brands"):
        ff.append(FF % (fam, "400", "fa-brands-400.woff2"))
    ff.append('@font-face{font-family:"FontAwesome";font-display:block;'
              'src:url(../webfonts/%s) format("woff2")}' % solid_file)
    css = "".join(ff) + re.sub(r'@font-face\s*\{[^}]*\}', '', css)
    (FA_DIR / "fa-subset.css").write_text(css, encoding="utf-8")

    miss_rules = [n for n in used if n in cmap and
                  ('.%s:' % n) not in css and ('.%s{' % n) not in css and ('.%s,' % n) not in css]

    # 合并 bundle
    for old in glob.glob(str(CSS_DIR / "bundle-*.css")):
        os.remove(old)
    bundles = {}
    for tag, srcs in (("app", ["main.css"]),
                      ("home", ["pidanai-theme.css", "pidanai.css", "pidanai-home.css"])):
        parts = ["/* ==== Font Awesome (subset) ==== */\n", css]
        for s in srcs:
            parts.append("\n/* ==== %s ==== */\n" % s)
            parts.append((CSS_DIR / s).read_text(encoding="utf-8", errors="replace"))
        payload = "".join(parts).encode("utf-8")
        fname = "bundle-%s.%s.css" % (tag, h8(payload))
        (CSS_DIR / fname).write_bytes(payload)
        bundles[tag] = (fname, payload)

    # 改写 layout
    def patch(layout, url):
        p = TPL_DIR / layout
        txt = p.read_text(encoding="utf-8")
        block = ('<!-- ASSETS:BEGIN (由 工具/build-assets.py 生成，勿手改) -->\n'
                 '  <link rel="stylesheet" href="%s" />\n'
                 '  <!-- ASSETS:END -->' % url)
        if "<!-- ASSETS:BEGIN" in txt:
            txt = re.sub(r'<!-- ASSETS:BEGIN.*?<!-- ASSETS:END -->', block, txt, flags=re.S)
        else:
            pat = re.compile(
                r'(?:[ \t]*<link rel="stylesheet" href="/public/(?:font-awesome/all\.min\.css|'
                r'css/(?:main|pidanai-theme|pidanai|pidanai-home)\.css)" />\n?)+')
            txt, n = pat.subn(block + "\n", txt, count=1)
            if n == 0:
                raise SystemExit("未能在 %s 中定位样式链接" % layout)
        p.write_text(txt, encoding="utf-8")

    patch("layout.ejs", "/public/css/" + bundles["app"][0])
    patch("layout-home.ejs", "/public/css/" + bundles["home"][0])

    # home 布局的 preload 也自动同步（它用的是 bundle-home）
    def patch_preload_home(urls):
        p = TPL_DIR / "layout-home.ejs"
        txt = p.read_text(encoding="utf-8")
        lines = ["<!-- PRELOAD:BEGIN (由 工具/build-assets.py 生成，勿手改) -->"]
        for u in urls:
            lines.append('    <link rel="preload" href="%s" as="style" />' % u)
        lines.append("    <noscript>")
        for u in urls:
            lines.append('      <link rel="stylesheet" href="%s" />' % u)
        lines.append("    </noscript>")
        lines.append("    <!-- PRELOAD:END -->")
        block = "\n".join(lines)
        if "<!-- PRELOAD:BEGIN" in txt:
            txt = re.sub(r'<!-- PRELOAD:BEGIN.*?<!-- PRELOAD:END -->', block, txt, flags=re.S)
            p.write_text(txt, encoding="utf-8")
            return True
        return False

    # 立即应用到 home 布局（之前只定义了函数却没调用，导致它的 preload 块是空的）
    print("preload(home): %s" % ("已同步" if patch_preload_home(["/public/css/" + bundles["home"][0]])
                                 else "[警告] layout-home.ejs 未找到 PRELOAD 标记"))

    # 首页布局专属样式（layout-home.ejs 原来的内联 <style>，约 3.7KB）
    home_core_src = CSS_DIR / "layout-home.css"
    if home_core_src.exists():
        hc_payload = home_core_src.read_bytes()
        hc_fname = "layout-home.%s.css" % h8(hc_payload)
        (CSS_DIR / hc_fname).write_bytes(hc_payload)
        for old in glob.glob(str(CSS_DIR / "layout-home.*.css")):
            if os.path.basename(old) != hc_fname:
                os.remove(old)

        # 首页区块样式（轮播等，原 home/index.ejs 开头的内联 <style>）
        sections_src = CSS_DIR / "home-sections.css"
        sec_fname = None
        if sections_src.exists():
            sec_payload = sections_src.read_bytes()
            sec_fname = "home-sections.%s.css" % h8(sec_payload)
            (CSS_DIR / sec_fname).write_bytes(sec_payload)
            for old in glob.glob(str(CSS_DIR / "home-sections.*.css")):
                if os.path.basename(old) != sec_fname:
                    os.remove(old)
            print("home-sections: %s  %d B (gzip %d)"
                  % (sec_fname, len(sec_payload), gz(sec_payload)))

        p = TPL_DIR / "layout-home.ejs"
        txt = p.read_text(encoding="utf-8")
        links = ['    <link rel="stylesheet" href="/public/css/%s" />' % hc_fname]
        if sec_fname:
            links.append('    <link rel="stylesheet" href="/public/css/%s" />' % sec_fname)
        block = ('<!-- HOME-CSS:BEGIN (由 工具/build-assets.py 生成，勿手改) -->\n'
                 + "\n".join(links) + '\n'
                 '    <!-- HOME-CSS:END -->')
        if "<!-- HOME-CSS:BEGIN" in txt:
            txt = re.sub(r'<!-- HOME-CSS:BEGIN.*?<!-- HOME-CSS:END -->', block, txt, flags=re.S)
            p.write_text(txt, encoding="utf-8")
            print("layout-home: %s  %d B (gzip %d)" % (hc_fname, len(hc_payload), gz(hc_payload)))
            # 首页的 preload 需要同时包含 bundle-home 与两个布局/区块 CSS，
            # 这里在都就绪后统一重写一次
            preload_urls = ["/public/css/" + bundles["home"][0],
                            "/public/css/" + hc_fname]
            if sec_fname:
                preload_urls.append("/public/css/" + sec_fname)
            patch_preload_home(preload_urls)
        else:
            print("[警告] layout-home.ejs 中未找到 HOME-CSS 标记")



    # 布局核心样式单独成包（原先是 layout.ejs 里的内联 <style>，约 20KB）
    # 单独而不是并进 bundle-app 的原因：layout-core 是所有页面共享的布局骨架，
    # 改动频率远低于站点样式；分开可以让两者各自独立缓存，
    # 改站点样式时不会让所有人的布局 CSS 缓存一起失效。
    core_src = CSS_DIR / "layout-core.css"
    if core_src.exists():
        core_payload = core_src.read_bytes()
        core_fname = "layout-core.%s.css" % h8(core_payload)
        (CSS_DIR / core_fname).write_bytes(core_payload)
        # 清理旧的带指纹版本
        for old in glob.glob(str(CSS_DIR / "layout-core.*.css")):
            if os.path.basename(old) != core_fname:
                os.remove(old)

        def patch_layout_css(url):
            p = TPL_DIR / "layout.ejs"
            txt = p.read_text(encoding="utf-8")
            block = ('<!-- LAYOUT-CSS:BEGIN (由 工具/build-assets.py 生成，勿手改) -->\n'
                     '  <link rel="stylesheet" href="%s" />\n'
                     '  <!-- LAYOUT-CSS:END -->' % url)
            if "<!-- LAYOUT-CSS:BEGIN" in txt:
                txt = re.sub(r'<!-- LAYOUT-CSS:BEGIN.*?<!-- LAYOUT-CSS:END -->', block, txt, flags=re.S)
                p.write_text(txt, encoding="utf-8")
                return True
            return False

        patched = patch_layout_css("/public/css/" + core_fname)
        print("layout-core: %s  %d B (gzip %d)%s"
              % (core_fname, len(core_payload), gz(core_payload),
                 "" if patched else "  [警告] layout.ejs 中未找到 LAYOUT-CSS 标记"))

        # 同步 preload 块：CSS 文件名带内容指纹，写死会失配
        def patch_preload(urls):
            p = TPL_DIR / "layout.ejs"
            txt = p.read_text(encoding="utf-8")
            lines = ["<!-- PRELOAD:BEGIN (由 工具/build-assets.py 生成，勿手改) -->"]
            lines.append("  <%# 关键的布局与站点 CSS 并行预加载，避免串行等待 %>")
            for u in urls:
                lines.append('  <link rel="preload" href="%s" as="style" />' % u)
            lines.append("  <noscript>")
            for u in urls:
                lines.append('    <link rel="stylesheet" href="%s" />' % u)
            lines.append("  </noscript>")
            lines.append("  <!-- PRELOAD:END -->")
            block = "\n".join(lines)
            if "<!-- PRELOAD:BEGIN" in txt:
                txt = re.sub(r'<!-- PRELOAD:BEGIN.*?<!-- PRELOAD:END -->', block, txt, flags=re.S)
                p.write_text(txt, encoding="utf-8")
                return True
            return False

        pl = patch_preload(["/public/css/" + core_fname,
                            "/public/css/" + bundles["app"][0]])
        print("preload 块: %s" % ("已同步" if pl else "[警告] 未找到 PRELOAD 标记"))

    else:
        print("layout-core.css 不存在，跳过（布局样式仍为内联）")


    # 报告
    print("图标: solid=%d (码位 %d), regular=%d (码位 %d), brands=%d"
          % (len(solid_names), len(solid_cps), len(regular_names), len(regular_cps), len(by_style["brands"])))
    print("字体: solid %d B%s -> %d B | regular %d B%s -> %d B"
          % ((WEBFONTS / "fa-solid-900.woff2").stat().st_size, " (回退 ttf)" if solid_fb else "",
             solid_size, (WEBFONTS / "fa-regular-400.woff2").stat().st_size,
             " (回退 ttf)" if regular_fb else "", regular_size))
    for tag, (fn, payload) in bundles.items():
        print("bundle-%s: %s  %d B (gzip %d)" % (tag, fn, len(payload), gz(payload)))
    print("CSS: all.min.css %d B (gzip %d) -> fa-subset.css %d B (gzip %d)"
          % (len(raw_css.encode()), gz(raw_css.encode()),
             len(css.encode()), gz(css.encode())))

    bad = []
    if miss_solid:
        bad.append("缺 solid 字形: " + ", ".join(miss_solid))
    if miss_regular:
        bad.append("缺 regular 字形: " + ", ".join(miss_regular))
    if miss_rules:
        bad.append("缺 CSS 规则: " + ", ".join(miss_rules[:10]))
    for tag, (fn, payload) in bundles.items():
        txt = payload.decode("utf-8")
        if txt.count("{") != txt.count("}"):
            bad.append("%s 花括号不平衡" % fn)
    if bad:
        print("\n构建失败：")
        for b in bad:
            print("  - " + b)
        sys.exit(1)
    print("\n校验通过：图标规则与字形全部覆盖。")


if __name__ == "__main__":
    main()
