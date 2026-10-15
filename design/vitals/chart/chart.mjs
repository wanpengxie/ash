// A2UI 卡片部件 `Chart`（Ash 扩展）的参考几何 + 网页渲染。
// - 小组件：手机按同样的几何画成位图（AshChart.kt），尺寸用小组件的真实 dp × 屏幕密度，暗色时重画。
// - 网页（应用页面）：chartSvg(component, w, h) 直接出 SVG；颜色用 CSS 变量，跟主题走。
// - 两边对数：vectors.json（node chart/make-vectors.mjs 生成）。
// 设计稿（画布「她的状态」）的小图就是这份几何画的。单位都是 dp（网页里 = CSS px）。

export const CHART = {
  lineWidth: 1.6,     // 折线默认线宽；高亮段 +0.4
  areaAlpha: 0.16,    // fill: true 时，线下面积用同色 16%
  dot: 2.4,           // 最后一个点的半径（dot 默认 true）
  pad: 2,             // 折线上下各留 2，线不贴边；柱不留
  limitWidth: 1,      // 上限虚线
  limitDash: [2, 3],
  barRadius: 2,       // 柱圆角，不超过柱宽一半
  barMin: 2,          // 柱最矮 2，0 也看得见
  gap: 2,             // 柱间距默认值
};

const r1 = (n) => Math.round(n * 10) / 10;

/** 一组数据的纵轴下限：给了 min 用 min（低于它的值落在底上），否则 0。 */
export const scaleMin = (series) => (typeof series.min === 'number' ? series.min : 0);

/**
 * 一组数据的纵轴上限：给了 max 用 max；否则 max(floor, min + (最大值 − min) × 1.25)；floor 默认 0，min 默认 0；
 * 算出来不高于 min 时（全是 0、全在 min 以下）为 min + 1。
 */
export function scaleMax(series) {
  if (typeof series.max === 'number') return series.max;
  const min = scaleMin(series);
  const top = Math.max(series.floor ?? 0, min + Math.max(0, Math.max(min, ...series.values) - min) * 1.25);
  return top > min ? top : min + 1;
}

/** v 在 [min, max] 这根轴上的高度比例（0..1），轴外的夹到两头。 */
const frac = (v, max, min) => (max > min ? (Math.min(Math.max(v, min), max) - min) / (max - min) : 0);

/** 折线的点：x 均分铺满宽度，y 上下各留 pad；值夹在 [min, max]。 */
export function linePoints(values, w, h, max, min = 0) {
  const n = values.length;
  return values.map((v, i) => [r1(n === 1 ? w : (i / (n - 1)) * w), r1(h - CHART.pad - frac(v, max, min) * (h - CHART.pad * 2))]);
}
/** 柱：等宽、间距 gap；从轴底 min 往上长。 */
export function barRects(values, w, h, max, gap = CHART.gap, min = 0) {
  const n = values.length, bw = (w - gap * (n - 1)) / n;
  return values.map((v, i) => { const bh = Math.max(CHART.barMin, frac(v, max, min) * h); return { x: r1(i * (bw + gap)), y: r1(h - bh), w: r1(bw), h: r1(bh) }; });
}
/** 上限虚线的 y：折线留 pad，柱不留。 */
export const limitY = (value, h, max, type, min = 0) => r1(type === 'bars' ? h - frac(value, max, min) * h : h - CHART.pad - frac(value, max, min) * (h - CHART.pad * 2));

/**
 * 一张图的几何（网页和原生都按这个画）。component 是 A2UI `Chart`：
 *   { series: [ { type: "line"|"bars", values, color, fill?, width?, dot?, max?, floor?, min?,
 *                 highlight?: {from, to?, color}, colors?: {"<i>": color}, lastColor?, limit?, limitColor? } ], gap? }
 * 返回按画的顺序排好的图元：{kind: "area"|"line"|"bar"|"limit"|"dot", ...}。颜色原样带出，由调用方解析。
 */
export function layout(component, w, h) {
  const out = [];
  for (const s of component.series) {
    const max = scaleMax(s), min = scaleMin(s), n = s.values.length;
    if (s.type === 'bars') {
      barRects(s.values, w, h, max, component.gap ?? CHART.gap, min).forEach((r, i) => {
        const color = (s.colors && s.colors[i]) || (i === n - 1 && s.lastColor) || s.color;
        out.push({ kind: 'bar', ...r, r: Math.min(CHART.barRadius, r.w / 2), color });
      });
    } else {
      const pts = linePoints(s.values, w, h, max, min), width = s.width ?? CHART.lineWidth;
      const seg = (a, b) => pts.slice(a, b);
      if (s.fill) out.push({ kind: 'area', points: pts, color: s.color, alpha: CHART.areaAlpha });
      out.push({ kind: 'line', points: pts, color: s.color, width });
      let dotColor = s.color;
      if (s.highlight) {
        const b = s.highlight.to === undefined ? n : s.highlight.to + 1;
        if (s.fill) out.push({ kind: 'area', points: seg(s.highlight.from, b), color: s.highlight.color, alpha: CHART.areaAlpha });
        out.push({ kind: 'line', points: seg(s.highlight.from, b), color: s.highlight.color, width: r1(width + 0.4) });
        if (s.highlight.to === undefined) dotColor = s.highlight.color;
      }
      if (s.dot !== false) out.push({ kind: 'dot', x: pts[n - 1][0], y: pts[n - 1][1], r: CHART.dot, color: dotColor });
    }
    if (typeof s.limit === 'number') out.push({ kind: 'limit', y: limitY(s.limit, h, max, s.type, min), x1: 0, x2: w, width: CHART.limitWidth, dash: CHART.limitDash, color: s.limitColor || 'gray' });
  }
  // 虚线和点画在最上面
  return [...out.filter((p) => p.kind !== 'limit' && p.kind !== 'dot'), ...out.filter((p) => p.kind === 'limit'), ...out.filter((p) => p.kind === 'dot')];
}

/** 网页渲染。color(c) 把颜色（令牌名 / 卡片颜色名 / {light,dark}）变成 CSS 颜色；默认把字符串当令牌名：var(--name)。 */
export function chartSvg(component, w, h, color = (c) => (typeof c === 'string' ? `var(--${c})` : c.light)) {
  const s = layout(component, w, h).map((p) => {
    switch (p.kind) {
      case 'bar': return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.r}" fill="${color(p.color)}"/>`;
      case 'area': return `<path d="M${p.points.map((q) => q.join(',')).join('L')}L${p.points.at(-1)[0]},${h}L${p.points[0][0]},${h}Z" fill="${color(p.color)}" opacity="${p.alpha}"/>`;
      case 'line': return `<path d="M${p.points.map((q) => q.join(',')).join('L')}" fill="none" stroke="${color(p.color)}" stroke-width="${p.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
      case 'limit': return `<line x1="${p.x1}" x2="${p.x2}" y1="${p.y}" y2="${p.y}" stroke="${color(p.color)}" stroke-width="${p.width}" stroke-dasharray="${p.dash.join(' ')}"/>`;
      case 'dot': return `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${color(p.color)}"/>`;
    }
  }).join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${s}</svg>`;
}

/** 小格子里 60 根柱太细：每 k 个并成一根，取最大。 */
export const bucket = (values, k = 3) => Array.from({ length: Math.ceil(values.length / k) }, (_, i) => Math.max(...values.slice(i * k, i * k + k)));
