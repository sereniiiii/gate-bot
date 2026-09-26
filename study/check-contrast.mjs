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

/* 哪些档位的日期字 / 格子里的标记被改成了主文字色，也从 app.css 里读 ——
   别在这里替它假设，否则把 CSS 那条规则删了脚本还说 PASS */
const lvUsingPrimary = (cls) =>
  new Set([...CSS.matchAll(new RegExp('\\.mo-d\\.lv(\\d)\\s+\\' + '.' + cls, 'g'))].map((m) => Number(m[1])));
const primaryLv = lvUsingPrimary('dn');
const dePrimaryLv = lvUsingPrimary('de');
const dlPrimaryLv = lvUsingPrimary('dl');
if (primaryLv.size) console.log('（app.css 中 lv' + [...primaryLv].join(' / lv') + ' 的日期字使用主文字色）');
if (!dePrimaryLv.size) {
  console.error('❌ app.css 里没有 .mo-d.lvN .de{color:var(--text-primary)} 这条 —— ' +
    '深色格子上「考108」这种小字会掉到 AA 以下');
  process.exit(1);
}
if (!dlPrimaryLv.size) {
  console.error('❌ app.css 里没有 .mo-d.lvN .dl{color:var(--text-primary)} 这条 —— ' +
    '深色格子上「截」这个标记会掉到 AA 以下');
  process.exit(1);
}
/* 两个标记必须同档提亮。少了任何一个都可能是因为加了一路新标记却只改了 .de ——
   那种漏改在浅色 lv3 上实测是 4.45:1，肉眼看不出来。 */
if ([...dePrimaryLv].sort().join() !== [...dlPrimaryLv].sort().join()) {
  console.error('❌ .de（考）和 .dl（截）的提亮档位不一致：de = lv' + [...dePrimaryLv].join('/lv') +
    '，dl = lv' + [...dlPrimaryLv].join('/lv') + '。格子里的标记要一起提亮。');
  process.exit(1);
}

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

/* 两套主题的色值**从 app.css 里现读**，不在这里抄一份：
   抄一份的话改了 app.css、脚本还拿旧值算 —— 2026-09-26 把浅色 --muted 从
   #898781 压到 #6e6c66 时先踩了一次，脚本报了一串假 FAIL。
   浅色取 :root{…}（第一段变量块），深色取 :root[data-theme="dark"]{…}
   （跟媒体查询那段的值是同一套，查一次就够）。 */
const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const varsFrom = (block) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
const VARS = {
  浅色: varsFrom((stripped.match(/:root\{([^}]*)\}/) || [, ''])[1]),
  深色: varsFrom((stripped.match(/:root\[data-theme="dark"\]\{([^}]*)\}/) || [, ''])[1]),
};
for (const [mode, V] of Object.entries(VARS)) {
  if (!V['--muted'] || !V['--page'] || !V['--surface-1'] || !V['--series-1'] || !V['--text-secondary']) {
    console.error(`❌ 没从 app.css 的${mode}变量块里读出 --muted / --page / --surface-1 / ` +
      `--series-1 / --text-secondary，变量块或选择器可能被改过`);
    process.exit(1);
  }
}
const MODES = {
  浅色: { s1: VARS.浅色['--series-1'], surface: VARS.浅色['--surface-1'],
          primary: VARS.浅色['--text-primary'], secondary: VARS.浅色['--text-secondary'] },
  深色: { s1: VARS.深色['--series-1'], surface: VARS.深色['--surface-1'],
          primary: VARS.深色['--text-primary'], secondary: VARS.深色['--text-secondary'] },
};

let bad = 0;
for (const [mode, M] of Object.entries(MODES)) {
  console.log(`\n【${mode}】`);
  const rows = [['无（无记录）', 0, 0], ...Object.entries(lvPct).map(([k, p]) => [
    `${k}（${p * 100}%）`, p, Number(k.slice(2)),
  ])];
  for (const [name, p, lv] of rows) {
    const bg = p ? mix(M.s1, M.surface, p) : hex(M.surface);
    const ink = primaryLv.has(lv) ? M.primary : M.secondary;
    const dInk = dePrimaryLv.has(lv) ? M.primary : M.secondary;
    const lInk = dlPrimaryLv.has(lv) ? M.primary : M.secondary;
    const r = ratio(hex(ink), bg), rv = ratio(hex(M.primary), bg);
    const re = ratio(hex(dInk), bg), rl = ratio(hex(lInk), bg);
    const okd = r >= 4.5, okv = rv >= 4.5, oke = re >= 4.5, okl = rl >= 4.5;
    if (!okd || !okv || !oke || !okl) bad++;
    console.log(`  ${name.padEnd(12)} 底 ${fmt(bg)}  日期字 ${r.toFixed(2)}:1 ${okd ? 'PASS' : 'FAIL'}` +
                `   考标记 ${re.toFixed(2)}:1 ${oke ? 'PASS' : 'FAIL'}` +
                `   截标记 ${rl.toFixed(2)}:1 ${okl ? 'PASS' : 'FAIL'}` +
                `   件数数字 ${rv.toFixed(2)}:1 ${okv ? 'PASS' : 'FAIL'}`);
  }
}

/* ── 除日历外，其它「小字压在底色上」的地方也一起查 ──────────────
   为什么加这一段：浅色模式下 --muted 当文字只有 3.50:1，这个坑已经踩过两次
   （.chip .cn 一次、.chip.done .ct 一次），都是靠人眼看出来的。 */

/* [选择器, 它压在哪个底色 token 上, 说明] */
const TEXT_ON = [
  ['.chip.done .ct', '--surface-1', 'chip 上已勾掉的章节名'],
  ['.chip .cn', '--surface-1', 'chip 右边的进度计数'],
  /* 校训两处底色不一样：登录页在卡片上（--surface-1），页头在页面底色上（--page）。
     --page 比 --surface-1 略深一档，所以两种都要单独算，别只算一种就放过。 */
  ['.motto', '--surface-1', '登录页那句校训'],
  ['.motto', '--page', '页头那句校训（压在页面底色上）'],
  /* 「↔ 同一件事」那一行。小标题没有自己的底色，压在小任务所在的卡片底（--page）上；
     每条已关联的 chip 自己铺了一层 --surface-1，按那一层算。 */
  ['.lks-h', '--page', '「↔ 同一件事」那行的小标题'],
  ['.lk', '--surface-1', '已关联的那条 chip'],
  /* 2026-09-26 把浅色的 --muted 压深之后补的这一组：这些选择器全是拿 --muted
     当**正文**用的（不是图表刻度那种装饰），原来压在 --page 上只有 3.50:1。
     同一段文字在卡片里和在页面底色上各查一次 —— 两个底色差一档，只算一种会漏。 */
  ['.sub', '--surface-1', '卡片副标题'],
  ['.sub', '--page', '页头那行「邮箱 · 已登录」'],
  ['.hint', '--surface-1', '表单/按钮下面的说明'],
  ['.hint', '--page', '挂在页面底色上的说明'],
  ['.item .m', '--page', '条目底下那行时间 / 来源'],
  ['.item .m', '--surface-1', '条目（卡片里那种）底下那行时间 / 来源'],
  ['.empty', '--surface-1', '空态那句「还没有…」'],
  ['.feed-item .mt', '--surface-1', '动态流每条下面的时间'],
  ['.pc-row .k', '--page', '主页人物卡的标签列'],
  ['.pc-row .q', '--page', '主页人物卡后面那句注解'],
  ['.entry .ed', '--surface-1', '入口卡片的一句说明'],
  ['.tile .k', '--page', '统计块上面那个小标签'],
  ['.mo-head span', '--page', '月历的星期表头'],
  ['.cd-head .cd-name', '--page', '倒计时分区头（今天 / 本周 / 以后）'],
  ['.cd-head .cd-n', '--page', '分区头右边那个「N 件」'],
  ['.cd-fold > summary', '--page', '「已完成 N 件」那个折叠头'],
  ['.exscore .fs', '--surface-1', '分数右边那行「满分」'],
  ['.who h3 .badge', '--page', '「我 / 对方」那个小标记'],
  ['.rg-head .rg-name', '--page', '资源列表的学科组名'],
  ['.rg-head .rg-n', '--page', '学科组头右边那个「N 个」'],
  ['.rk-head', '--page', '资源列表的类型小组名（色点旁边那行）'],
  ['.rk-head .rk-n', '--page', '类型小组右边那个个数'],
  /* ⚠️ 这条只保证 placeholder 用的 token 是 --muted、不是更浅的（换成别的 token 会红）；
     它**测不到** opacity —— 半透明是脚本算不出来的，那一层只能说好别加（见 app.css 里的注释）。 */
  ['.item .inline::placeholder', '--page', '就地编辑框里那句灰色提示（只保证 token 是 --muted）'],
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

/* ── 语义药丸：完成（绿）/ 逾期（红）/ 快到期（黄）───────────────
   三个都是「一层淡底 + 主文字色」，语义由**底色**承担，不染字。
   为什么要逐档实测、不能看着差不多就算：同色字压同色淡底实测全都不到 4.5:1 ——
   浅色 20% 底上绿字 4.87 勉强过、红字只有 3.23；深色 20% 底上红字 2.61。
   黄更极端：当字只有 1.84:1。「完成用绿」很自然会写 color:var(--good)，
   那就是这条守卫要拦的错法。百分比从 app.css 里读，改百分比会跟着重算。 */
console.log('\n【药丸：完成 / 逾期 / 快到期】');
for (const [name, tok, label] of [['ok', '--good', '已完成'],
                                  ['bad', '--critical', '逾期'],
                                  ['warn', '--warning', '快到期（3 天内）']]) {
  const sel = '.pill.' + name;
  const blk = (noComment.match(new RegExp('\\.pill\\.' + name + '\\s*\\{[^}]*\\}')) || [''])[0];
  const ink = inkToken(sel);
  const pctM = blk.match(new RegExp('var\\(' + tok + '\\)\\s+([\\d.]+)%'));
  /* 前面那个 (?:^|[;{\s]) 不能省：border-color:var(--warning) 里也含 "color:var(--warning)"，
     少了它这条守卫会在正确的 CSS 上误报（第一版就是这么错的）。
     border 那套已经不用了，但这条正则留着不碍事。 */
  const painted = new RegExp('(?:^|[;{\\s])color\\s*:\\s*var\\(' + tok + '\\)').test(blk);
  const solid = new RegExp('(?:^|[;{\\s])background\\s*:\\s*var\\(' + tok + '\\)').test(blk);
  if (solid) {
    console.error(`  ❌ ${sel} 的底铺成了满色 ${tok} —— 一整块红/绿太吵（语义色要克制）。` +
                  '底走 color-mix 掺成淡色。');
    bad++;
  } else if (painted) {
    console.error(`  ❌ ${sel} 把文字染成了 ${tok} —— 同色字压同色淡底达不到 AA。` +
                  '语义交给底色，字走 --text-primary。');
    bad++;
  } else if (!pctM || !ink) {
    console.error(`  ⚠️  没从 app.css 里解析出 ${sel} 的淡底百分比或字色（选择器被改过？）`);
    bad++;
  } else {
    const pct = Number(pctM[1]) / 100;
    for (const [mode, V] of Object.entries(VARS)) {
      if (!V[ink] || !V[tok] || !V['--chip']) {
        console.error(`  ⚠️  ${sel} 用了未知 token（字 ${ink} / 底 ${tok} / --chip）`); bad++; continue;
      }
      const bg = mix(V[tok], V['--chip'], pct);
      const r = ratio(hex(V[ink]), bg);
      const ok = r >= 4.5;
      /* 另一头也要看：底掺得太淡就等于没底，「浅色胶囊」看着跟正文一样了。
         阈值 1.2:1 是自定的（WCAG 没有这一档），只用来拦「调到 5% 底已经没了
         脚本还说 PASS」。药丸可能落在页面底也可能落在卡片底上，两边取更小的那个：
         浅色下卡片更亮、深色下卡片也更亮，方向相反，所以不能只算一种。 */
      const vis = Math.min(ratio(bg, hex(V['--page'])), ratio(bg, hex(V['--surface-1'])));
      const okv = vis >= 1.2;
      if (!ok || !okv) bad++;
      console.log(`  ${(mode + ' ' + sel).padEnd(22)} 淡底 ${fmt(bg)}（${tok} ${pct * 100}% + chip）  ` +
                  `字 ${r.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL'}   底色可辨 ${vis.toFixed(2)}:1 ` +
                  `${okv ? 'PASS' : '太淡'}   ${label}`);
    }
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
