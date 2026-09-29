/* ============================================================================
   home-shell.js —— D5ST 首页交互（忠于 pidanai.com 原始实现，剥离 SPA 路由）
   包含：主题切换 · 动态线场(默认随原版关闭) · Hero 3D 倾斜 · 光标聚光揭示
        · 点击爆破 · FPS 计数 · 滚动场景过渡 · 滚动渐显 · 统计数字滚动
   ========================================================================== */
(function () {
  "use strict";

  const root = document.documentElement;
  const siteHeader = document.querySelector(".site-header");
  const themeToggle = document.querySelector("#themeToggle");
  const cursorReveal = document.querySelector(".cursor-reveal");
  const cursorPop = document.querySelector(".cursor-pop");
  const fpsDisplay = document.querySelector("#pdaimFps");
  const lineFieldCanvas = document.querySelector("#pdaimLineField");

  const hasHeroCursor = Boolean(document.querySelector(".hero-copy-base"));

  /* ---------- 主题初始化（与原版一致：localStorage 优先，否则跟随系统） ---------- */
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  try {
    const saved = localStorage.getItem("leo-theme");
    root.dataset.theme = saved || (prefersDark ? "dark" : "light");
  } catch (e) {
    root.dataset.theme = prefersDark ? "dark" : "light";
  }

  /* ---------- 光标状态 ---------- */
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let targetX = cursorX;
  let targetY = cursorY;
  let cursorScale = 1;
  let scaleAnimation = 0;
  let popTimer = 0;
  let isHeaderHover = false;
  let isPageHover = false;
  let activeRadius = 0;
  let scrollFrame = 0;
  let cursorLoopStarted = false;

  /* ---------- 工具函数 ---------- */
  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(value, min), max);
  }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  /* ---------- 滚动渐显（与原版 updateRevealItems 一致） ---------- */
  let revealItems = document.querySelectorAll("[data-reveal]");
  function updateRevealItems() {
    // 进入线放宽到 0.96：首屏底部露出的卡片与标题一起显示，避免中间空洞；
    // 复位线保持在视口下方 1.08 倍处，往返滚动仍可重复播放动画。
    const enterLine = window.innerHeight * 0.96;
    const resetBelow = window.innerHeight * 1.08;
    revealItems.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const isVisible = item.classList.contains("is-visible");
      // 只要元素顶部越过进入线（含已滚过视口上方的情形）就显示，
      // 避免快速滚动/锚点跳转时元素停在视口上方而永远保持 opacity:0。
      if (!isVisible && rect.top < enterLine) {
        item.classList.add("is-visible");
        return;
      }
      // 仅在元素重新回到视口下方（或远在视口上方）时才复位，供往返滚动重复播放。
      if (isVisible && rect.top > resetBelow) {
        item.classList.remove("is-visible");
      }
    });
  }

  /* ---------- 光标揭示几何 ---------- */
  function updateCursorInnerOffset(x = cursorX, y = cursorY) {
    if (!cursorReveal) return;
    cursorReveal.style.setProperty("--cursor-inner-x", `${activeRadius - x}px`);
    cursorReveal.style.setProperty("--cursor-inner-y", `${activeRadius - y - window.scrollY}px`);
  }
  function setCursorScale(scale) {
    cursorScale = clamp(scale, 0.035, 1.06);
    updateCursorGeometry();
  }
  function getBaseCursorRadius() {
    if (window.innerWidth <= 620) return 66;
    return Math.min(Math.max(window.innerWidth * 0.085, 65), 122.5);
  }
  function updateCursorGeometry() {
    activeRadius = getBaseCursorRadius() * cursorScale;
    cursorReveal && cursorReveal.style.setProperty("--cursor-active-radius", `${activeRadius.toFixed(2)}px`);
    updateCursorInnerOffset();
  }
  function cancelScaleAnimation() {
    if (scaleAnimation) cancelAnimationFrame(scaleAnimation);
    scaleAnimation = 0;
  }
  function animateCursorScale(segments, onComplete) {
    cancelScaleAnimation();
    const startTime = performance.now();
    let previousScale = cursorScale;
    const safeSegments = segments.map((segment) => {
      const item = {
        duration: segment.duration,
        from: segment.from === "current" ? previousScale : segment.from != null ? segment.from : previousScale,
        to: segment.to,
        ease: segment.ease || easeInOutSine,
      };
      previousScale = item.to;
      return item;
    });
    function tick(now) {
      let elapsed = now - startTime;
      let offset = 0;
      for (const segment of safeSegments) {
        if (elapsed <= offset + segment.duration) {
          const t = clamp((elapsed - offset) / segment.duration, 0, 1);
          const eased = segment.ease(t);
          setCursorScale(segment.from + (segment.to - segment.from) * eased);
          scaleAnimation = requestAnimationFrame(tick);
          return;
        }
        offset += segment.duration;
      }
      setCursorScale(safeSegments[safeSegments.length - 1].to);
      scaleAnimation = 0;
      if (onComplete) onComplete();
    }
    scaleAnimation = requestAnimationFrame(tick);
  }
  function playPopEffect() {
    window.clearTimeout(popTimer);
    root.classList.remove("cursor-pop-active");
    void root.offsetWidth;
    root.classList.add("cursor-pop-active");
    popTimer = window.setTimeout(() => root.classList.remove("cursor-pop-active"), 380);
  }

  /* ---------- FPS 计数器 ---------- */
  function startFpsMeter() {
    if (!fpsDisplay) return;
    let frames = 0;
    let lastTime = performance.now();
    function tick() {
      const now = performance.now();
      frames += 1;
      const elapsed = now - lastTime;
      if (elapsed >= 500) {
        fpsDisplay.textContent = `${Math.round((frames * 1000) / elapsed)} FPS`;
        frames = 0;
        lastTime = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ---------- 动态线场（与原版算法一致；原版将 --line-field-opacity 强制为 0，故默认不可见） ---------- */
  function startLineField() {
    if (!lineFieldCanvas) return;
    const ctx = lineFieldCanvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const pointerFine = window.matchMedia("(pointer: fine)").matches;
    const particles = Array.from({ length: pointerFine ? 68 : 42 }, (_, index) => ({
      x: (index * 137.5) % 1,
      y: ((index * 61.7) % 100) / 100,
      ox: (index * 137.5) % 1,
      oy: ((index * 61.7) % 100) / 100,
      vx: (((index * 17) % 11) - 5) * 0.000012,
      vy: (((index * 29) % 13) - 6) * 0.000011,
      size: 0.62 + ((index * 19) % 9) * 0.055,
    }));
    let width = 0, height = 0, dpr = 1, lastTime = performance.now();
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, pointerFine ? 1 : 0.85);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      const nextWidth = Math.round(width * dpr);
      const nextHeight = Math.round(height * dpr);
      if (lineFieldCanvas.width !== nextWidth || lineFieldCanvas.height !== nextHeight) {
        lineFieldCanvas.width = nextWidth;
        lineFieldCanvas.height = nextHeight;
        lineFieldCanvas.style.width = `${width}px`;
        lineFieldCanvas.style.height = `${height}px`;
      }
    }
    function draw(now) {
      resize();
      const rootStyle = getComputedStyle(root);
      const opacity = parseFloat(rootStyle.getPropertyValue("--line-field-opacity")) || 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (opacity > 0.01) {
        const delta = Math.min(34, now - lastTime);
        const pointColor = "rgb(92,92,92)";
        const lineColor = "rgb(92,92,92)";
        const attractColor = "rgb(92,92,92)";
        const maxDistance = Math.min(210, Math.max(145, width * 0.13));
        const attractDistance = Math.min(300, Math.max(210, width * 0.18));
        const hasPointer = isPageHover || cursorLoopStarted;
        particles.forEach((particle) => {
          particle.ox += particle.vx * delta;
          particle.oy += particle.vy * delta;
          if (particle.ox < -0.04) particle.ox = 1.04;
          if (particle.ox > 1.04) particle.ox = -0.04;
          if (particle.oy < -0.04) particle.oy = 1.04;
          if (particle.oy > 1.04) particle.oy = -0.04;
          let targetParticleX = particle.ox;
          let targetParticleY = particle.oy;
          if (hasPointer) {
            const px = particle.ox * width;
            const py = particle.oy * height;
            const dx = targetX - px;
            const dy = targetY - py;
            const distance = Math.hypot(dx, dy);
            if (distance < attractDistance && distance > 0.001) {
              const pull = Math.pow(1 - distance / attractDistance, 2) * 0.015;
              targetParticleX += (dx / width) * pull;
              targetParticleY += (dy / height) * pull;
            }
          }
          particle.x += (targetParticleX - particle.x) * 0.025;
          particle.y += (targetParticleY - particle.y) * 0.025;
          if (particle.x < -0.04) particle.x = 1.04;
          if (particle.x > 1.04) particle.x = -0.04;
          if (particle.y < -0.04) particle.y = 1.04;
          if (particle.y > 1.04) particle.y = -0.04;
        });
        ctx.save();
        ctx.lineWidth = 0.65;
        ctx.lineCap = "butt";
        ctx.lineJoin = "miter";
        for (let i = 0; i < particles.length; i += 1) {
          const a = particles[i];
          const ax = a.x * width;
          const ay = a.y * height;
          for (let j = i + 1; j < particles.length; j += 1) {
            const b = particles[j];
            const bx = b.x * width;
            const by = b.y * height;
            const distance = Math.hypot(ax - bx, ay - by);
            if (distance > maxDistance) continue;
            ctx.strokeStyle = lineColor;
            ctx.globalAlpha = Math.pow(1 - distance / maxDistance, 1.45) * 0.92;
            ctx.beginPath();
            ctx.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5);
            ctx.lineTo(Math.round(bx) + 0.5, Math.round(by) + 0.5);
            ctx.stroke();
          }
        }
        if (hasPointer) {
          particles.forEach((particle) => {
            const px = particle.x * width;
            const py = particle.y * height;
            const distance = Math.hypot(px - targetX, py - targetY);
            if (distance > attractDistance) return;
            ctx.strokeStyle = attractColor;
            ctx.globalAlpha = Math.pow(1 - distance / attractDistance, 1.35) * 0.9;
            ctx.beginPath();
            ctx.moveTo(Math.round(px) + 0.5, Math.round(py) + 0.5);
            ctx.lineTo(Math.round(targetX) + 0.5, Math.round(targetY) + 0.5);
            ctx.stroke();
          });
        }
        ctx.fillStyle = pointColor;
        particles.forEach((particle) => {
          const distance = hasPointer ? Math.hypot(particle.x * width - targetX, particle.y * height - targetY) : Infinity;
          const boost = distance < attractDistance ? 0.45 * (1 - distance / attractDistance) : 0;
          ctx.globalAlpha = Math.min(1, 0.86 + boost);
          ctx.beginPath();
          ctx.arc(Math.round(particle.x * width) + 0.5, Math.round(particle.y * height) + 0.5, Math.max(0.65, particle.size + boost * 0.65), 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
        lineFieldCanvas.dataset.frame = String((Number(lineFieldCanvas.dataset.frame) || 0) + 1);
      }
      lastTime = now;
      requestAnimationFrame(draw);
    }
    resize();
    requestAnimationFrame(draw);
  }

  /* ---------- 指针 / Hero 倾斜 / 光标揭示 ---------- */
  function setPointerVars(x, y) {
    const visualX = `${x.toFixed(2)}px`;
    const visualY = `${y.toFixed(2)}px`;
    cursorReveal && cursorReveal.style.setProperty("--cursor-visual-x", visualX);
    cursorReveal && cursorReveal.style.setProperty("--cursor-visual-y", visualY);
    cursorPop && cursorPop.style.setProperty("--cursor-visual-x", visualX);
    cursorPop && cursorPop.style.setProperty("--cursor-visual-y", visualY);
    updateCursorInnerOffset(x, y);

    const dx = (x / window.innerWidth - 0.5) * 2;
    const dy = (y / window.innerHeight - 0.5) * 2;
    const overviewProgress = isOverviewRoute() ? getOverviewTransitionProgress() : 1;
    const heroMotionActive = overviewProgress < 0.985;

    if (heroMotionActive) {
      root.style.setProperty("--tilt-x", `${(-dy * 18).toFixed(2)}deg`);
      root.style.setProperty("--tilt-y", `${(dx * 24).toFixed(2)}deg`);
      root.style.setProperty("--move-x", `${(dx * 30).toFixed(2)}px`);
      root.style.setProperty("--move-y", `${(dy * 22).toFixed(2)}px`);
      root.style.setProperty("--grid-x", `${(dx * -24).toFixed(2)}px`);
      root.style.setProperty("--grid-y", `${(dy * -24).toFixed(2)}px`);
    }
    root.style.setProperty("--header-shadow-x", `${(18 - dx * 7).toFixed(2)}px`);
    root.style.setProperty("--header-shadow-y", `${(24 - dy * 5).toFixed(2)}px`);
    root.style.setProperty("--header-item-shadow-x", `${(-dx * 5).toFixed(2)}px`);
    root.style.setProperty("--header-item-shadow-y", `${(25 - dy * 4).toFixed(2)}px`);
  }

  function animateCursor() {
    const deltaX = targetX - cursorX;
    const deltaY = targetY - cursorY;
    const distance = Math.hypot(deltaX, deltaY);
    const followEase = Math.min(0.68, Math.max(0.24, distance / 260));
    cursorX += deltaX * followEase;
    cursorY += deltaY * followEase;
    setPointerVars(cursorX, cursorY);
    requestAnimationFrame(animateCursor);
  }

  function enterHeaderZone() {
    isHeaderHover = true;
    cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "1");
    playPopEffect();
    animateCursorScale([{ from: "current", to: 0.035, duration: 170, ease: easeOutCubic }], () => {
      if (!isHeaderHover) return;
      cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "0");
    });
  }
  function leaveHeaderZone() {
    isHeaderHover = false;
    cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "1");
    setCursorScale(0.035);
    animateCursorScale([{ from: "current", to: 1, duration: 260, ease: easeOutCubic }]);
  }
  function enterPageZone(x, y) {
    if (!hasHeroCursor || isPageHover) return;
    isPageHover = true;
    targetX = x; targetY = y; cursorX = x; cursorY = y;
    setPointerVars(x, y);
    cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "1");
    setCursorScale(0.035);
    playPopEffect();
    if (siteHeader) {
      const headerRect = siteHeader.getBoundingClientRect();
      isHeaderHover = x >= headerRect.left - 10 && x <= headerRect.right + 10 && y >= headerRect.top - 10 && y <= headerRect.bottom + 10;
    }
    if (isHeaderHover) {
      cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "0");
      return;
    }
    animateCursorScale([{ from: "current", to: 1, duration: 260, ease: easeOutCubic }]);
  }
  function leavePageZone() {
    if (!hasHeroCursor || !isPageHover) return;
    isPageHover = false;
    isHeaderHover = false;
    root.classList.remove("cursor-pressing");
    cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "1");
    playPopEffect();
    animateCursorScale([{ from: "current", to: 0.035, duration: 170, ease: easeOutCubic }], () => {
      if (isPageHover) return;
      cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "0");
    });
  }

  window.addEventListener("pointermove", (event) => {
    targetX = event.clientX;
    targetY = event.clientY;
    if (!hasHeroCursor) return;
    if (!isPageHover) enterPageZone(event.clientX, event.clientY);
    if (!siteHeader) return;
    const headerRect = siteHeader.getBoundingClientRect();
    const insideHeaderZone =
      event.clientX >= headerRect.left - 10 &&
      event.clientX <= headerRect.right + 10 &&
      event.clientY >= headerRect.top - 10 &&
      event.clientY <= headerRect.bottom + 10;
    if (insideHeaderZone && !isHeaderHover) enterHeaderZone();
    if (!insideHeaderZone && isHeaderHover) leaveHeaderZone();
  });
  document.addEventListener("pointerenter", (event) => { enterPageZone(event.clientX, event.clientY); });
  document.addEventListener("pointerleave", () => { leavePageZone(); });
  window.addEventListener("pointerdown", () => {
    if (!hasHeroCursor || isHeaderHover) return;
    root.classList.add("cursor-pressing");
    setCursorScale(0.035);
    playPopEffect();
  });
  window.addEventListener("pointerup", () => {
    if (!hasHeroCursor || isHeaderHover) return;
    root.classList.remove("cursor-pressing");
    setCursorScale(1);
    playPopEffect();
  });

  /* ---------- 滚动驱动的背景 / 光标过渡 ---------- */
  function isOverviewRoute() {
    return Boolean(document.querySelector(".hero[data-route-page='overview']"));
  }
  function getOverviewTransitionProgress(start, end) {
    start = start != null ? start : window.innerHeight * 0.22;
    end = end != null ? end : window.innerHeight * 0.82;
    return easeInOutCubic(clamp((window.scrollY - start) / (end - start), 0, 1));
  }
  function updateBackgroundTransition(progress) {
    progress = progress != null ? progress : getOverviewTransitionProgress();
    const isOverview = isOverviewRoute();
    const gridOpacity = isOverview ? 1 - progress : 0;
    const diagonalMaxOpacity = root.dataset.theme === "dark" ? 0.36 : 0.76;
    const diagonalOpacity = isOverview ? progress * diagonalMaxOpacity : 0;
    const lineFieldOpacity = 0; // 与原版一致：粒子线场默认关闭
    root.style.setProperty("--grid-opacity", gridOpacity.toFixed(3));
    root.style.setProperty("--diagonal-opacity", diagonalOpacity.toFixed(3));
    root.style.setProperty("--line-field-opacity", lineFieldOpacity.toFixed(3));
  }
  function updateScrollCursorEffect() {
    if (!hasHeroCursor) {
      root.classList.add("native-cursor", "cursor-disabled");
      root.style.setProperty("--scroll-cursor-opacity", "0");
      root.style.setProperty("--scroll-cursor-blur", "0px");
      updateBackgroundTransition();
      return;
    }
    const start = window.innerHeight * 0.22;
    const end = window.innerHeight * 0.82;
    const progress = getOverviewTransitionProgress(start, end);
    root.style.setProperty("--scroll-cursor-opacity", (1 - progress).toFixed(3));
    root.style.setProperty("--scroll-cursor-blur", `${(progress * 7).toFixed(2)}px`);
    root.classList.toggle("native-cursor", progress > 0.92);
    updateBackgroundTransition(progress);
  }
  function flushScrollEffects() {
    root.classList.toggle("has-scrolled", window.scrollY > window.innerHeight * 0.18);
    updateScrollCursorEffect();
    updateCursorInnerOffset();
    updateRevealItems();
  }
  function queueScrollEffects() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(flushScrollEffects);
  }
  window.addEventListener("scroll", () => { queueScrollEffects(); }, { passive: true });
  window.addEventListener("resize", () => { queueScrollEffects(); });

  /* ---------- 页面光标可用性 ---------- */
  function setPageCursorAvailability() {
    if (!hasHeroCursor) {
      root.classList.add("native-cursor", "cursor-disabled");
      cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "0");
      root.style.setProperty("--scroll-cursor-opacity", "0");
      root.style.setProperty("--scroll-cursor-blur", "0px");
      return;
    }
    root.classList.remove("native-cursor", "cursor-disabled");
  }

  /* ---------- 主题切换 ---------- */
  themeToggle && themeToggle.addEventListener("click", () => {
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    root.classList.add("theme-changing");
    root.dataset.theme = nextTheme;
    try { localStorage.setItem("leo-theme", nextTheme); } catch (e) {}
    updateBackgroundTransition();
    window.setTimeout(() => root.classList.remove("theme-changing"), 520);
  });

  /* ---------- 统计数字滚动 ---------- */
  function startCountUp() {
    const nums = document.querySelectorAll(".num[data-count]");
    if (!nums.length) return;
    const animate = (el) => {
      const target = Number(el.getAttribute("data-count")) || 0;
      if (target <= 0) { el.textContent = "0"; return; }
      const duration = 1400;
      const startTime = performance.now();
      function tick(now) {
        const t = clamp((now - startTime) / duration, 0, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const value = Math.round(target * eased);
        el.textContent = value.toLocaleString("en-US");
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString("en-US");
      }
      requestAnimationFrame(tick);
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) { animate(entry.target); io.unobserve(entry.target); }
        });
      }, { threshold: 0.4 });
      nums.forEach((n) => io.observe(n));
    } else {
      nums.forEach(animate);
    }
  }

  /* ---------- 初始化（与原版尾部一致） ---------- */
  setPointerVars(cursorX, cursorY);
  setCursorScale(0.035);
  cursorReveal && cursorReveal.style.setProperty("--cursor-opacity", "0");
  root.classList.add("pdaim-cursor-ready");
  setPageCursorAvailability();
  updateRevealItems();
  startFpsMeter();
  startLineField();
  updateBackgroundTransition();
  updateScrollCursorEffect();
  startCountUp();
  if (hasHeroCursor) {
    cursorLoopStarted = true;
    requestAnimationFrame(animateCursor);
  }
})();
