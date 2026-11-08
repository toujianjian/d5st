/* ============================================================
 * home-lite.js —— 移动端/触屏专用的首页脚本
 * ------------------------------------------------------------
 * 背景：
 *   home-shell.js 有 585 行 / 25KB，其中大部分是桌面视觉特效
 *   （自定义光标跟随、光标揭示层、Canvas 线场、FPS 计数器、滚动光标模糊）。
 *   它在移动端虽然用 liteMode 跳过了逐帧动画，但整个文件仍要下载并解析，
 *   在 4x CPU 降速下实测占用约 390ms 主线程 —— 这些代码手机上一行都不执行。
 *
 * 本文件只保留**移动端真正需要**的部分：
 *   1. 主题初始化（在首屏前同步执行，避免闪烁）
 *   2. 主题切换按钮
 *   3. 汉堡菜单开合（触屏无 hover，必须有 JS）
 *   4. 滚动渐显 [data-reveal]
 *   5. 统计数字滚动
 *
 * 使用方式：layout-home.ejs 里按 matchMedia 选择加载本文件或 home-shell.js，
 * 两者互斥，不会重复绑定事件。
 * ============================================================ */
(function () {
  const root = document.documentElement;

  /* ---------- 主题初始化：localStorage 优先，否则跟随系统 ---------- */
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("leo-theme"); } catch (e) {}
    if (saved === "dark" || saved === "light") {
      root.dataset.theme = saved;
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.dataset.theme = "dark";
    } else {
      root.dataset.theme = "light";
    }
  })();

  /* ---------- 主题切换 ---------- */
  const themeToggle = document.querySelector("#themeToggle");
  themeToggle && themeToggle.addEventListener("click", function () {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.classList.add("theme-changing");
    root.dataset.theme = next;
    try { localStorage.setItem("leo-theme", next); } catch (e) {}
    window.setTimeout(function () { root.classList.remove("theme-changing"); }, 520);
  });

  /* ---------- 汉堡菜单 ----------
     触屏（pointer: coarse）下顶部导航折叠为汉堡菜单，靠 html.mobile-menu-open 展开。 */
  const mobileToggle = document.querySelector("#mobileMenuToggle");
  const primaryNav = document.querySelector("#primaryNav");
  if (mobileToggle && primaryNav) {
    const setMenu = function (open) {
      root.classList.toggle("mobile-menu-open", open);
      mobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    mobileToggle.addEventListener("click", function (event) {
      event.stopPropagation();
      setMenu(!root.classList.contains("mobile-menu-open"));
    });
    // 点击菜单里的链接后自动收起
    primaryNav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setMenu(false);
    });
    // 点击菜单以外区域收起
    document.addEventListener("click", function (event) {
      if (!root.classList.contains("mobile-menu-open")) return;
      if (mobileToggle.contains(event.target) || primaryNav.contains(event.target)) return;
      setMenu(false);
    });
    // Esc 收起
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setMenu(false);
    });
    // 回到桌面布局（按钮被隐藏）时自动收起，避免状态残留
    window.addEventListener("resize", function () {
      if (getComputedStyle(mobileToggle).display === "none" &&
          root.classList.contains("mobile-menu-open")) {
        setMenu(false);
      }
    });
  }

  /* ---------- 滚动渐显 ---------- */
  const revealItems = document.querySelectorAll("[data-reveal]");
  function updateRevealItems() {
    if (!revealItems.length) return;
    const trigger = window.innerHeight * 0.88;
    revealItems.forEach(function (el) {
      if (el.getBoundingClientRect().top < trigger) {
        el.classList.add("is-revealed");
      }
    });
  }
  updateRevealItems();

  let revealFrame = 0;
  window.addEventListener("scroll", function () {
    if (revealFrame) return;
    revealFrame = window.requestAnimationFrame(function () {
      revealFrame = 0;
      updateRevealItems();
    });
  }, { passive: true });

  /* ---------- 统计数字滚动 ---------- */
  function startCountUp() {
    const nums = document.querySelectorAll(".num[data-count]");
    if (!nums.length) return;
    const animate = function (el) {
      const target = parseFloat(el.dataset.count) || 0;
      const dur = 900;
      const t0 = performance.now();
      const step = function (now) {
        const p = Math.min(1, (now - t0) / dur);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (p < 1) window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    };
    nums.forEach(animate);
  }

  // 首屏渲染完再跑数字动画，避免抢主线程
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(startCountUp, { timeout: 1200 });
  } else {
    window.setTimeout(startCountUp, 120);
  }
})();
