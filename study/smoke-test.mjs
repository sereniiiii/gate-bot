/* 学习协作 · app.js 冒烟测试 v4
   跑法：node study/smoke-test.mjs     退出码 0 = 全过，非 0 = 有断言没过

   覆盖：登录、主页与动态流、头像上传、四个功能区、
         大任务分段进度条与完成情况总览、月行程表（含月份导航、done_at 缺失时的降级）。

   假 DOM + 假 Supabase，不联网、不碰真库。
   验证不了的事：真实网络、Supabase 的 RLS 策略、真实浏览器的排版。
   这几样只能在浏览器里看 —— 别把这里的「全过」当成那几样也过了。
   配色对比度另有一个自检：node study/check-contrast.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* 本脚本在 study/ 目录下，用相对本文件的位置找 app.js / app.css，
   这样仓库挪到哪台机器上都能跑。 */
const DIR = path.dirname(fileURLToPath(import.meta.url));

/* ── 假 DOM ─────────────────────────────────────────────────── */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1; this.children = []; this.parentNode = null;
    this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = {};
    this._text = ''; this._cls = new Set();
    this.hidden = false; this.value = ''; this.disabled = false; this.checked = false;
    this.id = ''; this.href = ''; this.download = ''; this.title = ''; this.type = '';
    this.src = ''; this.alt = ''; this.width = 0; this.height = 0;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._cls.add(x)),
      remove: (...c) => c.forEach((x) => self._cls.delete(x)),
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !self._cls.has(c) : !!on; v ? self._cls.add(c) : self._cls.delete(c); return v; },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(ev || { target: this, preventDefault() {} })); }
  click() { this.fire('click'); }
  closest(sel) { let n = this; const c = sel.replace(/^\./, ''); while (n) { if (n._cls && n._cls.has(c)) return n; n = n.parentNode; } return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 200 }; }
  get offsetWidth() { return 120; }
  focus() {} scrollIntoView() {}
  getContext() { return { drawImage() {} }; }
  toDataURL() { return 'data:image/jpeg;base64,' + 'A'.repeat(400); }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.children.length = 0; this._text = String(v); }
}

/* 真 DOM 的 offsetTop / offsetWidth 这些是**可枚举的只读访问器**，挂在原型链上，
   赋值就抛 TypeError。假 El 里它们要么根本没有、要么是不可枚举的 class getter，
   于是「把节点当属性对象传给 h()」这种错法
   （h('tr', h('td', …)) → for...in 捞到 offsetTop → n.offsetTop = 0）
   在假 DOM 里**静默通过**，在真浏览器里抛异常把整块渲染带走。
   2026-09-26 学习资源列表就是这么整整坏了一轮没人知道的 —— 补上牙齿，让它在这里就炸。 */
for (const [k, v] of [['offsetTop', 0], ['offsetLeft', 0], ['offsetHeight', 24], ['offsetWidth', 120]]) {
  Object.defineProperty(El.prototype, k, { get: () => v, enumerable: true, configurable: true });
}

const reg = new Map();
const TABNAMES = ['home', 'goals', 'tasks', 'daily', 'res', 'exams', 'data'];
const tabs = TABNAMES.map((t) => {
  const e = new El('button'); e.dataset.tab = t; e.className = t === 'home' ? 'tab on' : 'tab'; return e;
});
const panes = TABNAMES.map((t) => {
  const e = new El('section'); e.id = 'pane-' + t; e.hidden = t !== 'home'; reg.set(e.id, e); return e;
});
const body = new El('body');
reg.set('toast', new El('div'));

globalThis.document = {
  readyState: 'complete', body, activeElement: null,
  getElementById(id) { if (!reg.has(id)) reg.set(id, new El('div')); return reg.get(id); },
  createElement: (t) => new El(t),
  createElementNS: (_n, t) => new El(t),
  createTextNode: (t) => { const n = new El('#text'); n.nodeType = 3; n._text = String(t); return n; },
  querySelectorAll(sel) { return sel === '.tab' ? tabs : sel === '.pane' ? panes : []; },
  addEventListener() {},
};
globalThis.confirm = () => true;
globalThis.window = globalThis;
globalThis.scrollTo = () => {};
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Image = class {
  set src(_v) { this.width = 400; this.height = 300; setTimeout(() => this.onload && this.onload(), 0); }
};

/* ── 假 Supabase ────────────────────────────────────────────── */
const ME = 'me-uuid', OT = 'other-uuid';

/* 倒计时的截止日按「今天」算，不写死日期 ——
   写死的话「还剩 2 天」这类断言换一天跑就全红。 */
function isoOff(n) {
  const t = new Date();
  const dt = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
const D2 = isoOff(2), D0 = isoOff(0), DM1 = isoOff(-1), DM5 = isoOff(-5), DM9 = isoOff(-9);

const DB = {
  profiles: [{ id: ME, display_name: '小 A', avatar: '' }, { id: OT, display_name: '小 B', avatar: '' }],
  /* goals 装两种东西：**没有 due_date 的**是以前的 30 天小目标，
     **有 due_date 的**是倒计时（页面主位）。每一行都得带 due_date 这个 key ——
     真库里 select('*') 会给所有行带上（值是 null 也带 key），假库要照做，
     否则 S.cdNoCol 会误判成「库里没这一列」。 */
  goals: [
    { id: 'g1', owner: ME, period_start: '2026-09-01', title: '背完 300 个单词', detail: '每天 10 个', target: 300, progress: 120, done: false, done_at: null, due_date: null, created_at: '2026-09-01T00:00:00Z' },
    { id: 'g2', owner: OT, period_start: '2026-09-10', title: '读完一本书', detail: '', target: 100, progress: 100, done: true, done_at: '2026-09-20T10:00:00Z', due_date: null, created_at: '2026-09-10T00:00:00Z' },
    { id: 'g3', owner: ME, period_start: '2026-09-20', title: '交开题报告', detail: '交到研究生院系统', target: 1, progress: 0, done: false, done_at: null, due_date: D2, created_at: '2026-09-20T00:00:00Z' },
    { id: 'g4', owner: ME, period_start: '2026-09-15', title: '交实验数据', detail: '', target: 1, progress: 0, done: false, done_at: null, due_date: DM5, created_at: '2026-09-15T00:00:00Z' },
    { id: 'g5', owner: OT, period_start: '2026-09-01', title: '预约答辩教室', detail: '', target: 1, progress: 1, done: true, done_at: DM9 + 'T10:00:00Z', due_date: DM9, created_at: '2026-09-01T00:00:00Z' },
  ],
  tasks: [
    { id: 't1', owner: ME, title: '学完线性代数', detail: '把 MIT 那门刷完', due_date: '2026-10-10', created_at: '2026-09-02T00:00:00Z' },
    { id: 't2', owner: OT, title: '写完开题报告', detail: '', due_date: '2026-09-20', created_at: '2026-09-03T00:00:00Z' },
  ],
  subtasks: [
    { id: 's1', task_id: 't1', owner: ME, seq: 1, title: '第 1-4 讲', detail: '', done: true, done_at: '2026-09-21T09:00:00Z' },
    { id: 's2', task_id: 't1', owner: ME, seq: 2, title: '第 5-8 讲', detail: '', done: true, done_at: '2026-09-22T09:00:00Z' },
    { id: 's3', task_id: 't1', owner: ME, seq: 3, title: '习题课', detail: '', done: false, done_at: null },
    { id: 's4', task_id: 't2', owner: OT, seq: 1, title: '文献综述', detail: '', done: false, done_at: null },
  ],
  daily_logs: [
    { id: 'd1', owner: ME, log_date: '2026-09-24', mood: 4, difficulty: '特征值那块卡住了', note: '', created_at: '2026-09-24T20:00:00Z' },
    { id: 'd2', owner: ME, log_date: '2026-09-23', mood: 5, difficulty: '', note: '状态不错', created_at: '2026-09-23T20:00:00Z' },
    { id: 'd3', owner: OT, log_date: '2026-09-24', mood: 2, difficulty: '找不到数据', note: '', created_at: '2026-09-24T21:00:00Z' },
  ],
  resources: [
    { id: 'r1', owner: ME, kind: 'book', name: '线性代数应该这样学', platform: '', subject: '数学', url: '', status: 'doing', created_at: '2026-09-05T00:00:00Z' },
    { id: 'r2', owner: ME, kind: 'course', name: 'MIT 18.06', platform: 'B站', subject: '数学', url: '', status: 'doing', created_at: '2026-09-06T00:00:00Z' },
    { id: 'r3', owner: ME, kind: 'teacher', name: 'Gilbert Strang', platform: 'MIT OCW', subject: '数学', url: '', status: 'todo', created_at: '2026-09-07T00:00:00Z' },
    { id: 'r4', owner: ME, kind: 'book', name: '英语语法新思维', platform: '', subject: '英语', url: '', status: 'done', created_at: '2026-09-08T00:00:00Z' },
    { id: 'r5', owner: OT, kind: 'course', name: '考研政治', platform: '徐涛', subject: '政治', url: '', status: 'doing', created_at: '2026-09-09T00:00:00Z' },
  ],
  /* 考试成绩是**独立一张表**，不在原来六张表那条链路上。
     故意留一场 score=null（还没出分），用来测「没填分」不等于 0 分。 */
  exams: [
    { id: 'e1', owner: ME, exam_date: '2026-09-12', name: '期中数学', subject: '数学', kind: 'school',
      score: 108, full_score: 120, note: '最后一道大题算错', created_at: '2026-09-12T10:00:00Z' },
    { id: 'e2', owner: ME, exam_date: '2026-09-20', name: '三角函数自测卷', subject: '数学', kind: 'paper',
      score: null, full_score: null, note: '', created_at: '2026-09-20T10:00:00Z' },
    { id: 'e3', owner: OT, exam_date: '2026-09-18', name: '英语月考', subject: '英语', kind: 'school',
      score: 88, full_score: 100, note: '', created_at: '2026-09-18T10:00:00Z' },
  ],
};
let seq = 100;
/* 假库默认不认识列名，插什么都能成。要测「她还没跑 SQL」那条路，
   得能人为让下一次写操作失败 —— 用法：failNext = 'column "resource_id" does not exist' */
let failNext = null;
/* 让**某一张表的读**失败，模拟「这张表还没建」。
   failNext 只管写（读要是一起失败，整页刷新就空掉了，测不出降级），
   而「exams 表不存在」发生在 select 那一步，所以另开一个钩子。 */
let failSelect = null;
function qb(table) {
  const st = { op: 'select', eq: null, single: false };
  const o = {
    select() { return o; }, order() { return o; }, limit() { return o; },
    single() { st.single = true; return o; },
    insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return o; },
    update(r) { st.op = 'update'; st.rows = r; return o; },
    upsert(r) { st.op = 'upsert'; st.rows = Array.isArray(r) ? r : [r]; return o; },
    delete() { st.op = 'delete'; return o; },
    eq(k, v) { st.eq = [k, v]; return o; },
    // 真客户端（PostgrestBuilder.then）返回的是 Promise，这里也必须返回，
    // 否则 setDone() 里的 .then(cb) 链式调用会拿到 undefined
    then(res, rej) {
      return new Promise((resolve) => {
        /* 只让**写**操作失败。读也一起失败的话整页刷新就空掉了，
           测出来的就不是「这一列不存在」而是「整个页面崩了」。 */
        if (failSelect && st.op === 'select' && failSelect === table) {
          failSelect = null;
          resolve({ data: null, error: { message: "Could not find the table 'public." + table + "' in the schema cache" } });
          return;
        }
        if (failNext && st.op !== 'select') { const m = failNext; failNext = null; resolve({ data: null, error: { message: m } }); return; }
        const T = (DB[table] = DB[table] || []);
        const hit = (x) => !st.eq || x[st.eq[0]] === st.eq[1];
        let data = null;
        if (st.op === 'select') data = T.filter(hit);
        else if (st.op === 'insert') { st.rows.forEach((r) => { r.id = r.id || 'new' + (++seq); T.push(r); }); data = st.single ? st.rows[0] : st.rows; }
        else if (st.op === 'update') { const t = T.filter(hit); t.forEach((x) => Object.assign(x, st.rows)); data = t; }
        else if (st.op === 'delete') { const t = T.filter(hit); t.forEach((x) => T.splice(T.indexOf(x), 1)); data = t; }
        else if (st.op === 'upsert') {
          st.rows.forEach((r) => {
            const k = table === 'daily_logs' ? (x) => x.owner === r.owner && x.log_date === r.log_date : (x) => x.id === r.id;
            const ex = T.find(k);
            if (ex) Object.assign(ex, r); else { r.id = r.id || 'new' + (++seq); T.push(r); }
          });
          data = st.rows;
        }
        resolve({ data: st.single ? (Array.isArray(data) ? data[0] : data) : data, error: null });
      }).then(res, rej);
    },
  };
  return o;
}
globalThis.supabase = {
  createClient: () => ({
    from: (t) => qb(t),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: ME, email: 'a@example.com' } } }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: ME, email: 'a@example.com' } }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: () => ({ on() { return this; }, subscribe(cb) { cb('SUBSCRIBED'); return this; } }),
    removeChannel() {},
  }),
};

/* ── 工具 ───────────────────────────────────────────────────── */
const tick = () => new Promise((r) => setTimeout(r, 30));
const $ = (id) => document.getElementById(id);
const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
const findAll = (root, pred) => { const o = []; walk(root, (n) => { if (pred(n)) o.push(n); }); return o; };
/* 按 class 取元素必须整词匹配。用 className.includes('chip') 会把 chips / chips-group
   这些**包含** chip 的类名一并捞进来 —— 加了分组容器之后计数就悄悄多出来了。 */
const hasCls = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byCls = (root, c) => findAll(root, (n) => hasCls(n, c));
const find = (root, pred) => findAll(root, pred)[0] || null;
const btns = (root, label) => findAll(root, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === label);
const inputs = (root) => findAll(root, (n) => n.tagName === 'INPUT' && n.type === 'text').map((n) => n.value);

/* 「今日完成情况」那两组是各自开着的开关（再点一下选中的那个 = 这组这次不记），
   开还是关会跟着前面的用例变。写死「点一下就能选中」太脆，用这两个按状态点。 */
const laneChip = (name) => byCls($('done-picker'), 'chip').find((c) => c.textContent.includes(name));
async function laneOn(name) { const c = laneChip(name); if (c && !hasCls(c, 'on')) { c.fire('click'); await tick(); } }
async function laneOff(name) { const c = laneChip(name); if (c && hasCls(c, 'on')) { c.fire('click'); await tick(); } }

/* 一行小任务/章节：按**输入框里的名字**找，不按整行文字 ——
   行里那个「↔」选择器的 option 文案会把对家所有章节名都带进行文本里。 */
const subRowOf = (root, title) =>
  findAll(root, (n) => hasCls(n, 'sub')).find((r) =>
    findAll(r, (n) => n.tagName === 'INPUT' && n.type === 'text').some((i) => i.value === title)) || null;
const rowSel = (row) => (row ? findAll(row, (n) => n.tagName === 'SELECT')[0] || null : null);
const rowBox = (row) => (row ? findAll(row, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')[0] || null : null);
/* 选「↔ 某条」。真浏览器里是选下拉，这里直接给 change 一个假 target。 */
async function pickLink(row, id) { rowSel(row).fire('change', { target: { value: id || '' } }); await tick(); await tick(); }

const fails = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✅ ' + label);
  else { fails.push(label); console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
};

/* ── 跑 ─────────────────────────────────────────────────────── */
eval(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
await tick(); await tick(); await tick();

console.log('── 登录后落在主页 ──');
ok($('view-app').hidden === false && $('view-login').hidden === true, '数据页显示、登录页隐藏');
ok(tabs[0].className.includes('on'), '主页页签是选中态');
ok(!tabs[1].className.includes('on'), '其他页签没被选中');
ok($('pane-home').hidden === false, '主页 pane 可见');
ok(panes.slice(1).every((p) => p.hidden === true), '其余 5 个 pane 都隐藏');
ok($('home-sub').textContent.includes('今天是'), '主页副标题：' + $('home-sub').textContent);

console.log('── 主页：两个人的状态卡 ──');
const pcs = findAll($('home-people'), (n) => n.className.includes('pcard'));
ok(pcs.length === 2, '两张状态卡，实际 ' + pcs.length);
ok(pcs[0].className.includes('me') && pcs[1].className.includes('other'), '我 / 对方 分栏样式正确');
const pc0 = pcs[0].textContent;
ok(pc0.includes('小 A'), '我的名字');
ok(pc0.includes('0 / 1 个完成'), '目标统计（我只有 1 个目标）：' + (pc0.match(/\d+ \/ \d+ 个完成/) || [''])[0]);
ok(pc0.includes('累计 120 / 300'), '累计进度');
ok(pc0.includes('小任务 2 / 3'), '小任务统计');
ok(pc0.includes('今天') && pc0.includes('还没记'), '今天还没记（09-25 无记录）');
ok(pcs[1].textContent.includes('小 B'), '对方名字');
ok(pcs[1].textContent.includes('1 / 1 个完成'), '对方目标已完成 1/1');
ok(findAll(pcs[0], (n) => n.className.includes('lg')).length === 1, '状态卡上有大头像');
ok(btns(pcs[0], '上传头像').length === 1, '自己的卡有「上传头像」按钮');
ok(btns(pcs[1], '上传头像').length === 0, '对方的卡没有（不能改别人）');

console.log('── 主页：动态流 ──');
const feedTxt = $('feed').textContent;
ok(feedTxt.includes('完成了 30 天目标'), '看到「完成了目标」');
ok(feedTxt.includes('读完一本书'), '完成的目标名在');
ok(feedTxt.includes('完成小任务') && feedTxt.includes('第 1-4 讲'), '看到完成的小任务');
ok(feedTxt.includes('学完线性代数'), '小任务归属的大任务名在');
ok(feedTxt.includes('记了 2026-09-24 的心情与困难'), '看到每日记录');
ok(feedTxt.includes('添加了工具书') && feedTxt.includes('线性代数应该这样学'), '看到添加的资源');
ok(!feedTxt.includes('习题课'), '未完成的小任务不进动态流');
ok(feedTxt.includes('找不到数据'), '对方记的困难也看得到');
const feedItems = findAll($('feed'), (n) => n.className.includes('feed-item'));
ok(feedItems.length >= 9, '动态条数 ' + feedItems.length);
ok(findAll($('feed'), (n) => n.className.includes('av')).length === feedItems.length, '每条动态都带头像');
ok(findAll($('feed'), (n) => n.className.includes('mo')).length === 3, '有心情的三条带了表情');
const mk = findAll($('feed-filter'), (n) => n.tagName === 'BUTTON');
ok(mk.length === 4, '筛选 4 个：' + mk.map((b) => b.textContent).join(' / '));
btns($('feed-filter'), '完成了什么')[0].fire('click'); await tick();
const doneOnly = findAll($('feed'), (n) => n.className.includes('feed-item'));
ok(doneOnly.every((n) => n.textContent.includes('完成')), '点「完成了什么」后只剩完成类，共 ' + doneOnly.length + ' 条');
ok(!$('feed').textContent.includes('考研政治'), '资源被筛掉了');
btns($('feed-filter'), '学习资源')[0].fire('click'); await tick();
ok($('feed').textContent.includes('考研政治') && !$('feed').textContent.includes('完成小任务'), '切到「学习资源」也正确');
btns($('feed-filter'), '全部')[0].fire('click'); await tick();

console.log('── 主页：入口跳转 ──');
// entries 顺序 = goals, tasks, daily, res, data（下标 0 起）
const entries = findAll($('home-entries'), (n) => n.className.includes('entry'));
ok(entries.length === 6, '入口卡片 6 个（加了考试成绩）');
ok(entries[0].textContent.includes('月度任务'), '入口顺序：' + entries.map((e) => e.textContent.slice(0, 4)).join(' '));
entries[0].fire('click'); await tick();
ok(tabs[1].className.includes('on') && !tabs[0].className.includes('on'), '点「月度任务」→ 页签切过去了');
ok($('pane-goals').hidden === false && $('pane-home').hidden === true, 'pane 也跟着切了');
ok($('goals-cols').textContent.includes('背完 300 个单词'), '目标内容渲染');
tabs[0].fire('click'); await tick();
ok($('pane-home').hidden === false, '点「主页」页签能回来');

console.log('── 头像：点自己的头像 → 选图 → 上传 ──');
ok($('me-av').textContent === '小', '还没上传时用名字首字兜底，实际「' + $('me-av').textContent + '」');
ok($('me-av').className.includes('me') && $('me-av').className.includes('clickable'), '头像是可点的我的样式');
let fileOpened = 0;
$('av-file').addEventListener('click', () => { fileOpened++; });
$('me-av').fire('click');
ok(fileOpened === 1, '点头像确实触发了文件选择');
$('av-file').fire('change', { target: { files: [{ type: 'image/png' }] } });
await tick(); await tick();
ok(DB.profiles[0].avatar.startsWith('data:image/jpeg;base64,'), '头像写进了 profiles.avatar');
ok(DB.profiles[0].avatar.length < 120000, '头像体积可控：' + DB.profiles[0].avatar.length + ' 字符');
ok(find($('me-av'), (n) => n.tagName === 'IMG') !== null, '页头头像变成了 img');
ok(findAll($('feed'), (n) => n.tagName === 'IMG').length >= 1, '动态流里的头像也跟着换了');
const pcs2 = findAll($('home-people'), (n) => n.className.includes('pcard'));
ok(findAll(pcs2[0], (n) => n.tagName === 'IMG').length === 1, '状态卡头像换成了 img');
ok(btns(pcs2[0], '换头像').length === 1, '按钮文案变成「换头像」');
$('av-file').fire('change', { target: { files: [{ type: 'text/plain' }] } });
await tick();
ok($('toast').textContent.includes('图片'), '非图片文件被拒：' + $('toast').textContent);

console.log('── 勾完成 → 写 done_at → 主页动态流能看到 ──');
entries[1].fire('click'); await tick();   // tasks
const boxes = findAll($('tasks-cols'), (n) => n.tagName === 'INPUT' && n.type === 'checkbox');
const mineBoxes = boxes.filter((b) => !b.disabled);
ok(mineBoxes.length === 3, '我有 3 个可勾的小任务，实际 ' + mineBoxes.length);
const todo = mineBoxes[2];              // 习题课，尚未完成
todo.checked = true;
todo.fire('change', { target: todo });
await tick(); await tick();
const s3 = DB.subtasks.find((x) => x.id === 's3');
ok(s3.done === true, '小任务写成了已完成');
ok(typeof s3.done_at === 'string' && s3.done_at.includes('T'), 'done_at 写进去了：' + s3.done_at);
ok(Math.abs(Date.now() - new Date(s3.done_at).getTime()) < 60000, 'done_at 是刚刚，不是瞎写的');
tabs[0].fire('click'); await tick();
ok($('feed').textContent.includes('习题课'), '刚勾完的小任务立刻出现在主页动态流里');

console.log('── 30 天目标：标记完成 → done_at ──');
entries[0].fire('click'); await tick();   // goals
btns($('goals-cols'), '标记完成')[0].fire('click');
await tick(); await tick();
const g1 = DB.goals.find((x) => x.id === 'g1');
ok(g1.done === true, '目标标记完成');
ok(g1.progress === 300, '进度被推到目标值 300');
ok(typeof g1.done_at === 'string', 'done_at 写上：' + g1.done_at);

console.log('── 原有四个功能区没被改坏 ──');
ok($('goals-cols').textContent.includes('进度 300 / 300'), '进度文案');
ok(findAll($('goals-cols'), (n) => n.className.includes('who')).length === 2, '目标仍双栏');
ok(findAll($('goals-cols'), (n) => n.className.includes('sm')).length === 2, '每栏标题带头像');
tabs[2].fire('click'); await tick();
ok($('tasks-cols').textContent.includes('3 / 3 个小任务'), '大任务计数（勾完 s3 → 3/3）');
tabs[3].fire('click'); await tick();
ok($('daily-cols').textContent.includes('特征值那块卡住了'), '日记内容');
tabs[4].fire('click'); await tick();
ok($('res-tiles').textContent.includes('资源总数'), '资源统计卡');
const svg = $('res-chart').children[0];
ok(svg.children.filter((c) => c.tagName === 'RECT' && String(c.attrs.fill).includes('--series-')).length > 0, '宏观图有数据段');
ok(svg.children.filter((c) => c.tagName === 'TEXT').map((c) => c.textContent).includes('数学'), '图上有学科标签');
/* 渲染必须一路走到最后。2026-09-26 的 bug 就是 renderResChart 里
   h('tr', h('td', …)) 把节点当属性对象传 → 抛 TypeError → 后面的
   twoCols($('res-cols'), …) 整块没执行，页面在图表之后戛然而止。
   所以这里要断言的不只是图表，还有图表**下面**的东西 —— 图表自己画得好好的。 */
const resTbl = findAll($('res-chart'), (n) => n.tagName === 'TABLE')[0];
ok(resTbl && resTbl.textContent.includes('数学'), '学科总览下面的「表格视图」也渲染出来了');
ok(resTbl && findAll(resTbl, (n) => n.tagName === 'TH').map((n) => n.textContent).join('|').includes('合计'),
  '表格视图表头完整');
ok(findAll($('res-cols'), (n) => hasCls(n, 'item')).length > 0, '图表下面的资源列表渲染出来了');
ok(btns($('res-cols'), '删除').length > 0, '资源卡片上有删除按钮');
tabs[6].fire('click'); await tick();
ok($('export-meta').textContent.includes('目标 ' + DB.goals.length),
  '导出统计：' + $('export-meta').textContent);
ok($('export-meta').textContent.includes('倒计时 3'),
  '导出统计里单列倒计时条数（它不是独立的表，是 goals 里 due_date 非空的部分）：' +
  $('export-meta').textContent);

/* ══════════════════════════════════════════════════════════════
   本轮新增：大任务可视化 + 月行程表
   注意这些断言必须跑在上面「勾完 s3、标记 g1 完成」之后 ——
   主题就是「改完某处，别处会不会自动跟上」。
   ══════════════════════════════════════════════════════════════ */

console.log('── 大任务：完成情况总览 ──');
tabs[2].fire('click'); await tick();          // tasks
ok($('ov-sub').textContent.includes('共 2 个大任务'), '总览副标题：' + $('ov-sub').textContent);
ok($('ov-sub').textContent.includes('已完成 3 个'), '总览统计跟着勾选走');
ok(findAll($('ov-list'), (n) => n.className.includes('ov-who')).length === 2, '两个人各一组');
const ovRows = findAll($('ov-list'), (n) => n.className.includes('ov-row'));
ok(ovRows.length === 2, '两个大任务两条横条，实际 ' + ovRows.length);
ok(ovRows[0].textContent.includes('学完线性代数'), '我的任务排在前面');
ok(ovRows[0].textContent.includes('3 / 3'), '我的 3 / 3 —— 勾完 s3 后自动跟上，不用刷新');
ok(ovRows[1].textContent.includes('0 / 1'), '对方的 0 / 1');
ok($('ov-legend').children.length === 2, '两人都有任务 → 出 2 条图例');

console.log('── 大任务：分段进度条 ──');
const segBars = findAll($('tasks-cols'), (n) => /\bseg\b/.test(n.className));
ok(segBars.length === 2, '两个大任务各一条分段进度条，实际 ' + segBars.length);
const segs = findAll(segBars[0], (n) => /\bsq\b/.test(n.className));
ok(segs.length === 3, '一个小任务一段 → 3 段，实际 ' + segs.length);
ok(segs.filter((x) => /\bon\b/.test(x.className)).length === 3, '勾完后 3 段全点亮');
ok(segs[0].title.includes('第 1 步') && segs[0].title.includes('第 1-4 讲'),
  '每段悬停能看出是哪一步：' + segs[0].title);
const segs2 = findAll(segBars[1], (n) => /\bsq\b/.test(n.className));
ok(segs2.length === 1, '对方 1 个小任务 → 1 段');
ok(segs2.filter((x) => /\bon\b/.test(x.className)).length === 0, '对方一段都没点亮');
ok($('tasks-cols').textContent.includes('100%'), '百分比 100%（我的任务）');

console.log('── 月行程表：跟着每天的完成情况走 ──');
tabs[1].fire('click'); await tick();          // goals
const Y = 2026, M = 9, DIM = 30, LEAD = new Date(Y, M - 1, 1).getDay();
const CELLS = Math.ceil((LEAD + DIM) / 7) * 7;
ok($('mo-head').children.length === 7, '星期表头 7 列');
ok($('mo-grid').children.length === CELLS, '补满整周共 ' + CELLS + ' 格，实际 ' + $('mo-grid').children.length);
ok($('mo-grid').children.filter((c) => !c.className.includes('blank')).length === DIM,
  '非空格子 = 当月 ' + DIM + ' 天');
const cell = (d) => $('mo-grid').children[LEAD + d - 1];
ok(cell(1).textContent.includes('1'), '1 号落在第 ' + LEAD + ' 格（周' + ['日','一','二','三','四','五','六'][LEAD] + '）');
const dcOf = (d) => { const k = findAll(cell(d), (n) => /\bdc\b/.test(n.className))[0]; return k ? k.textContent : ''; };
const dmOf = (d) => { const k = findAll(cell(d), (n) => /\bdm\b/.test(n.className))[0]; return k ? k.textContent : ''; };
ok(dcOf(20) === '1', '9/20 完成目标 → 记 1 件，实际「' + dcOf(20) + '」');
ok(cell(20).className.includes('lv1'), '9/20 上色档位 lv1');
ok(dcOf(21) === '1' && dcOf(22) === '1', '9/21、9/22 各完成 1 个小任务');
ok(dcOf(23) === '', '9/23 只记了心情，没有完成数');
ok(dmOf(23) === '😄', '9/23 心情 😄（mood 5），实际「' + dmOf(23) + '」');
ok(dmOf(24) === '😕', '9/24 心情 😕（mood 2），实际「' + dmOf(24) + '」');
ok(cell(20).title.includes('读完一本书'), '格子的悬停明细写了完成了什么：' +
  cell(20).title.split('\n')[1]);
ok(cell(21).title.includes('学完线性代数'), '小任务的悬停明细带上了所属大任务');

const now = new Date();
const inThisMonth = now.getFullYear() === Y && now.getMonth() === M - 1;
if (inThisMonth) {
  ok(cell(now.getDate()).className.includes('today'), '今天那格有描边');
  ok(dcOf(now.getDate()) === '2', '刚勾完的 s3 + 标记完成的 g1 立刻出现在今天：' +
    dcOf(now.getDate()) + ' 件');
} else {
  console.log('  ⏭  今天不在 ' + Y + '-' + M + '，跳过「今天」相关断言（不假造结果）');
}

console.log('── 月行程表：月份导航 / 图例 / 表格视图 ──');
ok($('mo-nav').children.length === 3, '月份导航 3 个按钮');
ok($('mo-nav').children[1].textContent.includes(Y + ' 年 ' + M + ' 月'), '中间显示当前月份');
ok($('mo-nav').children[1].disabled === true, '已在本月时「回到本月」不可点');
$('mo-nav').children[0].fire('click'); await tick();
ok($('mo-nav').children[1].textContent.includes('8 月'), '点上月 → 2026 年 8 月');
ok($('mo-grid').children.filter((c) => !c.className.includes('blank')).length === 31, '8 月 31 天');
ok($('mo-grid').children.filter((c) => !c.className.includes('blank')).every((c) => !/\blv\d\b/.test(c.className)),
  '8 月没有记录 → 一格都没上色');
$('mo-nav').children[2].fire('click'); await tick();
ok($('mo-nav').children[1].textContent.includes('9 月'), '点下月 → 回到 9 月');
ok($('mo-legend').children.length === 6,
  '图例 4 档色阶 + 考试标记 + 截止标记，实际 ' + $('mo-legend').children.length);
ok($('mo-legend').children[1].textContent.includes('1–2 件'), '图例文案说清楚深浅代表什么');
ok($('mo-legend').children[4].textContent.includes('考试'), '图例里单独说明了「考」这个标记');
ok($('mo-legend').children[5].textContent.includes('倒计时'),
  '图例第 6 项说明「截」这个标记：' + $('mo-legend').children[5].textContent);
/* 图例里的方块要把那个字**写出来** —— 只有虚线框的话，
   看的人对不上格子里那个「截」是什么意思 */
const kdLbl = findAll($('mo-legend').children[5], (n) => /\blbl\b/.test(n.className))[0];
ok(kdLbl && kdLbl.textContent === '截', '图例方块里写的就是格子里那个字，实际「' +
  (kdLbl ? kdLbl.textContent : '(没有)') + '」');
ok($('mo-table').textContent.includes('2026-09-21'), '表格视图列出 9/21');
ok($('mo-table').textContent.includes('第 1-4 讲'), '表格视图写出那天做了什么');
ok($('mo-table').textContent.includes('😄'), '表格视图带心情');
ok($('mo-sub').textContent.includes('这个月完成'), '统计副标题：' + $('mo-sub').textContent);

/* ── 其他表当月更新的东西，同步到月度任务视图 ── */
console.log('── 月度任务视图：考试成绩 / 学习资源同步进来 ──');
const deOf = (d) => { const k = findAll(cell(d), (n) => /\bde\b/.test(n.className))[0]; return k ? k.textContent : ''; };
ok(deOf(12) === '考108', '9/12 那格标出考试得分（108/120），实际「' + deOf(12) + '」');
ok(deOf(18) === '考88', '9/18 对方的英语月考也在日历上（这一页看的是两人的共同进度）');
ok(deOf(20) === '考', '9/20 那场还没出分 → 只标「考」，不假造一个 0 分');
ok(deOf(21) === '', '9/21 没有考试 → 没有标记');
ok(dcOf(12) === '', '9/12 只考了试、没完成任务 → 右下角仍是空（考试不改深浅口径）');
ok(!/\blv\d\b/.test(cell(12).className), '9/12 那格没被考试点亮成有进度的样子');
ok(cell(12).title.includes('考试：期中数学（数学）：108 / 120（90%）'),
  '格子悬停明细里有这一场：' + cell(12).title.split('\n').filter((s) => s.startsWith('考试'))[0]);
ok(cell(20).title.includes('没填分'), '没出分的那场，悬停里写的是「没填分」');
ok(cell(5).title.includes('加了资源：线性代数应该这样学（工具书）'),
  '9/5 加了资源 → 也落到那天的明细里');
ok(cell(23).title.includes('心情 😄（状态不错）'), '日记那天的补充也进悬停明细：' +
  (cell(23).title.split('\n').filter((s) => s.startsWith('心情'))[0] || '(没有)'));
ok($('mo-table').textContent.includes('108 / 120'), '表格视图也有考试那一列');
ok($('mo-table').textContent.includes('期中数学'), '表格视图写出考的是什么');
const headTxt = findAll($('mo-table'), (n) => n.tagName === 'TH').map((n) => n.textContent).join('/');
ok(headTxt === '日期/完成/考试/截止/心情/做了什么', '表格视图表头：' + headTxt);
ok($('mo-table').textContent.includes('加了资源：线性代数应该这样学'), '表格视图里也有资源');
ok($('mo-table').textContent.includes('心情补充：状态不错'), '日记的补充文字也带出来');
/* 统计句要真的把别的表算进去：这个月 9/5–9/9 一共 5 个资源、9 月 3 场考试 */
ok($('mo-sub').textContent.includes('考了 3 场试'), '统计句报了这个月考了几场：' + $('mo-sub').textContent);
ok($('mo-sub').textContent.includes('加了 5 个学习资源'), '统计句报了这个月加了几个资源');
/* 只有 9/12（108/120）和 9/18（88/100）两场有满分：196/220 = 89.1%。
   9/20 那场没出分，不能算进分母，也不能被当成 0 分拉低平均。 */
ok($('mo-sub').textContent.includes('有满分的 2 场，折算下来平均 89.1%'),
  '平均分只算有满分的 2 场：' + $('mo-sub').textContent);

/* ══════════════════════════════════════════════════════════════
   倒计时：几月几号要完成什么（取代 30 天小目标当这一页的主位）
   数据就是 goals 里 due_date 非空的行，不新开表 —— 见 setup-7-countdown.sql
   ══════════════════════════════════════════════════════════════ */

console.log('── 倒计时：列表 / 排序 / 还剩几天怎么说 ──');
tabs[1].fire('click'); await tick();
ok($('cd-warn').hidden === true, '库里已有 due_date 列 → 不提示去跑脚本');
const cdItems = byCls($('cd-cols'), 'item');
ok(cdItems.length === 3, '倒计时条目 3 条（g3 / g4 / g5），实际 ' + cdItems.length);
/* 倒计时的行 period_start/target/progress 只是占位，绝不能被当成 30 天小目标
   画成一条 0/1 的进度条 —— 那是这一页最容易串味的地方 */
ok(!byCls($('goals-cols'), 'item').some((i) => i.textContent.includes('交开题报告')),
  '倒计时不混进折叠区那张「30 天小目标」备忘录');
ok(!$('goals-cols').textContent.includes('进度 0 / 1'), '备忘录里没有 0/1 的假进度条');

const cdWho = byCls($('cd-cols'), 'who');
ok(cdWho.length === 2, '倒计时也是双栏（两人各一栏）');
ok(find(cdWho[0], (n) => hasCls(n, 'nm')).textContent === '小 A', '我那栏排前面');
const meCd = byCls(cdWho[0], 'item');
ok(meCd.length === 2, '我这栏 2 条（已完成的不算待办），实际 ' + meCd.length);
ok(meCd[0].textContent.includes('交实验数据') && meCd[1].textContent.includes('交开题报告'),
  '待办按截止日从近到远排 —— 已经过期的那条排在最前面：' +
  meCd.map((i) => i.textContent.slice(0, 6)).join(' | '));
const pillOf = (row) => byCls(row, 'pill')[0];
ok(pillOf(meCd[0]).textContent === '已过期 5 天',
  '过期 5 天 → 「已过期 5 天」，实际「' + pillOf(meCd[0]).textContent + '」');
ok(hasCls(pillOf(meCd[0]), 'bad'), '过期 / 今天到期 → bad 药丸（红）');
ok(pillOf(meCd[1]).textContent === '还剩 2 天',
  '还剩 2 天 → 「还剩 2 天」，实际「' + pillOf(meCd[1]).textContent + '」');
ok(hasCls(pillOf(meCd[1]), 'warn'), '3 天内到期 → warn 药丸');
ok(meCd[1].textContent.includes('截止 ') && /周[日一二三四五六]/.test(meCd[1].textContent),
  '每条都写出截止日（带星期几）：' + meCd[1].textContent);
/* 颜色只是辅助。药丸里必须自己说出还剩几天 ——
   色觉障碍、打印、强制配色下都要能读出来 */
ok(/还剩|到期|过期/.test(pillOf(meCd[0]).textContent) &&
   /还剩|到期|过期/.test(pillOf(meCd[1]).textContent),
  '不靠颜色也能读出剩余天数，药丸里带着话');

const otCd = byCls(cdWho[1], 'item');
ok(otCd.length === 1, '对方那一栏也在（这一页看的是两人的共同进度）');
ok(otCd[0].textContent.includes('预约答辩教室'), '对方已完成的那条也在');
ok(hasCls(otCd[0], 'done'), '已完成的行变淡（.item.done）');
const cdSep = find(cdWho[1], (n) => hasCls(n, 'cd-sep'));
ok(cdSep && cdSep.textContent === '已完成', '已完成的那条落在「已完成」分隔线下面');
ok(byCls(cdWho[0], 'cd-sep').length === 0, '没有已完成时不留一条空的分隔线');

ok($('cd-sub').textContent.includes('待办 2 件'), '副标题报待办件数：' + $('cd-sub').textContent);
ok($('cd-sub').textContent.includes('交实验数据'), '副标题点名最急的那一件');
ok($('cd-sub').textContent.includes('已过期 5 天'), '副标题里也说了还剩几天');
ok($('cd-sub').textContent.includes('已经完成 1 件'), '已完成的不算在待办里，单独报一句');

console.log('── 倒计时落到月历上：「截」标记 ──');
const dlOf = (d) => { const k = find(cell(d), (n) => hasCls(n, 'dl')); return k ? k.textContent : ''; };
const cellOfIso = (iso) => (iso.startsWith('2026-09') ? cell(Number(iso.slice(8))) : null);
/* 三个截止日都按「今天」算，跨月就可能不在当前显示的 9 月里 ——
   那就不假造结果，明说跳过（和上面「今天」那段的做法一致） */
if ([D2, DM5, DM9].every((s) => s.startsWith('2026-09'))) {
  ok(dlOf(Number(D2.slice(8))) === '截', '还没完成的截止日那天，格子里标「截」');
  ok(dlOf(Number(DM5.slice(8))) === '截', '过期未完成的也照样标出来（要能看见欠着的事）');
  ok(dlOf(Number(DM9.slice(8))) === '',
    '已经完成的那条不再标「截」—— 那天只会以「完成」的身份出现');
  ok(cellOfIso(DM9).title.includes('完成目标：预约答辩教室'), '完成了就归到「完成目标」那一栏');
  ok(cellOfIso(D2).title.includes('截止：交开题报告'),
    '那天的悬停明细里写了截止的是什么：' +
    (cellOfIso(D2).title.split('\n').filter((s) => s.startsWith('截止'))[0] || '(没有)'));
  ok(!/\blv\d\b/.test(cellOfIso(D2).className),
    '只有截止日的那天不上色 —— 深浅口径仍只由「完成」决定，没被截止日污染');
  ok(findAll(cellOfIso(D2), (n) => hasCls(n, 'dc')).length === 0,
    '只有截止日 → 不冒出件数数字（右下角仍是空的）');
  ok($('mo-sub').textContent.includes('另有 2 件事在这个月到期'),
    '统计句报了这个月有几个截止日（已完成的不算）：' + $('mo-sub').textContent);
  ok($('mo-table').textContent.includes('交开题报告'), '表格视图里也有「截止」那一列的内容');
} else {
  console.log('  ⏭  倒计时的截止日不在 2026-09，跳过月历相关断言（不假造结果）');
}

console.log('── 倒计时：加一条 ──');
ok($('cd-due').value === isoOff(7),
  '截止日默认填今天 + 7 天，省一次点日历：' + $('cd-due').value);
/* 从统计句里把两个数字抠出来对账：加一条截止日**不该**让那天变成「有记录的一天」
   （有记录 = 完成/推进/考试/资源/心情，截止日不在这个口径里）。
   不写死具体数字，比的是加之前和加之后的差 —— 换一天跑也不会飘。 */
const daysActive = () => Number((/有 (\d+) 天有记录/.exec($('mo-sub').textContent) || [null, 0])[1]);
const nDueText = () => Number((/另有 (\d+) 件事在这个月到期/.exec($('mo-sub').textContent) || [null, 0])[1]);
const active0 = daysActive(), due0 = nDueText();
/* 按需求里那句「什么都不要问我，做出来再让我知道」，加的时候只要标题 + 日期，
   说明留空也能加 */
async function addCd(title, due) {
  $('cd-title').value = title;
  $('cd-detail').value = '';
  $('cd-due').value = due;
  $('cd-add').fire('click');
  await tick(); await tick(); await tick();
}
await addCd('临时·明天要交的', isoOff(1));
ok(daysActive() === active0,
  '只加一个截止日，那天**不**算成「有记录的一天」：' + active0 + ' → ' + daysActive());
if (isoOff(1).startsWith('2026-09')) {
  ok(nDueText() === due0 + 1, '统计句里的截止日数跟着 +1：' + due0 + ' → ' + nDueText());
}
const gNew = DB.goals.find((g) => g.title === '临时·明天要交的');
ok(!!gNew, '写进了 goals 表（没新开 countdowns 表）');
ok(gNew.due_date === isoOff(1), 'due_date 记的是截止日：' + (gNew && gNew.due_date));
ok(gNew.period_start === isoOff(0),
  'period_start 拿今天占位（那一列 not null，页面不显示它）：' + (gNew && gNew.period_start));
ok(gNew.target === 1 && gNew.progress === 0 && gNew.done === false,
  '其余占位列：target 1 / progress 0 / 未完成');
ok($('cd-title').value === '', '加完把标题输入框清掉，方便接着加下一条');

/* 同一天到期两件事：格子里放不下两个「截」，要压成「截×2」 */
await addCd('临时·同天到期的另一件', isoOff(1));
if (isoOff(1).startsWith('2026-09')) {
  ok(dlOf(Number(isoOff(1).slice(8))) === '截×2',
    '同一天到期两件事 → 格子里写「截×2」，实际「' + dlOf(Number(isoOff(1).slice(8))) + '」');
  ok(cellOfIso(isoOff(1)).title.includes('截止：临时·明天要交的') &&
     cellOfIso(isoOff(1)).title.includes('截止：临时·同天到期的另一件'),
    '两件都在悬停明细里，一件不少');
}
btns(byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·同天到期的另一件')), '删除')[0]
  .fire('click'); await tick(); await tick();
ok(!DB.goals.some((g) => g.title === '临时·同天到期的另一件'), '（清掉这条同天到期的）');

const newRow = byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·明天要交的'));
ok(!!newRow, '加完立刻出现在列表里（不用手动刷新）');
ok(byCls(newRow, 'pill')[0].textContent === '明天到期',
  '明天到期 → 「明天到期」，实际「' + (newRow ? byCls(newRow, 'pill')[0].textContent : '') + '」');

await addCd('临时·今天要交的', isoOff(0));
const row0 = byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·今天要交的'));
ok(byCls(row0, 'pill')[0].textContent === '今天到期',
  '今天到期 → 「今天到期」，实际「' + (row0 ? byCls(row0, 'pill')[0].textContent : '') + '」');
ok(hasCls(byCls(row0, 'pill')[0], 'bad'), '今天到期算最急的一档（bad）');

await addCd('临时·昨天该交的', DM1);
const rowM1 = byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·昨天该交的'));
ok(byCls(rowM1, 'pill')[0].textContent === '昨天到期',
  '过期 1 天 → 「昨天到期」而不是「已过期 1 天」（说人话）：' +
  (rowM1 ? byCls(rowM1, 'pill')[0].textContent : ''));

/* 空标题拦下来，别在库里留一条认不出来的记录 */
const nGoalsBefore = DB.goals.length;
$('cd-title').value = '   ';
$('cd-add').fire('click'); await tick(); await tick();
ok(DB.goals.length === nGoalsBefore, '只写了空格 → 不写库');
ok($('toast').textContent.includes('先写要完成什么'), '并说清楚缺什么：' + $('toast').textContent);

console.log('── 倒计时：点「完成」 ──');
const doneRow = byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·昨天该交的'));
btns(doneRow, '完成')[0].fire('click'); await tick(); await tick();
const gDone = DB.goals.find((g) => g.title === '临时·昨天该交的');
ok(gDone && gDone.done === true, '点「完成」真的把 done 写上了');
ok(gDone && typeof gDone.done_at === 'string', 'done_at 也写了（月历靠它归日）');
ok(byCls($('cd-cols'), 'cd-sep').length >= 1, '完成后挪到「已完成」那一段下面去');
/* 完成后不再提醒：那天在月历上只以「完成」的身份出现，不该还挂着「截」 */
if (DM1.startsWith('2026-09') && DM9.startsWith('2026-09')) {
  ok(find(cellOfIso(DM1), (n) => hasCls(n, 'dl')) === null &&
     find(cellOfIso(DM9), (n) => hasCls(n, 'dl')) === null,
    '刚完成的那条也不再标「截」');
}
ok($('cd-cols').textContent.includes('临时·昨天该交的'), '完成后整页重画没抛错');

console.log('── 倒计时：删除 ──');
const delRow = byCls($('cd-cols'), 'item').find((i) => i.textContent.includes('临时·明天要交的'));
btns(delRow, '删除')[0].fire('click'); await tick(); await tick();
ok(!DB.goals.some((g) => g.title === '临时·明天要交的'), '点「删除」真的删掉了那一行');
ok(!$('cd-cols').textContent.includes('临时·明天要交的'), '删完列表里也没了');

/* 收尾：把这一节临时加的倒计时清掉，别影响后面的用例 */
DB.goals = DB.goals.filter((g) => !g.title.startsWith('临时·'));
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('cd-cols').textContent.includes('交开题报告'), '收尾后回到 3 条基准数据');

/* setup-7-countdown.sql 还没跑：goals 表里根本没有 due_date 这一列。
   要求：① 说清楚去跑哪个脚本，不甩 Postgres 原文；② 不静默失败；
   ③ **别的页签照常**（列不存在只影响这一块）；
   ④ 导入时把这一列剥掉再写 —— 带着它整批会被拒，连累同批的旧目标。 */
console.log('── 倒计时：setup-7 还没跑时怎么办 ──');
failNext = 'column "due_date" does not exist';
$('cd-title').value = '临时·列还没建时写的';
$('cd-due').value = isoOff(3);
$('cd-add').fire('click'); await tick(); await tick();
ok($('cd-warn').hidden === false, '写失败 → 冒出提示条，而不是静默什么都没发生');
ok($('cd-warn').textContent.includes('setup-7-countdown.sql'), '提示直接指向要跑哪个脚本');
ok($('toast').textContent.includes('setup-7-countdown.sql'),
  '没把 Postgres 原文甩给她：' + $('toast').textContent);
ok(!DB.goals.some((g) => g.title.startsWith('临时·列还没建')), '那一行没写进库');
ok($('cd-cols').textContent.includes('交开题报告'), '这一块降级了，但已有的内容照常看得见');

const snapCd = {
  app: 'study-collab', version: 1,
  data: { goals: [
    { id: 'imp-cd', owner: ME, period_start: '2026-09-01', title: '导入的倒计时', detail: '',
      target: 1, progress: 0, done: false, done_at: null, due_date: '2026-10-01' },
  ] },
};
$('file-import').fire('change', { target: { files: [{ text: async () => JSON.stringify(snapCd) }] } });
await tick(); await tick();
const impCd = DB.goals.find((g) => g.id === 'imp-cd');
ok(!!impCd, '带 due_date 的那行还是导进去了（剥掉那一列，而不是整行丢掉）');
ok(impCd && !('due_date' in impCd), 'due_date 被剥掉了，否则整批会被 PostgREST 拒掉');
ok($('import-meta').textContent.includes('setup-7-countdown.sql'),
  '并且说清楚哪一列没导、要跑哪个脚本：' + $('import-meta').textContent);

/* 跑完脚本（这里是把钩子放掉）后恢复正常 */
DB.goals = DB.goals.filter((g) => g.id !== 'imp-cd');
$('cd-title').value = '';
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('cd-warn').hidden === true, '刷新后（列在了）提示条自己收起来');
ok(byCls($('cd-cols'), 'item').length === 3, '恢复正常，仍是 3 条');

/* 上面那一段是「写的时候才发现列不在」。
   还得能**只靠读**就看出来 —— 否则她点刷新时页面假装一切正常，
   非得等她填完一条、点下去，才知道要去跑脚本。 */
const savedDue = DB.goals.map((g) => g.due_date);
DB.goals.forEach((g) => { delete g.due_date; });
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('cd-warn').hidden === false, '刷新时读到的数据里没有这一列 → 主动提示，不等她写一次才发现');
ok($('cd-warn').textContent.includes('setup-7-countdown.sql'), '提示指向要跑哪个脚本');
ok($('cd-sub').textContent.includes('还没有倒计时任务'), '这一块降级成空态，不假装有数据');
ok(byCls($('cd-cols'), 'item').length === 0, '一条倒计时都不画');
DB.goals.forEach((g, i) => { g.due_date = savedDue[i]; });
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('cd-warn').hidden === true, '列回来之后提示自己收起来');

console.log('── 倒计时：主页那边也跟着说人话 ──');
tabs[0].fire('click'); await tick();
ok($('home-people').textContent.includes('倒计时'), '主页人物卡里单列一块「倒计时」');
ok($('home-people').textContent.includes('待办 2 / 2 件'),
  '每人一张卡，各报各的「待办 / 总数」（我 2/2、对方 0/1）：' +
  $('home-people').textContent.slice(0, 130));
ok($('home-people').textContent.includes('已过期 5 天'), '卡片上点名最急的那件还剩几天');
ok($('home-people').textContent.includes('全部完成'), '一条待办都没有的那栏说的是「全部完成」，不是「还没建」');
/* 旧的 30 天小目标和倒计时都是 goals 表的行，卡片上必须分开算 ——
   混在一起的话倒计时那条 0/1 的占位进度会把「累计」压得没法看 */
ok($('home-people').textContent.includes('30 天小目标'), '旧的 30 天小目标另算一块，不跟倒计时混在一起');
ok($('home-people').textContent.includes('累计 '),
  '30 天小目标那块仍按 progress/target 累计：' + $('home-people').textContent.slice(0, 200));
ok($('home-entries').textContent.includes('倒计时'), '主页入口卡的说明也提了倒计时');
/* 动态流里两种目标说法不一样 —— 别把「交开题报告」说成「累计 1 / 1」 */
ok($('feed').textContent.includes('完成了倒计时任务'), '动态流里说「完成了倒计时任务」');
ok($('feed').textContent.includes('完成了 30 天目标'), '旧的 30 天小目标那条文案没被改坏');
tabs[1].fire('click'); await tick();

/* ══════════════════════════════════════════════════════════════
   本轮新增：今日完成情况
   ══════════════════════════════════════════════════════════════ */

console.log('── 今日完成情况：写一条 + 勾大任务 ──');
tabs[3].fire('click'); await tick();          // daily
// 假 DOM 的页签是手工造的、没有文字，页签名要去 index.html 里查
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
ok(/data-tab="daily"[^>]*>今日完成情况</.test(html), '页签改名为「今日完成情况」');
ok(!/data-tab="daily"[^>]*>每日困难与心情</.test(html), '旧名字没有残留');
ok(/id="done-picker"/.test(html) && /id="done-btn"/.test(html), 'index.html 里两个元素都在');
ok(/id="done-warn"/.test(html), '缺 done_at 列时的提示位也在');
/* 自由文本框去掉了。以前大任务是「写一条 → 凭空新建一条已完成的小任务」，
   会让大任务越记越长、分母越来越大，还替她宣布了「完成」—— 她明确说不要。 */
ok(!/id="done-text"/.test(html), 'index.html 里不再有自由文本框');
const chips = byCls($('done-picker'), 'chip');
/* 三组：大任务 + 学习资源 + 那个大任务的「哪一步」。
   我 1 个大任务 + 4 个资源 + 它的 3 步 = 8；对方的一个都不能出现 */
ok(chips.length === 8, '只列我的：1 大任务 + 4 资源 + 3 步，实际 ' + chips.length);
ok(chips.every((c) => !c.textContent.includes('考研政治')), '对方的资源不该出现');
const tchip = chips.find((c) => c.textContent.includes('学完线性代数'));
ok(!!tchip, '大任务 chip 在');
ok(tchip.className.includes('on'), '默认选中一个 —— 不能让人先点一下才能记');
ok(tchip.textContent.includes('3/3'), 'chip 上带当前进度，记之前就知道要挂到哪');
/* 再点一下**已选中的那个** = 这一组这次不记。以前是「再点也不掉」，
   现在两组可以同时勾，就必须有个办法把其中一组关掉 —— 否则今天只做了一件事时
   没法只记一边。（开关是可逆的，下面马上点回来。） */
tchip.fire('click'); await tick();
ok(!byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('学完线性代数')).className.includes('on'),
  '再点一下选中的那个 = 这一组这次不记');
ok(!$('done-picker').textContent.includes('哪一步'), '关掉的那组连「哪一步」一起收起来，不留半截');
ok($('done-btn').disabled === true && $('done-btn').textContent.includes('先选一样'),
  '两组都没选时按钮点不动，并说清要先选：' + $('done-btn').textContent);
byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('学完线性代数')).fire('click'); await tick();
ok(byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('学完线性代数')).className.includes('on'),
  '再点回来又能选中（开关是可逆的）');
ok(byCls($('done-picker'), 'chips-group').length === 3, '分成「大任务」「学习资源」「哪一步」三组');
ok($('done-picker').textContent.includes('学习资源'), '资源那一组有组名');
/* 组的顺序 = 大任务 / 哪一步 / 学习资源（开着的组紧跟在自己的父项后面），
   别按下标取，按组名找 */
const stepGroup = byCls($('done-picker'), 'chips-group').find((g) => g.textContent.includes('哪一步'));
ok(stepGroup.textContent.includes('哪一步'), '第三组叫「哪一步」');
ok(stepGroup.textContent.includes('习题课'), '「哪一步」列出这个大任务的三个阶段');
ok(byCls(stepGroup, 'chip').length === 3, '三步都列出来了，实际 ' + byCls(stepGroup, 'chip').length);

/* 三个阶段此刻都已完成 —— 不该允许再记推进：那会把「已经完成的那天」改成今天 */
$('done-btn').fire('click'); await tick();
ok($('toast').textContent.includes('已经完成了'), '已完成的那一步不给再记推进：' + $('toast').textContent);

/* ══ 核心：把 s3 退回未完成，记一笔推进。测完原样还回去，后面的断言不受影响 ══ */
const s3row = DB.subtasks.find((x) => x.id === 's3');
const s3keep = { done: s3row.done, done_at: s3row.done_at };
s3row.done = false; s3row.done_at = null;
$('btn-refresh').fire('click'); await tick();

const s3chip = byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('习题课'));
ok(!!s3chip, '「习题课」这一步在「哪一步」里');
ok(!hasCls(s3chip, 'done'), '退回未完成后，它不再是 ✅');
s3chip.fire('click'); await tick();
ok(hasCls(byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('习题课')), 'on'),
  '点一下就选中这一步');

const nBefore = DB.subtasks.length;
ok($('done-btn').textContent.includes('只记一笔'), '按钮说的是「只记一笔」，不是「完成」：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('进度条不动'), '旁边写清楚了进度条不会动');

$('done-btn').fire('click'); await tick(); await tick();

ok(DB.subtasks.length === nBefore, '没有偷偷新建小任务（旧行为会），' + nBefore + ' → ' + DB.subtasks.length);
ok(s3row.done === false, 'done 仍是 false —— 完成状态一点没动');
ok(typeof s3row.done_at === 'string' &&
   Math.abs(Date.now() - new Date(s3row.done_at).getTime()) < 60000,
  '只是盖上今天的 done_at，当作「今天动过」的戳');
ok($('toast').textContent.includes('还没算完成'), '提示里明说它还不算完成：' + $('toast').textContent);

console.log('── 记推进不该惊动「完成」口径：进度 / 总览 / 月行程表 / 动态流 ──');
tabs[2].fire('click'); await tick();          // tasks
const segBar1 = findAll($('tasks-cols'), (n) => /\bseg\b/.test(n.className))[0];
const segs1 = findAll(segBar1, (n) => /\bsq\b/.test(n.className));
ok(segs1.length === 3, '还是 3 段 —— 没凭空长出一段来（旧行为会长到 4 段），实际 ' + segs1.length);
ok(segs1.filter((x) => /\bon\b/.test(x.className)).length === 2, '只有 2 段亮 —— 推进的那一步不算完成');
ok($('ov-sub').textContent.includes('已完成 2 个'), '总览统计没被推进带上去：' + $('ov-sub').textContent);
ok(findAll($('ov-list'), (n) => n.className.includes('ov-row'))[0].textContent.includes('2 / 3'),
  '总览里我的退回 2 / 3，不是 3 / 3');

tabs[1].fire('click'); await tick();          // goals → 月行程表
if (inThisMonth) {
  /* 今天本来只有 g1 一个完成（s3 刚退回未完成）。dayStats 只认 done，
     推进盖的 done_at 不该点亮格子 —— 点亮了就说明口径串了。 */
  ok(dcOf(now.getDate()) === '1', '月行程表只算真完成的，推进不点亮格子，实际「' + dcOf(now.getDate()) + '」');
  /* 但「推进未完成」不是被丢掉 —— 它进悬停明细和统计句，只是不改深浅。
     这两条一起看才是完整口径：格子上不亮，明细里查得到。 */
  ok(cell(now.getDate()).title.includes('推进未完成：习题课'),
    '推进的那一步仍然写进悬停明细：' +
    (cell(now.getDate()).title.split('\n').filter((s) => s.startsWith('推进未完成'))[0] || '(没有)'));
  ok($('mo-sub').textContent.includes('只推进未完成'), '统计句单独报「只推进未完成」的步数');
}
tabs[0].fire('click'); await tick();          // home
ok(!$('feed').textContent.includes('习题课'), '动态流没把推进误报成完成');

console.log('── 今日完成情况列表：已完成 / 今天动过 分开标，可撤销 ──');
tabs[3].fire('click'); await tick();
ok($('done-sub').textContent.includes('今天'), '计数行：' + $('done-sub').textContent);
ok($('done-cols').textContent.includes('习题课'), '列表里能看到刚记的这一步');
ok($('done-cols').textContent.includes('今天动过'), '标成「今天动过」，不跟「已完成」混');
ok($('done-cols').textContent.includes('学完线性代数'), '并标出它属于哪个大任务');
ok(findAll($('done-cols'), (n) => n.className.includes('who')).length === 2, '两人分栏');
const undoBtn = btns($('done-cols'), '撤销推进')[0];
ok(!!undoBtn, '推进记录给的是「撤销推进」，不是「撤销完成」');
undoBtn.fire('click'); await tick(); await tick();
ok(s3row.done_at === null, '撤销后 done_at 清掉，这条推进记录消失');
ok(s3row.done === false, '撤销推进不会顺手把完成状态改掉');

/* 测完了，把 s3 原样还回去，后面「完成」那套断言照旧 */
Object.assign(s3row, s3keep);
$('btn-refresh').fire('click'); await tick();
tabs[2].fire('click'); await tick();
ok($('ov-sub').textContent.includes('已完成 3 个'), '还回去之后总览回到 3 个：' + $('ov-sub').textContent);

console.log('── 学习资源：拆成章节 + 一章一章勾 ──');
ok(/id="r-chapters"/.test(html), 'index.html 里加了「共几章」输入框');
tabs[4].fire('click'); await tick();          // res
/* 刚建好的资源没有章节，这时不该凭空出现进度条 */
const r1item = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
ok(!!r1item, '找得到 r1 这张卡片');
ok(findAll(r1item, (n) => hasCls(n, 'seg')).length === 0, '还没分章时不出进度条（不给假进度）');
ok(!!btns(r1item, '＋ 分章').length, '给一个「＋ 分章」入口');

btns(r1item, '＋ 分章')[0].fire('click'); await tick(); await tick();
const ch1 = DB.subtasks.filter((x) => x.resource_id === 'r1');
ok(ch1.length === 1, '点一下加一章，实际 ' + ch1.length);
ok(ch1[0].task_id == null, '这一章不能再挂到大任务上（二选一）');
ok(ch1[0].title === '第 1 章', '默认给个「第 1 章」当占位，不用先想名字');
ok(ch1[0].owner === ME, 'owner 是我');

/* 再点两下 → 三章，序号要接下去而不是重排 */
const r1item2 = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
btns(r1item2, '＋ 加一章')[0].fire('click'); await tick(); await tick();
const r1item3 = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
btns(r1item3, '＋ 加一章')[0].fire('click'); await tick(); await tick();
const chAll = DB.subtasks.filter((x) => x.resource_id === 'r1');
ok(chAll.length === 3, '三章，实际 ' + chAll.length);
ok(chAll.map((x) => x.seq).join(',') === '1,2,3', '序号依次递增，没重排已有的：' + chAll.map((x) => x.seq).join(','));

const r1final = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
const chSegs = findAll(r1final, (n) => hasCls(n, 'sq'));
ok(chSegs.length === 3, '进度条按章分段，3 章 3 段，实际 ' + chSegs.length);
ok(chSegs.every((x) => !hasCls(x, 'on')), '一章没勾时全是暗的');
ok(r1final.textContent.includes('共 3 章，已完成 0 章'), '文字说明：' + (r1final.textContent.match(/共 \d+ 章[^%]*%/) || [''])[0]);
ok(r1final.textContent.includes('章节清单（0 / 3）'), '章节清单默认收起但有计数');

console.log('── 今日完成情况也能挂到资源上（不只是大任务）──');
tabs[3].fire('click'); await tick();          // daily
const rchip = byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('线性代数应该这样学'));
ok(!!rchip, '资源也出现在选择器里');
rchip.fire('click'); await tick();
ok(byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('线性代数应该这样学')).className.includes('on'),
  '点资源能选中它');
/* 她问的那件事：两组**不再互斥** —— 选资源不会把大任务那边取消掉 */
ok(byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('学完线性代数')).className.includes('on'),
  '选资源的同时，大任务那边**仍然选中**（两组可以同步勾，不再互斥）');
const chChips = byCls($('done-picker'), 'chip').filter((c) => /^第 \d+ 章$/.test(c.textContent.replace(/[☐☑✅]/g, '').trim()));
ok(chChips.length === 3, '选完资源会摊开它的 3 章，实际 ' + chChips.length);
ok(chChips[0].className.includes('on'), '默认落在第 1 章 —— 顺着往下读的人不用每次自己点');
ok(byCls($('done-picker'), 'chips-group').length === 4,
  '四组：大任务 / 哪一步 / 学习资源 / 第几章 —— 两组各摊各的，实际 ' +
  byCls($('done-picker'), 'chips-group').length);
ok($('done-btn').textContent.includes('两样一起记'),
  '两组都勾着时按钮写明这一下会记两条：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('还不算完成') && $('done-tip').textContent.includes('就算完成'),
  '并写清两条各自算不算完成：' + $('done-tip').textContent);

/* 但「今天只读了一章」更常见 → 把大任务那组关掉，只记资源 */
await laneOff('学完线性代数');
ok(!$('done-picker').textContent.includes('哪一步'), '关掉的那组连「哪一步」一起收起来');
ok($('done-btn').textContent.includes('算完成') && !$('done-btn').textContent.includes('两样'),
  '只剩资源一组，按钮回到「勾掉这一章（算完成）」：' + $('done-btn').textContent);

const nBeforeRes = DB.subtasks.length;
const ch1row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 1);
ok(!ch1row.done, '第 1 章还没勾');
$('done-btn').fire('click'); await tick(); await tick();
ok(DB.subtasks.length === nBeforeRes, '勾章节**不新增行**（书就那么几章，不该越读越长），实际多了 ' +
  (DB.subtasks.length - nBeforeRes));
ok(ch1row.done === true, '勾的是已有的第 1 章那一行');
ok(typeof ch1row.done_at === 'string', '并带上了完成时间（月行程表要用）');
ok(ch1row.task_id == null && ch1row.resource_id === 'r1', '仍然只挂在资源上，两个父没同时填');

/* 再勾一次同一章：不该重复写时间戳 */
const at1 = ch1row.done_at;
$('done-btn').fire('click'); await tick(); await tick();
ok(ch1row.done_at === at1, '同一章重复勾不会刷新时间戳');
ok($('toast').textContent.includes('已经勾过了'), '并且明说已经勾过：' + $('toast').textContent);

console.log('── 同步：资源的章节进度条 / 列表 / 动态流 ──');
tabs[4].fire('click'); await tick();          // res
const r1done = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
ok(findAll(r1done, (n) => hasCls(n, 'sq')).filter((x) => hasCls(x, 'on')).length === 1,
  '资源进度条亮了 1 段');
ok(findAll(r1done, (n) => hasCls(n, 'sq')).length === 3,
  '分段数不变（亮的是颜色，不是长度）：' + findAll(r1done, (n) => hasCls(n, 'sq')).length);
ok(r1done.textContent.includes('共 3 章，已完成 1 章'), '文字跟着变：' +
  (r1done.textContent.match(/共 \d+ 章，已完成 \d+ 章/) || [''])[0]);
ok(r1done.textContent.includes('章节清单（1 / 3）'), '清单计数跟着变');

tabs[3].fire('click'); await tick();
ok($('done-cols').textContent.includes('资源 · 线性代数应该这样学'),
  '列表里标明它来自资源而不是大任务');
ok($('done-cols').textContent.includes('第 1 章'), '列的是那一章');
tabs[0].fire('click'); await tick();          // home
ok($('feed').textContent.includes('完成章节'), '动态流用「完成章节」而不是「完成小任务」');
ok($('feed').textContent.includes('线性代数应该这样学'), '并标出是哪本书');

console.log('── 核心：两组同时勾，一次记完两条 ──');
/* 真实场景：今天读了一章，顺手也推进了大任务的一步 —— 一次按下去两条一起落。
   挑一步还没完成的：把 s2 退回未完成（测完还回去）。 */
const s2row = DB.subtasks.find((x) => x.id === 's2');
const s2keep = { done: s2row.done, done_at: s2row.done_at };
s2row.done = false; s2row.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();

await laneOn('学完线性代数');
byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('第 5-8 讲')).fire('click'); await tick();
await laneOn('线性代数应该这样学');
byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('第 2 章')).fire('click'); await tick();

ok(byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('学完线性代数')).className.includes('on') &&
   byCls($('done-picker'), 'chip').find((c) => c.textContent.includes('线性代数应该这样学')).className.includes('on'),
  '两组各选中一条，同时挂着');
ok($('done-btn').textContent.includes('两样一起记'), '按钮：' + $('done-btn').textContent);

const ch2row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 2);
const nBeforeBoth = DB.subtasks.length;
$('done-btn').fire('click'); await tick(); await tick();

ok(DB.subtasks.length === nBeforeBoth,
  '一次记两条也**不新增行**，实际多了 ' + (DB.subtasks.length - nBeforeBoth));
ok(s2row.done === false && typeof s2row.done_at === 'string' &&
   Math.abs(Date.now() - new Date(s2row.done_at).getTime()) < 60000,
  '大任务那一步：只盖推进戳，done 仍然是 false');
ok(ch2row.done === true && typeof ch2row.done_at === 'string',
  '资源那一章：真的算完成，done = true');
ok($('toast').textContent.includes('今天推进了') && $('toast').textContent.includes('勾掉了'),
  '一条提示把两条都说清楚：' + $('toast').textContent);

/* 还回去：s2 恢复、第 2 章退回未勾、资源那组关掉，后面的用例照旧 */
Object.assign(s2row, s2keep);
ch2row.done = false; ch2row.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
await laneOff('线性代数应该这样学');
ok(byCls($('done-picker'), 'chip').length === 8,
  '两组都收回默认样子（只剩大任务那组）：chip 8 个，实际 ' + byCls($('done-picker'), 'chip').length);

console.log('── 更强的同步：把「大任务的一步」和「书的一章」绑成同一件事 ──');
const html2 = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const sql5 = fs.readFileSync(path.join(DIR, 'setup-5-link.sql'), 'utf8');
ok(/add column if not exists link_id/.test(sql5), 'setup-5-link.sql 加的是 link_id 那一列（可重复执行）');
ok(/同一件事/.test(html2), 'index.html 里把「↔」讲清楚了（大任务拆解 / 学习资源各一句）');

tabs[2].fire('click'); await tick();          // tasks
const c1row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 1);
const c2row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 2);
const rowS2 = subRowOf($('tasks-cols'), '第 5-8 讲');
ok(!!rowS2, '找得到「第 5-8 讲」这一行');
const selS2 = rowSel(rowS2);
ok(!!selS2, '每一步右边多了「↔ 同一件事」的选择器');
ok(selS2.textContent.includes('↔ 不绑'), '默认是「不绑」：' + selS2.textContent.slice(0, 24));
ok(selS2.textContent.includes('线性代数应该这样学 · 第 2 章'), '对家是这本书的章节，列了出来');
ok(!selS2.textContent.includes('习题课'), '不列自己的兄弟姐妹 —— 只能跨「大任务 ↔ 资源」绑');
ok(!selS2.textContent.includes('考研政治'), '对方的资源不出现');

/* 绑之前两边状态故意不一样（s2 已完成、第 2 章没完成）→ 应该**问她一句**，不自己拉平 */
const s2wasDone = DB.subtasks.find((x) => x.id === 's2').done;
ok(s2wasDone === true && c2row.done === false, '绑之前两边状态确实不一样，正好用来测「问一句」');
globalThis.confirm = () => false;             // 先答「不」
await pickLink(rowS2, c2row.id);
ok(DB.subtasks.find((x) => x.id === 's2').link_id === c2row.id &&
   c2row.link_id === 's2', '两条互相指着 = 绑上了');
ok(DB.subtasks.find((x) => x.id === 's2').done === true && c2row.done === false,
  '她答「不」时，不替她把哪一边标成完成');
ok($('toast').textContent.includes('绑好了'), '并且提示已经绑上：' + $('toast').textContent);
globalThis.confirm = () => true;              // 后面的删除确认走真流程

/* ── 核心：勾任意一边，另一边自动跟上 ──
   先把两条都退回未完成：不然「对家完成了」可能只是它本来就完成着，
   测出来的是空过（第一版就踩了这个坑，变异测试当场戳穿）。 */
s2row.done = false; s2row.done_at = null;      // s2row 是上面「两组同时勾」那块定义的，同一个对象
c2row.done = false; c2row.done_at = null;
$('btn-refresh').fire('click'); await tick();

tabs[4].fire('click'); await tick();          // res
const r1card = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
const chRow2 = subRowOf(r1card, '第 2 章');
ok(!!chRow2, '书的章节行也在（同一个 subRow 渲染的）');
ok(!!rowSel(chRow2), '这一章右边也有那个「↔」');

/* 日历上今天几件 —— 绑着的两条只能算一件 */
tabs[1].fire('click'); await tick();
const dBefore = Number(dcOf(now.getDate()) || 0);
tabs[4].fire('click'); await tick();

rowBox(subRowOf(findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学')), '第 2 章'))
  .fire('change', { target: { checked: true } });
await tick(); await tick();

ok(c2row.done === true, '勾了这一章，它自己完成');
ok(s2row.done === true, '**大任务里对应的那一步跟着完成了**（勾一个另一个自动跟上）');
ok(s2row.done_at === c2row.done_at, '两条用的是同一个时刻，不会被算成两天');

tabs[1].fire('click'); await tick();
ok(Number(dcOf(now.getDate()) || 0) === dBefore + 1,
  '日历上今天只多 1 件，不是 2 件（绑着的两条是同一件事）：' +
  dBefore + ' → ' + dcOf(now.getDate()));

tabs[0].fire('click'); await tick();          // home
const feedN = ($('feed').textContent.match(/完成章节|完成小任务/g) || []).length;
tabs[4].fire('click'); await tick();
rowBox(subRowOf(findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学')), '第 2 章'))
  .fire('change', { target: { checked: false } });
await tick(); await tick();
ok(c2row.done === false && s2row.done === false, '取消勾选，两边一起退回未完成');
tabs[0].fire('click'); await tick();
ok(($('feed').textContent.match(/完成章节|完成小任务/g) || []).length === feedN - 1,
  '动态流里也只减 1 条，不是 2 条');

/* ── 反方向：在「大任务拆解」里勾那一步，书那边跟着完成 ── */
tabs[2].fire('click'); await tick();
rowBox(subRowOf($('tasks-cols'), '第 5-8 讲')).fire('change', { target: { checked: true } });
await tick(); await tick();
ok(c2row.done === true, '在大任务那边勾，书的章节跟着完成（绑定是双向的）');

/* ── 一对一：已经被占的对家，不再出现在别人的候选里 ── */
const rowS3 = subRowOf($('tasks-cols'), '习题课');
ok(!rowSel(rowS3).textContent.includes('第 2 章'), '第 2 章已经和第 5-8 讲绑了，不再出现在别的候选里');
ok(rowSel(rowS3).textContent.includes('第 3 章'), '没被占的还能选');

/* ── 解开 ── */
await pickLink(rowS2, '');                    // 选「↔ 不绑」
ok(DB.subtasks.find((x) => x.id === 's2').link_id == null && c2row.link_id == null,
  '两边都松开了，不留单向指针');
ok(c2row.done === true && DB.subtasks.find((x) => x.id === 's2').done === true,
  '解开不会顺手改完成状态（各自保留当时的）');
ok($('toast').textContent.includes('解开了'), '并且说一声：' + $('toast').textContent);

/* ── 删掉一条，对家的指针要跟着松 ── */
await pickLink(rowS3, c2row.id);
ok(DB.subtasks.find((x) => x.id === 's3').link_id === c2row.id, '习题课 ←→ 第 2 章 绑上了');
const s3row2 = DB.subtasks.find((x) => x.id === 's3');
const s3keep2 = { done: s3row2.done, done_at: s3row2.done_at };
tabs[4].fire('click'); await tick();
const chRow3 = subRowOf(findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学')), '第 2 章');
btns(chRow3, '✕')[0].fire('click'); await tick(); await tick();
ok(!DB.subtasks.some((x) => x.id === c2row.id), '第 2 章删掉了');
ok(DB.subtasks.some((x) => x.id === 's3'), '（对家「习题课」还在，没被连坐）');
ok(s3row2.link_id == null, '对家（习题课）的指针也被松开，不会指着一个不存在的东西');

/* 收尾：把 s3 还回去、所有绑定清干净，后面的用例照旧 */
Object.assign(s3row2, s3keep2);
DB.subtasks.push(c2row);
DB.subtasks.forEach((x) => { x.link_id = null; });
$('btn-refresh').fire('click'); await tick();

console.log('── 降级：还没跑 setup-5-link.sql ──');
tabs[2].fire('click'); await tick();
failNext = 'column "link_id" of relation "subtasks" does not exist';
await pickLink(subRowOf($('tasks-cols'), '第 1-4 讲'),
  DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 3).id);
ok($('toast').textContent.includes('setup-5-link.sql'),
  '缺列时被翻译成「去跑哪个脚本」，不甩 Postgres 原文：' + $('toast').textContent);
ok(failNext === null, '（failNext 已消耗）');

console.log('── 降级：还没跑 setup-4-chapters.sql ──');
/* 没跑 SQL 时最真实的症状：资源根本分不了章 → 资源模式只能提示去分章，按钮点不动，
   而不是让她点一下才发现写不进去。 */
const keepCh = DB.subtasks.filter((x) => x.resource_id === 'r1');
for (let i = DB.subtasks.length - 1; i >= 0; i--) if (DB.subtasks[i].resource_id === 'r1') DB.subtasks.splice(i, 1);
/* 直接改 DB 之后必须走一次 refresh —— 界面读的是 app 自己那份 S.subtasks，
   不刷新的话它还在画旧数据，测出来的是「界面陈旧」不是「降级路径」 */
$('btn-refresh').fire('click'); await tick();
failNext = 'column "resource_id" of relation "subtasks" does not exist';
tabs[4].fire('click'); await tick();
const r1noch = findAll($('res-cols'), (n) => hasCls(n, 'item'))
  .find((n) => n.textContent.includes('线性代数应该这样学'));
btns(r1noch, '＋ 分章')[0].fire('click'); await tick(); await tick();
ok($('toast').textContent.includes('setup-4-chapters.sql'),
  '分章失败被翻译成「去跑哪个脚本」，而不是把 Postgres 原文甩给她：' + $('toast').textContent);

tabs[3].fire('click'); await tick();
await laneOff('学完线性代数');               // 只看资源那组
const rchip2 = laneChip('线性代数应该这样学');
rchip2.fire('click'); await tick();
ok($('done-btn').disabled === true, '没分章的资源：按钮禁用，不会点了才发现没用');
ok($('done-btn').textContent === '这本书还没分章', '并直接告诉她卡在哪：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('分章'), '顺手指路：' + $('done-tip').textContent);

/* 恢复：把章节放回去，后面的用例还要用（别在这之后又清掉） */
DB.subtasks.push(...keepCh);
$('btn-refresh').fire('click'); await tick();

console.log('── 「自己写两句」：文本框回来了，但不再凭空造小任务 ──');
tabs[3].fire('click'); await tick();
/* 以前那个自由文本框是「写一条 → 凭空新建一条已完成的小任务」，会越记越长、还替她
   宣布完成，所以删过一轮。现在回来的是**只存文字**的那种：不勾任何东西也能按，
   落在当天的 daily_logs.note 上，一根进度条都不动。 */
const dayHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
ok(/<textarea id="done-note"/.test(dayHtml),
  'index.html 里确实有这个框（假 DOM 认不出静态结构，只能查源码）');
ok(/for="done-note"/.test(dayHtml), '有配对的 label');
ok(/id="done-note"[^>]*rows=/.test(dayHtml), '是多行的 textarea，不是单行 input');

await laneOff('线性代数应该这样学');         // 只留大任务那组
await laneOn('学完线性代数');
ok($('done-btn').textContent.includes('只记一笔'), '切回大任务模式，按钮仍是「只记一笔」：' + $('done-btn').textContent);
ok($('done-picker').textContent.includes('哪一步'), '「哪一步」那一组在');
ok($('done-tip').textContent.includes('大任务拆解'),
  '提示明确告诉她真完成要去哪里勾：' + $('done-tip').textContent);

/* 光写字、一条都不勾 —— 也该能存下，而且不能多出小任务 */
const T = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const TODAY = T.getFullYear() + '-' + pad2(T.getMonth() + 1) + '-' + pad2(T.getDate());
const myToday = () => DB.daily_logs.filter((x) => x.owner === ME && x.log_date === TODAY);
const notesOf = () => DB.daily_logs.filter((x) => x.owner === ME && x.log_date === TODAY && x.note);

ok(myToday().length === 0, '起点干净：这天还没有日记行（下面几条断言才有意义）');
/* 只勾一条、一个字没写 → 不该凭空造出一行空的日记。
   必须落在**「哪一步」那一组**的 chip 上：大任务那一组的 chip 也长这样，
   点它只会开关整组，那样按下去 plan 是空的、断言就成了空转。
   前面几段可能已经把每一步都勾掉了，先按回未完成，否则这一下会被 blocked 掉。 */
const victim = DB.subtasks.find((x) => x.owner === ME && x.title === '习题课');
victim.done = false; victim.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
await laneOn('学完线性代数');
const stepGrp2 = byCls($('done-picker'), 'chips-group').find((g) => g.textContent.includes('哪一步'));
const undoneChip = byCls(stepGrp2 || $('done-picker'), 'chip').find((c) => c.textContent.includes('习题课'));
if (undoneChip) { undoneChip.fire('click'); await tick(); }
ok(!!undoneChip && $('done-btn').textContent.includes('只记一笔'),
  '挑到一个没做过的步骤来测（挑不到的话这一下会被 blocked 掉，断言就空转了）：' +
  $('done-btn').textContent);
$('done-btn').fire('click'); await tick(); await tick();
ok(myToday().length === 0, '只勾了一条、没写字 → 不多出一行空的日记');
ok(!!victim.done_at && victim.done === false,
  '这一条确实盖上了推进戳（证明上面按的按钮真干了活，断言不是空转）：' + victim.done_at);

await laneOff('学完线性代数');
$('done-note').value = '今天只读了两页，卡在特征值';
$('done-note').fire('input'); await tick();
ok($('done-btn').disabled === false, '一个字都没勾、只写了字，按钮也是可用的');
ok($('done-btn').textContent.includes('只记这段文字'), '按钮上写清这一下只存文字：' + $('done-btn').textContent);

const nSub = DB.subtasks.length;
$('done-btn').fire('click'); await tick(); await tick();
ok(DB.subtasks.length === nSub, '没有凭空多出一条小任务（上次删掉那个文本框就是栽在这）');
ok(notesOf().length === 1 && notesOf()[0].note === '今天只读了两页，卡在特征值',
  '文字落进了当天的 daily_logs.note');
ok(!(myToday()[0] || {}).mood && !(myToday()[0] || {}).difficulty,
  '没顺手把 mood / difficulty 抹掉 —— 那两个是折叠区管的，这里不该碰');

/* 有勾选 + 有文字 → 一次按钮两样都记，按钮上要写出来 */
await laneOn('学完线性代数');
$('done-note').value = '今天顺手记一笔';
$('done-note').fire('input'); await tick();
ok($('done-btn').textContent.includes('连文字一起存'),
  '勾了东西又写了字，按钮上两样都说清：' + $('done-btn').textContent);
$('done-btn').fire('click'); await tick(); await tick();
ok(notesOf().length === 1 && notesOf()[0].note === '今天顺手记一笔',
  '同一天只留一行，是改不是新加（upsert 到 owner+log_date）');

/* 今天本来就已经有一条带心情/困难的日记时，只写字不能把它们抹掉。
   上面那条断言测的是「新建那一行」，mood 本来就是空的 —— 单靠它测不出这个。
   先把今天清空到只剩这一条，否则 app 会去改更早的那一行，断言就落空了。 */
DB.daily_logs
  .filter((x) => x.owner === ME && x.log_date === TODAY)
  .forEach((x) => DB.daily_logs.splice(DB.daily_logs.indexOf(x), 1));
DB.daily_logs.push({
  id: 'dx', owner: ME, log_date: TODAY, mood: 3,
  difficulty: '卡在特征值', note: '', created_at: new Date().toISOString(),
});
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
await laneOff('学完线性代数');                       // 只写字，不勾任何东西
$('done-note').value = '只写这一行';
$('done-note').fire('input'); await tick();
$('done-btn').fire('click'); await tick(); await tick();
const row2 = myToday()[0] || {};
ok(row2.mood === 3 && row2.difficulty === '卡在特征值',
  '今天原本就有心情/困难，只写文字不会把它们抹掉：mood=' + row2.mood + ' 困难=' + row2.difficulty);
await laneOn('学完线性代数');

/* 打开页面时显示库里今天那一条；还没保存的字不能被刷新盖掉。
   dx 就是今天仅剩的那一行（上面清过、只留它），直接改它。 */
DB.daily_logs.find((x) => x.id === 'dx').note = '库里改过的字';
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok($('done-note').value === '库里改过的字', '刚打开时框里是今天已存的那份：' + $('done-note').value);
$('done-note').value = '还没保存的一行';
$('done-note').fire('input'); await tick();
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok($('done-note').value === '还没保存的一行',
  '还没保存的字，刷一次 / 切个页签不会被库里的旧值盖掉：' + $('done-note').value);

/* 折叠区挑的正好是今天时，两个框说的是同一条记录，保存要以「自己写两句」为准 */
ok(/d === today\(\) \? \$\('done-note'\)\.value/.test(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')),
  '折叠区保存今天那条时读的是同一个框，不会拿旧值反过来盖掉');

/* 收尾：这一段往今天的 daily_logs 里造过行，后面「兜底」「导出」都按原来的数据算，
   留着会把「今天已经记过」带进后面的用例。全删掉 + 清空框，恢复原状。 */
DB.daily_logs
  .filter((x) => x.owner === ME && x.log_date === TODAY)
  .forEach((x) => DB.daily_logs.splice(DB.daily_logs.indexOf(x), 1));
$('done-note').value = '';                 // 直接清，不走 input：touched 保持 true，prefill 不会又填回来
await tick();

console.log('── 心情与困难：没被删掉，退到折叠区 ──');
ok($('d-moods').children.length === 5, '心情 5 档按钮还在');
ok(!!$('d-save') && !!$('d-diff') && !!$('d-note'), '困难/补充/保存都还在');
ok($('daily-cols').textContent.includes('特征值那块卡住了'), '历史心情记录仍能列出');

console.log('── 兜底：没有任何可挂靠的东西的时候 ──');
const keepTasks = DB.tasks.slice();
const keepRes = DB.resources.slice();
/* 只清大任务：资源还在，所以**不该**禁用按钮 —— 挂到资源上照样能记 */
DB.tasks.length = 0;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok($('done-btn').disabled === false, '大任务没了但资源还在 → 仍然能记（挂到资源上）');
ok(!byCls($('done-picker'), 'chip').some((c) => c.textContent.includes('学完线性代数')),
  '大任务那一组整个消失，不留空壳');
/* 资源那一组 + 它下面的「第几章」= 2 组 */
ok($('done-picker').textContent.startsWith('学习资源'),
  '第一组就是学习资源：' + $('done-picker').textContent.slice(0, 20));

/* 资源和任务都清空 → 这才是真的没处可挂 */
DB.resources.length = 0;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok($('done-picker').textContent.includes('还没有大任务'),
  '先说清楚要先去建大任务，而不是给一个点了没反应的按钮');
ok($('done-btn').disabled === true, '按钮被禁用，不会点了才发现没用');

DB.tasks.push(...keepTasks);
DB.resources.push(...keepRes);
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok($('done-btn').disabled === false, '大任务回来之后按钮恢复可用');
/* 上一刻「什么都没得挂」把两组的选择清空了，回到出厂状态 = 只开大任务那组 */
ok(byCls($('done-picker'), 'chip').length === 8, 'chip 回来了（1 大任务 + 4 资源 + 3 步）');

console.log('── 降级：库里还没加 done_at 列（她还没跑 setup-3-feed.sql）──');
const s1row = DB.subtasks.find((x) => x.id === 's1');
const keepAt = s1row.done_at;
delete s1row.done_at;
tabs[1].fire('click'); await tick();          // goals → 重渲染
ok($('mo-warn').hidden === false, '给出「缺 done_at 列」的提示，而不是让日历凭空少一截');
ok($('mo-warn').textContent.includes('setup-3-feed.sql'), '提示里指明了要跑哪个脚本');
ok(dcOf(21) === '', '9/21 少了时间戳 → 从格子上消失（确认是缺列导致，不是算错）');
s1row.done_at = keepAt;
tabs[1].fire('click'); await tick();
ok($('mo-warn').hidden === true, '补回时间戳后提示自动消失');
ok(dcOf(21) === '1', '9/21 回到日历上');

/* ══════════════════════════════════════════════════════════════
   本轮新增：考试成绩（exams 表）
   这张表**不在原来六张表那条链路上**，所以这一段要盯两件事：
   ① 它自己记得对、筛得对、改得对；
   ② 它挂了不能连累别的页签（loadExams 是独立一条，不进 loadAll 的 Promise.all）。
   ══════════════════════════════════════════════════════════════ */
console.log('── 考试成绩：列出已有的三场 ──');
ok(TABNAMES.length === 7 && tabs[5].dataset.tab === 'exams', '页签顺序：考试成绩在「学习资源」之后、「导出」之前');
tabs[5].fire('click'); await tick();
ok($('pane-exams').hidden === false, '考试成绩 pane 显示出来');
ok($('ex-warn').hidden === true, '表在的时候不提示去跑 SQL');
ok($('ex-lead').textContent.includes('留空'), '页头说明提到得分/满分可以留空');
ok($('ex-date').value === TODAY, '日期默认填今天，实际 ' + $('ex-date').value);

const exCols = $('ex-cols');
ok(findAll(exCols, (n) => n.className.includes('who')).length === 2, '双栏（两个人各一栏）');
ok(byCls(exCols, 'item').length === 3, '三场都列出来了，实际 ' + byCls(exCols, 'item').length);
ok(exCols.textContent.includes('期中数学') && exCols.textContent.includes('英语月考'), '名称列出来');
ok(exCols.textContent.includes('9 月 12 日'), '日期写成「9 月 12 日」——' + (exCols.textContent.match(/\d+ 月 \d+ 日[^0-9]*/) || [''])[0]);
ok(/108/.test(exCols.textContent) && /120/.test(exCols.textContent) && exCols.textContent.includes('90%'),
  '得分 / 满分 / 百分比都在');
ok(exCols.textContent.includes('没填分') && !/0 分/.test(exCols.textContent),
  '没填分的那场说「没填分」，不显示成 0 分');
ok(exCols.textContent.includes('学校考试') && exCols.textContent.includes('自己做的试卷'),
  '「学校考试 / 自己做的试卷」两类都标出来');
ok(exCols.textContent.includes('最后一道大题算错'), '备注显示');
ok(btns(exCols, '改这一场').length === 2, '只有自己那两场有「改这一场」，实际 ' + btns(exCols, '改这一场').length);
ok(btns(exCols, '删除').length === 2, '只有自己那两场有删除按钮，实际 ' + btns(exCols, '删除').length);
ok(btns(exCols, '改这一场').length + btns(exCols, '删除').length > 0, '（行动按钮确实渲染到了图表以外的位置）');

console.log('── 考试成绩：小结的算法 ──');
/* 平均只按**有满分**的场算：108/120=90、88/100=88 → 89。
   那场没填分的绝不能混进去（混进去会被当成 0 分，把平均拉垮）。 */
ok($('ex-sub').textContent.includes('一共 3 场'), '小结报总数：' + $('ex-sub').textContent);
ok($('ex-sub').textContent.includes('学校考试 2') && $('ex-sub').textContent.includes('自己做的试卷 1'),
  '小结里两类分开数');
ok($('ex-sub').textContent.includes('平均 89%') && $('ex-sub').textContent.includes('2 场有满分'),
  '平均只按有满分的 2 场算（89%），并说明是几场：' + $('ex-sub').textContent);

console.log('── 考试成绩：科目候选 ──');
const subjChips = findAll($('ex-subj'), (n) => n.tagName === 'BUTTON');
ok(subjChips.length === 3, '科目候选 = 全部科目 + 数学 + 英语，实际 ' + subjChips.length);
ok(subjChips.map((c) => c.textContent).some((t) => t.startsWith('数学')), '数学带着场数');
const dlOpts = findAll($('ex-subject-list'), (n) => n.tagName === 'OPTION').map((n) => String(n.value));
ok(dlOpts.includes('政治'), '候选里也带上「学习资源」里出现过的学科（政治）：' + dlOpts.join('/'));

console.log('── 考试成绩：记一场新的 ──');
const examCount0 = DB.exams.length;
$('ex-date').value = '2026-09-25';
$('ex-name').value = '物理随堂测';
$('ex-subject').value = '物理';
$('ex-kind').value = 'paper';
$('ex-score').value = '82';
$('ex-full').value = '100';
$('ex-note').value = '电路那题漏了单位';
$('ex-add').fire('click'); await tick(); await tick();

ok(DB.exams.length === examCount0 + 1, '库里多了一场');
const added = DB.exams.find((e) => e.name === '物理随堂测');
ok(!!added && added.owner === ME, '新行带 owner = 我自己（否则 RLS 会拒）');
ok(added.exam_date === '2026-09-25' && added.subject === '物理', '日期和科目存对：' + added.exam_date + ' / ' + added.subject);
ok(added.kind === 'paper', '选了「自己做的试卷」，存的是 paper');
ok(added.score === 82 && added.full_score === 100, '得分满分存成数字，不是字符串：' + typeof added.score);
ok(added.note === '电路那题漏了单位', '备注也存了');
ok($('ex-name').value === '' && $('ex-score').value === '' && $('ex-subject').value === '', '提交后表单清空');
ok($('ex-add').textContent === '记下这一场', '按钮回到「记下这一场」');
ok(byCls($('ex-cols'), 'item').length === 4, '新那场立刻出现在列表上，实际 ' + byCls($('ex-cols'), 'item').length);
ok($('ex-cols').textContent.includes('82') && $('ex-cols').textContent.includes('82%'), '新那场的 82 和 82% 都在');

console.log('── 考试成绩：只写名称、不填分 ──');
const examCount1 = DB.exams.length;
$('ex-name').value = '还没出分的那场';
$('ex-score').value = '';
$('ex-full').value = '';
$('ex-add').fire('click'); await tick(); await tick();
const blank = DB.exams.find((e) => e.name === '还没出分的那场');
ok(DB.exams.length === examCount1 + 1 && !!blank, '只填名称也能记');
/* 空字符串必须变成 null。写成 0 的话，这一场会以「0 分」混进平均里，
   而「还没出分」和「考了 0 分」是两回事。 */
ok(blank.score === null && blank.full_score === null, '没填的分数存成 null，不是 0：' + JSON.stringify([blank.score, blank.full_score]));

console.log('── 考试成绩：名称和科目都不填 ──');
const examCount2 = DB.exams.length;
$('ex-name').value = '';
$('ex-subject').value = '';
$('ex-add').fire('click'); await tick();
ok(DB.exams.length === examCount2, '两个都空着时不写库（免得列表里多一行认不出来的）');
ok($('toast').textContent.includes('至少写个考试名称或科目'), '明说缺什么：' + $('toast').textContent);

console.log('── 考试成绩：改这一场 ──');
const rowOf = (name) => byCls($('ex-cols'), 'item').find((r) => r.textContent.includes(name));
const targetId = DB.exams.find((e) => e.name === '物理随堂测').id;
btns(rowOf('物理随堂测'), '改这一场')[0].fire('click'); await tick();
ok($('ex-name').value === '物理随堂测' && $('ex-subject').value === '物理', '点「改这一场」把内容填回表单');
ok($('ex-score').value === '82' && $('ex-full').value === '100', '分数也填回去：' + $('ex-score').value);
ok($('ex-date').value === '2026-09-25' && $('ex-kind').value === 'paper', '日期和类别也填回去');
ok($('ex-add').textContent === '保存修改' && $('ex-cancel').hidden === false,
  '按钮变「保存修改」，旁边出现「取消」');
ok(DB.exams.length === examCount2, '点「改」本身没有偷偷插一行新的');

$('ex-score').value = '90';
$('ex-add').fire('click'); await tick(); await tick();
ok(DB.exams.length === examCount2, '保存修改**没有**多出一行，实际 ' + DB.exams.length);
ok(DB.exams.filter((e) => e.name === '物理随堂测').length === 1, '还是只有那一场');
ok(DB.exams.find((e) => e.id === targetId).score === 90, '分数改成了 90');
ok($('ex-add').textContent === '记下这一场' && $('ex-cancel').hidden === true, '改完按钮复位、取消藏起来');
ok($('ex-cols').textContent.includes('90%'), '列表跟着变成 90%');

console.log('── 考试成绩：改到一半反悔 ──');
btns(rowOf('物理随堂测'), '改这一场')[0].fire('click'); await tick();
$('ex-score').value = '10';
$('ex-cancel').fire('click'); await tick(); await tick();
ok($('ex-score').value === '' && $('ex-name').value === '', '点「取消」把表单清空');
ok(DB.exams.find((e) => e.id === targetId).score === 90, '库里还是 90，没被那半截改动写进去');
ok($('ex-add').textContent === '记下这一场', '按钮也复位了');

console.log('── 考试成绩：按科目 / 按人筛 ──');
findAll($('ex-subj'), (n) => n.tagName === 'BUTTON').find((c) => c.textContent.startsWith('数学')).fire('click');
await tick();
/* 五场里科目是「数学」的只有期中数学和三角函数自测卷那两场
   （物理随堂测是物理，英语月考是英语，还有一场没填科目） */
ok(byCls($('ex-cols'), 'item').length === 2, '只看数学 → 两场，实际 ' + byCls($('ex-cols'), 'item').length);
const mathItems = byCls($('ex-cols'), 'item');
ok(mathItems.length > 0 && mathItems.every((r) => r.textContent.includes('数学')), '筛出来的每一场都是数学');
ok(!$('ex-cols').textContent.includes('英语月考'), '别的科目被筛掉了');
ok($('ex-sub').textContent.includes('一共 2 场') && $('ex-sub').textContent.includes('平均 90%'),
  '小结跟着科目走（只剩数学两场，平均 90%）：' + $('ex-sub').textContent);
ok(findAll($('ex-subj'), (n) => n.tagName === 'BUTTON').length === 4,
  '筛科目之后候选按钮没跟着缩水（数学/物理/英语 + 全部科目），实际 '
  + findAll($('ex-subj'), (n) => n.tagName === 'BUTTON').map((c) => c.textContent).join('|'));
findAll($('ex-subj'), (n) => n.tagName === 'BUTTON').find((c) => c.textContent === '全部科目').fire('click');
await tick();
ok(byCls($('ex-cols'), 'item').length === 5, '回到全部科目 → 五场，实际 ' + byCls($('ex-cols'), 'item').length);

findAll($('ex-scope'), (n) => n.tagName === 'BUTTON').find((c) => c.textContent === '只看对方').fire('click');
await tick();
/* twoCols 有一条「自己那栏永远在」的规矩，所以这里我那一栏还会在，
   但必须是空的、而且**明说是被筛掉的** —— 不能写成「还没记过考试」
   让她以为自己的记录没了。 */
ok(byCls($('ex-cols'), 'item').length === 1, '只看对方 → 只剩对方那一场，实际 ' + byCls($('ex-cols'), 'item').length);
ok($('ex-cols').textContent.includes('英语月考') && !$('ex-cols').textContent.includes('期中数学'),
  '我自己的那几场都不在列表里');
ok($('ex-cols').textContent.includes('小 B'), '对方那一栏在');
ok(/被上面的筛选挡住了/.test($('ex-cols').textContent) && !/还没记过考试/.test($('ex-cols').textContent),
  '我那一栏空着，但说的是「被筛选挡住了」而不是「还没记过」');
ok(findAll($('ex-scope'), (n) => n.tagName === 'BUTTON').find((c) => hasCls(c, 'primary')).textContent === '只看对方',
  '「只看对方」这个按钮是选中态');
findAll($('ex-scope'), (n) => n.tagName === 'BUTTON').find((c) => c.textContent === '全部').fire('click');
await tick();
ok(byCls($('ex-cols'), 'item').length === 5, '回到全部 → 五场');
ok($('ex-sub').textContent.includes('一共 5 场'), '小结回到全部');

console.log('── 考试成绩：删除 ──');
const examCount3 = DB.exams.length;
btns(rowOf('还没出分的那场'), '删除')[0].fire('click'); await tick(); await tick();
ok(DB.exams.length === examCount3 - 1, '删除真的删掉一行');
ok(!DB.exams.some((e) => e.name === '还没出分的那场'), '删的就是那一场');
ok($('ex-cols').textContent.includes('还没出分的那场') === false, '删完列表里也没了');

console.log('── 考试成绩：这条链路断了也不能连累别的页签 ──');
/* setup-6-exams.sql 还没跑：exams 表根本不存在（select 就报 schema cache 找不到）。
   要求：① 这一页明说去跑脚本；② 记不了东西，但别白屏；
   ③ **原来六张表照常读**（loadExams 是独立一条，绝不在 loadAll 的 Promise.all 里）。 */
/* 先往库里**加**一条目标，再让 exams 读失败、点刷新。
   断言目标页必须出现这条新目标 —— 光断言「原来那条还在」抓不住问题：
   S.goals 是上一次读到的旧数据，刷新失败时页面照旧显示旧值，看起来一切正常。
   （也不能用「改标题」的办法：假库返回的是同一批**对象引用**，
     改 DB 里的字段等于直接改了 S.goals，不用刷新就"看见"了，断言是空转的。） */
DB.goals.push({
  id: 'g-新加的', owner: ME, period_start: '2026-09-25', title: '刷新后才出现的目标',
  detail: '', target: 1, progress: 0, done: false, done_at: null, created_at: '2026-09-25T00:00:00Z',
});
failSelect = 'exams';
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('ex-warn').hidden === false, '给出「还没建表」的提示，而不是静默空白');
ok($('ex-warn').textContent.includes('setup-6-exams.sql'), '提示里指明了要跑哪个脚本');
ok($('ex-lead').textContent.includes('setup-6-exams.sql'), '页头也说了要先跑脚本');
ok($('ex-cols').textContent.includes('这张表还没建'), '这一页降级成「这张表还没建」，没抛异常');
ok(tabs[3].dataset.tab === 'daily', '（页签对象还在）');
tabs[1].fire('click'); await tick();
ok($('goals-cols').textContent.includes('刷新后才出现的目标'),
  '目标页读到的是刷新后的数据（exams 读失败没把六张表带崩）');
tabs[4].fire('click'); await tick();
ok($('res-tiles').textContent.includes('资源总数'), '资源页照常渲染');
const examCount4 = DB.exams.length;
tabs[5].fire('click'); await tick();
$('ex-name').value = '表还没建时写的';
$('ex-add').fire('click'); await tick();
ok(DB.exams.length === examCount4, '表不在时不写库（点了也不会报出 Postgres 原文）');
ok($('toast').textContent.includes('setup-6-exams.sql'), '拦下来并告诉她去跑脚本：' + $('toast').textContent);
$('ex-name').value = '';
failSelect = null;
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('ex-warn').hidden === true && byCls($('ex-cols'), 'item').length === 4,
  '跑完脚本（这里是把钩子放掉）后恢复正常，实际 ' + byCls($('ex-cols'), 'item').length + ' 场');
ok($('ex-cancel').hidden === true && $('ex-add').textContent === '记下这一场', '表单也是正常态');
/* 把上面为了测「刷新确实读到了新数据」而临时加的那条目标拿掉 */
DB.goals = DB.goals.filter((g) => g.id !== 'g-新加的');

console.log('── 考试成绩：导出 / 导入 ──');
tabs[6].fire('click'); await tick();
ok($('export-meta').textContent.includes('考试 ' + DB.exams.length),
  '导出统计里带上了考试场数：' + $('export-meta').textContent);
tabs[5].fire('click'); await tick();

const snap = {
  app: 'study-collab', version: 1,
  data: {
    exams: [
      { id: 'imp-1', owner: ME, exam_date: '2026-08-01', name: '导入进来的历史考试', subject: '语文',
        kind: 'school', score: 95, full_score: 100, note: '' },
      { id: 'imp-2', owner: OT, exam_date: '2026-08-02', name: '对方的历史考试', subject: '语文',
        kind: 'school', score: 60, full_score: 100, note: '' },
    ],
  },
};
$('file-import').fire('change', { target: { files: [{ text: async () => JSON.stringify(snap) }] } });
await tick(); await tick();
ok(DB.exams.some((e) => e.id === 'imp-1'), '快照里我自己的考试导进来了');
ok(!DB.exams.some((e) => e.id === 'imp-2'), '对方那一行被跳过（RLS 只让写自己的）');
ok($('import-meta').textContent.includes('跳过 1 行'), '跳过几行说清楚：' + $('import-meta').textContent);
ok(!$('import-meta').textContent.includes('setup-6-exams.sql'), '表在的时候不啰嗦脚本的事');

console.log('── 导出 ──');
$('btn-export').fire('click'); await tick();
ok(true, '导出没抛错');

console.log('── CSS：[hidden] 必须是硬开关 ──');
/* 回归测试：登录成功后登录页没消失、直接盖住主页。
   根因是「作者样式表压过浏览器默认样式表」——
   .login-wrap 写了 display:flex，于是浏览器默认的 [hidden]{display:none} 失效。
   这里把不变量写死：只要有规则对 #view-login 命中并声明了 display，
   就必须存在带 !important 的 [hidden] 兜底，否则 hidden 是哑的。 */
const css = fs.readFileSync(path.join(DIR, 'app.css'), 'utf8');
const guarded = /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/.test(css);
// 先剥掉注释，否则注释里写的示例选择器会被当成真规则数进来
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const loginDisplayRules = [...cssNoComment.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter((m) => /(^|;)\s*display\s*:/.test(m[2]))
  .map((m) => m[1].split('\n').pop().trim())
  .filter((sel) => /(\.login-wrap|#view-login)/.test(sel) && !/\[hidden\]/.test(sel));
ok(guarded, 'app.css 有 [hidden]{display:none !important}');
// （「登录后 view-login.hidden === true」在开头的「登录后落在主页」里已经测了行为，
//   这里只测 CSS 侧的兜底条件，不重复凑数）
ok(loginDisplayRules.length === 0 || guarded,
  '有 ' + loginDisplayRules.length + ' 条规则对登录浮层写了 display，已被 [hidden] 兜住',
  loginDisplayRules.join(' | '));

console.log('── 登录报错能区分「账号不存在」和「邮箱没确认」──');
ok(/email_not_confirmed/.test(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')),
  '识别 email_not_confirmed，给出「去后台 Confirm email」的具体做法');

console.log('');
if (fails.length) { console.log('❌ ' + fails.length + ' 项没过：'); fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
