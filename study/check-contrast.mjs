/* 月行程表色阶的对比度自检。
   跑法：node study/check-contrast.mjs
   退出码 0 = 全部达标，1 = 有格子上的文字看不清。

   为什么要有这个文件：日历格子靠「颜色深浅」表示那天推进了几件事，
   底色越深，压在它上面的文字就越难看清。这不是能靠眼睛估的东西 ——
   实测过 lv3 在浅色模式下日期数字只有 4.45:1，比 WCAG AA 的 4.5:1 差一点，
   所以把 lv2 以上的日期字改成了主文字色。改色阶百分比之后请重跑本脚本。 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');

/* 色阶百分比直接从 app.css 里读，避免脚本和样式各写一份、改了一边忘了另一边 */
const lvPct = {};
for (const m of CSS.matchAll(/\.mo-d\.lv(\d)\s*\{[^}]*?var\(--series-1\)\s+([\d.]+)%/g)) {
  lvPct['lv' + m[1]] = Number(m[2]) / 100;   // CSS 里写的是 12%，当小数用
}
if (!Object.keys(lvPct).length) {
  console.error('❌ 没从 app.css 里解析出 .mo-d.lvN 的色阶百分比，选择器可能被改过');
  process.exit(1);
}

/* 哪些档位的日期字被改成了主文字色，也从 app.css 里读 ——
   别在这里替它假设，否则把 CSS 那条规则删了脚本还说 PASS */
const primaryLv = new Set([...CSS.matchAll(/\.mo-d\.lv(\d)\s+\.dn/g)].map((m) => Number(m[1])));
if (primaryLv.size) console.log('（app.css 中 lv' + [...primaryLv].join(' / lv') + ' 的日期字使用主文字色）');

const hex = (s) => { s = s.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
/* color-mix(in srgb, A p%, B)：在 sRGB 伽马空间线性插值 */
const mix = (a, b, p) => hex(a).map((v, i) => Math.round(v * p + hex(b)[i] * (1 - p)));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (f, b) => {
  const a = lum(f), c = lum(b);
  const [hi, lo] = a > c ? [a, c] : [c, a];
  return (hi + 0.05) / (lo + 0.05);
};
const fmt = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/* 取自 app.css 的两套主题变量 */
const MODES = {
  浅色: { s1: '#2a78d6', surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e' },
  深色: { s1: '#3987e5', surface: '#1a1a19', primary: '#ffffff', secondary: '#c3c2b7' },
};

let bad = 0;
for (const [mode, M] of Object.entries(MODES)) {
  console.log(`\n【${mode}】`);
  const rows = [['无（无记录）', 0, M.secondary], ...Object.entries(lvPct).map(([k, p]) => [
    `${k}（${p * 100}%）`, p, primaryLv.has(Number(k.slice(2))) ? M.primary : M.secondary,
  ])];
  for (const [name, p, ink] of rows) {
    const bg = p ? mix(M.s1, M.surface, p) : hex(M.surface);
    const r = ratio(hex(ink), bg), rv = ratio(hex(M.primary), bg);
    const okd = r >= 4.5, okv = rv >= 4.5;
    if (!okd || !okv) bad++;
    console.log(`  ${name.padEnd(12)} 底 ${fmt(bg)}  日期字 ${r.toFixed(2)}:1 ${okd ? 'PASS' : 'FAIL'}` +
                `   件数数字 ${rv.toFixed(2)}:1 ${okv ? 'PASS' : 'FAIL'}`);
  }
}

/* ── 除日历外，其它「小字压在底色上」的地方也一起查 ──────────────
   为什么加这一段：浅色模式下 --muted 当文字只有 3.50:1，这个坑已经踩过两次
   （.chip .cn 一次、.chip.done .ct 一次），都是靠人眼看出来的。
   颜色 token 从 app.css 里读、不写死在这里 —— 写死的话把 CSS 改坏了脚本还报 PASS。 */
const VARS = {
  浅色: { '--surface-1': '#fcfcfb', '--page': '#f9f9f7', '--chip': '#f2f1ed',
          '--text-primary': '#0b0b0b', '--text-secondary': '#52514e', '--muted': '#898781' },
  深色: { '--surface-1': '#1a1a19', '--page': '#0d0d0d', '--chip': '#242422',
          '--text-primary': '#ffffff', '--text-secondary': '#c3c2b7', '--muted': '#898781' },
};
/* [选择器, 它压在哪个底色 token 上, 说明] */
const TEXT_ON = [
  ['.chip.done .ct', '--surface-1', 'chip 上已勾掉的章节名'],
  ['.chip .cn', '--surface-1', 'chip 右边的进度计数'],
];
const noComment = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
/* 取某个选择器块里 color:var(--x) 的 token 名 */
function inkToken(sel) {
  const i = noComment.indexOf(sel + '{');
  if (i < 0) return null;
  const body = noComment.slice(i, noComment.indexOf('}', i));
  const m = body.match(/(?:^|[;{\s])color\s*:\s*var\((--[\w-]+)\)/);
  return m ? m[1] : null;
}

console.log('\n【其它小字】');
for (const [sel, bgTok, label] of TEXT_ON) {
  const tok = inkToken(sel);
  if (!tok) { console.log(`  ⚠️  ${sel} 没解析到 color:var(...) （选择器被改了？）`); bad++; continue; }
  for (const [mode, V] of Object.entries(VARS)) {
    if (!V[tok] || !V[bgTok]) { console.log(`  ⚠️  ${sel} 用了未知 token ${tok} / ${bgTok}`); bad++; continue; }
    const r = ratio(hex(V[tok]), hex(V[bgTok]));
    const okd = r >= 4.5;
    if (!okd) bad++;
    console.log(`  ${(mode + ' ' + sel).padEnd(24)} ${tok} 压在 ${bgTok} 上  ` +
                `${r.toFixed(2)}:1 ${okd ? 'PASS' : 'FAIL'}   ${label}`);
  }
}

/* 反向守卫：来源标记那颗点必须是**色块**，不能把文字染成 series-3 ——
   实测那样在浅色 chip 底上只有 2.49:1。 */
if (/(^|[},])\s*\.pill\.res\s*\{[^}]*color\s*:/.test(noComment)) {
  console.log('  ❌ .pill.res 又把文字染成系列色了（浅色底上只有 2.49:1）。' +
              '身份该由 ::before 那颗小色点承担。');
  bad++;
}

console.log(bad ? `\n❌ 有 ${bad} 处低于 WCAG AA 的 4.5:1` : '\n✅ 全部达到 WCAG AA（≥ 4.5:1）');
process.exit(bad ? 1 : 0);
