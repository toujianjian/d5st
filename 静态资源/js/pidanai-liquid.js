(function () {
  const root = document.documentElement;
  const liquidCanvases = document.querySelectorAll(".liquid-glass-canvas");
  if (!liquidCanvases.length) return;

  // 移动端（小屏 / 触屏）不做 WebGL 液态玻璃动画：逐帧渲染非常耗 CPU/GPU，
  // 手机端直接跳过（不依赖它的菜单/主题功能由 home-shell.js 负责）。
  if (window.matchMedia("(max-width: 1024px), (pointer: coarse)").matches) return;

  const vertexSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 fragTexCoord;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      fragTexCoord = a_texCoord;
    }
  `;

  const fragmentSource = `
    precision highp float;

    #define PI 3.141592653589793
    #define disp 6.25
    #define Pow 3.0
    #define A 1.75
    #define B 1.25
    #define C 2.0
    #define GRAD 255.0

    varying vec2 fragTexCoord;

    uniform sampler2D backgroundTexture;
    uniform sampler2D orbTexture;
    uniform sampler2D lineTexture;
    uniform vec2 resolution;
    uniform vec2 backgroundResolution;
    uniform vec2 textureOffset;
    uniform vec2 lightPos;
    uniform float glassBlur;
    uniform float cornerRadius;
    uniform vec2 shapeSize;
    uniform float alphaBoost;
    uniform float darkAmount;
    uniform vec2 viewportOffset;
    uniform float lineFieldOpacity;

    float dither(vec2 pixelCoord) {
      int x = int(mod(pixelCoord.x, 8.0));
      int y = int(mod(pixelCoord.y, 8.0));
      int idx = x * 8 + y;
      if (idx == 0) return 0.0;
      if (idx == 1) return 0.5;
      if (idx == 2) return 0.125;
      if (idx == 3) return 0.625;
      if (idx == 4) return 0.03125;
      if (idx == 5) return 0.53125;
      if (idx == 6) return 0.15625;
      if (idx == 7) return 0.65625;
      if (idx == 8) return 0.75;
      if (idx == 9) return 0.25;
      if (idx == 10) return 0.875;
      if (idx == 11) return 0.375;
      if (idx == 12) return 0.78125;
      if (idx == 13) return 0.28125;
      if (idx == 14) return 0.90625;
      if (idx == 15) return 0.40625;
      if (idx == 16) return 0.1875;
      if (idx == 17) return 0.6875;
      if (idx == 18) return 0.0625;
      if (idx == 19) return 0.5625;
      if (idx == 20) return 0.21875;
      if (idx == 21) return 0.71875;
      if (idx == 22) return 0.09375;
      if (idx == 23) return 0.59375;
      if (idx == 24) return 0.9375;
      if (idx == 25) return 0.4375;
      if (idx == 26) return 0.8125;
      if (idx == 27) return 0.3125;
      if (idx == 28) return 0.96875;
      if (idx == 29) return 0.46875;
      if (idx == 30) return 0.84375;
      if (idx == 31) return 0.34375;
      if (idx == 32) return 0.046875;
      if (idx == 33) return 0.546875;
      if (idx == 34) return 0.171875;
      if (idx == 35) return 0.671875;
      if (idx == 36) return 0.015625;
      if (idx == 37) return 0.515625;
      if (idx == 38) return 0.140625;
      if (idx == 39) return 0.640625;
      if (idx == 40) return 0.796875;
      if (idx == 41) return 0.296875;
      if (idx == 42) return 0.921875;
      if (idx == 43) return 0.421875;
      if (idx == 44) return 0.765625;
      if (idx == 45) return 0.265625;
      if (idx == 46) return 0.890625;
      if (idx == 47) return 0.390625;
      if (idx == 48) return 0.234375;
      if (idx == 49) return 0.734375;
      if (idx == 50) return 0.109375;
      if (idx == 51) return 0.609375;
      if (idx == 52) return 0.203125;
      if (idx == 53) return 0.703125;
      if (idx == 54) return 0.078125;
      if (idx == 55) return 0.578125;
      if (idx == 56) return 0.984375;
      if (idx == 57) return 0.484375;
      if (idx == 58) return 0.859375;
      if (idx == 59) return 0.359375;
      if (idx == 60) return 0.953125;
      if (idx == 61) return 0.453125;
      if (idx == 62) return 0.828125;
      return 0.328125;
    }

    float sdRoundBox(vec2 p, vec2 halfSize, float radius) {
      vec2 q = abs(p) - halfSize + vec2(radius);
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    }

    float distance_pow(vec2 p, float pw) {
      return pow(pow(abs(p.x), pw) + pow(abs(p.y), pw), 1.0 / pw);
    }

    vec2 capsuleAnchor(vec2 p, vec2 halfSize, float radius) {
      float capX = max(halfSize.x - radius, 0.0);
      return vec2(clamp(p.x, -capX, capX), 0.0);
    }

    vec2 sdfNormal(vec2 p, vec2 halfSize, float radius) {
      vec2 e = vec2(1.0, 0.0);
      vec2 n = vec2(
        sdRoundBox(p + e.xy, halfSize, radius) - sdRoundBox(p - e.xy, halfSize, radius),
        sdRoundBox(p + e.yx, halfSize, radius) - sdRoundBox(p - e.yx, halfSize, radius)
      );
      float lenN = length(n);
      if (lenN < 0.0001) {
        vec2 fallback = capsuleAnchor(p, halfSize, radius);
        n = p - fallback;
        lenN = length(n);
      }
      if (lenN < 0.0001) return vec2(0.0, -1.0);
      return n / lenN;
    }

    float liquidRel(float dst, float glassRadius, float blurRadius) {
      float normalized = pow(clamp(max(0.0, dst - glassRadius + blurRadius) / blurRadius, 0.0, 1.0), A);
      return 1.0 - pow(1.0 - pow(1.0 - normalized, B), C);
    }

    vec2 toTex(vec2 pixelCoord) {
      vec2 uv = vec2(
        (pixelCoord.x + textureOffset.x) / backgroundResolution.x,
        (pixelCoord.y + textureOffset.y) / backgroundResolution.y
      );
      return clamp(uv, vec2(0.001), vec2(0.999));
    }

    vec3 applyOrbs(vec3 base, vec2 pixelCoord) {
      vec2 uv = (pixelCoord + viewportOffset) / backgroundResolution;
      vec4 orb = texture2D(orbTexture, clamp(uv, vec2(0.001), vec2(0.999)));
      return mix(base, orb.rgb, orb.a);
    }

    vec3 applyLineField(vec3 base, vec2 pixelCoord) {
      if (lineFieldOpacity <= 0.001) return base;
      vec2 uv = (pixelCoord + viewportOffset) / backgroundResolution;
      vec4 line = texture2D(lineTexture, clamp(uv, vec2(0.001), vec2(0.999)));
      return mix(base, line.rgb, line.a * lineFieldOpacity);
    }

    void main() {
      vec2 pixelCoord = vec2(fragTexCoord.x * resolution.x, (1.0 - fragTexCoord.y) * resolution.y);
      float ditherValue = dither(pixelCoord);
      vec2 center = resolution * 0.5;
      vec2 p = pixelCoord - center;
      vec2 halfSize = max(shapeSize * 0.5 - vec2(0.75), vec2(1.0));
      float radius = min(cornerRadius, min(halfSize.x, halfSize.y));
      float signedDistance = sdRoundBox(p, halfSize, radius);
      float visibleMask = 1.0 - smoothstep(0.25, 1.0, signedDistance);
      if (visibleMask <= 0.001) {
        discard;
      }

      vec2 normal = sdfNormal(p, halfSize, radius);
      float glassRadius = radius;
      float distance = clamp(glassRadius + signedDistance, 0.0, glassRadius + 6.25);
      vec2 d = normal * distance;

      vec3 back = applyLineField(applyOrbs(texture2D(backgroundTexture, toTex(pixelCoord)).rgb, pixelCoord), pixelCoord);
      vec3 color = back;
      vec2 lightVec = pixelCoord - lightPos;
      float dt = clamp((abs(lightVec.x) + abs(lightVec.y)) / glassBlur, 0.0, 1.0);
      float rel = 0.0;
      float r = 0.0;
      float g = 0.0;
      float b = 0.0;

      if (signedDistance <= 0.0) {
        rel = liquidRel(distance, glassRadius, glassBlur);
        float ref = rel;
        int upsc = int(clamp(floor(12.0 * abs(1.0 - ref) + ditherValue), 1.0, 8.0));

        if (upsc < 2) {
          float dsp = min(1.0, disp / glassRadius * (1.0 - ref));
          vec2 r_coord = pixelCoord - d * (1.0 - ref + dsp);
          vec2 g_coord = pixelCoord - d * (1.0 - ref);
          vec2 b_coord = pixelCoord - d * (1.0 - ref - dsp);
          r += applyLineField(texture2D(backgroundTexture, toTex(r_coord)).rgb, r_coord).r;
          g += applyLineField(texture2D(backgroundTexture, toTex(g_coord)).rgb, g_coord).g;
          b += applyLineField(texture2D(backgroundTexture, toTex(b_coord)).rgb, b_coord).b;
        } else {
          float dst;
          float dsp;

          dst = clamp(glassRadius + sdRoundBox(p + vec2(-0.5, -0.5), halfSize, radius), 0.0, glassRadius + 6.25);
          float ref_g0 = liquidRel(dst, glassRadius, glassBlur);
          dsp = min(1.0, disp / glassRadius * (1.0 - ref_g0));
          float ref_r0 = ref_g0 - dsp;
          float ref_b0 = ref_g0 + dsp;

          dst = clamp(glassRadius + sdRoundBox(p + vec2(0.5, -0.5), halfSize, radius), 0.0, glassRadius + 6.25);
          float ref_g1 = liquidRel(dst, glassRadius, glassBlur);
          dsp = min(1.0, disp / glassRadius * (1.0 - ref_g1));
          float ref_r1 = ref_g1 - dsp;
          float ref_b1 = ref_g1 + dsp;

          dst = clamp(glassRadius + sdRoundBox(p + vec2(-0.5, 0.5), halfSize, radius), 0.0, glassRadius + 6.25);
          float ref_g2 = liquidRel(dst, glassRadius, glassBlur);
          dsp = min(1.0, disp / glassRadius * (1.0 - ref_g2));
          float ref_r2 = ref_g2 - dsp;
          float ref_b2 = ref_g2 + dsp;

          dst = clamp(glassRadius + sdRoundBox(p + vec2(0.5, 0.5), halfSize, radius), 0.0, glassRadius + 6.25);
          float ref_g3 = liquidRel(dst, glassRadius, glassBlur);
          dsp = min(1.0, disp / glassRadius * (1.0 - ref_g3));
          float ref_r3 = ref_g3 - dsp;
          float ref_b3 = ref_g3 + dsp;

          for (int ii = 0; ii < 8; ii++) {
            if (ii >= upsc) break;
            for (int jj = 0; jj < 8; jj++) {
              if (jj >= upsc) break;
              float inum = float(ii) / float(upsc);
              float jnum = float(jj) / float(upsc);
              float rr = ref_r0 + (ref_r1 - ref_r0) * inum + (ref_r2 - ref_r0) * jnum + (ref_r3 - ref_r0) * inum * jnum;
              float gg = ref_g0 + (ref_g1 - ref_g0) * inum + (ref_g2 - ref_g0) * jnum + (ref_g3 - ref_g0) * inum * jnum;
              float bb = ref_b0 + (ref_b1 - ref_b0) * inum + (ref_b2 - ref_b0) * jnum + (ref_b3 - ref_b0) * inum * jnum;
              vec2 r_coord = pixelCoord - d * (1.0 - rr);
              vec2 g_coord = pixelCoord - d * (1.0 - gg);
              vec2 b_coord = pixelCoord - d * (1.0 - bb);
              r += applyLineField(texture2D(backgroundTexture, toTex(r_coord)).rgb, r_coord).r;
              g += applyLineField(texture2D(backgroundTexture, toTex(g_coord)).rgb, g_coord).g;
              b += applyLineField(texture2D(backgroundTexture, toTex(b_coord)).rgb, b_coord).b;
            }
          }

          float div = float(upsc * upsc);
          r /= div;
          g /= div;
          b /= div;
        }

        if (rel < 0.15) {
          float shad = 0.85 + rel;
          r *= shad;
          g *= shad;
          b *= shad;
        }

        float num1 = clamp(distance - glassRadius + 2.25, 0.0, 1.0) * dt;
        float num2 = (1.0 - rel * pow(1.0 - rel, 2.0)) * pow(1.0 - (glassRadius - distance) / glassBlur, 2.2) * dt;
        float ang1 = 0.0;
        float ang2 = 0.0;
        if (num1 > 0.0 || num2 > 0.0) {
          vec2 lightDir = lightPos - pixelCoord;
          float angle = atan(d.y, d.x) - atan(lightDir.y, lightDir.x);
          ang1 = cos(angle);
          ang2 = cos(angle - PI);
        }
        if (num1 > 0.0) {
          float high = num1 * max(0.16, ang1);
          r *= 1.0 - high;
          g *= 1.0 - high;
          b *= 1.0 - high;
          r += (1.0 - r) * high;
          g += (1.0 - g) * high;
          b += (1.0 - b) * high;
        }
        if (num2 > 0.0) {
          float high = num2 * pow(max(0.0, max(ang2 * 0.4, ang1 * 0.3)), 2.2);
          r += (1.0 - r) * high;
          g += (1.0 - g) * high;
          b += (1.0 - b) * high;
        }

        color = applyOrbs(vec3(r, g, b), pixelCoord - d * (1.0 - rel));
      }

      if (distance > glassRadius - 2.0 && signedDistance <= 0.75) {
        float shad = (distance - glassRadius) / 6.25;
        shad = clamp(shad, 0.0, 1.0);
        vec2 lightVec2 = pixelCoord - lightPos;
        float glassAngle = atan(d.y, d.x);
        float lightAngle = atan(lightVec2.y, lightVec2.x);
        float angle = glassAngle - lightAngle;
        shad = 1.0 - (1.0 - shad) * max(0.16, cos(angle)) * dt;
        shad = pow(shad, 1.0 / 2.2) * 0.5 + 0.5;
        float alp = clamp(glassRadius - distance, 0.0, 1.0);
        back *= shad;
        color = mix(back, color, alp);
      }

      color = floor(clamp(color, 0.0, 1.0) * GRAD + ditherValue) / GRAD;

      float alpha = visibleMask * alphaBoost;
      gl_FragColor = vec4(color, alpha);
    }
  `;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "LiquidGlass shader compile failed");
    }
    return shader;
  }

  function link(gl, vertex, fragment) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "LiquidGlass program link failed");
    }
    return program;
  }

  function createBackgroundCanvas() {
    const bg = document.createElement("canvas");
    const ctx = bg.getContext("2d", { alpha: false });
    return {
      bg,
      ctx,
      width: 0,
      height: 0,
      scrollY: -1,
      gridX: NaN,
      gridY: NaN,
      gridOpacity: NaN,
      diagonalOpacity: NaN,
      bgColor: "",
      dotColor: "",
      skipUnsafeImages: false,
      warnedTaintedCanvas: false,
      textureUploaded: false,
    };
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function getCompositedOpacity(element) {
    let opacity = 1;
    let current = element;

    while (current && current.nodeType === 1 && current !== document.body.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      const value = parseFloat(style.opacity);
      if (Number.isFinite(value)) opacity *= value;
      current = current.parentElement;
    }

    return opacity;
  }

  function drawBlurredCircle(ctx, x, y, radius, color, blur) {
    ctx.save();
    ctx.filter = `blur(${blur}px)`;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function canvasFontFromStyle(style, dpr) {
    const fontSize = (parseFloat(style.fontSize) || 16) * dpr;
    return `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  }

  function applyCanvasTextSpacing(ctx, style, dpr) {
    if ("letterSpacing" in ctx) {
      const letterSpacing = style.letterSpacing === "normal"
        ? 0
        : parseFloat(style.letterSpacing) || 0;
      ctx.letterSpacing = `${letterSpacing * dpr}px`;
    }

    if ("wordSpacing" in ctx) {
      const wordSpacing = style.wordSpacing === "normal"
        ? 0
        : parseFloat(style.wordSpacing) || 0;
      ctx.wordSpacing = `${wordSpacing * dpr}px`;
    }
  }

  function colorMixAlpha(color, alpha) {
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1].length === 3
        ? hex[1].split("").map((item) => item + item).join("")
        : hex[1];
      const value = parseInt(raw, 16);
      return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
    }

    const rgb = color.match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
      const parts = rgb[1].split(",").map((part) => parseFloat(part));
      return `rgba(${parts[0] || 0}, ${parts[1] || 0}, ${parts[2] || 0}, ${alpha})`;
    }

    return `rgba(7, 7, 7, ${alpha})`;
  }

  function radialGridMask(t) {
    if (t <= 0.23) return 1;
    if (t <= 0.47) return 1 - ((t - 0.23) / 0.24) * 0.24;
    if (t <= 0.82) return 0.76 * (1 - (t - 0.47) / 0.35);
    return 0;
  }

  function drawProductDiagonalTexture(ctx, canvasRect, dpr, fgColor, gridX, gridY, opacity) {
    if (opacity <= 0.001) return;

    const section = document.querySelector(".product-section");
    if (!section) return;

    const rect = section.getBoundingClientRect();
    const top = rect.top - window.innerHeight * 0.38;
    const bottom = rect.bottom;
    if (bottom < canvasRect.top || top > canvasRect.bottom) return;

    const x = (rect.left - canvasRect.left) * dpr;
    const y = (top - canvasRect.top) * dpr;
    const width = rect.width * dpr;
    const height = (bottom - top) * dpr;
    const isDark = root.dataset.theme === "dark";

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    const angle = 55 * Math.PI / 180;
    const lineX = Math.cos(angle);
    const lineY = Math.sin(angle);
    const normalX = Math.sin(angle);
    const normalY = -Math.cos(angle);
    const drawLines = (period, stripeCenter, alpha, lineWidth, phaseScale) => {
      const posX = gridX * phaseScale * dpr;
      const posY = gridY * phaseScale * dpr;
      const corners = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ];
      let minP = Infinity;
      let maxP = -Infinity;

      corners.forEach(([cx, cy]) => {
        const projection = (cx - posX) * normalX + (cy - posY) * normalY;
        minP = Math.min(minP, projection);
        maxP = Math.max(maxP, projection);
      });

      ctx.strokeStyle = colorMixAlpha(fgColor, alpha);
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      const lineLength = Math.hypot(width, height) + period * 4;
      const first = Math.floor((minP - stripeCenter) / period) * period + stripeCenter;
      for (let p = first; p <= maxP + period; p += period) {
        const baseX = x + posX + normalX * p;
        const baseY = y + posY + normalY * p;
        ctx.moveTo(baseX - lineX * lineLength, baseY - lineY * lineLength);
        ctx.lineTo(baseX + lineX * lineLength, baseY + lineY * lineLength);
      }
      ctx.stroke();
    };

    drawLines(29 * dpr, 14.5 * dpr, isDark ? 0.028 : 0.052, Math.max(0.75, 1 * dpr), 1);
    drawLines(76 * dpr, 37.5 * dpr, isDark ? 0.018 : 0.026, Math.max(0.6, 0.75 * dpr), 0.6);
    ctx.restore();
  }

  function drawRefractionField(ctx, canvasRect, dpr, fgColor, gridX, gridY, opacity) {
    if (opacity <= 0.001) return;

    const isDark = root.dataset.theme === "dark";
    const width = canvasRect.width * dpr;
    const height = canvasRect.height * dpr;
    const time = performance.now() * 0.00011;
    const phase = [
      Math.sin(time),
      Math.sin(time * 1.18 + 1.7),
      Math.sin(time * 0.82 + 3.1),
      Math.cos(time * 1.05 + 0.8),
      Math.cos(time * 0.72 + 2.4),
    ];
    const colors = isDark
      ? [
        "rgba(72, 178, 255, 0.22)",
        "rgba(255, 116, 184, 0.19)",
        "rgba(158, 120, 255, 0.21)",
        "rgba(80, 224, 190, 0.17)",
        "rgba(255, 194, 105, 0.16)",
      ]
      : [
        "rgba(71, 169, 255, 0.2)",
        "rgba(255, 108, 174, 0.17)",
        "rgba(153, 111, 255, 0.18)",
        "rgba(83, 221, 184, 0.15)",
        "rgba(255, 192, 98, 0.14)",
      ];
    const blobs = [
      { x: 0.18, y: 0.22, r: 0.28, dx: 0.24, dy: 0.16, color: colors[0], phase: phase[0] },
      { x: 0.78, y: 0.18, r: 0.25, dx: -0.2, dy: 0.18, color: colors[1], phase: phase[1] },
      { x: 0.72, y: 0.76, r: 0.3, dx: -0.22, dy: -0.18, color: colors[2], phase: phase[2] },
      { x: 0.28, y: 0.78, r: 0.24, dx: 0.2, dy: -0.22, color: colors[3], phase: phase[3] },
      { x: 0.5, y: 0.48, r: 0.33, dx: 0.16, dy: 0.14, color: colors[4], phase: phase[4] },
    ];

    ctx.save();
    ctx.globalAlpha = opacity;

    blobs.forEach((blob, index) => {
      const viewportX = (window.innerWidth * (blob.x + blob.dx * blob.phase) + gridX * (0.12 - index * 0.025)) * dpr;
      const viewportY = (window.innerHeight * (blob.y + blob.dy * blob.phase) + gridY * (0.1 - index * 0.018)) * dpr;
      const radius = Math.min(window.innerWidth, window.innerHeight) * blob.r * dpr;
      drawBlurredCircle(
        ctx,
        viewportX - canvasRect.left * dpr,
        viewportY - canvasRect.top * dpr,
        radius,
        blob.color,
        Math.max(90, radius * 0.58),
      );
    });
    ctx.restore();
  }

  function getLineHeight(style, fontSize) {
    const parsed = parseFloat(style.lineHeight);
    return Number.isFinite(parsed) ? parsed : fontSize * 1.25;
  }

  function splitWrapUnits(text) {
    if (/\s/.test(text)) {
      return text.split(/(\s+)/).filter(Boolean);
    }
    return Array.from(text);
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const units = splitWrapUnits(text);
    const lines = [];
    let line = "";

    units.forEach((unit) => {
      const next = line ? line + unit : unit;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line.trimEnd());
        line = unit.trimStart();
      } else {
        line = next;
      }
    });

    if (line) lines.push(line.trim());
    return lines.length ? lines : [text];
  }

  function collectTextNodes(element) {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function drawTextByRangeRects(ctx, element, canvasRect, dpr, style, options = {}) {
    const fullText = element.textContent || "";
    if (!fullText.trim() || fullText.length > 520) return false;

    const textNodes = collectTextNodes(element);
    if (!textNodes.length) return false;

    const fontSize = parseFloat(style.fontSize) || 16;
    let drew = false;

    ctx.save();
    ctx.font = canvasFontFromStyle(style, dpr);
    ctx.fillStyle = options.color || style.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    applyCanvasTextSpacing(ctx, style, dpr);
    ctx.globalAlpha = getCompositedOpacity(element) * (options.opacity ?? 1);

    textNodes.forEach((textNode) => {
      const raw = textNode.nodeValue || "";
      let lineText = "";
      let lineTop = null;
      let lineBottom = null;
      let lineLeft = Infinity;
      let lineRight = -Infinity;

      const flushLine = () => {
        const clean = lineText.replace(/\s+/g, " ").trim();
        if (!clean || lineTop === null || !Number.isFinite(lineLeft) || !Number.isFinite(lineRight)) {
          lineText = "";
          lineTop = null;
          lineBottom = null;
          lineLeft = Infinity;
          lineRight = -Infinity;
          return;
        }

        const x = (lineLeft - canvasRect.left) * dpr;
        const y = (((lineTop + lineBottom) * 0.5) - canvasRect.top) * dpr;
        const maxWidth = Math.max(fontSize * dpr, (lineRight - lineLeft) * dpr * 1.08);
        ctx.fillText(clean, x, y, maxWidth);
        drew = true;

        lineText = "";
        lineTop = null;
        lineBottom = null;
        lineLeft = Infinity;
        lineRight = -Infinity;
      };

      for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        const range = document.createRange();
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        const rect = range.getBoundingClientRect();
        range.detach?.();

        if (!rect.width && !rect.height) {
          if (lineText && /\s/.test(char)) lineText += " ";
          continue;
        }

        if (lineTop !== null && Math.abs(rect.top - lineTop) > Math.max(2, fontSize * 0.32)) {
          flushLine();
        }

        lineText += char;
        lineTop = lineTop === null ? rect.top : Math.min(lineTop, rect.top);
        lineBottom = lineBottom === null ? rect.bottom : Math.max(lineBottom, rect.bottom);
        lineLeft = Math.min(lineLeft, rect.left);
        lineRight = Math.max(lineRight, rect.right);
      }

      flushLine();
    });

    ctx.restore();
    return drew;
  }

  function isCompositeTextElement(element) {
    return Boolean(element.matches?.(
      ".abacus .price, .pdaim-license-price, .badge-money, .item-stock, .pdaim-license-tag, .sku, .chip, .switch-category",
    ));
  }

  function drawTextElement(ctx, element, canvasRect, dpr, options = {}) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    const text = (options.text || element.textContent).replace(/\s+/g, " ").trim();
    if (!text) return;

    const style = getComputedStyle(element);
    const fontSize = parseFloat(style.fontSize) || 16;
    const lineHeight = getLineHeight(style, fontSize);
    const x = ((options.x ?? (rect.left + rect.width / 2)) - canvasRect.left) * dpr;
    const y = ((options.y ?? (rect.top + rect.height / 2)) - canvasRect.top) * dpr;
    const maxWidth = (options.maxWidth ?? (rect.width * 1.08)) * dpr;
    const isMultiline = !options.text && text.length > 18 && rect.height > lineHeight * 1.45;

    if ((options.precise || isCompositeTextElement(element)) && !options.text && drawTextByRangeRects(ctx, element, canvasRect, dpr, style, options)) {
      return;
    }

    ctx.save();
    ctx.font = canvasFontFromStyle(style, dpr);
    ctx.fillStyle = options.color || style.color;
    applyCanvasTextSpacing(ctx, style, dpr);
    ctx.globalAlpha = getCompositedOpacity(element) * (options.opacity ?? 1);

    if (isMultiline) {
      const paddingLeft = parseCssLength(style.paddingLeft, 0);
      const paddingRight = parseCssLength(style.paddingRight, 0);
      const paddingTop = parseCssLength(style.paddingTop, 0);
      const align = style.textAlign === "start" ? "left" : style.textAlign;
      const innerWidth = Math.max(fontSize * 2, rect.width - paddingLeft - paddingRight) * dpr;
      const lines = wrapCanvasText(ctx, text, innerWidth);
      const drawX = align === "right"
        ? (rect.right - paddingRight - canvasRect.left) * dpr
        : align === "center"
          ? (rect.left + rect.width * 0.5 - canvasRect.left) * dpr
          : (rect.left + paddingLeft - canvasRect.left) * dpr;
      let drawY = (rect.top + paddingTop + lineHeight * 0.5 - canvasRect.top) * dpr;
      const maxLines = Math.max(1, Math.floor((rect.height - paddingTop) / Math.max(lineHeight, 1)));

      ctx.textAlign = align === "right" || align === "center" ? align : "left";
      ctx.textBaseline = "middle";
      lines.slice(0, maxLines).forEach((line) => {
        ctx.fillText(line, drawX, drawY, innerWidth);
        drawY += lineHeight * dpr;
      });
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y, Math.max(maxWidth, fontSize * dpr));
    }
    ctx.restore();
  }

  function drawTextLikeElement(ctx, sourceElement, text, rect, canvasRect, dpr, options = {}) {
    if (!sourceElement || !rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    const style = getComputedStyle(sourceElement);
    const fontSize = parseFloat(style.fontSize) || 16;
    const x = ((options.x ?? (rect.left + rect.width / 2)) - canvasRect.left) * dpr;
    const y = ((options.y ?? (rect.top + rect.height / 2)) - canvasRect.top) * dpr;
    const maxWidth = (options.maxWidth ?? (rect.width * 1.08)) * dpr;

    ctx.save();
    ctx.font = canvasFontFromStyle(style, dpr);
    ctx.fillStyle = options.color || style.color;
    ctx.textAlign = options.align || "center";
    ctx.textBaseline = options.baseline || "middle";
    applyCanvasTextSpacing(ctx, style, dpr);
    ctx.globalAlpha = getCompositedOpacity(sourceElement) * (options.opacity ?? 1);
    ctx.fillText(text, x, y, Math.max(maxWidth, fontSize * dpr));
    ctx.restore();
  }

  function drawImageFallback(ctx, image, canvasRect, dpr) {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    const rootStyle = getComputedStyle(root);
    const bg = rootStyle.getPropertyValue("--bg").trim() || "#ffffff";
    const fg = rootStyle.getPropertyValue("--fg").trim() || "#070707";
    const muted = rootStyle.getPropertyValue("--muted").trim() || "rgba(7, 7, 7, 0.58)";
    const line = rootStyle.getPropertyValue("--line").trim() || "rgba(7, 7, 7, 0.08)";
    const x = (rect.left - canvasRect.left) * dpr;
    const y = (rect.top - canvasRect.top) * dpr;
    const w = rect.width * dpr;
    const h = rect.height * dpr;
    const radius = Math.min(18 * dpr, w * 0.04, h * 0.08);

    ctx.save();
    const opacity = parseFloat(getComputedStyle(image).opacity);
    ctx.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
    roundedRectPath(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = "rgba(120, 170, 220, 0.08)";
    ctx.fillRect(x, y, w, h);

    const topH = Math.max(28 * dpr, h * 0.075);
    ctx.fillStyle = "rgba(255, 255, 255, 0.36)";
    ctx.fillRect(x, y, w, topH);
    ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(x, y + topH);
    ctx.lineTo(x + w, y + topH);
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.font = `700 ${Math.max(10, 12 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PDAim Pro", x + w * 0.5, y + topH * 0.5);

    const sidebarW = w * 0.16;
    ctx.fillStyle = "rgba(7, 7, 7, 0.035)";
    ctx.fillRect(x, y + topH, sidebarW, h - topH);
    ctx.fillStyle = "rgba(88, 162, 255, 0.16)";
    ctx.fillRect(x + sidebarW * 0.18, y + topH + h * 0.15, sidebarW * 0.68, h * 0.06);

    ctx.fillStyle = muted;
    ctx.font = `800 ${Math.max(9, 11 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "left";
    for (let i = 0; i < 7; i += 1) {
      const ly = y + topH + h * (0.13 + i * 0.095);
      ctx.fillRect(x + sidebarW * 0.24, ly, sidebarW * 0.46, Math.max(2, 3 * dpr));
    }

    const contentX = x + sidebarW + w * 0.04;
    const contentY = y + topH + h * 0.08;
    ctx.fillStyle = fg;
    ctx.font = `900 ${Math.max(16, 26 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(image.src.includes("b07e8bc2") ? "Curve Training" : "Overview", contentX, contentY);

    const cardGap = w * 0.018;
    const cardW = (w - sidebarW - w * 0.1 - cardGap) * 0.5;
    const cardH = h * 0.25;
    const cardY = contentY + h * 0.06;
    const cardColors = [
      "rgba(216, 242, 210, 0.78)",
      "rgba(228, 238, 249, 0.82)",
      "rgba(221, 235, 248, 0.78)",
      "rgba(220, 247, 232, 0.82)",
    ];

    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        const cx = contentX + col * (cardW + cardGap);
        const cy = cardY + row * (cardH + cardGap);
        roundedRectPath(ctx, cx, cy, cardW, cardH, 8 * dpr);
        ctx.fillStyle = cardColors[row * 2 + col];
        ctx.fill();
        ctx.strokeStyle = "rgba(67, 143, 210, 0.12)";
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.font = `800 ${Math.max(8, 9 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
        ctx.fillText(row === 0 && col === 0 ? "Base Status" : "Runtime", cx + cardW * 0.08, cy + cardH * 0.28);
      }
    }

    const rightX = contentX + cardW * 2 + cardGap * 2;
    const rightW = x + w - rightX - w * 0.04;
    for (let i = 0; i < 3; i += 1) {
      roundedRectPath(ctx, rightX, cardY + i * (cardH * 0.55), rightW, cardH * 0.42, 7 * dpr);
      ctx.fillStyle = i === 0 ? "rgba(255, 255, 255, 0.58)" : "rgba(228, 238, 249, 0.72)";
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawImageElement(ctx, image, canvasRect, dpr, skipUnsafeImages = false) {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    if (skipUnsafeImages || !image.complete) {
      drawImageFallback(ctx, image, canvasRect, dpr);
      return;
    }

    ctx.save();
    ctx.globalAlpha = getCompositedOpacity(image);
    try {
      ctx.drawImage(
        image,
        (rect.left - canvasRect.left) * dpr,
        (rect.top - canvasRect.top) * dpr,
        rect.width * dpr,
        rect.height * dpr,
      );
    } catch (error) {
      ctx.restore();
      drawImageFallback(ctx, image, canvasRect, dpr);
      return;
    }
    ctx.restore();
  }

  function drawCanvasElement(ctx, sourceCanvas, canvasRect, dpr) {
    if (!sourceCanvas.width || !sourceCanvas.height) return;

    const rect = sourceCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    ctx.save();
    ctx.globalAlpha = getCompositedOpacity(sourceCanvas);
    try {
      ctx.drawImage(
        sourceCanvas,
        (rect.left - canvasRect.left) * dpr,
        (rect.top - canvasRect.top) * dpr,
        rect.width * dpr,
        rect.height * dpr,
      );
    } catch (error) {}
    ctx.restore();
  }

  function isTransparentColor(color) {
    return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawElementBox(ctx, element, canvasRect, dpr) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersects(rect, canvasRect)) return;

    const style = getComputedStyle(element);
    const background = style.backgroundColor;
    const borderColor = style.borderTopColor;
    const borderWidth = parseCssLength(style.borderTopWidth, 0);
    const radius = parseCssLength(style.borderTopLeftRadius, 0);
    const opacity = parseFloat(style.opacity);
    const alpha = getCompositedOpacity(element);

    const hasBackground = !isTransparentColor(background);
    const hasBorder = borderWidth > 0 && !isTransparentColor(borderColor);
    if (hasBackground && background.includes("color-mix(")) return;
    if (!hasBackground && !hasBorder) return;

    const x = (rect.left - canvasRect.left) * dpr;
    const y = (rect.top - canvasRect.top) * dpr;
    const w = rect.width * dpr;
    const h = rect.height * dpr;
    const r = radius * dpr;

    ctx.save();
    ctx.globalAlpha = alpha;
    roundedRectPath(ctx, x, y, w, h, r);
    if (hasBackground) {
      ctx.fillStyle = background;
      ctx.fill();
    }
    if (hasBorder) {
      ctx.lineWidth = Math.max(1, borderWidth * dpr);
      ctx.strokeStyle = borderColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  function parseCssLength(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  function getCursorSnapshot() {
    const cursor = document.querySelector(".cursor-reveal");
    if (!cursor) return null;

    const style = getComputedStyle(cursor);
    const opacity = parseFloat(style.opacity);
    if (!Number.isFinite(opacity) || opacity <= 0.01 || style.display === "none" || style.visibility === "hidden") {
      return null;
    }

    const rootStyle = getComputedStyle(root);
    const x = parseCssLength(style.getPropertyValue("--cursor-visual-x"), window.innerWidth * 0.5);
    const y = parseCssLength(style.getPropertyValue("--cursor-visual-y"), window.innerHeight * 0.5);
    const radius = parseCssLength(style.getPropertyValue("--cursor-active-radius"), 0);
    if (radius <= 0.5) return null;

    return {
      x,
      y,
      radius,
      edge: parseCssLength(style.getPropertyValue("--cursor-edge"), 5),
      opacity,
      color: rootStyle.getPropertyValue("--cursor").trim() || style.backgroundColor,
      textColor: rootStyle.getPropertyValue("--cursor-text").trim() || style.color,
    };
  }

  function drawCursorLayer(ctx, canvasRect, dpr) {
    const cursor = getCursorSnapshot();
    if (!cursor) return;

    const bounds = {
      left: cursor.x - cursor.radius,
      top: cursor.y - cursor.radius,
      right: cursor.x + cursor.radius,
      bottom: cursor.y + cursor.radius,
    };
    if (!intersects(bounds, canvasRect)) return;

    ctx.save();
    ctx.globalAlpha = cursor.opacity;
    const cx = (cursor.x - canvasRect.left) * dpr;
    const cy = (cursor.y - canvasRect.top) * dpr;
    const radius = cursor.radius * dpr;
    const edge = Math.max(1, cursor.edge * dpr);
    const gradient = ctx.createRadialGradient(cx, cy, Math.max(0, radius - edge), cx, cy, radius);
    gradient.addColorStop(0, cursor.color);
    gradient.addColorStop(0.72, cursor.color);
    gradient.addColorStop(0.96, cursor.color);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    drawCursorRevealText(ctx, canvasRect, dpr, cursor);
    ctx.restore();
  }

  function drawCursorRevealText(ctx, canvasRect, dpr, cursor) {
    const revealCopy = document.querySelector(".cursor-reveal .hero-copy-reveal");
    const revealEyebrow = document.querySelector(".cursor-reveal .hero-copy-reveal .eyebrow");
    const revealStrong = document.querySelector(".cursor-reveal .hero-copy-reveal .title-strong");
    const revealComma = document.querySelector(".cursor-reveal .hero-copy-reveal .title-comma");
    const revealLight = document.querySelector(".cursor-reveal .hero-copy-reveal .title-light");
    const revealSubtitle = document.querySelector(".cursor-reveal .hero-copy-reveal .subtitle");

    if (!revealCopy || !revealStrong || !revealLight) return;

    const copyRect = revealCopy.getBoundingClientRect();
    const h2Rect = document.querySelector(".cursor-reveal .hero-copy-reveal h2")?.getBoundingClientRect();
    const baseH1Rect = document.querySelector(".hero-copy-base h1")?.getBoundingClientRect();
    const baseStrongRect = document.querySelector(".hero-copy-base .title-strong")?.getBoundingClientRect();
    const baseLightRect = document.querySelector(".hero-copy-base .title-light")?.getBoundingClientRect();

    // The browser cannot expose the final composited cursor layer to WebGL.
    // Repaint the reveal copy from the same screen-space anchors so the glass texture sees it.
    const sourceH1Rect = h2Rect || baseH1Rect;
    const titleY = sourceH1Rect
      ? sourceH1Rect.top + sourceH1Rect.height * 0.5
      : copyRect.top + copyRect.height * 0.5;

    if (baseStrongRect && baseLightRect) {
      drawTextLikeElement(ctx, revealStrong, "你好", baseStrongRect, canvasRect, dpr, {
        color: cursor.textColor,
        opacity: cursor.opacity,
        y: titleY,
      });

      if (revealComma) {
        const commaRect = revealComma.getBoundingClientRect();
        const commaX = (baseStrongRect.right + baseLightRect.left) * 0.5;
        drawTextLikeElement(ctx, revealComma, "，", commaRect, canvasRect, dpr, {
          color: cursor.textColor,
          opacity: cursor.opacity,
          x: commaX,
          y: titleY,
          maxWidth: Math.max(32, baseLightRect.left - baseStrongRect.right),
        });
      }

      drawTextLikeElement(ctx, revealLight, "这里是 PDAim", baseLightRect, canvasRect, dpr, {
        color: cursor.textColor,
        opacity: cursor.opacity,
        y: titleY,
      });
    } else {
      [revealStrong, revealComma, revealLight].filter(Boolean).forEach((element) => {
        drawTextElement(ctx, element, canvasRect, dpr, {
          color: cursor.textColor,
          opacity: cursor.opacity,
        });
      });
    }

    if (revealEyebrow) {
      drawTextElement(ctx, revealEyebrow, canvasRect, dpr, {
        color: cursor.textColor,
        opacity: cursor.opacity * 0.72,
      });
    }

    if (revealSubtitle) {
      drawTextElement(ctx, revealSubtitle, canvasRect, dpr, {
        color: cursor.textColor,
        opacity: cursor.opacity * 0.72,
      });
    }
  }

  const EXCLUDE_ALL_GLASS_HOSTS = {};
  let underlyingCacheDirty = true;
  let underlyingElements = [];
  let underlyingImages = [];

  function refreshUnderlyingCache() {
    underlyingElements = Array.from(document.querySelectorAll("main *, section *"));
    underlyingImages = Array.from(document.querySelectorAll("main img, section img"));
    underlyingCacheDirty = false;
  }

  function shouldSkipUnderlyingElement(element, host) {
    if (element.classList?.contains("liquid-glass-canvas")) {
      if (host === EXCLUDE_ALL_GLASS_HOSTS) return true;
      return Boolean(host && host.contains(element));
    }
    if (host?.dataset?.glassIsolate === "true") {
      if (element.closest?.(".pdaim-shop-panel")) return true;
      const elementRect = element.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (!intersects(elementRect, hostRect)) return true;
    }
    if (host === EXCLUDE_ALL_GLASS_HOSTS) return Boolean(element.closest?.("[data-liquid-glass]"));
    if (host?.closest?.(".site-header") && !host.classList.contains("site-header")) {
      return Boolean(host.contains(element));
    }
    return Boolean(host && host.contains(element));
  }

  function shouldDrawPreciseText(canvasRect) {
    return canvasRect.top < 180 && canvasRect.bottom > -40;
  }

  function drawUnderlyingContent(ctx, canvasRect, dpr, state, host) {
    if (underlyingCacheDirty) refreshUnderlyingCache();
    const elements = underlyingElements.filter((element) => element.isConnected);
    const images = underlyingImages.filter((image) => image.isConnected);

    elements.forEach((element) => {
      if (shouldSkipUnderlyingElement(element, host)) return;
      if (element instanceof HTMLCanvasElement && (element.classList.contains("liquid-glass-canvas") || element.classList.contains("pdaim-line-field"))) {
        drawCanvasElement(ctx, element, canvasRect, dpr);
        return;
      }
      if (element instanceof HTMLImageElement) return;
      drawElementBox(ctx, element, canvasRect, dpr);
    });

    images.forEach((image) => {
      if (shouldSkipUnderlyingElement(image, host)) return;
      if (image.currentSrc && image.currentSrc.includes("/captcha/")) return;
      drawImageElement(ctx, image, canvasRect, dpr, state.skipUnsafeImages);
    });

    elements.forEach((element) => {
      if (shouldSkipUnderlyingElement(element, host)) return;
      if (element.children.length > 0) return;
      if (element instanceof HTMLImageElement) return;
      if (element instanceof HTMLCanvasElement) return;
      const rect = element.getBoundingClientRect();
      const intersectsCanvas = intersects(rect, canvasRect);
      const nearHeader = rect.top < 180 && rect.bottom > -40;
      if (!intersectsCanvas && !nearHeader) return;
      drawTextElement(ctx, element, canvasRect, dpr, {
        precise: nearHeader && shouldDrawPreciseText(canvasRect),
      });
    });

    elements.forEach((element) => {
      if (shouldSkipUnderlyingElement(element, host)) return;
      if (!isCompositeTextElement(element)) return;
      drawTextElement(ctx, element, canvasRect, dpr, { precise: true });
    });

    drawCursorLayer(ctx, canvasRect, dpr);
  }

  function drawBackground(state, width, height, dpr, rect, gridX, gridY, gridOpacity, diagonalOpacity, refractionOpacity, bgColor, dotColor, force, host) {
    const needsResize = state.width !== width || state.height !== height;
    const needsScroll = Math.abs(state.scrollY - window.scrollY) > 0.5;
    const needsGrid = Math.abs(state.gridX - gridX) > 0.1 || Math.abs(state.gridY - gridY) > 0.1;
    const needsBackgroundOpacity =
      Math.abs((state.gridOpacity ?? NaN) - gridOpacity) > 0.002 ||
      Math.abs((state.diagonalOpacity ?? NaN) - diagonalOpacity) > 0.002 ||
      Math.abs((state.refractionOpacity ?? NaN) - refractionOpacity) > 0.002;
    const needsColor = state.bgColor !== bgColor || state.dotColor !== dotColor;
    const needsRect = Math.abs((state.rectLeft ?? NaN) - rect.left) > 0.5 || Math.abs((state.rectTop ?? NaN) - rect.top) > 0.5;
    if (!force && !needsResize && !needsScroll && !needsGrid && !needsBackgroundOpacity && !needsColor && !needsRect) return false;

    if (needsResize) {
      state.bg.width = width;
      state.bg.height = height;
      state.width = width;
      state.height = height;
    }

    state.scrollY = window.scrollY;
    state.gridX = gridX;
    state.gridY = gridY;
    state.gridOpacity = gridOpacity;
    state.diagonalOpacity = diagonalOpacity;
    state.refractionOpacity = refractionOpacity;
    state.bgColor = bgColor;
    state.dotColor = dotColor;
    state.rectLeft = rect.left;
    state.rectTop = rect.top;

    const ctx = state.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    const rootStyle = getComputedStyle(root);
    const fgColor = rootStyle.getPropertyValue("--fg").trim() || (root.dataset.theme === "dark" ? "#ffffff" : "#070707");
    const heroBeforeX = (window.innerWidth * 0.07 - rect.left + window.innerWidth * 0.17) * dpr;
    const heroBeforeY = (window.innerHeight * 0.22 - rect.top + window.innerWidth * 0.17) * dpr;
    const heroAfterX = (window.innerWidth * 0.9 - rect.left - window.innerWidth * 0.17) * dpr;
    const heroAfterY = (window.innerHeight * 0.86 - rect.top - window.innerWidth * 0.17) * dpr;
    drawBlurredCircle(ctx, heroBeforeX, heroBeforeY, Math.min(window.innerWidth * 0.17, 260) * dpr, colorMixAlpha(fgColor, 0.04), 60 * dpr);
    drawBlurredCircle(ctx, heroAfterX, heroAfterY, Math.min(window.innerWidth * 0.17, 260) * dpr, colorMixAlpha(fgColor, 0.04), 60 * dpr);
    drawRefractionField(ctx, rect, dpr, fgColor, gridX, gridY, refractionOpacity);

    if (gridOpacity > 0.001) {
      const spacing = 38 * dpr;
      const dotRadius = 1.05 * dpr;
      const pageLeft = -rect.left * dpr;
      const pageTop = -rect.top * dpr;
      const centerX = window.innerWidth * dpr * 0.5;
      const centerY = window.innerHeight * dpr * 0.5;
      const maxDim = Math.max(window.innerWidth * dpr, window.innerHeight * dpr);
      const startX = ((((pageLeft + gridX * dpr) % spacing) + spacing) % spacing) - spacing;
      const startY = ((((pageTop + gridY * dpr) % spacing) + spacing) % spacing) - spacing;

      ctx.fillStyle = dotColor;
      for (let y = startY; y < height + spacing; y += spacing) {
        for (let x = startX; x < width + spacing; x += spacing) {
          const viewportX = rect.left * dpr + x - gridX * dpr;
          const viewportY = rect.top * dpr + y - gridY * dpr;
          const dist = Math.hypot(viewportX - centerX, viewportY - centerY);
          const mask = radialGridMask(dist / maxDim);
          if (mask <= 0.02) continue;

          ctx.globalAlpha = mask * gridOpacity;
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.globalAlpha = 1;
    drawUnderlyingContent(ctx, rect, dpr, state, host);
    return true;
  }

  function getInstanceOptions(host) {
    const style = getComputedStyle(host);
    const radius = parseCssLength(style.borderTopLeftRadius, host.getBoundingClientRect().height * 0.5);
    const blur = parseCssLength(host.dataset.glassBlur || "", NaN);

    return {
      cornerRadius: radius,
      glassBlur: Number.isFinite(blur) ? blur : 20,
      alphaBoost: parseFloat(host.dataset.glassAlpha) || 1,
    };
  }

  const mobileGlassQuery = window.matchMedia("(max-width: 720px), (pointer: coarse)");
  const MAX_GLASS_OUTPUTS = 64;
  const MOBILE_MAX_GLASS_OUTPUTS = 1;
  const GLASS_DPR_LIMIT = 1.25;
  const MOBILE_GLASS_DPR_LIMIT = 0.85;
  const outputContexts = new WeakMap();
  const sharedBackground = createBackgroundCanvas();
  const localBackground = createBackgroundCanvas();
  const workCanvas = document.createElement("canvas");
  let frameSignature = "";
  let frameForceBackground = true;
  let activeTextureSource = "";
  let gl = null;
  let program = null;
  let buffer = null;
  let texture = null;
  let orbTexture = null;
  let lineTexture = null;
  let orbCanvas = null;
  let orbCtx = null;
  let orbTextureWidth = 0;
  let orbTextureHeight = 0;
  let locations = null;
  let contextLost = false;
  let lastRenderTime = 0;
  let lastRenderStamp = 0;
  let lineTextureFrame = "";
  let lineTextureUploaded = false;

  function isLiteGlassMode() {
    return mobileGlassQuery.matches;
  }

  function resolveHost(canvas) {
    return canvas.closest("[data-liquid-glass]") || canvas.parentElement;
  }

  function getOutputContext(canvas) {
    let ctx = outputContexts.get(canvas);
    if (!ctx) {
      ctx = canvas.getContext("2d", { alpha: true });
      if (ctx) outputContexts.set(canvas, ctx);
    }
    return ctx;
  }

  function getCanvasPriority(canvas, host, rect) {
    let priority = 20;
    if (host?.classList.contains("site-header")) priority = 0;
    else if (host?.classList.contains("theme-toggle-float")) priority = 1;
    else if (host?.classList.contains("nav-pill") || host?.classList.contains("auth-button") || host?.classList.contains("icon-button")) priority = 2;
    else if (host?.classList.contains("pdaim-license-card")) priority = 24;
    else if (host?.closest?.(".site-header")) priority = 4;
    else priority = 10;

    const centerX = (rect.left + rect.right) * 0.5;
    const centerY = (rect.top + rect.bottom) * 0.5;
    const distance = Math.hypot(centerX - window.innerWidth * 0.5, centerY - window.innerHeight * 0.5);
    if (rect.bottom < -180 || rect.top > window.innerHeight + 180 || rect.right < -180 || rect.left > window.innerWidth + 180) {
      priority += 100;
    }
    return priority + distance / 10000;
  }

  function collectOutputItems() {
    const liteMode = isLiteGlassMode();
    if (liteMode) return [];
    const maxOutputs = MAX_GLASS_OUTPUTS;

    return Array.from(document.querySelectorAll(".liquid-glass-canvas"))
      .map((canvas) => {
        const host = resolveHost(canvas);
        if (!host || !host.isConnected || !canvas.isConnected) return null;

        const rect = canvas.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        if (!rect.width || !rect.height || !hostRect.width || !hostRect.height) return null;
        if (rect.bottom < -180 || rect.top > window.innerHeight + 180 || rect.right < -180 || rect.left > window.innerWidth + 180) return null;

        const style = getComputedStyle(host);
        if (style.display === "none" || style.visibility === "hidden") return null;
        if (getCompositedOpacity(host) <= 0.01) return null;

        return {
          canvas,
          host,
          rect,
          hostRect,
          rank: getCanvasPriority(canvas, host, rect),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, maxOutputs);
  }

  function initRenderer() {
    try {
      gl = workCanvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error("LiquidGlass WebGL unavailable");

      program = link(gl, vertexSource, fragmentSource);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
        -1,  1, 0, 1,
         1, -1, 1, 0,
         1,  1, 1, 1,
      ]), gl.STATIC_DRAW);

      locations = {
        position: gl.getAttribLocation(program, "a_position"),
        texCoord: gl.getAttribLocation(program, "a_texCoord"),
        backgroundTexture: gl.getUniformLocation(program, "backgroundTexture"),
        orbTexture: gl.getUniformLocation(program, "orbTexture"),
        lineTexture: gl.getUniformLocation(program, "lineTexture"),
        resolution: gl.getUniformLocation(program, "resolution"),
        backgroundResolution: gl.getUniformLocation(program, "backgroundResolution"),
        textureOffset: gl.getUniformLocation(program, "textureOffset"),
        lightPos: gl.getUniformLocation(program, "lightPos"),
        glassBlur: gl.getUniformLocation(program, "glassBlur"),
        cornerRadius: gl.getUniformLocation(program, "cornerRadius"),
        shapeSize: gl.getUniformLocation(program, "shapeSize"),
        alphaBoost: gl.getUniformLocation(program, "alphaBoost"),
        darkAmount: gl.getUniformLocation(program, "darkAmount"),
        viewportOffset: gl.getUniformLocation(program, "viewportOffset"),
        lineFieldOpacity: gl.getUniformLocation(program, "lineFieldOpacity"),
      };

      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      orbCanvas = document.createElement("canvas");
      orbCtx = orbCanvas.getContext("2d", { alpha: true });
      orbTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, orbTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      lineTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, lineTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.SCISSOR_TEST);

      workCanvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        contextLost = true;
        root.classList.add("liquid-glass-global-failed");
      }, false);

      root.classList.add("liquid-glass-global-ready");
      return true;
    } catch (error) {
      root.classList.add("liquid-glass-global-failed");
      return false;
    }
  }

  function uploadSharedBackground(metrics, paintState) {
    const rect = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const changed = drawBackground(
      sharedBackground,
      metrics.viewportWidth,
      metrics.viewportHeight,
      metrics.dpr,
      rect,
      paintState.gridX,
      paintState.gridY,
      paintState.gridOpacity,
      paintState.diagonalOpacity,
      paintState.refractionOpacity,
      paintState.bgColor,
      paintState.dotColor,
      frameForceBackground,
      EXCLUDE_ALL_GLASS_HOSTS,
    );
    if (!changed && sharedBackground.textureUploaded && activeTextureSource === "shared") return true;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sharedBackground.bg);
      sharedBackground.textureUploaded = true;
      activeTextureSource = "shared";
      return true;
    } catch (error) {
      if (!error || error.name !== "SecurityError") throw error;
      sharedBackground.skipUnsafeImages = true;
      sharedBackground.warnedTaintedCanvas = true;
      sharedBackground.bg.width = metrics.viewportWidth;
      sharedBackground.bg.height = metrics.viewportHeight;
      sharedBackground.width = metrics.viewportWidth;
      sharedBackground.height = metrics.viewportHeight;
      drawBackground(
        sharedBackground,
        metrics.viewportWidth,
        metrics.viewportHeight,
        metrics.dpr,
        rect,
        paintState.gridX,
        paintState.gridY,
        paintState.gridOpacity,
        paintState.diagonalOpacity,
        paintState.refractionOpacity,
        paintState.bgColor,
        paintState.dotColor,
        true,
        EXCLUDE_ALL_GLASS_HOSTS,
      );
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sharedBackground.bg);
        sharedBackground.textureUploaded = true;
        activeTextureSource = "shared";
        return true;
      } catch (retryError) {
        return false;
      }
    }
  }

  function needsLocalBackground(item, items) {
    if (item.host.dataset?.glassIsolate === "true") return true;
    const insideHeader = item.host.closest?.(".site-header");
    const isItemDetailPage = /^\/item\/\d+/.test(window.location.pathname || "") || (window.location.pathname || "").includes("/user/index/item");
    if (insideHeader) {
      if (isItemDetailPage) return true;
      if (!item.host.classList.contains("site-header")) return false;
    }
    if (!item.host.classList.contains("site-header")) return false;
    return items.some((other) => (
      other !== item &&
      other.host !== item.host &&
      !item.host.contains(other.host) &&
      !other.host.contains(item.host) &&
      intersects(item.hostRect, other.hostRect)
    ));
  }

  function uploadLocalBackground(item, metrics, paintState) {
    const { rect, host } = item;
    const width = Math.max(1, Math.round(rect.width * metrics.dpr));
    const height = Math.max(1, Math.round(rect.height * metrics.dpr));

    const changed = drawBackground(
      localBackground,
      width,
      height,
      metrics.dpr,
      rect,
      paintState.gridX,
      paintState.gridY,
      paintState.gridOpacity,
      paintState.diagonalOpacity,
      paintState.refractionOpacity,
      paintState.bgColor,
      paintState.dotColor,
      frameForceBackground,
      host,
    );
    if (!changed && localBackground.textureUploaded && activeTextureSource === "local") return true;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, localBackground.bg);
      localBackground.textureUploaded = true;
      activeTextureSource = "local";
      return true;
    } catch (error) {
      if (!error || error.name !== "SecurityError") throw error;
      localBackground.skipUnsafeImages = true;
      localBackground.warnedTaintedCanvas = true;
      localBackground.bg.width = width;
      localBackground.bg.height = height;
      localBackground.width = width;
      localBackground.height = height;
      drawBackground(
        localBackground,
        width,
        height,
        metrics.dpr,
        rect,
        paintState.gridX,
        paintState.gridY,
        paintState.gridOpacity,
        paintState.diagonalOpacity,
        paintState.refractionOpacity,
        paintState.bgColor,
        paintState.dotColor,
        true,
        host,
      );
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, localBackground.bg);
        localBackground.textureUploaded = true;
        activeTextureSource = "local";
        return true;
      } catch (retryError) {
        return false;
      }
    }
  }

  function uploadOrbTexture(metrics, paintState) {
    if (!orbCtx || !orbTexture) return false;

    const width = Math.max(1, Math.round(metrics.viewportWidth * 0.25));
    const height = Math.max(1, Math.round(metrics.viewportHeight * 0.25));
    const scaleX = width / metrics.viewportWidth;
    const scaleY = height / metrics.viewportHeight;
    const scale = Math.min(scaleX, scaleY);

    if (orbCanvas.width !== width || orbCanvas.height !== height) {
      orbCanvas.width = width;
      orbCanvas.height = height;
      orbTextureWidth = width;
      orbTextureHeight = height;
    }

    const time = performance.now() * 0.001;
    const darkAmount = root.dataset.theme === "dark" ? 1 : 0;
    const baseRadius = Math.min(metrics.viewportWidth, metrics.viewportHeight);
    const mix = (a, b) => a + (b - a) * darkAmount;
    const defs = [
      { x: 0.18, y: 0.22, dx: 0.24, dy: 0.16, speed: 0.62, phase: 0.0, radius: 0.28, light: [0.278, 0.663, 1.0], dark: [0.282, 0.698, 1.0], strength: [0.20, 0.22] },
      { x: 0.78, y: 0.18, dx: -0.20, dy: 0.18, speed: 0.73, phase: 1.7, radius: 0.25, light: [1.0, 0.424, 0.682], dark: [1.0, 0.455, 0.722], strength: [0.17, 0.19] },
      { x: 0.72, y: 0.76, dx: -0.22, dy: -0.18, speed: 0.51, phase: 3.1, radius: 0.30, light: [0.600, 0.435, 1.0], dark: [0.620, 0.471, 1.0], strength: [0.18, 0.21] },
      { x: 0.28, y: 0.78, dx: 0.20, dy: -0.22, speed: 0.68, phase: 0.8, radius: 0.24, light: [0.325, 0.867, 0.722], dark: [0.314, 0.878, 0.745], strength: [0.15, 0.17] },
      { x: 0.50, y: 0.48, dx: 0.16, dy: 0.14, speed: 0.44, phase: 2.4, radius: 0.33, light: [1.0, 0.753, 0.384], dark: [1.0, 0.761, 0.412], strength: [0.14, 0.16] },
    ];

    orbCtx.setTransform(1, 0, 0, 1, 0, 0);
    orbCtx.clearRect(0, 0, width, height);
    orbCtx.globalCompositeOperation = "source-over";

    defs.forEach((orb) => {
      const waveA = Math.sin(time * orb.speed + orb.phase);
      const waveB = Math.cos(time * (orb.speed * 0.73 + 0.17) + orb.phase * 1.37);
      const x = metrics.viewportWidth * (orb.x + orb.dx * waveA) * scaleX;
      const y = metrics.viewportHeight * (orb.y + orb.dy * waveB) * scaleY;
      const radius = baseRadius * orb.radius * scale;
      const strength = paintState.refractionOpacity * mix(orb.strength[0], orb.strength[1]);
      const r = Math.round(mix(orb.light[0], orb.dark[0]) * 255);
      const g = Math.round(mix(orb.light[1], orb.dark[1]) * 255);
      const b = Math.round(mix(orb.light[2], orb.dark[2]) * 255);
      const gradient = orbCtx.createRadialGradient(x, y, radius * 0.08, x, y, radius);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${strength})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      orbCtx.fillStyle = gradient;
      orbCtx.beginPath();
      orbCtx.arc(x, y, radius, 0, Math.PI * 2);
      orbCtx.fill();
    });

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, orbTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, orbCanvas);
    return true;
  }

  function uploadLineTexture() {
    if (!lineTexture) return false;
    const canvas = document.querySelector("#pdaimLineField");
    if (!canvas || !canvas.width || !canvas.height) return false;
    const frame = canvas.dataset.frame || "0";
    if (lineTextureUploaded && frame === lineTextureFrame) return true;

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, lineTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      lineTextureFrame = frame;
      lineTextureUploaded = true;
      return true;
    } catch (error) {
      return false;
    }
  }

  function renderOutput(item, paintState, metrics) {
    const { canvas, host, rect, hostRect } = item;
    const dpr = metrics.dpr;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const outputCtx = getOutputContext(canvas);
    if (!outputCtx) return;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const options = getInstanceOptions(host);
    const shapeWidth = Math.max(1, Math.round(hostRect.width * dpr));
    const shapeHeight = Math.max(1, Math.round(hostRect.height * dpr));
    const cornerRadius = Math.min(options.cornerRadius * dpr, shapeHeight * 0.5, shapeWidth * 0.5);
    const glassBlur = options.glassBlur * dpr;
    const darkAmount = root.dataset.theme === "dark" ? 1 : 0;

    gl.viewport(0, 0, width, height);
    gl.scissor(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(locations.position);
    gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locations.texCoord);
    gl.vertexAttribPointer(locations.texCoord, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(locations.backgroundTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, orbTexture);
    gl.uniform1i(locations.orbTexture, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, lineTexture);
    gl.uniform1i(locations.lineTexture, 2);
    gl.uniform2f(locations.resolution, width, height);
    if (item.localBackground) {
      gl.uniform2f(locations.backgroundResolution, width, height);
      gl.uniform2f(locations.textureOffset, 0, 0);
      gl.uniform2f(locations.viewportOffset, rect.left * dpr, rect.top * dpr);
    } else {
      gl.uniform2f(locations.backgroundResolution, metrics.viewportWidth, metrics.viewportHeight);
      gl.uniform2f(locations.textureOffset, rect.left * dpr, rect.top * dpr);
      gl.uniform2f(locations.viewportOffset, rect.left * dpr, rect.top * dpr);
    }
    gl.uniform2f(locations.lightPos, width * 0.25, height * 0.25);
    gl.uniform1f(locations.glassBlur, glassBlur);
    gl.uniform1f(locations.cornerRadius, cornerRadius);
    gl.uniform2f(locations.shapeSize, shapeWidth, shapeHeight);
    gl.uniform1f(locations.alphaBoost, options.alphaBoost);
    gl.uniform1f(locations.darkAmount, darkAmount);
    gl.uniform1f(locations.lineFieldOpacity, paintState.lineFieldOpacity || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    outputCtx.setTransform(1, 0, 0, 1, 0, 0);
    outputCtx.clearRect(0, 0, width, height);
    outputCtx.drawImage(workCanvas, 0, workCanvas.height - height, width, height, 0, 0, width, height);
  }

  function render() {
    if (!gl || contextLost || gl.isContextLost()) return;
    lastRenderStamp = performance.now();

    const dpr = Math.min(window.devicePixelRatio || 1, isLiteGlassMode() ? MOBILE_GLASS_DPR_LIMIT : GLASS_DPR_LIMIT);
    const metrics = {
      dpr,
      viewportWidth: Math.max(1, Math.round(window.innerWidth * dpr)),
      viewportHeight: Math.max(1, Math.round(window.innerHeight * dpr)),
    };
    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(document.body);
    const isOverviewPage = Boolean(document.querySelector(".hero[data-route-page='overview']"));
    const paintState = {
      gridX: parseFloat(rootStyle.getPropertyValue("--grid-x")) || 0,
      gridY: parseFloat(rootStyle.getPropertyValue("--grid-y")) || 0,
      gridOpacity: isOverviewPage ? clamp01(parseFloat(rootStyle.getPropertyValue("--grid-opacity"))) : 0,
      diagonalOpacity: isOverviewPage ? clamp01(parseFloat(rootStyle.getPropertyValue("--diagonal-opacity"))) : 0,
      refractionOpacity: clamp01(parseFloat(rootStyle.getPropertyValue("--refraction-opacity"))),
      lineFieldOpacity: clamp01(parseFloat(rootStyle.getPropertyValue("--line-field-opacity"))),
      dotColor: rootStyle.getPropertyValue("--dot").trim() || (root.dataset.theme === "dark" ? "rgba(255,255,255,0.34)" : "rgba(7,7,7,0.34)"),
      bgColor: bodyStyle.backgroundColor || (root.dataset.theme === "dark" ? "#050505" : "#ffffff"),
    };
    const effectiveGridX = paintState.gridOpacity > 0.001 ? paintState.gridX : 0;
    const effectiveGridY = paintState.gridOpacity > 0.001 ? paintState.gridY : 0;

    const nextFrameSignature = [
      metrics.viewportWidth,
      metrics.viewportHeight,
      metrics.dpr,
      Math.round(window.scrollY * 2) / 2,
      effectiveGridX.toFixed(1),
      effectiveGridY.toFixed(1),
      paintState.gridOpacity.toFixed(3),
      paintState.diagonalOpacity.toFixed(3),
      paintState.refractionOpacity.toFixed(3),
      paintState.lineFieldOpacity.toFixed(3),
      paintState.dotColor,
      paintState.bgColor,
      root.dataset.theme || "",
      underlyingCacheDirty ? "dirty" : "clean",
    ].join("|");
    frameForceBackground = nextFrameSignature !== frameSignature;
    if (frameForceBackground) {
      frameSignature = nextFrameSignature;
      sharedBackground.textureUploaded = false;
      localBackground.textureUploaded = false;
      activeTextureSource = "";
    }

    const items = collectOutputItems();
    let maxWorkWidth = 1;
    let maxWorkHeight = 1;
    items.forEach((item) => {
      maxWorkWidth = Math.max(maxWorkWidth, Math.round(item.rect.width * dpr));
      maxWorkHeight = Math.max(maxWorkHeight, Math.round(item.rect.height * dpr));
    });

    if (workCanvas.width !== maxWorkWidth || workCanvas.height !== maxWorkHeight) {
      workCanvas.width = maxWorkWidth;
      workCanvas.height = maxWorkHeight;
    }

    items.forEach((item) => {
      item.localBackground = needsLocalBackground(item, items);
    });

    if (!items.length) return;
    paintState.gridX = effectiveGridX;
    paintState.gridY = effectiveGridY;
    if (!uploadSharedBackground(metrics, paintState)) return;
    if (!uploadOrbTexture(metrics, paintState)) return;
    if (!uploadLineTexture()) paintState.lineFieldOpacity = 0;

    items.filter((item) => !item.localBackground).forEach((item) => {
      try {
        renderOutput(item, paintState, metrics);
      } catch (error) {}
    });

    items.filter((item) => item.localBackground).forEach((item) => {
      try {
        if (!uploadLocalBackground(item, metrics, paintState)) return;
        renderOutput(item, paintState, metrics);
      } catch (error) {}
    });
  }

  function loop(now) {
    const liteMode = isLiteGlassMode();
    const minInterval = liteMode ? 1000 / 24 : 1;
    if (!liteMode || now - lastRenderTime >= minInterval) {
      lastRenderTime = now;
      if (now - lastRenderStamp >= 1) render();
    }
    requestAnimationFrame(loop);
  }

  function renderForScroll() {
    if (isLiteGlassMode()) return;
    lastRenderTime = performance.now();
    render();
  }

  if (initRenderer()) {
    window.addEventListener("resize", render, { passive: true });
    mobileGlassQuery.addEventListener?.("change", () => {
      frameSignature = "";
      render();
    });
    window.addEventListener("scroll", renderForScroll, { passive: true });
    document.addEventListener("pdaim:liquid-refresh", () => {
      underlyingCacheDirty = true;
      frameSignature = "";
      render();
    });
    new MutationObserver(() => {
      underlyingCacheDirty = true;
      frameSignature = "";
    }).observe(document.body, { childList: true, subtree: true });
    requestAnimationFrame(loop);
  }
})();
