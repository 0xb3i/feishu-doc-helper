/*
 * 模拟的文档图片（演示数据）。接入后端后由真实图片列表替换。
 * 每项：{ id, name, src, width, height, bytes }
 */
(() => {
  'use strict';

  const C = {
    paper: '#ffffff',
    sunk: '#f4f3f0',
    line: '#e4e1dc',
    ink: '#4a4844',
    soft: '#9a958f',
    sage: '#7fa58a',
    amber: '#cfa468',
    slate: '#7c9a99',
    rose: '#b98583',
  };

  const svg = (w, h, body) =>
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
        `<rect width="${w}" height="${h}" fill="${C.paper}"/>${body}</svg>`,
    );

  const label = (x, y, text, size = 28) =>
    `<text x="${x}" y="${y}" font-family="PingFang SC, sans-serif" font-size="${size}" font-weight="600" fill="${C.ink}">${text}</text>`;

  function bars(w, h, title, seed) {
    const n = 7;
    const gw = (w - 160) / n;
    let b = label(64, 80, title);
    b += `<line x1="64" y1="${h - 80}" x2="${w - 64}" y2="${h - 80}" stroke="${C.line}" stroke-width="2"/>`;
    for (let i = 0; i < n; i++) {
      const v = 0.3 + (((seed * (i + 3)) % 7) / 10);
      const bh = (h - 220) * v;
      b += `<rect x="${80 + i * gw}" y="${h - 80 - bh}" width="${gw * 0.56}" height="${bh}" rx="6" fill="${i === n - 2 ? C.amber : C.sage}"/>`;
    }
    return svg(w, h, b);
  }

  function line(w, h, title, seed) {
    let pts = [];
    for (let i = 0; i <= 10; i++) {
      const x = 64 + ((w - 128) / 10) * i;
      const y = h - 100 - (h - 240) * (0.2 + 0.6 * (i / 10) + 0.12 * Math.sin(i * seed));
      pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
    }
    let b = label(64, 80, title);
    for (let i = 0; i < 4; i++) {
      const y = 140 + ((h - 240) / 3) * i;
      b += `<line x1="64" y1="${y}" x2="${w - 64}" y2="${y}" stroke="${C.sunk}" stroke-width="2"/>`;
    }
    b += `<polyline points="${pts.join(' ')}" fill="none" stroke="${C.slate}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
    return svg(w, h, b);
  }

  function flow(w, h, title) {
    const bw = (w - 64 * 2 - 3 * 60) / 4;
    const y = h / 2 - 50;
    const fills = [C.sage, C.slate, C.amber, C.rose];
    let b = label(64, 80, title);
    for (let i = 0; i < 4; i++) {
      const x = 64 + i * (bw + 60);
      b += `<rect x="${x}" y="${y}" width="${bw}" height="100" rx="12" fill="${C.sunk}" stroke="${fills[i]}" stroke-width="3"/>`;
      b += `<rect x="${x + 24}" y="${y + 40}" width="${bw * 0.5}" height="18" rx="9" fill="${fills[i]}" opacity=".7"/>`;
      if (i < 3)
        b += `<path d="M${x + bw + 12} ${y + 50} h36 m-10 -9 l10 9 l-10 9" fill="none" stroke="${C.soft}" stroke-width="3" stroke-linecap="round"/>`;
    }
    return svg(w, h, b);
  }

  function screen(w, h, title) {
    let b = `<rect x="40" y="40" width="${w - 80}" height="${h - 80}" rx="14" fill="${C.sunk}" stroke="${C.line}" stroke-width="2"/>`;
    b += `<rect x="40" y="40" width="${(w - 80) * 0.24}" height="${h - 80}" rx="14" fill="#ecebe7"/>`;
    for (let i = 0; i < 6; i++)
      b += `<rect x="72" y="${110 + i * 46}" width="${(w - 80) * 0.15}" height="14" rx="7" fill="${i === 1 ? C.sage : C.line}"/>`;
    const cx = 40 + (w - 80) * 0.24 + 40;
    b += label(cx, 112, title, 30);
    for (let i = 0; i < 3; i++)
      b += `<rect x="${cx}" y="${150 + i * 120}" width="${w - cx - 80}" height="96" rx="10" fill="${C.paper}" stroke="${C.line}" stroke-width="2"/>`;
    return svg(w, h, b);
  }

  function scene(w, h) {
    let b = `<rect width="${w}" height="${h}" fill="#e9eee8"/>`;
    b += `<circle cx="${w * 0.72}" cy="${h * 0.3}" r="${h * 0.09}" fill="${C.amber}" opacity=".85"/>`;
    b += `<path d="M0 ${h * 0.7} Q ${w * 0.25} ${h * 0.45} ${w * 0.5} ${h * 0.66} T ${w} ${h * 0.58} V ${h} H 0 Z" fill="${C.sage}" opacity=".75"/>`;
    b += `<path d="M0 ${h * 0.82} Q ${w * 0.35} ${h * 0.68} ${w * 0.7} ${h * 0.84} T ${w} ${h * 0.8} V ${h} H 0 Z" fill="${C.slate}" opacity=".7"/>`;
    return svg(w, h, b);
  }

  function table(w, h, title) {
    let b = label(64, 80, title);
    const rows = 6;
    const cols = 4;
    const rh = (h - 180) / rows;
    const cw = (w - 128) / cols;
    b += `<rect x="64" y="120" width="${w - 128}" height="${rh}" fill="${C.sunk}"/>`;
    for (let r = 0; r <= rows; r++)
      b += `<line x1="64" y1="${120 + r * rh}" x2="${w - 64}" y2="${120 + r * rh}" stroke="${C.line}" stroke-width="2"/>`;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        b += `<rect x="${84 + c * cw}" y="${120 + r * rh + rh / 2 - 7}" width="${cw * (r === 0 ? 0.4 : 0.55 - ((r + c) % 3) * 0.1)}" height="14" rx="7" fill="${r === 0 ? C.soft : C.line}"/>`;
    return svg(w, h, b);
  }

  const SPECS = [
    ['季度营收', 1280, 720, bars],
    ['用户增长', 1600, 900, line],
    ['迁移流程', 1600, 600, flow],
    ['后台截图', 1440, 900, screen],
    ['现场照片', 1200, 800, scene],
    ['版本对比表', 1200, 900, table],
    ['留存曲线', 1280, 720, line],
    ['审批流程', 1600, 600, flow],
    ['设置页截图', 1440, 900, screen],
    ['渠道占比', 1000, 1000, bars],
    ['封面配图', 1080, 1440, scene],
    ['指标明细', 1200, 900, table],
    ['转化漏斗', 1280, 720, bars],
    ['部署拓扑', 1600, 600, flow],
    ['移动端截图', 900, 1200, screen],
    ['活动海报', 1080, 1440, scene],
    ['数据字典', 1200, 900, table],
    ['月度趋势', 1600, 900, line],
  ];

  window.FDM_MOCK_IMAGES = SPECS.map(([name, w, h, draw], i) => ({
    id: `img-${i + 1}`,
    name,
    src: draw(w, h, name, i + 2),
    width: w,
    height: h,
    bytes: Math.round(w * h * (0.11 + ((i * 37) % 9) / 100)),
  }));
})();
