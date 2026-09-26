/* 实测 weight/index.html 的「饮食 / 运动 / 睡眠」卡。
   真页面 + 真 DOM + 真 localStorage（无头 Chrome，不是假 DOM）。
   跑法（两步，静态服务由本脚本自己起，不用另开）：
     1. /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
          --headless --remote-debugging-port=9222 --user-data-dir=/tmp/w-chrome &
     2. /usr/local/bin/node test.mjs
   为什么不用假 DOM：这一卡碰的是 localStorage 的真实存盘结构、
   `input[type=date]` 的 change 派发、以及 alert 挡住写入这几条，
   假 DOM 全都测不出来（study/ 那边有假 DOM 的测试台，这里是另一套）。 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // 不写死路径，挪目录也不会坏
const PORT = 8793;
const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('x'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(d);
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise((r) => ws.addEventListener('open', r));

const dialogs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    send('Page.handleJavaScriptDialog', { accept: true, promptText: 'x' });  // 不自动接管会挂住 evaluate
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
await send('Page.enable'); await send('Runtime.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
// setDeviceMetricsOverride 挂在 target 上不自动清，每次都显式设宽，别继承上一轮的残留
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1400, deviceScaleFactor: 2, mobile: false });

const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(1500);
await ev(`localStorage.clear()`);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(1500);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
};

console.log('innerWidth=' + await ev('window.innerWidth'));

/* 页面里现成的交互入口 —— 用真的 click()，不是直接改 state */
const addMeal = (food, kcal) => ev(`(() => {
  document.getElementById('hb-food').value = ${JSON.stringify(food)};
  document.getElementById('hb-kcal').value = ${JSON.stringify(kcal)};
  document.getElementById('hb-add-meal').click();
  return 1;
})()`);
const addEx = (type, min) => ev(`(() => {
  document.getElementById('hb-ex').value = ${JSON.stringify(type)};
  document.getElementById('hb-min').value = ${JSON.stringify(min)};
  document.getElementById('hb-add-ex').click();
  return 1;
})()`);
const saveSleep = (h) => ev(`(() => {
  document.getElementById('hb-sleep').value = ${JSON.stringify(h)};
  document.getElementById('hb-save-sleep').click();
  return 1;
})()`);
const rows = () => ev(`[...document.querySelectorAll('#hb-body tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()))`);
const stored = () => ev(`JSON.parse(localStorage.getItem('weight-tracker.v1'))`);
const tileText = () => ev(`[...document.querySelectorAll('#tiles .tile')].map(t => t.querySelector('.k').textContent + '|' + t.querySelector('.v').textContent + '|' + (t.querySelector('.d') ? t.querySelector('.d').textContent : ''))`);

/* 基线：库全空的时候跑一次结算，「连续未记录」是多少天。
   一会儿记完饮食再跑一次，数字必须**一模一样** —— 这才是「记饭顶不掉称重」的真断言。
   （空库时页面本来就会报出一个很大的天数，那是 missStreak() 的 guard 上限，既有行为。） */
const settleExpr = (pick) => `(() => {
  document.getElementById('btn-settle').click();
  const t = document.getElementById('settle-out').textContent;
  return ${pick};
})()`;
const missBase = await ev(settleExpr('(t.match(/连续 (\\d+) 天未记录/) || [])[1]'));

console.log('\n── 空态 ──');
ok('刚打开时是空态', (await ev(`document.getElementById('hb-body').textContent`)).includes('还没记饮食'));
ok('日期药丸显示今天', (await ev(`document.getElementById('hb-pill').textContent`)) === await ev(`(()=>{const d=new Date();const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()`));

console.log('\n── 饮食：填了热量 ──');
await addMeal('一碗牛肉面', '600');
let r = await rows();
ok('加了一条饮食', r.length === 1, r);
ok('内容带热量', r[0][1] === '一碗牛肉面 · 600 千卡', r[0]);
ok('小计 600 千卡', r[0][2] === '600 千卡', r[0]);
ok('第一行写着「饮食」', r[0][0] === '饮食', r[0]);
ok('输入框已清空', (await ev(`document.getElementById('hb-food').value`)) === '');
ok('光标回到食物框（连记不用够鼠标）', (await ev(`document.activeElement.id`)) === 'hb-food');

console.log('\n── 饮食：不填热量（空 ≠ 0） ──');
await addMeal('一杯拿铁', '');
r = await rows();
ok('变成两行', r.length === 2, r);
ok('第二行写「未填热量」而不是 0', r[1][1] === '一杯拿铁 · 未填热量', r[1]);
ok('第二行不重复写「饮食」', r[1][0] === '', r[1]);
ok('小计只加填了的，并说明有 1 条没填', r[0][2] === '600 千卡（另有 1 条没填）', r[0]);

console.log('\n── 运动 ──');
await addEx('快走', '40');
r = await rows();
ok('多出运动那一行', r.length === 3, r);
ok('运动内容 = 类型 · 时长', r[2][1] === '快走 · 40 分钟', r[2]);
ok('运动小计 40 分钟', r[2][2] === '40 分钟', r[2]);
ok('运动缺时长会被挡（类型必填先过）', await (async () => {
  await addEx('力量', '');
  const after = await rows();
  const dlg = dialogs[dialogs.length - 1] || '';
  return after.length === 3 && dlg.includes('时长');
})(), dialogs.slice(-1));

console.log('\n── 睡眠 ──');
await saveSleep('7.5');
r = await rows();
ok('多出睡眠那一行', r.length === 4, r);
ok('睡眠内容 = n 小时', r[3][1] === '7.5 小时', r[3]);
ok('睡眠没有小计（一天一个数）', r[3][2] === '', r[3]);
ok('睡眠框回填已记的值', (await ev(`document.getElementById('hb-sleep').value`)) === '7.5');

console.log('\n── 存盘结构 ──');
const st = await stored();
const d0 = Object.keys(st.entries)[0];
const e0 = st.entries[d0];
ok('只有今天这一天的 entry', Object.keys(st.entries).length === 1, Object.keys(st.entries));
ok('meals 两条', Array.isArray(e0.meals) && e0.meals.length === 2, e0.meals);
ok('没填热量的那条 kcal 是 null（不是 0）', e0.meals[1].kcal === null, e0.meals[1]);
ok('exercises 一条', Array.isArray(e0.exercises) && e0.exercises.length === 1, e0.exercises);
ok('sleep 是数字 7.5', e0.sleep === 7.5, e0.sleep);
ok('**没有**被写出一个 weight（记饭 ≠ 称重）', !('weight' in e0), e0);

console.log('\n── 关键口径：这一块不能影响惩罚判定 ──');
const tiles = await tileText();
const tw = tiles.find((x) => x.startsWith('今日体重'));
ok('「今日体重」子标题仍是「今天还没记录」', tw.includes('今天还没记录'), tw);
const ts = tiles.find((x) => x.startsWith('连续记录'));
ok('「连续记录」仍是 0 天（记饮食不算记录）', ts.includes('|0天|'), ts);
ok('7 日均线仍是 —', (tiles.find((x) => x.startsWith('7 日均线')) || '').includes('—'));
const missNow = await ev(settleExpr('(t.match(/连续 (\\d+) 天未记录/) || [])[1]'));
ok('记了一堆饮食运动，缺记录天数跟空库时**一模一样**（这卡不参与判定）',
   missNow === missBase && missBase !== undefined, { missBase, missNow });

console.log('\n── 切日期 ──');
await ev(`(() => { const el = document.getElementById('in-date');
  el.value = '${await ev(`(() => { const d=new Date(); d.setDate(d.getDate()-1); const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()) })()`)}';
  el.dispatchEvent(new Event('change')); return 1; })()`);
ok('切到昨天后回到空态', (await ev(`document.getElementById('hb-body').textContent`)).includes('还没记饮食'));
ok('切到昨天后睡眠框是空的（不是 7.5）', (await ev(`document.getElementById('hb-sleep').value`)) === '');
await ev(`(() => { const el = document.getElementById('in-date');
  const d=new Date(); const p=n=>String(n).padStart(2,'0');
  el.value = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
  el.dispatchEvent(new Event('change')); return 1; })()`);
ok('切回今天，四条又都回来了', (await rows()).length === 4);

console.log('\n── 删除 ──');
await ev(`[...document.querySelectorAll('#hb-body tbody tr')][0].querySelector('button').click()`);
r = await rows();
ok('删掉牛肉面后剩三行', r.length === 3, r);
ok('拿铁顶上「饮食」那一格 + 小计变「—」（一条都没填热量）', r[0][0] === '饮食' && r[0][2] === '—', r[0]);
ok('库里 meals 只剩一条', (await stored()).entries[d0].meals.length === 1);

console.log('\n── 未来日期要被挡住 ──');
const tmr = await ev(`(() => { const d=new Date(); d.setDate(d.getDate()+1); const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()) })()`);
dialogs.length = 0;
await ev(`(() => { const el = document.getElementById('in-date'); el.value = '${tmr}'; el.dispatchEvent(new Event('change')); return 1; })()`);
await addMeal('明天的饭', '500');
ok('弹了「不能录未来的日期」', (dialogs[dialogs.length - 1] || '').includes('未来'), dialogs.slice(-1));
ok('未来日期没写进库', !(await stored()).entries[tmr]);

console.log('\n── 边界：清空睡眠 = 撤销 ──');
await ev(`(() => { const el = document.getElementById('in-date');
  const d=new Date(); const p=n=>String(n).padStart(2,'0');
  el.value = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
  el.dispatchEvent(new Event('change')); return 1; })()`);
await saveSleep('');
ok('睡眠框空着点「记下」= 删掉睡眠记录', !('sleep' in (await stored()).entries[d0]));
ok('界面上睡眠那行没了', !(await rows()).some((x) => x[0] === '睡眠'));

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotPath = path.join(os.tmpdir(), 'weight-habits.png');
fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
console.log('\n📷 ' + shotPath);

console.log('\n' + (fail ? '❌ ' + fail + ' 条没过' : '✅ 全部通过') + '（共 ' + (pass + fail) + ' 条）');
ws.close(); srv.close();
process.exit(fail ? 1 : 0);
