// node design/app/vitals/chart/make-vectors.mjs → vectors.json：输入一张 Chart + 宽高（dp），期望的图元（坐标保留 1 位小数）。
// 原生 AshChart.layout(...) 对同样的输入要得到同样的图元（单测里逐个比，允许 ±0.05）。
import { writeFileSync } from 'node:fs';
import { layout } from './chart.mjs';
const C = (name) => name; // 颜色原样带出，测试只比几何和颜色引用
const cases = [
  { name: '折线 · 自动纵轴 · 下限 15', w: 64, h: 30, chart: { series: [{ type: 'line', values: [1, 2, 4, 13, 3, 2], color: C('her-fill'), fill: true, floor: 15 }] } },
  { name: '折线 · 正在越界 · 上限虚线', w: 64, h: 30, chart: { series: [{ type: 'line', values: [2, 1, 2, 30, 38, 36], color: C('her-fill'), fill: true, max: 47.5, highlight: { from: 3, color: C('err-fill') }, limit: 5, limitColor: C('text-3') }] } },
  { name: '折线 · 已经过去的一段', w: 64, h: 30, chart: { series: [{ type: 'line', values: [2, 3, 30, 35, 3, 2], color: C('her-fill'), max: 43.8, highlight: { from: 2, to: 3, color: C('warn-fill') } }] } },
  { name: '柱 · 最后一根换色', w: 121, h: 30, chart: { series: [{ type: 'bars', values: [2.1, 3.8, 2.6, 4.9, 1.6, 3.0, 3.42], color: C('surface-3'), lastColor: C('you-mark') }], gap: 3 } },
  { name: '柱 · 指定几根 + 虚线 + 0 值', w: 64, h: 30, chart: { series: [{ type: 'bars', values: [0, 4, 8, 44, 46], color: C('her-fill'), max: 57.5, colors: { 3: C('err-fill'), 4: C('err-fill') }, limit: 30, limitColor: C('text-3') }], gap: 1 } },
  { name: '两组 · 柱在下线在上（4×4 大图）', w: 302, h: 84, chart: { series: [{ type: 'bars', values: [3, 8, 14, 6], color: C('surface-3'), max: 32 }, { type: 'line', values: [2, 6, 13, 4], color: C('her-fill'), width: 2, max: 16.3 }], gap: 1.2 } },
  { name: '折线 · 纵轴从 min 起 · 上限虚线', w: 64, h: 30, chart: { series: [{ type: 'line', values: [61.2, 60.8, 61.5, 60.4, 60.9], color: C('her-fill'), fill: true, min: 58, limit: 61, limitColor: C('text-3') }] } },
  { name: '柱 · min 以下落在底上 · floor 更低', w: 64, h: 30, chart: { series: [{ type: 'bars', values: [5, 12, 18, 9, 3], color: C('her-fill'), min: 6, floor: 20 }], gap: 2 } },
  { name: '全是 0', w: 64, h: 30, chart: { series: [{ type: 'line', values: [0, 0, 0], color: C('her-fill') }] } },
];
const out = cases.map((c) => ({ ...c, expect: layout(c.chart, c.w, c.h) }));
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(out.length, 'cases', out.reduce((n, c) => n + c.expect.length, 0), 'primitives');
