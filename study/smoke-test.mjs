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
  /* 真 input 失焦时会补一个 change（**只在值变过时**才发）。Enter 存 / Esc 还原
     全靠这条 —— 假 DOM 里没有它，「按 Enter 到底存没存」根本测不出来。
     focus() 记下进来时的值，blur() 跟前值比对，跟浏览器的 change 语义一致：
     没 focus 过就直接改 value 不算「用户输入」，不会补 change。 */
  focus() { this._atFocus = this.value; this.focusCount = (this.focusCount || 0) + 1; }
  blur() {
    const was = this._atFocus;
    this._atFocus = undefined;
    if (was !== undefined && was !== this.value) this.fire('change');
  }
  scrollIntoView() {}
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
/* 确认框改成**记账的**：删除这一路现在不弹框了，得能断言「一次都没问」。
   返回 true 保持老行为（还有几处正常流程仍会问她，比如「一圈状态不一致，
   要一起标完成吗」）。 */
let confirmCalls = 0;
globalThis.confirm = () => { confirmCalls++; return true; };

/* ── 把时钟往前拨 ────────────────────────────────────────────────
   删除是**延迟 5 秒真删**（那 5 秒是给她撤回的窗口）。真等 5 秒整个用例要多跑
   好几秒，所以把这类长定时器截下来攒着，runLongTimers() 一次性触发 —— 等价于
   「5 秒过去了」。短的（toast 自动收）照常走真的：它们每节都在用。 */
const LATE = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  (ms >= 4500 ? (LATE.push(fn), 0) : realSetTimeout(fn, ms, ...rest));
const runLongTimers = () => { LATE.splice(0).forEach((f) => f()); };

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
    select(cols) { st.cols = cols; return o; }, order() { return o; }, limit() { return o; },
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
        /* 'exams' → 整张表读不了；'goals:priority' → 只有「探这一列在不在」的那次读失败
           （loadPriorityCol 走的就是后者，列不存在时 PostgREST 报的是 column ... does not exist）。 */
        if (failSelect) {
          const [ft, fcol] = failSelect.split(':');
          if (st.op === 'select' && ft === table && (!fcol || String(st.cols || '').includes(fcol))) {
            failSelect = null;
            resolve({ data: null, error: { message: fcol
              ? 'column "' + fcol + '" does not exist'
              : "Could not find the table 'public." + table + "' in the schema cache" } });
            return;
          }
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
/* 记下订过哪些频道。「一张表一条频道」，频道名是 'study-' + 表名 ——
   没订某张表的话，那张表改了对方那台要手动刷新才看得到，
   而药丸上那句「已连接 · 实时同步」看不出来（少订一张也照样是「全连上了」）。 */
const channels = [];
globalThis.supabase = {
  createClient: () => ({
    from: (t) => qb(t),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: ME, email: 'a@example.com' } } }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: ME, email: 'a@example.com' } }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: (name) => { channels.push(name); return { on() { return this; }, subscribe(cb) { cb('SUBSCRIBED'); return this; } }; },
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

/* 资源卡片上的名称现在是**输入框**（就地可编辑，见 resRow），名字不在
   textContent 里 —— 按名字找那一行得看 input 的 value。 */
const byResName = (name) => find($('res-cols'), (n) => hasCls(n, 'item') && inputs(n).includes(name));
/* 断言 toast 之前先清一下。toast 那个节点是常驻的，文案会一直留到下一次
   （2600ms 的自动隐藏在这次运行里根本来不及触发）—— 不清的话，上一条的
   「已保存」能冒充这一条的，报错也好、成功也好都测不出来。 */
const clearToast = () => { $('toast').textContent = ''; };
/* 一张资源卡上那几件可以就地改的东西。必须**从对应的那一小块里取**：
   整张卡连同下面的章节行一起 walk 的话，章节行里的输入框和「↔」下拉都会捞进来。 */
const resNameInput  = (card) => { const t = card && byCls(card, 't')[0]; return (t && findAll(t, (n) => n.tagName === 'INPUT')[0]) || null; };
const resTextInputs = (card) => { const d = card && byCls(card, 'two').find((n) => hasCls(n, 'd')); return d ? findAll(d, (n) => n.tagName === 'INPUT') : []; };
const resSelects    = (card) => { const m = card && byCls(card, 'two').find((n) => hasCls(n, 'm')); return m ? findAll(m, (n) => n.tagName === 'SELECT') : []; };
/* 读下拉当前选中的那一项。真浏览器里 `select.value` 会跟着 `<option selected>` 走，
   假 DOM 不会（h() 遇到 `'selected' in El` 为假 → 走 setAttribute），所以两个都认。 */
const selVal = (sel) => {
  const o = findAll(sel, (n) => n.tagName === 'OPTION' && (n.selected === true || n.getAttribute('selected') != null))[0];
  return o ? o.value : '';
};

/* 「今日完成情况」的选择器 2026-09-26 改成了**父项、子项都是多选**，而且勾上父项
   **不会**替她预勾子项（勾哪几步 / 哪几章得自己点）。开还是关会跟着前面的用例变，
   写死「点一下就能选中」太脆 —— 一律按状态点：
     chipOn('学完线性代数')   父项：没勾就勾上（勾上只是把它下面的步摊开）
     stepOn('习题课')         子项：没勾就勾上（这一条这次要记）
   关的那两个同理。laneChip 按文字找 chip，父项子项都能找。 */
const laneChip = (name) => byCls($('done-picker'), 'chip').find((c) => c.textContent.includes(name));
async function chipOn(name) { const c = laneChip(name); if (c && !hasCls(c, 'on')) { c.fire('click'); await tick(); } }
async function chipOff(name) { const c = laneChip(name); if (c && hasCls(c, 'on')) { c.fire('click'); await tick(); } }
const laneOn = chipOn, laneOff = chipOff, stepOn = chipOn, stepOff = chipOff;

/* 勾中的父项各自摊开的那一行子项。它是 .sub-pick，**不是** .chips-group ——
   父项那两行是"组名 62px + 一排 chip"的横排，子项是"父项名独占一行 + 下面一排 chip"。
   按父项名找，别按下标（勾了几项就会有几行，下标会漂）。 */
const stepGroups = () => byCls($('done-picker'), 'sub-pick');
const stepGroupOf = (name) => stepGroups().find((g) => g.textContent.includes(name));
const stepChips = (name) => { const g = stepGroupOf(name); return g ? byCls(g, 'chip') : []; };

/* 临时把某一步退回未完成，返回一个「还回去」的函数。
   有两段要测「勾了父项、还没挑步」（noStep）—— 可那两处 `学完线性代数` 的三步
   **正好全完成了**，全完成走的是另一条路（按钮说「这一项已经都完事了」）。
   不退回一步的话，测的就不是 noStep。用法：
     const restore = await shelveStep('s3');  …  await restore();
   假库返回同一批对象引用，改完 refresh 一下界面就跟着变。 */
async function shelveStep(id) {
  const row = DB.subtasks.find((x) => x.id === id);
  const keep = { done: row.done, done_at: row.done_at };
  row.done = false; row.done_at = null;
  $('btn-refresh').fire('click'); await tick();
  return async () => { Object.assign(row, keep); $('btn-refresh').fire('click'); await tick(); };
}

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
/* 2026-09-26 她要求「30 天小目标这一栏不再保留」—— 主页状态卡上那行
   「n / m 个完成 · 累计 p / t」跟着撤掉。库里那两行（g1 / g2 没有 due_date）
   一行没删，只是不再往这张卡上算（见下面「界面撤了，数据还在」那一节）。 */
ok(!pc0.includes('30 天小目标'), '状态卡上不再有「30 天小目标」那一行');
ok(!/\d+ \/ \d+ 个完成/.test(pc0), '也不再报「n / m 个完成」那套旧口径');
ok(!pc0.includes('累计 120 / 300'), '更不再把 30 天目标的 progress/target 累计出来');
ok(pc0.includes('小任务 2 / 3'), '小任务统计');
ok(pc0.includes('今天') && pc0.includes('还没记'), '今天还没记（09-25 无记录）');
ok(pcs[1].textContent.includes('小 B'), '对方名字');
ok(!pcs[1].textContent.includes('30 天小目标'), '对方那张卡同样没有（两边口径一致）');
ok(findAll(pcs[0], (n) => n.className.includes('lg')).length === 1, '状态卡上有大头像');
ok(btns(pcs[0], '上传头像').length === 1, '自己的卡有「上传头像」按钮');
ok(btns(pcs[1], '上传头像').length === 0, '对方的卡没有（不能改别人）');

console.log('── 主页：动态流 ──');
const feedTxt = $('feed').textContent;
/* 30 天小目标在**界面上**撤了，但动态流是历史记录 —— 她那两行还在库里，
   以前记下的「完成了 30 天目标」条目照旧列出来，不该跟着一起消失 */
ok(feedTxt.includes('完成了 30 天目标'), '旧的 30 天目标那几条动态还在（撤界面不等于删历史）');
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
/* 假 DOM 的 getElementById **会自动造出**缺失的元素，所以「index.html 里还有没有
   这个 id」只能回源码里查 —— 问 $('goals-cols') 永远问不出真相（它总在那儿）。 */
const srcHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
ok(!/id="goals-cols"/.test(srcHtml), '月度任务页里那张「30 天小目标」备忘录整个撤了');
ok(!/id="g-add"/.test(srcHtml) && !/id="g-start"/.test(srcHtml) && !/id="g-title"/.test(srcHtml),
  '「新建 30 天小目标」那张表单也一起撤了（不留点不动的东西）');
ok(byCls($('cd-cols'), 'item').length === 3, '倒计时还在渲染 —— 这一页不是空壳');
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

console.log('── 30 天小目标：界面撤了，库里的行一条没删 ──');
entries[0].fire('click'); await tick();   // goals
/* 撤的是**界面**。删数据是另一回事 —— CLAUDE.md 里写着不删她的行，
   而且动态流里那些历史条目、导出快照都还指着这两行。 */
ok(DB.goals.filter((x) => !x.due_date).length === 2, '库里那两条 30 天小目标还躺着（一行没删）');
ok(!$('pane-goals').textContent.includes('背完 300 个单词'),
  '但页面上再也看不到它们了（不再往这一页渲染）');
ok(byCls($('cd-cols'), 'item').length === 3,
  '倒计时照旧只数 due_date 非空的 3 条 —— 那两条没被混进来当倒计时');

console.log('── 原有四个功能区没被改坏 ──');
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
   注意这些断言必须跑在上面「勾完 s3」之后 ——
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

console.log('── 大任务：已建立的任务也能就地改 ──');
/* 她：「大任务拆解里已经建立的任务也要变得可以编辑」。
   以前只有小任务那一行能改，大任务的名字 / 说明 / 截止日是印上去的死文本 ——
   想改个名字只能删掉重建，连带下面的小任务和关联全丢。
   ⚠️ 找卡片不能用 findAll(card, INPUT) 当门牌：小任务的输入框也在这个 .item 里面
   （.subs 是它的子节点），会把「第 1-4 讲」那些一起捞进来。这里按**标题框里的值**认卡。 */
const taskCard = (title) => byCls($('tasks-cols'), 'item').find((c) => {
  const t = findAll(c, (n) => n.tagName === 'INPUT' && n.type === 'text')[0];
  return !!t && t.value === title;
});
/* 卡片里的输入框按 DOM 顺序：名字 / 说明 / 截止日，然后才是小任务那些（勾选框 + 名字） */
const cardIns = (c) => findAll(c, (n) => n.tagName === 'INPUT');
const t1card = taskCard('学完线性代数');
ok(!!t1card, '（先找到「学完线性代数」那张卡）');
ok(cardIns(t1card).length >= 3 && cardIns(t1card)[0].className.includes('inline'),
  '大任务的名字本身就是个输入框，不是印出来的死文本');
ok(cardIns(t1card)[0].value === '学完线性代数' && cardIns(t1card)[1].value === '把 MIT 那门刷完',
  '框里装着现在的名字和说明');
ok(cardIns(t1card)[2].type === 'date' && cardIns(t1card)[2].value === '2026-10-10',
  '截止日也是能改的日期框（原来这里是个印上去的 pill）：' + cardIns(t1card)[2].value);

/* 改名字：走 update、不新增一行、说一声、并且重画（名字决定卡片顺序） */
clearToast();
const t1 = DB.tasks.find((t) => t.id === 't1');
const t1keep = { title: t1.title, detail: t1.detail, due_date: t1.due_date };
const nTasksBefore = DB.tasks.length;
const nameNode = cardIns(t1card)[0];
nameNode.value = '学完线性代数（改过）';
nameNode.fire('change'); await tick(); await tick();
ok(DB.tasks.length === nTasksBefore && DB.tasks.find((t) => t.id === 't1').title === '学完线性代数（改过）',
  '改的是**原来那一行**，不是新增一行（id 还是 t1）');
ok($('toast').textContent === '已保存', '就地改没有「保存」那一下，得说一声：' + $('toast').textContent);
ok(cardIns(taskCard('学完线性代数（改过）'))[0] !== nameNode,
  '改名字会重画列表 —— 名字决定卡片排在哪、也决定分组');
ok(!!taskCard('学完线性代数（改过）') || subRowOf($('tasks-cols'), '第 1-4 讲'),
  '重画之后这张卡还在（名字变了照样认得出）');
ok(findAll($('tasks-cols'), (n) => /\bsq\b/.test(n.className)).length === 4,
  '重画只重画列表，下面的小任务和分段进度条一条没丢（我的 3 段 + 对方的 1 段）');

/* 改说明：**不重画** —— 存完那个输入框还得是同一个节点，光标不至于被踢出去 */
const tcard2 = taskCard('学完线性代数（改过）');
const noteNode2 = cardIns(tcard2)[1];
noteNode2.value = '改成别的说明';
noteNode2.fire('change'); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').detail === '改成别的说明', '说明也写进去了');
ok(cardIns(taskCard('学完线性代数（改过）'))[1] === noteNode2,
  '改说明不重画 —— 重画会把光标踢出输入框，接着打字就打到空气里');

/* 改截止日：那一行的「剩 N 天」得跟着重算，所以要重画 */
const dueNode2 = cardIns(taskCard('学完线性代数（改过）'))[2];
dueNode2.value = isoOff(5);
dueNode2.fire('change'); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').due_date === isoOff(5), '新截止日写进去了');
ok(cardIns(taskCard('学完线性代数（改过）'))[2] !== dueNode2, '改截止日会重画（那行「剩几天」要重算）');
ok(taskCard('学完线性代数（改过）').textContent.includes('剩 5 天'),
  '卡片上「剩几天」跟着新的截止日走：' + taskCard('学完线性代数（改过）').textContent);

/* 名字清空 → 不写库、弹回原值。空名字的卡片就是一张不知道是什么的东西 */
clearToast();
const cardNow = taskCard('学完线性代数（改过）');
cardIns(cardNow)[0].value = '   ';
cardIns(cardNow)[0].fire('change'); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').title === '学完线性代数（改过）', '名字只有空格 → 不写库');
ok($('toast').textContent.includes('大任务名不能空着'), '并且说清楚缺什么：' + $('toast').textContent);
ok(cardIns(taskCard('学完线性代数（改过）'))[0].value === '学完线性代数（改过）',
  '框里弹回原来的名字，不留一个空格在那儿');

/* 对方那一栏还是只读的：改也只该改自己那份 */
const oCard = byCls($('tasks-cols'), 'item').find((c) => c.textContent.includes('写完开题报告'));
ok(!!oCard, '（找到对方那张卡）');
ok(findAll(oCard, (n) => n.tagName === 'INPUT' && (n.type === 'text' || n.type === 'date')).length === 0,
  '对方那一栏的大任务名字 / 说明 / 截止日都还是只读文本，点不动');

/* ── 行内编辑的另外两个键位：Enter 存、Esc 还原 ──────────────────
   第三个是 Tab，它走的是浏览器失焦时补的那个 change，不用自己写代码 ——
   所以下面测的是「失焦确实会存」这条前提，而不是某个 keydown 分支。
   三个少一个都会卡住：没 Enter 就得去够鼠标，没 Esc 改错了没法退，没 Tab 敲不下去。 */
const keyEv = (el, k) => el.fire('keydown', { key: k, target: el, preventDefault() {} });

clearToast();
const kName = cardIns(taskCard('学完线性代数（改过）'))[0];
kName.focus();
kName.value = 'Enter 改的名字';
keyEv(kName, 'Enter'); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').title === 'Enter 改的名字',
  'Enter 直接存了，不用再把鼠标挪出去点一下');
ok($('toast').textContent === '已保存', '并且跟失焦一样说一声：' + $('toast').textContent);

/* Esc：改了但不要了。库里**一次请求都不该发** —— 把原值写回去再失焦，值没变，
   浏览器就不补 change（是「根本没发」，不是「发了再撤回」）。 */
Object.assign(DB.tasks.find((t) => t.id === 't1'), { title: 'Esc 之前' });
$('btn-refresh').fire('click'); await tick(); await tick();
clearToast();
const escName = cardIns(taskCard('Esc 之前'))[0];
escName.focus();
escName.value = '打了一半不要了';
keyEv(escName, 'Escape'); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').title === 'Esc 之前', 'Esc 还原 —— 库里没被改');
/* 这条要拿**同一个节点**问，不能再 taskCard(value) 找一次卡 —— taskCard 就是按
   名字框里的值认卡的，而 Esc 改的正是那个值：实现被删掉时它会找不到卡、
   cardIns(undefined) 直接抛 TypeError，测试**崩在断言上**而不是「断言失败」，
   看着是红的，其实后面几十条断言一条都没跑（2026-09-27 实测踩到）。 */
ok(escName.value === 'Esc 之前', '框里也回到原值，没留着她打了一半的那串');
ok($('toast').textContent !== '已保存', 'Esc 什么都没存，不该弹「已保存」：' + $('toast').textContent);

/* Tab 跳走 = 失焦 = 存。这条同时是上面两条的地基：假 DOM 里要是没有
   「失焦补 change」这个行为，Enter / Esc 那两条断言就是空转的。 */
const tbName = escName;   // 接着用上面那个节点：Esc 没写库、没重画，还是同一个
tbName.focus();
tbName.value = 'Tab 跳走时存下的';
tbName.blur(); await tick(); await tick();
ok(DB.tasks.find((t) => t.id === 't1').title === 'Tab 跳走时存下的',
  'Tab 跳到下一格时也存了（靠失焦补的那个 change）');

/* 收尾：按 id 把三个字段还原，别影响后面的用例（「学完线性代数」这个名字
   下面几十条断言都要用它找） */
Object.assign(DB.tasks.find((t) => t.id === 't1'), t1keep);
$('btn-refresh').fire('click'); await tick(); await tick();
ok(!!taskCard('学完线性代数') && !taskCard('学完线性代数（改过）'),
  '收尾后「学完线性代数」回来了（按 id 还原）');

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
  /* 刚勾完的 s3（今天完成的小任务）—— 30 天小目标不再有「标记完成」这个入口，
     所以今天只有它这一件 */
  ok(dcOf(now.getDate()) === '1', '刚勾完的 s3 立刻出现在今天：' + dcOf(now.getDate()) + ' 件');
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
/* 倒计时的行 period_start/target/progress 只是占位（满足非空约束），
   绝不能被当成 30 天小目标画成一条 0/1 的进度条 —— 那是这一页最容易串味的地方。
   原来查的是「那张备忘录里没有它」，2026-09-26 备忘录整个撤了，
   改成直接钉倒计时自己的行：只有一条药丸，没有任何进度条。 */
ok(byCls($('cd-cols'), 'item').length === 3 && !byCls($('cd-cols'), 'seg').length,
  '倒计时行里没有分段进度条（0/1 那套是 30 天小目标的老口径）');
ok(!$('cd-cols').textContent.includes('进度 0 / 1') && !$('pane-goals').textContent.includes('进度 0 / 1'),
  '这一页哪儿都没有 0/1 的假进度条');

/* ⚠️ 每次 renderCountdown 都会把 #cd-cols 里的东西整个重建，早先抓的 cdWho
   就成了脱离 DOM 的旧节点 —— 假 DOM 里照样读得出内容，但那是改之前的。
   凡是在「点过按钮 / 改过字段」之后要读的，一律用 cdWhoNow() 现抓。 */
const cdWhoNow = () => byCls($('cd-cols'), 'who');
const cdWho = cdWhoNow();
ok(cdWho.length === 2, '倒计时也是双栏（两人各一栏）');
ok(find(cdWho[0], (n) => hasCls(n, 'nm')).textContent === '小 A', '我那栏排前面');
const meCd = byCls(cdWho[0], 'item');
ok(meCd.length === 2, '我这栏 2 条（已完成的不算待办），实际 ' + meCd.length);

/* 倒计时的标题 / 说明 / 截止日现在是卡片上的就地编辑框 —— 不在 textContent 里，
   定位一行得按输入框的值找（跟资源列表那边一个道理）。
   标题那个是「我的」那一栏里第一个 text 输入框；对方那栏的标题是 span，
   这里读不到，正好不会误认。 */
const cdTitle = (row) => {
  const i = row && findAll(row, (n) => n.tagName === 'INPUT' && n.type === 'text')[0];
  return i ? i.value : '';
};
const cdDueOf = (row) => {
  const i = row && findAll(row, (n) => n.tagName === 'INPUT' && n.type === 'date')[0];
  return i ? i.value : '';
};
/* 只在**待办分区**里找行，不碰「已完成」折叠区里的那些 —— 混在一起的话
   「它还在不在待办里」这种断言永远为真，等于没查。 */
const cdTodoRows = () => byCls($('cd-cols'), 'cd-group').flatMap((g) => byCls(g, 'item'));
const cdFind = (t) => cdTodoRows().find((r) => cdTitle(r) === t);
const cdBtn = (t, label) => btns(cdFind(t), label)[0];

ok(cdTitle(meCd[0]) === '交实验数据' && cdTitle(meCd[1]) === '交开题报告',
  '待办按截止日从近到远排 —— 已经过期的那条排在最前面：' + meCd.map(cdTitle).join(' | '));
/* ⚠️ 上面那条其实**测不出段内排序**：那两条分属「今天」和「本周」，
   谁在前是分段顺序定的，跟段内怎么排没关系（把排序反过来它照样绿）。
   临时塞一条**同段**的（也过期了），两条都落在「今天」里才看得出先后。 */
DB.goals.push({
  id: 'tmp-cd-order', owner: ME, title: '临时·过期一天', detail: '', due_date: isoOff(-1),
  period_start: D0, target: 1, progress: 0, done: false, done_at: null, priority: '',
});
$('btn-refresh').fire('click'); await tick();
const todayRows = byCls(byCls(cdWhoNow()[0], 'cd-group')[0], 'item').map(cdTitle);
ok(todayRows.join(' | ') === '交实验数据 | 临时·过期一天',
  '同一段里也是截止日近的在前（过期 5 天的压在过期 1 天的前面）：' + todayRows.join(' | '));
DB.goals = DB.goals.filter((g) => g.id !== 'tmp-cd-order');
$('btn-refresh').fire('click'); await tick();
ok(byCls(cdWhoNow()[0], 'item').length === 2 && !cdFind('临时·过期一天'),
  '收尾：临时那条清掉，回到 2 条待办');
const pillOf = (row) => byCls(row, 'pill')[0];
ok(pillOf(meCd[0]).textContent === '已过期 5 天',
  '过期 5 天 → 「已过期 5 天」，实际「' + pillOf(meCd[0]).textContent + '」');
ok(hasCls(pillOf(meCd[0]), 'bad'), '过期 / 今天到期 → bad 药丸（红）');
ok(pillOf(meCd[1]).textContent === '还剩 2 天',
  '还剩 2 天 → 「还剩 2 天」，实际「' + pillOf(meCd[1]).textContent + '」');
ok(hasCls(pillOf(meCd[1]), 'warn'), '3 天内到期 → warn 药丸');
ok(cdDueOf(meCd[1]) === D2,
  '我这栏的截止日就是就地编辑的日期框，值等于那条记录的截止日：' + cdDueOf(meCd[1]));
ok(meCd[1].textContent.includes('截止'),
  '「截止」两个字还在，不然单摆一个日期框看不出那是什么');
/* 颜色只是辅助。药丸里必须自己说出还剩几天 ——
   色觉障碍、打印、强制配色下都要能读出来 */
ok(/还剩|到期|过期/.test(pillOf(meCd[0]).textContent) &&
   /还剩|到期|过期/.test(pillOf(meCd[1]).textContent),
  '不靠颜色也能读出剩余天数，药丸里带着话');

const otCd = byCls(cdWho[1], 'item');
ok(otCd.length === 1, '对方那一栏也在（这一页看的是两人的共同进度）');
ok(otCd[0].textContent.includes('预约答辩教室'), '对方已完成的那条也在');
ok(hasCls(otCd[0], 'done'), '已完成的行变淡（.item.done）');
/* 完成区：折进一个默认收起的 <details> 里。默认收起是重点 ——
   攒到几十件之后，已经做完的那些天天占着视线，今天该干什么反而看不见。 */
const otFold = find(cdWho[1], (n) => n.tagName === 'DETAILS');
ok(otFold && hasCls(otFold, 'cd-fold'), '对方那条已完成折进「已完成」区（<details>）');
ok(!!otFold && otFold.getAttribute('open') == null, '完成区默认收起（不带 open）');
const otSum = otFold && find(otFold, (n) => n.tagName === 'SUMMARY');
ok(!!otSum && otSum.textContent.includes('已完成 1 件'),
  '折叠头上就报了件数，不用展开也知道有几件：' + (otSum ? otSum.textContent : '(没有 summary)'));
ok(byCls(cdWho[1], 'item').length === 1, '折起来不等于删了 —— 那一行仍在 DOM 里');
ok(!find(cdWho[0], (n) => n.tagName === 'DETAILS'), '我这栏没有已完成的，就不冒出一个空的完成区');
/* 分区：今天 / 本周 / 以后。过期的那条并进「今天」排最前，不是单独一档。 */
const gNames = byCls(cdWho[0], 'cd-name').map((n) => n.textContent);
ok(gNames.join('/') === '今天/本周',
  '过期 5 天的并进「今天」、2 天后的进「本周」：' + gNames.join('/'));
const cdGN = byCls(cdWho[0], 'cd-n').map((n) => n.textContent);
ok(cdGN.length === 2 && /1/.test(cdGN[0]), '每个分区头右边带着件数：' + cdGN.join(' / '));
ok(byCls(cdWho[0], 'cd-group').length === 2, '两个有内容的区各是一个 .cd-group：' + byCls(cdWho[0], 'cd-group').length);
const otNames = byCls(cdWho[1], 'cd-name').map((n) => n.textContent);
ok(otNames.length === 0, '只有已完成的行不再画空的分区头：' + otNames.join('/'));

ok($('cd-sub').textContent.includes('待办 2 件'), '副标题报待办件数：' + $('cd-sub').textContent);
ok($('cd-sub').textContent.includes('交实验数据'), '副标题点名最急的那一件');
ok($('cd-sub').textContent.includes('已过期 5 天'), '副标题里也说了还剩几天');
ok($('cd-sub').textContent.includes('已经完成 1 件'), '已完成的不算在待办里，单独报一句');

console.log('── 倒计时落到月历上：「截」标记 ──');
const dlOf = (d) => { const k = find(cell(d), (n) => hasCls(n, 'dl')); return k ? k.textContent : ''; };
/* 「截」那个字本身在 .dlc 里，标题在 .dt 里（窄屏 CSS 会把 .dt 藏掉）。
   只对「截 / 截×2」这个标记做断言时用这个，别拿 .dl 的全文比 —— 会带上标题。 */
const dlcOf = (d) => { const k = find(cell(d), (n) => hasCls(n, 'dlc')); return k ? k.textContent : ''; };
const cellOfIso = (iso) => (iso.startsWith('2026-09') ? cell(Number(iso.slice(8))) : null);
/* 三个截止日都按「今天」算，跨月就可能不在当前显示的 9 月里 ——
   那就不假造结果，明说跳过（和上面「今天」那段的做法一致） */
if ([D2, DM5, DM9].every((s) => s.startsWith('2026-09'))) {
  ok(dlcOf(Number(D2.slice(8))) === '截', '还没完成的截止日那天，格子里标「截」');
  ok(dlOf(Number(D2.slice(8))).includes('交开题报告'),
    '「截」后面直接写出是哪件事，不用悬停：' + dlOf(Number(D2.slice(8))));
  ok(dlcOf(Number(DM5.slice(8))) === '截', '过期未完成的也照样标出来（要能看见欠着的事）');
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
/* 「加完光标回到标题框」要拿加之前后比 —— focusCount 是累计的 */
const fc0 = $('cd-title').focusCount || 0;
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
/* 连着录十条不该去够十次鼠标：加完光标得自己回到标题框 */
ok(($('cd-title').focusCount || 0) === fc0 + 1,
  '加完把光标送回标题框（能一路敲下去）：' + fc0 + ' → ' + ($('cd-title').focusCount || 0));

/* ── 截止日的四个快捷按钮 ──
   点开日历控件翻到「下周一」要 5 次操作，点一下按钮是 1 次。
   「今天 / 明天」能对死值；「本周末 / 下周一」不能照实现再算一遍期望值 ——
   两边一起错就测不出来，所以改成断言**性质**：那天真的是周六 / 周一吗、落在合理天数内吗。 */
const dowOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
const gapFromToday = (iso) => Math.round(
  (new Date(iso + 'T00:00:00') - new Date(isoOff(0) + 'T00:00:00')) / 86400000);
$('cd-due').value = '';
$('cd-today').fire('click'); await tick();
ok($('cd-due').value === isoOff(0), '点「今天」填今天：' + $('cd-due').value);
$('cd-tomorrow').fire('click'); await tick();
ok($('cd-due').value === isoOff(1), '点「明天」填明天：' + $('cd-due').value);
$('cd-weekend').fire('click'); await tick();
ok(dowOf($('cd-due').value) === 6,
  '点「本周末」给的是周六（算出来星期 ' + dowOf($('cd-due').value) + '）：' + $('cd-due').value);
ok(gapFromToday($('cd-due').value) >= 0 && gapFromToday($('cd-due').value) <= 6,
  '而且就在本周之内（差 ' + gapFromToday($('cd-due').value) + ' 天）');
$('cd-nextmon').fire('click'); await tick();
ok(dowOf($('cd-due').value) === 1,
  '点「下周一」给的是周一（算出来星期 ' + dowOf($('cd-due').value) + '）：' + $('cd-due').value);
ok(gapFromToday($('cd-due').value) >= 1 && gapFromToday($('cd-due').value) <= 7,
  '而且是**下一个**周一（差 ' + gapFromToday($('cd-due').value) + ' 天；今天就是周一的话要给 7 天后）');

/* ── 「今天正好是周一」这一支（2026-09-27 补）──
   上面那条「下周一」的断言**在非周一跑时是恒真的**：今天不是周一 → nextDow 里
   `if (!delta && skipToday)` 那个分支根本走不到，把 nextDow(1, true) 改成
   nextDow(1, false) 照样绿。2026-09-27 的变异检验 K3 实测漏网，就是栽在这儿
   —— 今天（周日）跑一万遍也测不出「周一那天不给今天」。
   唯一能在测试里钉住「今天」的办法是临时换掉 Date，跟测试台换 Blob 是同一个套路。
   固定到正午，避开时区边界；用完在 finally 里还回去，否则后面所有用例的日期都变了。 */
async function withToday(iso, fn) {
  const Real = globalThis.Date;
  const fixed = new Real(iso + 'T12:00:00');
  class FakeDate extends Real {
    constructor(...a) { if (a.length === 0) super(fixed.getTime()); else super(...a); }
    static now() { return fixed.getTime(); }
  }
  globalThis.Date = FakeDate;
  try { return await fn(); } finally { globalThis.Date = Real; }
}

await withToday('2026-10-05', async () => {          // 2026-10-05 是周一
  ok(dowOf('2026-10-05') === 1, '前提：2026-10-05 这天确实是周一（按日历算出来的）');
  ok(isoOff(0) === '2026-10-05', '前提：「今天」已经被钉在 2026-10-05：' + isoOff(0));
  $('cd-due').value = '';
  $('cd-nextmon').fire('click'); await tick();
  ok($('cd-due').value === '2026-10-12' && dowOf($('cd-due').value) === 1 &&
     gapFromToday($('cd-due').value) === 7,
    '今天就是周一时，「下周一」要给 7 天后的 10-12，**不能给今天**：' + $('cd-due').value);
  $('cd-weekend').fire('click'); await tick();
  ok($('cd-due').value === '2026-10-10' && dowOf($('cd-due').value) === 6,
    '今天就是周一时，「本周末」给本周六 10-10（今天算本周）：' + $('cd-due').value);
  $('cd-today').fire('click'); await tick();
  ok($('cd-due').value === '2026-10-05', '「今天」仍然是今天，不受影响：' + $('cd-due').value);
  $('cd-tomorrow').fire('click'); await tick();
  ok($('cd-due').value === '2026-10-06', '「明天」也照旧是明天：' + $('cd-due').value);
});
ok(isoOff(0) !== '2026-10-05', '出块之后「今天」还回来了（没把 Date 永久换掉）：' + isoOff(0));
/* 快捷按钮只管填值，不写库 —— 没点「加上」之前不该多出任何一行 */
ok(!DB.goals.some((g) => g.due_date === $('cd-due').value && !g.title),
  '点快捷按钮只填日期框，不会凭空写一行进库');
$('cd-due').value = isoOff(7);   // 还回默认值，别影响后面的用例

/* 同一天到期两件事：格子里放不下两个「截」，要压成「截×2」 */
await addCd('临时·同天到期的另一件', isoOff(1));
if (isoOff(1).startsWith('2026-09')) {
  ok(dlOf(Number(isoOff(1).slice(8))) === '截×2',
    '同一天到期两件事 → 格子里写「截×2」，实际「' + dlOf(Number(isoOff(1).slice(8))) + '」');
  ok(cellOfIso(isoOff(1)).title.includes('截止：临时·明天要交的') &&
     cellOfIso(isoOff(1)).title.includes('截止：临时·同天到期的另一件'),
    '两件都在悬停明细里，一件不少');
}
/* 清掉这条同天到期的。**这里不走界面上的「删除」按钮** —— 删除现在带 5 秒撤回
   窗口，会留一个待删状态给后面几十条断言；删除那条路径在下面单独走一遍。 */
DB.goals = DB.goals.filter((g) => g.title !== '临时·同天到期的另一件');
$('btn-refresh').fire('click'); await tick(); await tick();

const newRow = cdFind('临时·明天要交的');
ok(!!newRow, '加完立刻出现在列表里（不用手动刷新）');
ok(!!newRow && byCls(newRow, 'pill')[0].textContent === '明天到期',
  '明天到期 → 「明天到期」，实际「' + (newRow ? byCls(newRow, 'pill')[0].textContent : '') + '」');

await addCd('临时·今天要交的', isoOff(0));
const row0 = cdFind('临时·今天要交的');
ok(!!row0 && byCls(row0, 'pill')[0].textContent === '今天到期',
  '今天到期 → 「今天到期」，实际「' + (row0 ? byCls(row0, 'pill')[0].textContent : '') + '」');
ok(!!row0 && hasCls(byCls(row0, 'pill')[0], 'bad'), '今天到期算最急的一档（bad）');

await addCd('临时·昨天该交的', DM1);
const rowM1 = cdFind('临时·昨天该交的');
ok(!!rowM1 && byCls(rowM1, 'pill')[0].textContent === '昨天到期',
  '过期 1 天 → 「昨天到期」而不是「已过期 1 天」（说人话）：' +
  (rowM1 ? byCls(rowM1, 'pill')[0].textContent : ''));

/* 空标题拦下来，别在库里留一条认不出来的记录 */
const nGoalsBefore = DB.goals.length;
$('cd-title').value = '   ';
$('cd-add').fire('click'); await tick(); await tick();
ok(DB.goals.length === nGoalsBefore, '只写了空格 → 不写库');
ok($('toast').textContent.includes('先写要完成什么'), '并说清楚缺什么：' + $('toast').textContent);

console.log('── 倒计时：点「完成」 ──');
cdBtn('临时·昨天该交的', '完成').fire('click'); await tick(); await tick();
const gDone = DB.goals.find((g) => g.title === '临时·昨天该交的');
ok(gDone && gDone.done === true, '点「完成」真的把 done 写上了');
ok(gDone && typeof gDone.done_at === 'string', 'done_at 也写了（月历靠它归日）');
/* 完成后落进「已完成」折叠区（默认收起），不再平铺在待办分区里 */
const myFold = find(cdWhoNow()[0], (n) => n.tagName === 'DETAILS' && hasCls(n, 'cd-fold'));
ok(!!myFold, '完成后我这一栏也冒出「已完成」折叠区');
ok(!!myFold && myFold.getAttribute('open') == null, '新冒出来的完成区也是默认收起');
ok(!!myFold && byCls(myFold, 'item').length === 1, '刚完成的那条就在折叠区里，一条不多不少');
ok(cdFind('临时·昨天该交的') === undefined,
  '它同时从待办分区里消失了 —— 不该两处都画一条');
/* 完成后不再提醒：那天在月历上只以「完成」的身份出现，不该还挂着「截」 */
if (DM1.startsWith('2026-09') && DM9.startsWith('2026-09')) {
  ok(find(cellOfIso(DM1), (n) => hasCls(n, 'dl')) === null &&
     find(cellOfIso(DM9), (n) => hasCls(n, 'dl')) === null,
    '刚完成的那条也不再标「截」');
}
ok(cdTitle(byCls(myFold, 'item')[0]) === '临时·昨天该交的',
  '完成后整页重画没抛错，那条在折叠区里好好的');

/* ── 删除：不弹确认框，改成 5 秒内可以撤回 ──────────────────────
   她：「删除不弹确认框，给 5 秒 Undo 提示条，误删点一下回来」。
   实现上是**延迟真删**：点下去的 5 秒内库里一行没动，只是界面上先摘掉。
   这么做的理由是「先删后建」那套会换 id —— 外键级联的关联全丢，
   撤回等于新建一条残缺的。延迟真删没有这个问题。
   测试里不等这 5 秒（等的话整个用例要多跑 5 秒）：改成验「这 5 秒里库还在」
   —— 变异成立刻真删，下面第一条断言就会红。 */
console.log('── 倒计时：删除 → 5 秒内可以撤回 ──');
const nGoalsBeforeDel = DB.goals.length;
cdBtn('临时·明天要交的', '删除').fire('click'); await tick();
ok(cdFind('临时·明天要交的') === undefined, '点「删除」那一行立刻从界面上消失');
ok(DB.goals.some((g) => g.title === '临时·明天要交的'),
  '但库里那行还在 —— 真删推迟 5 秒，留出撤回的窗口');
ok($('undo').hidden === false, '底部冒出「撤回」条');
ok($('undo').textContent.includes('已删除'), '条上说了删了什么：' + $('undo').textContent);
const cdUndoBtn = find($('undo'), (n) => n.tagName === 'BUTTON');
ok(!!cdUndoBtn, '条上有个按钮能点（不只是一行说明）');

/* 待删的那 5 秒里刷新一下：不能又冒回来 —— 那等于「撤回窗口随刷新失效」 */
$('btn-refresh').fire('click'); await tick(); await tick();
ok(cdFind('临时·明天要交的') === undefined,
  '这 5 秒里刷新页面，那一行也不会冒回来（live() 把它滤掉了）');

cdUndoBtn.fire('click'); await tick(); await tick();
ok(DB.goals.some((g) => g.title === '临时·明天要交的') && DB.goals.length === nGoalsBeforeDel,
  '点「撤回」那行回来了，库里一行没少');
ok(!!cdFind('临时·明天要交的'), '界面上也回来了，回到原来的分区里');
ok($('undo').hidden === true, '撤回后条收起来');
ok($('toast').textContent.includes('已恢复'), '并且说了一声「已恢复」：' + $('toast').textContent);

/* 撤回之后重新点删除 —— 验两件事：① 条上的状态没粘住（还能再弹一次）；
   ② 条上点得出删的是哪一条（误删时才知道撤回的是什么）。然后撤回清干净，
   不给后面几十条断言留一个待删状态。 */
cdBtn('临时·明天要交的', '删除').fire('click'); await tick();
ok($('undo').hidden === false, '（再删一次，条又出来了 —— 上一轮的状态没粘住）');
ok($('undo').textContent.includes('明天要交的'),
  '条上点名删的是哪一条，误删时才知道撤回的是什么：' + $('undo').textContent);
find($('undo'), (n) => n.tagName === 'BUTTON').fire('click'); await tick(); await tick();
ok($('undo').hidden === true && !!cdFind('临时·明天要交的'),
  '（撤回，清掉待删状态回到待办里，不给后面的用例留尾巴）');

/* 收尾：把这一节临时加的倒计时清掉，别影响后面的用例 */
DB.goals = DB.goals.filter((g) => !g.title.startsWith('临时·'));
$('btn-refresh').fire('click'); await tick(); await tick();
ok(!!cdFind('交开题报告'), '收尾后回到 3 条基准数据');

/* ── 倒计时：在卡片上就地改（没有「改」按钮那一套）─────────────
   她：「就地编辑 / 点标题直接改，不弹窗不跳页；失焦即自动保存」。
   要点跟学习资源那张卡一致：
     ① 走 update 不是 insert（否则一改多一行）；
     ② 只动改的那个字段，done / progress / target / period_start 一律不碰
        —— 改个标题不该把完成状态和占位字段顺手重置掉；
     ③ 就地改**没有「保存」那一下**，所以存完必须说一声「已保存」；
     ④ 标题 / 截止日决定这条落在哪一段 → 要重画；说明和优先级不影响位置
        → 不重画（重画会把光标从输入框里踢出去，接着打字就打到空气里）。 */
console.log('── 倒计时：在卡片上就地改 ──');
const cdHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const eTgt = DB.goals.find((g) => g.title === '交实验数据');
const eBefore = { id: eTgt.id, done: eTgt.done, progress: eTgt.progress,
                  target: eTgt.target, period_start: eTgt.period_start };
const eRow = cdFind('交实验数据');
ok(!!eRow, '（先找到「交实验数据」那一行）');
ok(cdBtn('交实验数据', '改') === undefined, '卡片上没有「改」按钮了');
ok(cdHtml.indexOf('id="cd-cancel"') < 0, 'index.html 里那份「取消」也一起拆掉了');
const eIns = (row) => findAll(row, (n) => n.tagName === 'INPUT');
ok(!!eRow && eIns(eRow).length === 3 && eIns(eRow)[0].value === '交实验数据',
  '标题就是卡片上的输入框，框里装着现在的标题：' +
  (eRow ? eIns(eRow).map((i) => i.type + '=' + i.value).join(' | ') : '(没找到行)'));
ok(!!eRow && eIns(eRow)[0].type === 'text' && eIns(eRow)[2].type === 'date',
  '第一个是文本框（标题）、第三个是日期框（截止日），中间那个是说明');
ok(cdDueOf(eRow) === DM5, '截止日框里就是那条的截止日：' + cdDueOf(eRow));
ok(!!eRow && eIns(eRow)[0].getAttribute('placeholder') === '要完成什么',
  '空标题时那行灰字提示还在：' + (eRow ? eIns(eRow)[0].getAttribute('placeholder') : ''));

/* 改标题：走 update、不碰别的字段、说一声「已保存」、并且重画（标题决定排序） */
clearToast();
eIns(eRow)[0].value = '交实验数据（改过）';
eIns(eRow)[0].fire('change'); await tick(); await tick();
const eAfter = DB.goals.find((g) => g.id === eBefore.id);
ok(!!eAfter, '改完还是**原来那一行**，不是新增一行（id 没变）');
ok(DB.goals.filter((g) => g.title === '交实验数据（改过）').length === 1, '库里只有一条改过的');
ok(eAfter && eAfter.title === '交实验数据（改过）', '新标题写进去了');
ok(eAfter && eAfter.done === eBefore.done && eAfter.progress === eBefore.progress &&
   eAfter.target === eBefore.target && eAfter.period_start === eBefore.period_start,
   '完成状态和占位字段一个都没被顺手重置');
ok($('toast').textContent === '已保存',
  '就地改没有「保存」那一下，不说一声她不知道到底存上没有：' + $('toast').textContent);

/* 改说明：不重画 —— 抓住那个输入框节点，存完它还得是同一个节点 */
const noteIn = () => eIns(cdFind('交实验数据（改过）'))[1];
const noteNode = noteIn();
noteNode.value = '改了说明';
noteNode.fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).detail === '改了说明', '说明也写进去了');
ok(noteIn() === noteNode,
  '改说明不重画列表 —— 重画会把光标踢出输入框，接着打字就打到空气里');

/* 改截止日：换一天就可能换一段，必须重画 */
const dueNode = eIns(cdFind('交实验数据（改过）'))[2];
dueNode.value = isoOff(20);
dueNode.fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).due_date === isoOff(20), '新截止日写进去了');
ok(eIns(cdFind('交实验数据（改过）'))[2] !== dueNode,
  '改截止日会重画列表 —— 节点换新的是对的，它要换段了');
const namesNow = byCls(cdWhoNow()[0], 'cd-name').map((n) => n.textContent);
ok(namesNow.join('/') === '本周/以后',
  '20 天后 → 从「今天」挪到「以后」段，中间空掉的那段不画：' + namesNow.join('/'));

/* 清空日期框 → 不写库。空日期存进去这条就掉进「今天」那一段骗人
   （「今天到期」其实是「没填日期」）。 */
clearToast();
const dueNode3 = eIns(cdFind('交实验数据（改过）'))[2];
dueNode3.value = '';
dueNode3.fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).due_date === isoOff(20),
  '日期框清空 → 不写库，截止日还是原来那个');
ok($('toast').textContent.includes('得选一个日期'), '并且说清楚该干什么：' + $('toast').textContent);
ok(eIns(cdFind('交实验数据（改过）'))[2].value === isoOff(20),
  '框里弹回原来的日期，不留一个空框在那儿');

/* 空标题不写库，并且弹回原值 —— 名字空着这一行就是个不知道是什么的东西。
   ⚠️ 先抓住那一行再改值，别改完再按标题找：标题框里刚被改成空格，
      cdFind（按框里的值认行）当场就找不到它了 —— 第一版就是这么把自己绕进去的。 */
const keepTitle = DB.goals.find((g) => g.id === eBefore.id).title;
const keepRow = cdFind(keepTitle);
ok(!!keepRow, '（找到那条改过标题的）');
eIns(keepRow)[0].value = '   ';
eIns(keepRow)[0].fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).title === keepTitle, '标题只有空格 → 不写库');
ok($('toast').textContent.includes('标题不能空着'), '并且说清楚缺什么：' + $('toast').textContent);
ok(cdTitle(cdFind(keepTitle)) === keepTitle, '框里弹回原来的标题，不留一个空格在那儿');

/* ── 优先级：只在左边一条 3px 色条 ──────────────────────────────
   她：「优先级只给左边 3px 色条，不加整块背景」。色条本身在 CSS 里（.pri-N::before），
   这儿钉的是「类加得对不对、值存得对不对」—— 类错了色条就画不出来。 */
console.log('── 倒计时：优先级 ──');
const priOf = (t) => { const r = cdFind(t); return r && find(r, (n) => n.tagName === 'SELECT'); };
ok(!!priOf(keepTitle), '我的卡片上有优先级下拉');
ok(!hasCls(cdFind(keepTitle), 'pri'),
  '没标优先级时**不加** pri 类 —— 左边不留一条灰条，跟别的行左对齐');
priOf(keepTitle).value = 'hi';
priOf(keepTitle).fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).priority === 'hi', '选「高」写进库了');
ok(cdFind(keepTitle).className === 'item pri pri-hi',
  '卡片上就这三个类，色条交给 CSS 的 .pri-hi::before：' + cdFind(keepTitle).className);
ok(!hasCls(cdFind(keepTitle), 'done'), '标优先级不会把它变成「已完成」那一档');
priOf(keepTitle).value = '';
priOf(keepTitle).fire('change'); await tick(); await tick();
ok(DB.goals.find((g) => g.id === eBefore.id).priority === '', '选回「不标」也写进去（清得掉）');
ok(!hasCls(cdFind(keepTitle), 'pri'), '清掉之后色条也没了');

/* setup-11-priority.sql 还没跑：goals 表里没有 priority 这一列。
   探测是**单独一次 select**（不能靠「行里带不带这个 key」猜：goals 一行都没有时
   恰恰是第一次用、最需要知道该不该显示那个下拉的时候）。
   宁可**不显示**下拉：显示了、她选完、插入却整个失败 ——
   那就成了「因为标了个优先级，任务反而加不上了」。 */
console.log('── 倒计时：setup-11 还没跑时 ──');
console.log('DEBUG 重画前', keepTitle, JSON.stringify(cdTodoRows().map(cdTitle)));
failSelect = 'goals:priority';
$('btn-refresh').fire('click'); await tick(); await tick();
console.log('DEBUG 重画后', JSON.stringify(cdTodoRows().map(cdTitle)));
ok(!priOf(keepTitle), '探到 priority 列不存在 → 优先级下拉整个不显示');
ok(!!cdFind(keepTitle), '这一块降级了，但倒计时照常看得见（别的字段一个不少）');
ok(eIns(cdFind(keepTitle)).length === 3, '标题 / 说明 / 截止日三个框照常可改');

/* 收尾：把改过的那条**按 id 还原**。
   ⚠️ 不能靠「临时·」前缀清理它 —— 它不叫那个名字，而且后面几十条断言
      都要靠「交实验数据」找到它（第一版就是这么错的）。 */
const eBack = DB.goals.find((g) => g.id === eBefore.id);
if (eBack) { eBack.title = '交实验数据'; eBack.due_date = DM5; eBack.detail = ''; eBack.priority = ''; }
$('btn-refresh').fire('click'); await tick(); await tick();
ok(!!cdFind('交实验数据'), '收尾后「交实验数据」回来了（按 id 还原，不是按名字）');

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
ok(!!cdFind('交开题报告'), '这一块降级了，但已有的内容照常看得见');

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
   混在一起的话倒计时那条 0/1 的占位进度会把「累计」压得没法看。
   2026-09-26 之后前半句已经不成立了：30 天小目标那块整个从卡片上撤掉，
   所以这里反过来钉「它**不**在了，倒计时那条也没被它带歪」。 */
ok(!$('home-people').textContent.includes('30 天小目标'), '状态卡上不再有「30 天小目标」那一块');
ok(!$('home-people').textContent.includes('累计 '), '更不再报 30 天目标的累计进度');
ok($('home-people').textContent.includes('待办 2 / 2 件'), '倒计时那一块自己该报的照旧报（没被撤掉带歪）');
ok($('home-entries').textContent.includes('倒计时'), '主页入口卡的说明也提了倒计时');
/* 动态流里两种目标说法不一样 —— 别把「交开题报告」说成「累计 1 / 1」 */
ok($('feed').textContent.includes('完成了倒计时任务'), '动态流里说「完成了倒计时任务」');
ok($('feed').textContent.includes('完成了 30 天目标'), '旧的 30 天小目标那条文案没被改坏');
tabs[1].fire('click'); await tick();

/* ══════════════════════════════════════════════════════════════
   本轮新增：今日完成情况
   ══════════════════════════════════════════════════════════════ */

console.log('── 今日完成情况：父项、子项都能勾好几条 ──');
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
/* 2026-09-26 她要求：可以勾多个大任务 / 学习资源，每一项下面的步 / 章也能勾好几条 */
ok(/id="done-picker-label"[^>]*>这次要记什么（大任务和资源都可以勾好几条）/.test(html),
  '选择器的标题写清了「可以勾好几条」');

/* 一开始**什么都不预勾** —— 多选之后替她预勾，按钮上「记 N 条」的 N 就跟她
   看到的不一致；而且第一条也不一定是她今天真动过的那件事。 */
const mineChips = () => byCls($('done-picker'), 'chip');
ok(mineChips().length === 5, '一开始只列父项：1 大任务 + 4 资源，实际 ' + mineChips().length);
ok(!mineChips().some((c) => hasCls(c, 'on')), '一条都不预勾');
ok(stepGroups().length === 0, '没勾父项时，一条子项都不摊开');
ok(mineChips().every((c) => !c.textContent.includes('考研政治')), '对方的资源不该出现');
const tchip = laneChip('学完线性代数');
ok(!!tchip, '大任务 chip 在');
ok(tchip.textContent.includes('3/3'), 'chip 上带当前完成进度，记之前就知道要挂到哪');
ok($('done-btn').disabled === true && $('done-btn').textContent.includes('先选一样'),
  '什么都没勾时按钮点不动，并说清要先选：' + $('done-btn').textContent);

/* 这一组此刻三步全完成了，全完成走的是「都完事了」那条路 —— 先退回一步才测得到 noStep */
const unshelveS3 = await shelveStep('s3');
await chipOn('学完线性代数');
ok(hasCls(laneChip('学完线性代数'), 'on'), '点一下父项就勾上');
ok(stepGroups().length === 1, '勾上父项 → 摊开它自己那一组子项，实际 ' + stepGroups().length);
ok(stepChips('学完线性代数').length === 3, '三步都列出来了，实际 ' + stepChips('学完线性代数').length);
ok(stepGroupOf('学完线性代数').textContent.includes('哪一步'), '那一组叫「哪一步」');
/* 多选之后会同时摊开好几组，父项名字必须写出来，否则分不出这几步是谁的 */
ok(stepGroupOf('学完线性代数').textContent.includes('学完线性代数'), '并把父项名字写在那一组头上');
ok(mineChips().length === 8, '父项 5 个 + 子项 3 个 = 8，实际 ' + mineChips().length);
ok($('done-btn').disabled === true, '勾了父项、没挑步：按钮点不动（不能装作能记）');
ok($('done-btn').textContent.includes('还没挑'), '并说清卡在「还没挑具体哪一条」：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('一步或多步'), '顺手指路点哪儿：' + $('done-tip').textContent);
await unshelveS3();

/* 三个阶段此刻都已完成（前面在「大任务拆解」里勾了 s3）——
   已完成的不给勾：勾了也只能在按下时被跳过，不如一开始就告诉她 */
const doneStepChips = stepChips('学完线性代数').filter((c) => hasCls(c, 'done'));
ok(doneStepChips.length === 3, '已完成的那几步标成 .done，实际 ' + doneStepChips.length);
ok(doneStepChips.every((c) => c.disabled === true), '而且真的 disabled —— 点不动，记不成「今天推进」');
ok(doneStepChips.every((c) => c.textContent.includes('✅')), '前面挂 ✅，一眼看出这条完事了');
/* 再点一下**已勾中的父项** = 这一组这次不记，连同它下面勾着的子项一起清 */
await chipOff('学完线性代数');
ok(!hasCls(laneChip('学完线性代数'), 'on'), '再点一下勾中的父项 = 这一组这次不记');
ok(stepGroups().length === 0, '关掉的那组连「哪一步」一起收起来，不留半截');
ok($('done-btn').disabled === true, '收干净之后按钮回到禁用');

/* 关掉一个勾中的父项时，它下面勾着的子项要**一起清掉**。不清的话父项关了、子项还亮着 ☑，
   按钮上「记 N 条」就跟她看到的不一致；再点开父项还会莫名其妙地又把那一条记一遍。
   （上一段关父项时一条子项都没勾，测不出这件事 —— 得先勾一条。） */
const unshelveS3c = await shelveStep('s3');
await chipOn('学完线性代数');
await stepOn('习题课');
ok($('done-btn').textContent.includes('推进 1 步'),
  '先挑一条子项（不挑的话这一测就是空转）：' + $('done-btn').textContent);
await chipOff('学完线性代数');
await chipOn('学完线性代数');
ok(!hasCls(laneChip('习题课'), 'on'), '关掉父项时，它下面勾着的那一条**一起清掉**了');
ok($('done-btn').disabled === true && !$('done-btn').textContent.includes('推进'),
  '清干净之后按钮回到禁用，不残留一条她没在勾的：' + $('done-btn').textContent);
await chipOff('学完线性代数');
await unshelveS3c();

/* ══ 核心：把 s3 退回未完成，记一笔推进。测完原样还回去，后面的断言不受影响 ══ */
const s3row = DB.subtasks.find((x) => x.id === 's3');
const s3keep = { done: s3row.done, done_at: s3row.done_at };
s3row.done = false; s3row.done_at = null;
$('btn-refresh').fire('click'); await tick();

await chipOn('学完线性代数');
const s3chip = laneChip('习题课');
ok(!!s3chip, '「习题课」这一步在「哪一步」里');
ok(!hasCls(s3chip, 'done') && s3chip.disabled === false, '退回未完成后，它不再是 ✅，也点得动了');
ok(!hasCls(s3chip, 'on'), '父项勾上**不**替她预勾子项（旧版会自动挑第一条）');
await stepOn('习题课');
ok(hasCls(laneChip('习题课'), 'on'), '点一下才选中这一步');

const nBefore = DB.subtasks.length;
ok($('done-btn').textContent.includes('推进 1 步'), '按钮上写明这一下推进几步：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('进度条不动'), '旁边写清楚了进度条不会动');

/* 顺手把「勾完这一条之后，别处把它标成了完成」那条竞态也钉住：
   假库返回的是同一批**对象引用**，直接改字段就能造出这个状态，界面还停在旧样子。 */
s3row.done = true;
$('done-btn').fire('click'); await tick(); await tick();
ok(s3row.done_at === null, '竞态里它已经不是待办了 → 一条也不写（不把完成时刻改成今天）');
ok($('toast').textContent.includes('已经完成了'), '并且说一句，不闷声吞掉：' + $('toast').textContent);
s3row.done = false;                    // 还回竞态前的样子，下面接着测正常那一笔

$('done-btn').fire('click'); await tick(); await tick();
ok(DB.subtasks.length === nBefore, '没有偷偷新建小任务（旧行为会），' + nBefore + ' → ' + DB.subtasks.length);
ok(s3row.done === false, 'done 仍是 false —— 完成状态一点没动');
ok(typeof s3row.done_at === 'string' &&
   Math.abs(Date.now() - new Date(s3row.done_at).getTime()) < 60000,
  '只是盖上今天的 done_at，当作「今天动过」的戳');
ok($('toast').textContent.includes('还没算完成'), '提示里明说它还不算完成：' + $('toast').textContent);
ok(!mineChips().some((c) => hasCls(c, 'on')), '记完把勾全清掉了 —— 不清的话那几步会重复记一遍');
ok($('done-btn').disabled === true, '清完之后按钮回到禁用');

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
  /* 今天本来一件完成都没有（s3 刚退回未完成；30 天小目标那条老路径也撤了）。
     dayStats 只认 done，推进盖的 done_at 不该点亮格子 —— 点亮了就说明口径串了。 */
  ok(dcOf(now.getDate()) === '', '月行程表只算真完成的，推进不点亮格子，实际「' + dcOf(now.getDate()) + '」');
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
const r1item = byResName('线性代数应该这样学');
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
const r1item2 = byResName('线性代数应该这样学');
btns(r1item2, '＋ 加一章')[0].fire('click'); await tick(); await tick();
const r1item3 = byResName('线性代数应该这样学');
btns(r1item3, '＋ 加一章')[0].fire('click'); await tick(); await tick();
const chAll = DB.subtasks.filter((x) => x.resource_id === 'r1');
ok(chAll.length === 3, '三章，实际 ' + chAll.length);
ok(chAll.map((x) => x.seq).join(',') === '1,2,3', '序号依次递增，没重排已有的：' + chAll.map((x) => x.seq).join(','));

const r1final = byResName('线性代数应该这样学');
const chSegs = findAll(r1final, (n) => hasCls(n, 'sq'));
ok(chSegs.length === 3, '进度条按章分段，3 章 3 段，实际 ' + chSegs.length);
ok(chSegs.every((x) => !hasCls(x, 'on')), '一章没勾时全是暗的');
ok(r1final.textContent.includes('共 3 章，已完成 0 章'), '文字说明：' + (r1final.textContent.match(/共 \d+ 章[^%]*%/) || [''])[0]);
ok(r1final.textContent.includes('章节清单（0 / 3）'), '章节清单默认收起但有计数');

console.log('── 今日完成情况也能挂到资源上（多选，不只是大任务）──');
tabs[3].fire('click'); await tick();          // daily
ok(!!laneChip('线性代数应该这样学'), '资源也出现在选择器里');
await chipOn('学完线性代数');                 // 父项：大任务
await chipOn('线性代数应该这样学');           // 父项：资源
ok(hasCls(laneChip('线性代数应该这样学'), 'on'), '点资源能勾上它');
/* 她问的那件事：两组**不再互斥** —— 勾资源不会把大任务那边取消掉 */
ok(hasCls(laneChip('学完线性代数'), 'on'), '勾资源的同时，大任务那边**仍然勾着**（两组各勾各的）');
ok(stepGroups().length === 2, '两条父项各摊一组子项，实际 ' + stepGroups().length);
const chChips = stepChips('线性代数应该这样学');
ok(chChips.length === 3, '资源那边摊开它的 3 章，实际 ' + chChips.length);
ok(stepGroupOf('线性代数应该这样学').textContent.includes('第几章'), '资源那组叫「第几章」');
ok(chChips.every((c) => !hasCls(c, 'on')), '一章都不预勾');
ok($('done-btn').disabled === true, '两条父项都勾着、一条子项没挑 → 还是点不动');
ok($('done-tip').textContent.includes('章'), '顺手说清该点哪儿：' + $('done-tip').textContent);

/* 但「今天只读了一章」更常见 → 把大任务那组关掉，只记资源 */
await chipOff('学完线性代数');
ok(stepGroups().length === 1, '关掉大任务那组，只剩资源那组摊着');
await stepOn('第 1 章');
ok(stepChips('线性代数应该这样学').filter((c) => hasCls(c, 'on')).length === 1, '只挑了 1 章');
ok($('done-btn').textContent.includes('勾掉 1 章') && !$('done-btn').textContent.includes('推进'),
  '挑好之后按钮只说这一章：' + $('done-btn').textContent);
ok($('done-tip').textContent.includes('就算完成'), '并写清这一章勾掉就算完成：' + $('done-tip').textContent);

const nBeforeRes = DB.subtasks.length;
const ch1row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 1);
ok(!ch1row.done, '第 1 章还没勾');
$('done-btn').fire('click'); await tick(); await tick();
ok(DB.subtasks.length === nBeforeRes, '勾章节**不新增行**（书就那么几章，不该越读越长），实际多了 ' +
  (DB.subtasks.length - nBeforeRes));
ok(ch1row.done === true, '勾的是已有的第 1 章那一行');
ok(typeof ch1row.done_at === 'string', '并带上了完成时间（月行程表要用）');
ok(ch1row.task_id == null && ch1row.resource_id === 'r1', '仍然只挂在资源上，两个父没同时填');

/* 再想勾一次同一章：它已经完成了，chip 直接 disabled ——
   「重复勾会刷新时间戳」这件事从结构上就不可能发生了（旧版只能靠按下时挡一道） */
const at1 = ch1row.done_at;
await chipOn('线性代数应该这样学');
const ch1again = stepChips('线性代数应该这样学').find((c) => c.textContent.includes('第 1 章'));
ok(!!ch1again && ch1again.disabled === true, '已勾过的章变成 disabled，勾不上第二次');
ok(hasCls(ch1again, 'done') && ch1again.textContent.includes('✅'), '并且标成 .done + ✅');
ok(ch1row.done_at === at1, '时间戳没有被改写');

console.log('── 同步：资源的章节进度条 / 列表 / 动态流 ──');
tabs[4].fire('click'); await tick();          // res
const r1done = byResName('线性代数应该这样学');
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

console.log('── 核心：一组里勾好几条 + 两组一起勾，一次全记掉 ──');
/* 真实场景：今天推进了大任务的两步，还读了一章 —— 一次按下去三条一起落。
   同一组里勾两条，正是她说的「也可以多选」。把 s2 / s3 都退回未完成（测完还回去）。 */
const s2row = DB.subtasks.find((x) => x.id === 's2');
const s2keep = { done: s2row.done, done_at: s2row.done_at };
const s3row2 = DB.subtasks.find((x) => x.id === 's3');
const s3keep3 = { done: s3row2.done, done_at: s3row2.done_at };
s2row.done = false; s2row.done_at = null;
s3row2.done = false; s3row2.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();

await chipOn('学完线性代数');
await stepOn('第 5-8 讲');
await stepOn('习题课');
const picked2 = stepChips('学完线性代数').filter((c) => hasCls(c, 'on'));
ok(picked2.length === 2, '同一个大任务里勾了两步（这就是「也可以多选」）：' +
  picked2.map((c) => c.textContent).join(' | '));
ok($('done-btn').textContent.includes('推进 2 步'), '按钮跟着报 2 步：' + $('done-btn').textContent);

await chipOn('线性代数应该这样学');
await stepOn('第 2 章');
ok(stepChips('线性代数应该这样学').filter((c) => hasCls(c, 'on')).length === 1, '资源那边挑了 1 章');
ok(hasCls(laneChip('学完线性代数'), 'on') && hasCls(laneChip('线性代数应该这样学'), 'on'),
  '两组各勾着，同时挂着');
ok($('done-btn').textContent.includes('推进 2 步') && $('done-btn').textContent.includes('勾掉 1 章'),
  '按钮把两样都写出来：' + $('done-btn').textContent);

const ch2row = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 2);
const nBeforeBoth = DB.subtasks.length;
$('done-btn').fire('click'); await tick(); await tick();

ok(DB.subtasks.length === nBeforeBoth,
  '一次记三条也**不新增行**，实际多了 ' + (DB.subtasks.length - nBeforeBoth));
ok(s2row.done === false && typeof s2row.done_at === 'string' &&
   Math.abs(Date.now() - new Date(s2row.done_at).getTime()) < 60000,
  '大任务那两步：只盖推进戳，done 仍然是 false');
ok(s3row2.done === false && typeof s3row2.done_at === 'string',
  '第二步也盖上了推进戳 —— 不是只记了第一条');
ok(ch2row.done === true && typeof ch2row.done_at === 'string',
  '资源那一章：真的算完成，done = true');
/* 条数按**实际记成的**说：勾了 3 条就是 3 条，跳过的绝不混进来说成功 */
ok($('toast').textContent.includes('推进了 2 步') && $('toast').textContent.includes('勾掉了 1 章'),
  '一条提示把三条都说清楚（按实际记成的条数）：' + $('toast').textContent);

/* 还回去：s2 / s3 恢复、第 2 章退回未勾，后面的用例照旧 */
Object.assign(s2row, s2keep);
Object.assign(s3row2, s3keep3);
ch2row.done = false; ch2row.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
ok(byCls($('done-picker'), 'chip').length === 5,
  '刷新之后回到出厂样子：一条不预勾、子项不摊开，只列 5 个父项，实际 ' +
  byCls($('done-picker'), 'chip').length);

console.log('── 更强的同步：把「大任务的一步」和「书的一章」关联成同一件事（可以挂好几条）──');
const html2 = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const sql5 = fs.readFileSync(path.join(DIR, 'setup-5-link.sql'), 'utf8');
const sql9 = fs.readFileSync(path.join(DIR, 'setup-9-links.sql'), 'utf8');
ok(/add column if not exists link_id/.test(sql5),
  'setup-5-link.sql 那一列还在（旧数据一行不删，页面继续读得到）');
ok(/create table if not exists public\.links/.test(sql9), 'setup-9-links.sql 建的是 links 表（可重复执行）');
ok(/create unique index if not exists links_pair_uniq/.test(sql9), '同一对只留一行（唯一索引挡重复）');
ok(/a_kind in \('subtask', 'goal'\)/.test(sql9), '两端可以是 subtask（一步/一章）或 goal（30 天小目标）');
ok(/同一件事/.test(html2), 'index.html 里把「↔」讲清楚了（大任务拆解 / 学习资源各一句）');
ok(/可以关联好几条/.test(html2), '并且说明了能挂好几条');

tabs[2].fire('click'); await tick();          // tasks
const c1r = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 1);
const c2r = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 2);
const s2r = DB.subtasks.find((x) => x.id === 's2');
const s3r = DB.subtasks.find((x) => x.id === 's3');
const g1r = DB.goals.find((x) => x.id === 'g1');
/* 这一整节会来回改这些行的状态，先记下原样，收尾时逐条还回去
   （后面的用例依赖它们现在的样子） */
const c1keep = { done: c1r.done, done_at: c1r.done_at };
const c2keep = { done: c2r.done, done_at: c2r.done_at };
const s2keep2 = { done: s2r.done, done_at: s2r.done_at };
const s3keep2 = { done: s3r.done, done_at: s3r.done_at };
const g1keep = { done: g1r.done, progress: g1r.progress, done_at: g1r.done_at };

const rowS2 = subRowOf($('tasks-cols'), '第 5-8 讲');
ok(!!rowS2, '找得到「第 5-8 讲」这一行');
const selS2 = rowSel(rowS2);
ok(!!selS2, '每一步多了「↔ 同一件事」那一行');
ok(selS2.textContent.includes('＋ 关联…'), '默认是「＋ 关联…」：' + selS2.textContent.slice(0, 24));
ok(selS2.textContent.includes('线性代数应该这样学 · 第 2 章'), '对家是这本书的章节，列了出来');
ok(selS2.textContent.includes('30 天小目标 · 背完 300 个单词'), '30 天小目标也能挂上来');
ok(!selS2.textContent.includes('第 1-4 讲'), '不列自己的兄弟姐妹 —— 只能跨「大任务 ↔ 资源」挂');
ok(!selS2.textContent.includes('考研政治'), '对方的资源不出现');
ok(!selS2.textContent.includes('交开题报告'), '倒计时的目标不参与（它是 0/1 的截止日，没法拆解）');
ok(byCls(rowS2, 'lk').length === 0, '还没关联时一个小方块都不显示');

/* 关联之前两边状态故意不一样（s2 早就完成、第 2 章没有）→ 应该**问她一句**，不自己拉平 */
ok(s2r.done === true && c2r.done === false, '关联之前两边状态确实不一样，正好用来测「问一句」');
globalThis.confirm = () => false;             // 先答「不」
await pickLink(rowS2, 'subtask:' + c2r.id);
ok(DB.links.length === 1, 'links 表里只写了一行（不是两边各写一条），实际 ' + DB.links.length);
const pair = DB.links[0];
ok(new Set([pair.a_id, pair.b_id]).size === 2 &&
   [pair.a_id, pair.b_id].includes('s2') && [pair.a_id, pair.b_id].includes(c2r.id),
  '这一行两端指着这两条');
ok(pair.a_kind + ':' + pair.a_id < pair.b_kind + ':' + pair.b_id,
  '写之前先排了序 —— 正着点反着点都落在同一行上，唯一索引挡得住重复');
ok(s2r.done === true && c2r.done === false,
  '她答「不」时，不替她把哪一边标成完成');
ok($('toast').textContent.includes('关联上了'), '并且提示已经关联上：' + $('toast').textContent);

/* ── 这次改动的重点：一条可以挂**好几条** ── */
const rowS2b = subRowOf($('tasks-cols'), '第 5-8 讲');
ok(byCls(rowS2b, 'lk').length === 1, '已经关联的那条显示成一个小方块');
ok(byCls(rowS2b, 'lk')[0].textContent.includes('第 2 章'),
  '方块上写着关联的是哪一条：' + byCls(rowS2b, 'lk')[0].textContent);
ok(!rowSel(rowS2b).textContent.includes('第 2 章'), '已经挂上的那条不再出现在候选里');
ok(rowSel(rowS2b).textContent.includes('第 3 章'), '但别的还能接着挂（多对多，不再「名花有主」）');
/* 第 1 章早就完成了，s2 也完成着 —— 两边状态一样，这一条**不该**再问她 */
let asked = 0;
globalThis.confirm = () => { asked++; return false; };   // 这一圈里还有一条没完成 → 应该问一句
await pickLink(rowS2b, 'subtask:' + c1r.id);
ok(DB.links.length === 2, '挂上第二条了，两条并存（多对多，不再「名花有主」），实际 ' + DB.links.length);
ok(asked === 1, '这一圈里状态不一致，所以问了一句');
ok(c2r.done === false && s2r.done_at === s2keep2.done_at, '她答「不」就一条也不动');
globalThis.confirm = () => true;

const rowS2c = subRowOf($('tasks-cols'), '第 5-8 讲');
ok(byCls(rowS2c, 'lk').length === 2, '两个小方块并排显示，可以挂好几条');
ok(rowSel(rowS2c).textContent.includes('＋ 关联…') && !rowSel(rowS2c).textContent.includes('第 1 章'),
  '两条挂过的不再出现在候选里');

/* ── 多对多的关键一条：只排掉「挂给我的」，不能把「挂给别人的」也排掉 ──
   第 2 章这会儿已经挂给「第 5-8 讲」了。多对多的意思正是「一章 = 两本书的那一节」
   也可能同时等于**另一**步，所以它在别的行的候选里必须还在。
   （只按文案断言会漏：那一条的表达在两边都能通过，得直接看 option 的 value。） */
const optVals = (row) => (rowSel(row)
  ? rowSel(row).children.filter((c) => c.tagName === 'OPTION').map((c) => c.value) : []);
const selS3 = subRowOf($('tasks-cols'), '习题课');
ok(!!selS3 && optVals(selS3).includes('subtask:' + c2r.id),
  '已经挂给**别人**的那条，在别的行的候选里照旧列出来（不是「名花有主」）');

/* ── 核心：勾任意一边，关联着的另外几条自动跟上 ──
   先把三条都退回未完成：不然「跟上了」可能只是它本来就完成着，
   测出来的是空过（第一版就踩了这个坑，变异测试当场戳穿）。 */
s2r.done = false; s2r.done_at = null;
c1r.done = false; c1r.done_at = null;
c2r.done = false; c2r.done_at = null;
$('btn-refresh').fire('click'); await tick();

tabs[4].fire('click'); await tick();          // res
const r1card = byResName('线性代数应该这样学');
const chRow2 = subRowOf(r1card, '第 2 章');
ok(!!chRow2, '书的章节行也在（同一个 subRow 渲染的）');
ok(!!rowSel(chRow2), '这一章也有那条「↔」');
ok(byCls(chRow2, 'lk').length === 1 && byCls(chRow2, 'lk')[0].textContent.includes('第 5-8 讲'),
  '从这一边也看得到那一步：' + byCls(chRow2, 'lk')[0].textContent);

/* 日历上今天几件 —— 关联着的三条只能算一件 */
tabs[1].fire('click'); await tick();
const dBefore = Number(dcOf(now.getDate()) || 0);
tabs[4].fire('click'); await tick();

rowBox(subRowOf(byResName('线性代数应该这样学'), '第 2 章'))
  .fire('change', { target: { checked: true } });
await tick(); await tick();

ok(c2r.done === true, '勾了这一章，它自己完成');
ok(s2r.done === true, '**大任务里对应的那一步跟着完成了**');
ok(c1r.done === true, '**另外挂着的那一章也跟着完成了**（不是只联动一条）');
ok(s2r.done_at === c2r.done_at && c1r.done_at === c2r.done_at,
  '三条用的是同一个时刻，不会被算成三天');

tabs[1].fire('click'); await tick();
ok(Number(dcOf(now.getDate()) || 0) === dBefore + 1,
  '日历上今天只多 1 件，不是 3 件（关联着的几条是同一件事）：' +
  dBefore + ' → ' + dcOf(now.getDate()));

tabs[0].fire('click'); await tick();          // home
const feedN = ($('feed').textContent.match(/完成章节|完成小任务/g) || []).length;
tabs[4].fire('click'); await tick();
rowBox(subRowOf(byResName('线性代数应该这样学'), '第 2 章'))
  .fire('change', { target: { checked: false } });
await tick(); await tick();
ok(c2r.done === false && s2r.done === false && c1r.done === false,
  '取消勾选，关联着的三条一起退回未完成');
tabs[0].fire('click'); await tick();
ok(($('feed').textContent.match(/完成章节|完成小任务/g) || []).length === feedN - 1,
  '动态流里也只减 1 条，不是 3 条');

/* ── 再挂第三条：验证真能挂好几条，以及一圈状态本来就一致时不该弹确认框 ── */
const c3r = DB.subtasks.find((x) => x.resource_id === 'r1' && x.seq === 3);
tabs[2].fire('click'); await tick();
let asked2 = 0;
globalThis.confirm = () => { asked2++; return true; };
await pickLink(subRowOf($('tasks-cols'), '第 5-8 讲'), 'subtask:' + c3r.id);
ok(DB.links.length === 3, '挂上第三条了，好几条并存，实际 ' + DB.links.length);
ok(asked2 === 0, '这一圈此刻全都没完成、状态本来就一致 → 不弹确认框烦她');
globalThis.confirm = () => { confirmCalls++; return true; };
ok(byCls(subRowOf($('tasks-cols'), '第 5-8 讲'), 'lk').length === 3, '三个小方块并排显示');

/* ── 反方向：在「大任务拆解」里勾那一步，书那边跟着完成 ── */
tabs[2].fire('click'); await tick();
rowBox(subRowOf($('tasks-cols'), '第 5-8 讲')).fire('change', { target: { checked: true } });
await tick(); await tick();
ok(c1r.done === true && c2r.done === true, '在大任务那边勾，两章都跟着完成（关联是双向的）');
ok(c3r.done === true, '隔着一跳的那条也跟上了 —— 按**整圈**传，不是只传一跳');

/* ── 30 天小目标也能挂上来（她原话：「下面的 30 天小目标依然可以关联上」）──
   2026-09-26 那张备忘录撤了，所以这次**从子任务这一侧挂过去** ——
   候选下拉里仍然列着 g1（kindOfGoal 只放行没有 due_date 的那几个）。
   两边都先退回未完成，不然「它没被标成完成」测的是空过。收尾按 g1keep / s3keep2 还原。 */
g1r.done = false; g1r.done_at = null; g1r.progress = 120;
s3r.done = false; s3r.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[2].fire('click'); await tick();          // tasks
const rowS3link = subRowOf($('tasks-cols'), '习题课');
ok(!!rowSel(rowS3link), '「习题课」这一行有「↔ 同一件事」');
ok(optVals(rowS3link).includes('goal:g1'),
  '候选下拉里还列着那个 30 天小目标（界面撤了，关联没撤）：' +
  optVals(rowS3link).join(' | '));
await pickLink(rowS3link, 'goal:g1');
const gpair = DB.links.find((l) => l.a_id === 'g1' || l.b_id === 'g1');
ok(!!gpair, '30 天小目标和一条小任务关联上了');
ok(gpair.a_kind === 'goal' || gpair.b_kind === 'goal', '这一端是 goal，另一端是 subtask');

/* 关键：勾那一步**不会**顺手把这个 30 天目标标成完成 —— 它有自己的进度计数 */
rowBox(subRowOf($('tasks-cols'), '习题课')).fire('change', { target: { checked: true } });
await tick(); await tick();
ok(s3r.done === true, '勾了「习题课」这一步（它本来是待办，所以这一下是真变化）');
ok(g1r.done === false && g1r.progress === 120,
  '关联着的 30 天目标**没有**被跟着标成完成，进度也没动（它自己算自己的）');

/* ── 解开：点一下那个小方块 ── */
const rowS3c = subRowOf($('tasks-cols'), '习题课');
const gpill = byCls(rowS3c, 'lk').find((n) => n.textContent.includes('背完 300 个单词'));
ok(!!gpill, '这一步那边显示着关联的小目标：' +
  byCls(rowS3c, 'lk').map((n) => n.textContent).join(' | '));
gpill.fire('click'); await tick(); await tick();
ok(!DB.links.some((l) => l.a_id === 'g1' || l.b_id === 'g1'), '点一下就解开了（不用再去下拉里选「不绑」）');
ok($('toast').textContent.includes('解开了'), '并且说一声：' + $('toast').textContent);
ok(g1r.done === false && g1r.progress === 120, '解开也不会顺手改完成状态和进度');

/* ── 旧的一对一那一列（setup-5-link.sql）：数据没删，照样读得到、照样能解 ── */
s3r.link_id = c1r.id;
c1r.link_id = 's3';
$('btn-refresh').fire('click'); await tick();
tabs[2].fire('click'); await tick();
const rowS3 = subRowOf($('tasks-cols'), '习题课');
ok(byCls(rowS3, 'lk').length === 1, '旧的一对一绑定被当成一条关联显示出来，一行都没丢');
ok(byCls(rowS3, 'lk')[0].textContent.includes('第 1 章'),
  '方块上写的是对家的名字：' + byCls(rowS3, 'lk')[0].textContent);
/* 缺列时的降级：旧的那一套解绑要写 link_id，库里没这一列就得说清楚去跑哪个脚本 */
failNext = 'column "link_id" of relation "subtasks" does not exist';
byCls(rowS3, 'lk')[0].fire('click'); await tick(); await tick();
ok($('toast').textContent.includes('setup-5-link.sql'),
  '缺列时被翻译成「去跑哪个脚本」，不甩 Postgres 原文：' + $('toast').textContent);
ok(s3r.link_id === c1r.id, '写失败了就老实保持原样，不会假装解开');
ok(failNext === null, '（failNext 已消耗）');
/* 再点一次（这次能写）→ 两边都松开 */
const rowS3b = subRowOf($('tasks-cols'), '习题课');
byCls(rowS3b, 'lk')[0].fire('click'); await tick(); await tick();
ok(s3r.link_id == null && c1r.link_id == null,
  '点掉旧的那条时，**两边**的 link_id 都清掉，不留单向指针');

/* ── 删掉一条：跟别处同一个规矩（不弹框、延迟真删），挂着的关联要一起清 ──
   这里除了「删掉」本身，钉的是**真删那一刻**的两件收尾活儿：
     ① dropLinksOf：links 表里指着它的行不能留；
     ② 反方向的 link_id：对端那条 subtask 自己那一列也指着它，得一起清空，
        否则对端就成了指着一个不存在 id 的孤儿（勾选联动会勾到空气）。
   ①在 removeRow 里、②在 beforeDelete 钩子里 —— 两条都得真发生，删干净了才算数。 */
const nLinksBeforeDel = DB.links.length;
tabs[4].fire('click'); await tick();
/* 给对端埋一根反方向的指针，看它删完会不会被一起清掉。
   ⚠️ 必须**互相指着**：只埋单向的话，要清的那个值本来就是 null，
   断言永远为真 —— 第一版就是这么把这条漏过去的（变异检验抓出来的）。 */
c2r.link_id = s2r.id;
s2r.link_id = c2r.id;
$('btn-refresh').fire('click'); await tick();
tabs[4].fire('click'); await tick();
const confirmBeforeDel = confirmCalls;
btns(subRowOf(byResName('线性代数应该这样学'), '第 2 章'), '✕')[0].fire('click');
await tick(); await tick();
ok(confirmCalls === confirmBeforeDel, '删章节也不弹确认框了，点下去就是删');
ok(!subRowOf(byResName('线性代数应该这样学'), '第 2 章'), '那一章立刻从界面上消失');
ok(DB.subtasks.some((x) => x.id === c2r.id), '但库里还在 —— 留 5 秒给她撤回');
ok($('undo').hidden === false && $('undo').textContent.includes('第 2 章'),
  '底部条上点名删的是哪一章：' + $('undo').textContent);
runLongTimers(); await tick(); await tick();
ok(!DB.subtasks.some((x) => x.id === c2r.id), '5 秒过去 → 这次是真删了');
ok(DB.links.length === nLinksBeforeDel - 1,
  '挂着它的关联也一起清了，不留指着空气的行：' + nLinksBeforeDel + ' → ' + DB.links.length);
ok(DB.links.every((l) => l.a_id !== c2r.id && l.b_id !== c2r.id),
  'links 里再也找不到它');
ok(s2r.link_id == null, '对端那根反方向的指针也清了（不留指着一个不存在 id 的孤儿）');

/* 收尾：把第 2 章放回去、状态逐条还原、关联清空，后面的用例照旧。
   （删走的那条得**放回数组**，不然后面「这本书还有没勾过的章可以挑」就少一章） */
DB.subtasks.push(c2r);
Object.assign(c1r, c1keep);
Object.assign(c2r, c2keep);
Object.assign(s2r, s2keep2);
Object.assign(s3r, s3keep2);
Object.assign(g1r, g1keep);
DB.links.length = 0;
DB.subtasks.forEach((x) => { x.link_id = null; });
$('btn-refresh').fire('click'); await tick();

console.log('── 降级：还没跑 setup-9-links.sql ──');
/* 表不存在时：整页照常（旧的一对一那套还在用），只是挂不了第二条，
   而且明说去跑哪个脚本，不把 Postgres 原文甩给她。 */
failSelect = 'links';
$('btn-refresh').fire('click'); await tick();
tabs[2].fire('click'); await tick();
const rowDeg = subRowOf($('tasks-cols'), '第 5-8 讲');
ok(!!rowDeg && !!rowSel(rowDeg), '没有 links 表时页面照常画得出来，那一行还在');
failNext = "Could not find the table 'public.links' in the schema cache";
await pickLink(rowDeg, 'subtask:' + c1r.id);
ok($('toast').textContent.includes('setup-9-links.sql'),
  '写失败被翻译成「去跑哪个脚本」：' + $('toast').textContent);
ok($('toast').textContent.includes('只能一条对一条'),
  '并告诉她在那之前只能一条对一条');
ok(!DB.links.length, '（一行都没写进去）');
failSelect = null;
$('btn-refresh').fire('click'); await tick();

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
const r1noch = byResName('线性代数应该这样学');
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
/* 同上：三步全完成的话按钮说的是「都完事了」，测不到 noStep，先退回一步 */
const unshelveS3b = await shelveStep('s3');
await laneOn('学完线性代数');
ok($('done-picker').textContent.includes('哪一步'), '「哪一步」那一组在');
/* 勾了父项但没挑步 → 按钮不该装作能记，直接说卡在哪 */
ok($('done-btn').disabled === true && $('done-btn').textContent.includes('还没挑'),
  '切回大任务模式、还没挑步：按钮点不动并说清原因：' + $('done-btn').textContent);
await unshelveS3b();

/* 光写字、一条都不勾 —— 也该能存下，而且不能多出小任务 */
const T = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const TODAY = T.getFullYear() + '-' + pad2(T.getMonth() + 1) + '-' + pad2(T.getDate());
const myToday = () => DB.daily_logs.filter((x) => x.owner === ME && x.log_date === TODAY);
const notesOf = () => DB.daily_logs.filter((x) => x.owner === ME && x.log_date === TODAY && x.note);

ok(myToday().length === 0, '起点干净：这天还没有日记行（下面几条断言才有意义）');
/* 只勾一条、一个字没写 → 不该凭空造出一行空的日记。
   必须落在**子项**（「哪一步」那一组）的 chip 上：点父项只会摊开那一组、
   一条都不勾，那样按下去 plan 是空的，断言就成了空转。
   前面几段可能已经把每一步都勾掉了，先按回未完成，否则这一下会被挡掉。 */
const victim = DB.subtasks.find((x) => x.owner === ME && x.title === '习题课');
victim.done = false; victim.done_at = null;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
await chipOn('学完线性代数');
const undoneChip = stepChips('学完线性代数').find((c) => !hasCls(c, 'done'));
ok(!!undoneChip, '有一条第 5-8 讲 / 习题课这样还没做完的步骤可以挑');
if (undoneChip) await stepOn(undoneChip.textContent.replace(/[☐☑✅]/g, '').trim());
ok(!!undoneChip && $('done-btn').textContent.includes('推进 1 步'),
  '挑到一个没做过的步骤来测（挑不到的话这一下会被挡掉，断言就空转了）：' +
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
await stepOn('习题课');                 // 上一步关父项时把子项一起清了，得重新挑
$('done-note').value = '今天顺手记一笔';
$('done-note').fire('input'); await tick();
ok($('done-btn').textContent.includes('推进 1 步') && $('done-btn').textContent.includes('连文字一起存'),
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
/* 只清大任务：资源还在，所以**不该**禁用 —— 挂到资源上照样能记 */
DB.tasks.length = 0;
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
/* 多选之后没有「默认选中」，所以按钮一开始本来就是禁用的（等她自己勾）。
   这里要证的是「资源还在，勾一条就能记」—— 所以勾完再看按钮的状态。 */
ok(!mineChips().some((c) => c.textContent.includes('学完线性代数')),
  '大任务那一组整个消失，不留空壳');
ok($('done-picker').textContent.startsWith('学习资源'),
  '第一组就是学习资源：' + $('done-picker').textContent.slice(0, 20));
await chipOn('线性代数应该这样学');
/* 挑一条**还没完成**的章（前面几段可能已经把某几章勾掉了，写死「第 1 章」会挑到 disabled 的那条） */
const anyCh = stepChips('线性代数应该这样学').find((c) => !hasCls(c, 'done'));
ok(!!anyCh, '这本书还有没勾过的章可以挑');
if (anyCh) await stepOn(anyCh.textContent.replace(/[☐☑✅]/g, '').trim());
ok($('done-btn').disabled === false && $('done-btn').textContent.includes('勾掉 1 章'),
  '大任务没了但资源还在 → 勾一条照样能记：' + $('done-btn').textContent);

/* 反过来：一本书的章全勾完了，勾上它就该说「没得记」，而不是指路去点一个 disabled 的 chip */
const keepDone = DB.subtasks.filter((x) => x.resource_id === 'r1').map((x) => ({ row: x, done: x.done, done_at: x.done_at }));
DB.subtasks.filter((x) => x.resource_id === 'r1').forEach((x) => { x.done = true; if (!x.done_at) x.done_at = '2026-09-19T09:00:00Z'; });
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();
await chipOn('线性代数应该这样学');
ok($('done-btn').disabled === true && $('done-btn').textContent.includes('都完事了'),
  '章全勾完 → 按钮说「这一项已经都完事了」，不指路去点勾不动的东西：' + $('done-btn').textContent);
keepDone.forEach((k) => { k.row.done = k.done; k.row.done_at = k.done_at; });
$('btn-refresh').fire('click'); await tick();
tabs[3].fire('click'); await tick();

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
ok(mineChips().length === 5, '父项 chip 回来了（1 大任务 + 4 资源），实际 ' + mineChips().length);
ok(!mineChips().some((c) => hasCls(c, 'on')), '（多选之后还是「一条不预勾」）');
await chipOn('学完线性代数');
await stepOn('习题课');
ok($('done-btn').disabled === false, '大任务回来之后勾一条就能记了');
await chipOff('学完线性代数');

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

/* 删除走的是同一条路（延迟真删 + 5 秒撤回条），考试页也一样。
   这儿验一遍是为了钉住「删除那一套不是只有倒计时在用」。 */
console.log('── 考试成绩：删除 → 5 秒内可以撤回 ──');
const examCount3 = DB.exams.length;
btns(rowOf('还没出分的那场'), '删除')[0].fire('click'); await tick();
ok($('ex-cols').textContent.includes('还没出分的那场') === false, '点「删除」界面上立刻没了');
ok(DB.exams.length === examCount3 && DB.exams.some((e) => e.name === '还没出分的那场'),
  '库里那行还在 —— 真删推迟 5 秒，留出撤回的窗口');
ok($('undo').hidden === false, '撤回到条也冒出来了（不是只有倒计时那一页有）');
find($('undo'), (n) => n.tagName === 'BUTTON').fire('click'); await tick(); await tick();
ok(DB.exams.length === examCount3 && $('ex-cols').textContent.includes('还没出分的那场'),
  '点「撤回」那一场回来了，库里一行没少');
ok($('undo').hidden === true, '（撤回后条收起来，不给后面的用例留尾巴）');
/* 这一节后面的断言要靠「少了一场」。等 5 秒太慢，所以直接把库里那条摘掉再刷新 ——
   效果等于 5 秒后那个定时器干的事，顺便也验了「刷新之后列表跟着库走」。 */
DB.exams = DB.exams.filter((e) => e.name !== '还没出分的那场');
$('btn-refresh').fire('click'); await tick(); await tick();
ok(DB.exams.length === examCount3 - 1 && $('ex-cols').textContent.includes('还没出分的那场') === false,
  '少了一场之后重画，列表里也没了');

console.log('── 考试成绩：这条链路断了也不能连累别的页签 ──');
/* setup-6-exams.sql 还没跑：exams 表根本不存在（select 就报 schema cache 找不到）。
   要求：① 这一页明说去跑脚本；② 记不了东西，但别白屏；
   ③ **原来六张表照常读**（loadExams 是独立一条，绝不在 loadAll 的 Promise.all 里）。 */
/* 先往库里**加**一条目标，再让 exams 读失败、点刷新。
   断言目标页必须出现这条新目标 —— 光断言「原来那条还在」抓不住问题：
   S.goals 是上一次读到的旧数据，刷新失败时页面照旧显示旧值，看起来一切正常。
   （也不能用「改标题」的办法：假库返回的是同一批**对象引用**，
     改 DB 里的字段等于直接改了 S.goals，不用刷新就"看见"了，断言是空转的。） */
/* 这一条写成**倒计时**（带 due_date）—— 2026-09-26 之后没有 due_date 的 goals
   不再往界面上渲染，写那种的话「刷新后看得见」这条断言就落空了。
   收尾时把它删掉，后面的导出统计照旧按原来的数据算。 */
DB.goals.push({
  id: 'g-新加的', owner: ME, period_start: '2026-09-25', title: '刷新后才出现的倒计时',
  detail: '', target: 1, progress: 0, done: false, done_at: null,
  due_date: D2, created_at: '2026-09-25T00:00:00Z',
});
failSelect = 'exams';
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('ex-warn').hidden === false, '给出「还没建表」的提示，而不是静默空白');
ok($('ex-warn').textContent.includes('setup-6-exams.sql'), '提示里指明了要跑哪个脚本');
ok($('ex-lead').textContent.includes('setup-6-exams.sql'), '页头也说了要先跑脚本');
ok($('ex-cols').textContent.includes('这张表还没建'), '这一页降级成「这张表还没建」，没抛异常');
ok(tabs[3].dataset.tab === 'daily', '（页签对象还在）');
tabs[1].fire('click'); await tick();
ok(!!cdFind('刷新后才出现的倒计时'),
  '月度任务页读到的是刷新后的数据（exams 读失败没把六张表带崩）');
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

/* ── 校训：登录页和主页各显示一句，且是同一句 ────────────────
   两条路径都要测：
   ① 表在 → 显示库里的，能加 / 能改 / 能删；
   ② 表不在 → 退回内置的 39 条，登录页照样有话说（不能白着一行），只是改不了。 */
console.log('── 校训：登录页与主页随机显示一句 ──');
/* 主页那句是页头里的，任何页签下都在；管理卡片在「导出 / 导入」页，
   所以动列表之前要先切到那一页 —— 不然 $('mt-list') 是空的，
   看起来像「列表没渲染」，其实是那一页没打开过。 */
const mottoOf = () => $('home-motto').textContent;
const goData = async () => { tabs.find((t) => t.dataset.tab === 'data').fire('click'); await tick(); };
await goData();
ok(mottoOf() === $('lg-motto').textContent && mottoOf().length > 0,
  '登录页和主页显示的是**同一条**（各抽各的会让同一屏里两句话打架）：' + mottoOf());
ok(!$('mt-warn').textContent.includes('setup-8-mottos.sql'),
  '表在的时候不啰嗦脚本的事：' + ($('mt-warn').textContent || '(空)'));

DB.mottos = [
  { id: 'm1', school: '复旦大学', text: '博学而笃志，切问而近思', sort: 1, created_at: '2026-09-01T00:00:00Z' },
  { id: 'm2', school: '清华大学', text: '自强不息，厚德载物', sort: 2, created_at: '2026-09-01T00:00:00Z' },
];
$('btn-refresh').fire('click'); await tick(); await tick();
ok(/博学而笃志|自强不息/.test(mottoOf()),
  '刷新后显示的是**库里**那两条之一，不是内置兜底：' + mottoOf());
ok(mottoOf().includes('」 · '), '格式是「校训」 · 学校：' + mottoOf());

/* 「换一条看看」要真的换（两条的池子里至少换一次能换到另一条）。
   只看一次可能抽到同一条，所以给它几次机会 —— 但断言的是「换过」。 */
let changed = false;
for (let i = 0; i < 12 && !changed; i++) {
  const was = mottoOf();
  $('mt-shuffle').fire('click');
  if (mottoOf() !== was) changed = true;
}
ok(changed, '点「换一条看看」会换一条');

/* 加上一条 */
const nMt = DB.mottos.length;
$('mt-text').value = '临时·测试校训';
$('mt-school').value = '测试大学';
$('mt-add').fire('click'); await tick(); await tick();
ok(DB.mottos.length === nMt + 1, '「加上」真的写库了');
const mtNew = DB.mottos.find((m) => m.text === '临时·测试校训');
ok(mtNew && mtNew.school === '测试大学', '学校名也写进去了');
ok($('mt-text').value === '' && $('mt-school').value === '', '加完把两个输入框清空');
ok(mottoOf().includes('测试校训'),
  '刚加完就把它显示出来 —— 否则「加上了」之后顶上还是别人，像没存进去：' + mottoOf());

/* 空校训要拦下来 */
$('mt-text').value = '   ';
const nMt2 = DB.mottos.length;
$('mt-add').fire('click'); await tick(); await tick();
ok(DB.mottos.length === nMt2, '校训空着不写库');
ok($('toast').textContent.includes('先写一句话'), '并且说清楚要先写内容：' + $('toast').textContent);
$('mt-text').value = '';

/* 改一条：走 update，不能多出一行 */
const mtRow = byCls($('mt-list'), 'item').find((r) => r.textContent.includes('测试校训'));
btns(mtRow, '改')[0].fire('click');
ok(byCls($('mt-list'), 'item').some((r) => findAll(r, (n) => n.tagName === 'INPUT').length === 2),
  '点「改」把这一行换成两个输入框（原文 + 学校）');
const mtEditBox = byCls($('mt-list'), 'item').find((r) => findAll(r, (n) => n.tagName === 'INPUT').length === 2);
const mtIns = findAll(mtEditBox, (n) => n.tagName === 'INPUT');
mtIns[0].value = '临时·改过的校训';
mtIns[1].value = '改过的大学';
btns(mtEditBox, '保存')[0].fire('click'); await tick(); await tick();
ok(DB.mottos.filter((m) => m.text === '临时·改过的校训').length === 1, '改完只出一条（走的是 update）');
ok(DB.mottos.length === nMt2, '总条数没变 —— 没多出一行');
ok(DB.mottos.some((m) => m.school === '改过的大学'), '学校名也改了');
ok($('mt-text').value === '', '（改的那次没顺手往上面的「加上」表单里灌东西）');

/* 删除 */
const mtDel = byCls($('mt-list'), 'item').find((r) => r.textContent.includes('改过的校训'));
btns(mtDel, '删除')[0].fire('click'); await tick(); await tick();
ok(!DB.mottos.some((m) => m.text === '临时·改过的校训'), '「删除」真的删掉了');

/* 表不在 → 退回内置 39 条，照样有校训看 */
DB.mottos = [];
failSelect = 'mottos';
$('btn-refresh').fire('click'); await tick(); await tick();
const fb = mottoOf();
ok(fb.length > 0, '表没建时登录页也不是空着 —— 用内置那份兜底：' + fb);
ok(/^(「.*」)( · .+)?$/.test(fb), '兜底那条也是同样的格式：' + fb);
ok($('mt-warn').textContent.includes('setup-8-mottos.sql'),
  '并且明说去跑哪个脚本：' + $('mt-warn').textContent);
ok(!$('mt-list').textContent.includes('复旦'),
  '表不在时不画可点的列表（画了也存不下，点了只会报错）');
ok(mottoOf() === $('lg-motto').textContent, '兜底状态下两处也还是同一条');

/* 放掉钩子，恢复 */
DB.mottos = [
  { id: 'm1', school: '复旦大学', text: '博学而笃志，切问而近思', sort: 1, created_at: '2026-09-01T00:00:00Z' },
  { id: 'm2', school: '清华大学', text: '自强不息，厚德载物', sort: 2, created_at: '2026-09-01T00:00:00Z' },
];
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('mt-warn').textContent === '', '表回来后提示条自己收起来');
ok(/博学而笃志|自强不息/.test(mottoOf()), '显示切回库里那两条');

/* ── 站名：登录页和主页顶上那个名字（见 setup-10-site.sql）─────
   两条路径都要测：
   ① site 表在 → 显示库里的名字，能改；
   ② 表不在 → 退回写死的默认名，页面照常，只是改不了（明说去跑脚本）。
   页面顶上那两个 h1 在假 DOM 里是自动补出来的空 div，所以「index.html 里
   确实有这两个 id」得直接查源文件 —— 只测运行时的话，HTML 里漏了 id
   这里照样全绿，真浏览器里却是名字永远不跟着变。 */
console.log('── 站名：登录页与主页显示同一个名字 ──');
const htmlSrc = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
ok(/<h1 id="lg-title">Alano<\/h1>/.test(htmlSrc), 'index.html 的登录页 h1 有 id="lg-title" 且默认是 Alano');
ok(/<h1 id="home-title">Alano<\/h1>/.test(htmlSrc), 'index.html 的页头 h1 有 id="home-title" 且默认是 Alano');
ok(/<title>Alano<\/title>/.test(htmlSrc), 'index.html 的 <title> 默认也是 Alano');
const titleOf = () => $('home-title').textContent;
const sameTitle = () => titleOf() === $('lg-title').textContent;

/* 库里一行都没有（空表）＝ 跑完 SQL 但那一行被删过 —— 这时必须退回默认名，
   不能显示成空字符串，那样页头就是一个空行，看着像页面坏了。 */
DB.site = [];
$('btn-refresh').fire('click'); await tick(); await tick();
ok(titleOf() === 'Alano', '空表时退回写死的默认名：' + JSON.stringify(titleOf()));
ok(sameTitle(), '两处 h1 是同一个名字（各写各的会让同一屏里两个名字打架）');
ok(document.title === 'Alano', '浏览器标签页标题也跟着：' + document.title);

/* 库里有名字 → 三处一起变 */
DB.site = [{ id: true, title: '两个人的自习室' }];
$('btn-refresh').fire('click'); await tick(); await tick();
ok(titleOf() === '两个人的自习室', '显示**库里**那个名字，不是默认名：' + titleOf());
ok($('lg-title').textContent === '两个人的自习室', '登录页那个 h1 也变了');
ok(document.title === '两个人的自习室', '标签页标题也变了：' + document.title);
ok(!/id="st-now"/.test(htmlSrc), '卡上没堆一行「现在显示的是」—— 输入框里就是当前名字，多一行是重复');
ok(!$('st-warn').textContent.includes('setup-10-site.sql'), '表在的时候不啰嗦脚本的事：' + ($('st-warn').textContent || '(空)'));
ok($('st-title').value === '两个人的自习室', '输入框里预填的是当前名字');

/* 改名字：走 upsert（表只有一行，按主键 id 覆盖），改完三处立刻跟着变 */
$('st-title').value = '临时·测试站名';
$('st-save').fire('click'); await tick(); await tick();
ok(DB.site.length === 1, '改完还是**一行** —— 没多出第二条：' + DB.site.length);
ok(DB.site[0].title === '临时·测试站名', '新名字真的写库了');
ok(titleOf() === '临时·测试站名' && $('lg-title').textContent === '临时·测试站名',
  '改完两个 h1 立刻跟着变，不用刷新：' + titleOf());
ok(document.title === '临时·测试站名', '标签页标题也跟着变了');

/* 在框里打字时，刷新不能把正在打的名字盖掉（对方那台设备推实时事件 = 走同一条路） */
$('st-title').value = '打到一半的名字';
document.activeElement = $('st-title');
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('st-title').value === '打到一半的名字', '正在输入框里打字时，刷新不会把没打完的名字回填掉');
ok(titleOf() === '临时·测试站名', '（但库里那个名字没被这个「打到一半」的字符串污染）');
document.activeElement = null;
$('st-title').value = '';

/* 空名字 / 超长名字都要拦下来，别把库里的名字改坏 */
const before = DB.site[0].title;
$('st-title').value = '   ';
$('st-save').fire('click'); await tick(); await tick();
ok(DB.site[0].title === before, '名字空着（或全是空格）不写库');
ok($('toast').textContent.includes('名字不能是空的'), '并且说清楚原因：' + $('toast').textContent);

$('st-title').value = '阿'.repeat(25);
$('st-save').fire('click'); await tick(); await tick();
ok(DB.site[0].title === before, '超过 24 个字不写库');
ok($('toast').textContent.includes('最多 24 个字'), '并且说清楚是长度问题：' + $('toast').textContent);
ok(titleOf() === '临时·测试站名', '拦下来之后页面上还是原来那个名字，没被改坏');
$('st-title').value = '';

/* 表不在 → 退回默认名，页面照常，只是改不了 */
failSelect = 'site';
$('btn-refresh').fire('click'); await tick(); await tick();
ok(titleOf() === 'Alano', '表没建时退回默认名（不是空着）：' + JSON.stringify(titleOf()));
ok(sameTitle(), '这种状态下两处也还是同一个名字');
ok($('st-warn').textContent.includes('setup-10-site.sql'),
  '并且明说去跑哪个脚本：' + $('st-warn').textContent);
/* 表不在时点保存：真库那边会回一句「找不到这张表」，页面要把它翻译成
   「去跑 setup-10」，而不是把 PostgREST 的原文甩出来。
   （假库的 failSelect 是**一次性**的，只够让上面那次读失败；
     这里要的是「写」失败，所以另用 failNext 塞一句真库会说的话。） */
$('st-title').value = '表没建也想改';
failNext = "Could not find the table 'public.site' in the schema cache";
$('st-save').fire('click'); await tick(); await tick();
ok(!DB.site.some((s) => s.title === '表没建也想改'), '写失败时一个字都没写进去');
ok($('toast').textContent.includes('setup-10-site.sql'),
  '并且把这句报错翻译成去跑哪个脚本：' + $('toast').textContent);
ok(titleOf() === 'Alano', '页面顶上还是原来那个名字，没被改坏');

/* 数据库那道长度闸门（site_title_len）报错时也要说人话。
   ⚠️ 这条报错的原话是 `new row for relation "site" violates check constraint
   "site_title_len"` —— 里面既有 relation 又有带引号的 site，
   schemaWarn 里「表还没建」那条分支会把它整条吃掉。所以两条分支的
   先后顺序是有讲究的，这里把它钉死。 */
failNext = 'new row for relation "site" violates check constraint "site_title_len"';
$('st-save').fire('click'); await tick(); await tick();
ok($('toast').textContent.includes('24 个字') && !$('toast').textContent.includes('setup-10'),
  '长度约束报错说的是长度，不是误导她去跑脚本：' + $('toast').textContent);
$('st-title').value = '';

/* 放掉钩子，恢复 */
DB.site = [{ id: true, title: '两个人的自习室' }];
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('st-warn').textContent === '', '表回来后提示条自己收起来');
ok(titleOf() === '两个人的自习室', '显示切回库里那个名字');
ok(channels.includes('study-site'),
  'site 也订了实时 —— 没订的话对方改完名字，这边要手动刷新才看得到'
  + '（药丸上那句「已连接 · 实时同步」看不出来，少订一张也照样是全连上）：'
  + channels.join(' '));

/* 导出的快照里带上当前站名（放在顶层，不塞进 data —— site 没有 owner，
   塞进 data 会被导入逻辑当成「对方的行」跳掉） */
const siteSnap = (() => {
  const orig = globalThis.Blob;
  let text = '';
  globalThis.Blob = class { constructor(parts) { text = String(parts[0]); } };
  $('btn-export').fire('click');
  globalThis.Blob = orig;
  return JSON.parse(text);
})();
ok(siteSnap.site && siteSnap.site.title === '两个人的自习室',
  '导出的快照顶层记了当前站名：' + JSON.stringify(siteSnap.site));
ok(siteSnap.backend.tables.includes('site'), 'backend.tables 里有 site');
ok(/setup-10-site\.sql/.test(siteSnap.backend.schema_sql), 'schema_sql 列到了 setup-10-site.sql');
ok(!('site' in siteSnap.data), 'site 不在 data 里（否则导入会报告「跳过 1 行·属于对方」）');

/* ══════════════════════════════════════════════════════════════
   2026-09-26 追加：资源列表分两层、已添加的资源可继续改、改自己的名字
   ══════════════════════════════════════════════════════════════ */
console.log('── 学习资源：列表按「学科 → 类型」分两层 ──');
tabs[4].fire('click'); await tick();

/* 只看**我那一栏** —— 两栏各分各的，混在一起数会把对方那栏也算进来。
   who/me 每次刷新都是新节点，所以这里写成函数，别存下来。 */
const myCol   = () => findAll($('res-cols'), (n) => hasCls(n, 'who') && hasCls(n, 'me'))[0];
const rGroups = () => findAll(myCol(), (n) => hasCls(n, 'res-group'));
const gName   = (g) => (findAll(g, (n) => hasCls(n, 'rg-name'))[0] || {}).textContent;
const gN      = (g) => (findAll(g, (n) => hasCls(n, 'rg-n'))[0] || {}).textContent;
const kNames  = (g) => findAll(g, (n) => hasCls(n, 'rk-name')).map((n) => n.textContent);

ok(rGroups().length === 2,
  '我这一栏分了 2 个学科组（数学 3 个 + 英语 1 个）：' + rGroups().map(gName).join(' / '));
ok(gName(rGroups()[0]) === '数学' && gN(rGroups()[0]) === '3 个',
  '第一组是数量最多的那一科，个数标在组头上不用她数：' + gName(rGroups()[0]) + ' ' + gN(rGroups()[0]));
ok(kNames(rGroups()[0]).join('|') === '工具书|网课|老师',
  '学科里面再按类型细分，顺序固定：' + kNames(rGroups()[0]).join('|'));
const kindDots = findAll(rGroups()[0], (n) => hasCls(n, 'kdot'));
ok(kindDots.length === 3
  && String(kindDots[0].style.background).includes('--series-1')
  && String(kindDots[1].style.background).includes('--series-2')
  && String(kindDots[2].style.background).includes('--series-3'),
  '每个类型头上有色点，用的就是宏观图那三个色（图跟列表说的是同一件事）：'
  + kindDots.map((d) => d.style.background).join(' '));
ok(!findAll(rGroups()[0], (n) => hasCls(n, 'pill') && /工具书|网课|老师/.test(n.textContent)).length,
  '卡片上不再重复标一遍类型 —— 小组头已经写了，再标一遍是啰嗦');

/* 临时造两条极端数据：一条没填学科、一条 kind 是脏值。测完原样还回去。 */
const keepResForGroup = DB.resources.map((r) => Object.assign({}, r));
DB.resources.push(
  { id: 'r9', owner: ME, kind: 'book', name: '化学习题', platform: '', subject: '化学',
    url: '', status: 'todo', created_at: '2026-09-25T00:00:00Z' },
  { id: 'r8', owner: ME, kind: 'weird', name: '不知道哪来的', platform: '', subject: '',
    url: '', status: 'todo', created_at: '2026-09-25T01:00:00Z' });
$('btn-refresh').fire('click'); await tick(); await tick();

const chem = rGroups().find((g) => gName(g) === '化学');
ok(!!chem && kNames(chem).join('|') === '工具书',
  '新加的那一科自己成一组，组内照样按类型分：' + (chem ? kNames(chem).join('|') : '(没有化学组)'));

/* 脏 kind 的那条没填学科，所以它落在「未分类」组里。
   两条断言都在这一组上：学科兜底 + 类型兜底 —— 库里的行一条都不能凭空消失。 */
const unc = rGroups()[rGroups().length - 1];
ok(gName(unc) === '未分类',
  '没填学科的那条归到「未分类」，而且**永远排在最后**，不顶在分好类的上面：'
  + rGroups().map(gName).join(' / '));
ok(kNames(unc).join('|') === '其他',
  'kind 是脏值的那条兜进「其他」小组，不会凭空消失：' + kNames(unc).join('|'));
const othDot = findAll(unc, (n) => hasCls(n, 'kdot'))[0];
ok(!!othDot && String(othDot.style.background).includes('--muted'),
  '「其他」用中性色，不占用那三个正经类型的颜色：' + (othDot ? othDot.style.background : '(没有)'));
/* 这条脏 kind 的行，卡片上那个就地改类型的小下拉也得给它一个对得上的项 ——
   下拉里没有它，浏览器就会把第一项（工具书）顶上来，看着像她填过一样。 */
const dirtySel = resSelects(findAll(unc, (n) => hasCls(n, 'item'))[0])[0];
ok(!!dirtySel && selVal(dirtySel) === 'weird' && dirtySel.textContent.includes('其他'),
  '库里 kind 是脏值的那条，类型下拉里也兜一个「其他」给它：'
  + (dirtySel ? selVal(dirtySel) + ' / ' + dirtySel.textContent : '(没有下拉)'));

DB.resources.length = 0;
keepResForGroup.forEach((r) => DB.resources.push(r));
$('btn-refresh').fire('click'); await tick(); await tick();
ok(rGroups().length === 2, '还回去之后恢复成 2 组（临时那两条没留在库里）：' + rGroups().map(gName).join(' / '));

console.log('── 学习资源：在卡片上就地改（没有「改」按钮那一套）──');

/* 她的原话：「可以不要用"改"字吗，直接在对应已经添加的部分编辑就行了吧」。
   先把这条钉死 —— 资源列表里不该再有「改」这个按钮，上面那张表单也不该再有
   「取消」：它只管新建，没有「改一半反悔」这回事了。 */
ok(btns($('res-cols'), '改').length === 0, '资源列表里没有「改」这个按钮了');
/* 别用 $('r-cancel') 判 —— 假 DOM 的 getElementById 会把缺的元素凭空造出来，
   永远为真。查静态结构只能直接读 index.html。 */
ok(!/id="r-cancel"/.test(htmlSrc), '上面那张表单的「取消」也一起删了，html 里都没有它');

const r1CardIn = byResName('线性代数应该这样学');
ok(!!r1CardIn, 'r1 那张卡片还在');
const nameIn = resNameInput(r1CardIn);
const [platIn, subjIn] = resTextInputs(r1CardIn);
ok(!!nameIn && hasCls(nameIn, 'inline'), '名称本身**就是**个输入框，不是「点一下才变出来」的');
ok(nameIn.value === '线性代数应该这样学', '框里就是库里那个名字：' + nameIn.value);
ok(String(nameIn.title).includes('点一下就能改'), '移上去有一句告诉她这儿能改：' + nameIn.title);
ok(platIn.value === '' && subjIn.value === '数学',
  '平台 / 学科同样是输入框，值是库里的：' + JSON.stringify([platIn.value, subjIn.value]));
/* 空着时那句灰字只能有两个字。写成长句（「平台（B站 / Coursera…）」）会把
   半个框填满灰字，看着像她已经填了内容；截图核对时就是这么发现的。
   读 getAttribute 不读 .placeholder —— 假 DOM 的 El 没声明这个属性，
   h() 于是走了 setAttribute 那条路（真浏览器里两条都能读到）。 */
const ph = (n) => (n ? n.getAttribute('placeholder') : null);
ok(ph(platIn) === '平台' && ph(subjIn) === '学科' && ph(resNameInput(r1CardIn)) === '名称',
  '空着时的提示就两个字，不写长句：'
  + [ph(resNameInput(r1CardIn)), ph(platIn), ph(subjIn)].join(' / '));
ok(!byCls(r1CardIn, 'sep').length, '两个框之间不加「·」—— 空值时那是夹在中间的一个孤儿');

const [kindSel, statSel] = resSelects(r1CardIn);
ok(selVal(kindSel) === 'book' && selVal(statSel) === 'doing',
  '类型 / 状态是就地下拉，选中的就是库里那个值：' + selVal(kindSel) + ' / ' + selVal(statSel));
ok(kindSel.textContent.includes('工具书'),
  '下拉里写的是中文标签，不是 book 这种内部值：' + kindSel.textContent);

/* 改名字：失焦（change）就自动写库。先记下库里那行，改完对一遍。 */
const r1Idx = DB.resources.findIndex((r) => r.id === 'r1');
const keepR1 = Object.assign({}, DB.resources[r1Idx]);
clearToast();
nameIn.value = '线性代数（改过名）';
nameIn.fire('change', { target: { value: nameIn.value } });
await tick(); await tick();
const r1Now = DB.resources.find((r) => r.id === 'r1');
ok(r1Now.name === '线性代数（改过名）', '改完名字自动写库：' + r1Now.name);
ok(DB.resources.length === 5 && DB.resources.filter((r) => r.id === 'r1').length === 1,
  '走的是 update 不是 insert —— 没多出一行：' + DB.resources.length + ' 条');
ok(r1Now.owner === ME && r1Now.created_at === keepR1.created_at,
  'owner 和 created_at 一个字都没碰（就地改也不该碰这两列）');
ok($('toast').textContent.includes('已保存'),
  '存完说一声「已保存」—— 没有按按钮那一下，不说她不知道到底存上没有：' + $('toast').textContent);
ok(byResName('线性代数（改过名）') !== r1CardIn && byResName('线性代数应该这样学') === null,
  '名字决定这条排在哪一组，所以改完重画了一次；旧名字那张卡已经不在列表上了');

/* 学科决定分组 —— 换学科要立刻换组，且不用她手动刷新。 */
const subjIn2 = resTextInputs(byResName('线性代数（改过名）'))[1];
subjIn2.value = '高等数学';
subjIn2.fire('change', { target: { value: subjIn2.value } });
await tick(); await tick();
ok(DB.resources.find((r) => r.id === 'r1').subject === '高等数学', '改学科也自动写库');
ok(!!rGroups().find((g) => gName(g) === '高等数学'),
  '换了学科立刻自己成一组，不用刷新：' + rGroups().map(gName).join(' / '));

/* 平台不决定分组 —— 所以**不重画**：重画会把光标从输入框里踢出去，
   她正打到一半的字就没了。这条盯的是「同一个 DOM 节点还在」，不是文案。 */
const card3 = byResName('线性代数（改过名）');
const platIn3 = resTextInputs(card3)[0];
platIn3.value = '图书馆';
platIn3.fire('change', { target: { value: platIn3.value } });
await tick(); await tick();
ok(DB.resources.find((r) => r.id === 'r1').platform === '图书馆', '改平台也写库了');
ok(resTextInputs(byResName('线性代数（改过名）'))[0] === platIn3,
  '平台不决定分组 → 不重画，她接着打第二个字时光标还在原来那个框里');

/* 名字不能空 —— 空名字在列表上就是一条看不见的东西。 */
const nameIn4 = resNameInput(byResName('线性代数（改过名）'));
clearToast();
nameIn4.value = '   ';
nameIn4.fire('change', { target: { value: nameIn4.value } });
await tick(); await tick();
ok(DB.resources.find((r) => r.id === 'r1').name === '线性代数（改过名）',
  '名字清空一个字节都不写库');
/* 先断「这一行还在」再读框里的值 —— 不重画的话按名字根本找不到这一行，
   直接读 .value 会抛异常把整轮跑挂掉，那就看不清是哪儿错了。 */
const card4 = byResName('线性代数（改过名）');
ok(!!card4, '名字没被写空，那一行还在（按名字还找得着）');
ok(!!card4 && resNameInput(card4).value === '线性代数（改过名）',
  '框里也弹回原来的名字 —— 不留一个空框在那儿骗人');
ok($('toast').textContent.includes('不能空着'), '并且说清楚为什么没给存：' + $('toast').textContent);

/* 换个类型 → 换小组。「相同科目分在一起、再按类型细分」那条的延伸。 */
const kindSel5 = resSelects(byResName('线性代数（改过名）'))[0];
kindSel5.value = 'course';
kindSel5.fire('change', { target: { value: 'course' } });
await tick(); await tick();
ok(DB.resources.find((r) => r.id === 'r1').kind === 'course', '下拉换类型也写库');
const adv = rGroups().find((g) => gName(g) === '高等数学');
ok(!!adv && kNames(adv).join('|') === '网课',
  '换成网课后，它那一组的小节头跟着变成「网课」：' + (adv ? kNames(adv).join('|') : '(没有高等数学组)'));

/* 状态不影响分组，同样不重画。 */
const statSel6card = byResName('线性代数（改过名）');
const statSel6 = resSelects(statSel6card)[1];
statSel6.value = 'done';
statSel6.fire('change', { target: { value: 'done' } });
await tick(); await tick();
ok(DB.resources.find((r) => r.id === 'r1').status === 'done', '状态也能就地改');
ok(resSelects(byResName('线性代数（改过名）'))[1] === statSel6,
  '状态不决定分组 → 也不重画，刚点过的下拉不会被重画掉');

/* 对方那一栏永远只有只读文字 —— 就地编辑不能把这条破掉。 */
const othCol = findAll($('res-cols'), (n) => hasCls(n, 'who') && !hasCls(n, 'me'))[0];
ok(!!othCol && othCol.textContent.includes('考研政治'), '对方那一栏还在');
ok(!findAll(othCol, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT').length,
  '对方那栏一个输入框 / 下拉都没有 —— 就地编辑只在「我」这边开');
ok(!!findAll(othCol, (n) => hasCls(n, 'pill'))[0], '对方的状态还是那个小圆标，不是能点的下拉');

/* 写失败：quiet() 报错 + 把真值拉回来，不留「界面上改了、库里没改」的假象。
   ⚠️ 假库 select 返回的是**同一批对象引用**，而就地改是「先改本地那份、再写库」——
   不换一下的话界面持有的和库里存的是同一个对象，改完两边一起变，
   「写失败弹回真值」这条根本测不出来（真库里这两份是分开的）。
   所以先把那一行换成内容一样的**新对象**，让界面手里那份变成「旧的」。 */
const r1db = DB.resources.findIndex((r) => r.id === 'r1');
DB.resources[r1db] = Object.assign({}, DB.resources[r1db]);
failNext = 'permission denied for table resources';
const nameIn7 = resNameInput(byResName('线性代数（改过名）'));
clearToast();
nameIn7.value = '这个名字不该留下来';
nameIn7.fire('change', { target: { value: nameIn7.value } });
await tick(); await tick();
ok(failNext === null, '（failNext 已消耗）');
ok(DB.resources.find((r) => r.id === 'r1').name === '线性代数（改过名）', '写失败，库里当然没变');
const card7 = byResName('线性代数（改过名）');
ok(!!card7, '界面上那一行回到了原来那个名字（写失败没留下改过的痕迹）');
ok(!!card7 && resNameInput(card7).value === '线性代数（改过名）',
  '界面也弹回真值 —— 不留「看着改了、其实没改」的假象');
ok($('toast').textContent.includes('permission denied'), '把库里的原话报出来：' + $('toast').textContent);

/* 还回去：名字 / 平台 / 学科 / 类型 / 状态都是。章节在另一张表里，这段没碰过。 */
Object.assign(DB.resources.find((r) => r.id === 'r1'), keepR1);
$('btn-refresh').fire('click'); await tick(); await tick();
ok(!!byResName('线性代数应该这样学') && DB.resources.length === 5
   && rGroups().map(gName).join(' / ') === '数学 / 英语',
  '把 r1 按原样还回去，列表恢复成 2 组：' + rGroups().map(gName).join(' / '));

console.log('── 我的名字：各改各的（页头 / 状态卡 / 动态流里那个）──');
/* 前提：没上传头像。前面「头像上传」那一段给 ME 写过 data URL，
   有头像时页头那个圆显示的是图片、textContent 当然是空的 ——
   下面这几条测的是**没头像**时「圆里那个字取名字首字」，先把头像清掉。 */
const meProfile = DB.profiles.find((p) => p.id === ME);
const keepAvatar = meProfile.avatar;
meProfile.avatar = '';
$('btn-refresh').fire('click'); await tick(); await tick();
tabs[6].fire('click'); await tick();
ok($('pn-name').value === '小 A', '输入框里预填的是库里那个名字：' + $('pn-name').value);
ok(/id="pn-name"[^>]*maxlength="12"/.test(htmlSrc),
  '输入框自己也带着 12 字上限，不用等按了保存才知道太长');
ok(!findAll($('me-av'), (n) => n.tagName === 'IMG').length && $('me-av').textContent === '小',
  '还没上传头像时，页头那个圆里取名字的第一个字：' + JSON.stringify($('me-av').textContent));

$('pn-name').value = '阿明';
$('pn-save').fire('click'); await tick(); await tick();
ok(DB.profiles.find((p) => p.id === ME).display_name === '阿明', '新名字真的写库了');
ok(DB.profiles.find((p) => p.id === OT).display_name === '小 B',
  '**只改自己那一行** —— 对方那条一个字没动（RLS 也只让改自己的）');
ok($('me-av').textContent === '阿', '页头那个圆立刻跟着换，不用刷新：' + $('me-av').textContent);
ok($('toast').textContent.includes('名字改好了'), '并且回一句「名字改好了」：' + $('toast').textContent);

/* 导出快照顶层那个 me.display_name 走的是 nameOf()（读 profileMap），
   data.profiles 那份走的是 profileList —— 两条路都得改，不然导出来的还是旧名字。
   ⚠️ 假库返回的是**同一批对象引用**，profileList 里那行跟 DB.profiles 里那行是
      同一个对象，所以「忘了同步 profileList」这个错法在这里抓不出来（变异检验
      证实过：把同步那两行删掉，下面两条照样全绿）。那一步只有在真库里才看得出来。
      留着这两条是因为它们钉的是「导出结果是对的」这个结果本身。 */
const nameSnap = (() => {
  const orig = globalThis.Blob;
  let text = '';
  globalThis.Blob = class { constructor(parts) { text = String(parts[0]); } };
  $('btn-export').fire('click');
  globalThis.Blob = orig;
  return JSON.parse(text);
})();
ok(nameSnap.me && nameSnap.me.display_name === '阿明',
  '导出的快照顶层 me 里是新名字：' + JSON.stringify(nameSnap.me && nameSnap.me.display_name));
const meInSnap = ((nameSnap.data || {}).profiles || []).find((p) => p.id === ME);
ok(!!meInSnap && meInSnap.display_name === '阿明',
  '快照 data.profiles 里那一行也是新名字：' + JSON.stringify(meInSnap && meInSnap.display_name));

/* 在框里打字时，刷新不能把正在打的名字盖掉（对方那台设备推实时事件 = 同一条路） */
$('pn-name').value = '打到一半的名字';
document.activeElement = $('pn-name');
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('pn-name').value === '打到一半的名字', '正在这个框里打字时，刷新不会把没打完的名字回填掉');
ok(DB.profiles.find((p) => p.id === ME).display_name === '阿明',
  '（但库里那个名字没被这个「打到一半」的字符串污染）');
document.activeElement = null;
$('pn-name').value = '';

/* 空 / 超长都要拦下来，别把库里的名字改坏。
   超长那条故意用「超」开头 —— 万一没拦住，页头那个圆会跟着变成「超」，
   跟「阿明」区分得开，这条断言才真的在测东西。 */
$('pn-name').value = '   ';
$('pn-save').fire('click'); await tick(); await tick();
ok(DB.profiles.find((p) => p.id === ME).display_name === '阿明', '名字空着（或全是空格）不写库');
ok($('toast').textContent.includes('名字不能是空的'), '并且说清楚原因：' + $('toast').textContent);

$('pn-name').value = '超'.repeat(13);
$('pn-save').fire('click'); await tick(); await tick();
ok(DB.profiles.find((p) => p.id === ME).display_name === '阿明', '超过 12 个字不写库');
ok($('toast').textContent.includes('最多 12 个字'), '并且说清楚是长度问题：' + $('toast').textContent);
ok($('me-av').textContent === '阿', '拦下来之后页头那个圆没被改坏：' + $('me-av').textContent);

/* 写失败（RLS 挡住 / 网络抖）时不能装作改成功了 */
$('pn-name').value = '存不下的名字';
failNext = 'permission denied for table profiles';
$('pn-save').fire('click'); await tick(); await tick();
ok(!DB.profiles.some((p) => p.display_name === '存不下的名字'), '写失败时一个字都没写进去');
ok($('me-av').textContent === '阿', '页头还是原来那个名字，没被改坏');

meProfile.display_name = '小 A';
$('btn-refresh').fire('click'); await tick(); await tick();
ok($('pn-name').value === '小 A' && $('me-av').textContent === '小', '名字还回去，页面跟着回到原样');
/* 头像还回去 —— 这一段开头是**借**「没头像」这个前提来测的，用完还给人家 */
meProfile.avatar = keepAvatar;
$('btn-refresh').fire('click'); await tick(); await tick();

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

/* ── 资源列表那两层分组的样式 ──
   断的是「层级看得出来」这件事：光有 DOM 结构、没有缩进和分隔线，
   屏幕上看上去还是一堆平铺的卡片，她说的「不直观」就还在。 */
ok(/\.res-kind\s+\.item\s*\{[^}]*margin-left\s*:\s*14px/.test(cssNoComment),
  '组内的卡片缩进一格 —— 缩进本身就是「它属于上面那个类型」的信号');
ok(/\.rg-head\s*\{[^}]*border-bottom\s*:/.test(cssNoComment),
  '学科组头下面有一条细分隔线，跟下面的卡片分得开');
ok(/\.rg-n\s*\{[^}]*margin-left\s*:\s*auto/.test(cssNoComment),
  '组头右边那个「N 个」被推到最右边，不跟学科名挤在一起');
/* ── 就地编辑那层「平时像文字、点进去才像输入框」的样式 ──
   不加这一层，一屏资源全是框框，比原来还乱。三条缺一不可：
   平时透明、移上去透出「这儿能改」、点进去才是正经输入框。 */
ok(/\.item\s+\.inline\s*\{[^}]*border\s*:\s*1px\s+solid\s+transparent/.test(cssNoComment),
  '卡片上那些字段平时是**透明边框**，看着就是文字，不是一屏输入框');
ok(/\.item\s+\.inline:hover\s*\{[^}]*border-color\s*:\s*var\(--border\)/.test(cssNoComment),
  '鼠标移上去才透出边框 —— 「这儿能改」的信号只在她要看的时候出现');
ok(/\.item\s+\.inline:focus\s*\{[^}]*border-color\s*:\s*var\(--series-1\)/.test(cssNoComment),
  '点进去用强调色描边，跟页面其他地方「正在编辑」说的是同一种颜色');
ok(/\.item\s+\.inline\s*\{[^}]*padding\s*:\s*2px\s+4px/.test(cssNoComment),
  '内边距恒定、不带负 margin —— 聚焦时盒子尺寸不变，旁边那块不会跟着抖一下');
ok(!/\.item\.editing/.test(cssNoComment), '「正在改」那套描边样式跟着拆掉了，不留死代码');

/* ── 2026-09-26：语义色收敛 / 视觉层级 / 撤回条 / 优先级色条 ──
   这四条都是「看」出来的东西，假 DOM 断言碰不到，只能在 CSS 侧钉住。 */
ok(/\.item\s+\.t\s*\{[^}]*font-size\s*:\s*15px/.test(cssNoComment),
  '标题 15px —— 跟 12px 的说明、12px 的元信息拉开三级，别再全挤在一个字号上');
ok(/\.item\s+\.m\s*\{[^}]*font-size\s*:\s*12px/.test(cssNoComment),
  '元信息 12px（原来 11.5px，跟 12px 的说明只差半档，等于没层级）');
ok(!/\.pill\s*\{[^}]*border\s*:\s*1px/.test(cssNoComment),
  '标签不再是描边式 —— 缩到 11px 时那圈细线看着发虚，改成浅色胶囊');
ok(/\.pill\.ok\s*\{[^}]*color-mix\(in srgb,\s*var\(--good\)/.test(cssNoComment),
  '「已完成」是一层淡绿底');
ok(/\.pill\.bad\s*\{[^}]*color-mix\(in srgb,\s*var\(--critical\)/.test(cssNoComment),
  '「逾期」是一层淡红底');
ok(/\.pill\.ok\s*\{[^}]*color\s*:\s*var\(--text-primary\)/.test(cssNoComment),
  '淡底上的字走主文字色 —— 同色字压同色淡底实测不到 AA（浅色底上红字只有 3.23:1）');
/* 撤回条：浮在底部，位置比 toast 高一档，两者同时出现时都点得到 */
ok(/\.undo\s*\{[^}]*position\s*:\s*fixed/.test(cssNoComment),
  '撤回条浮在底部，不占页面流');
ok(/\.undo\s*\{[^}]*bottom\s*:\s*78px/.test(cssNoComment),
  '它比 toast（bottom:28px）高一档 —— toast 正在报别的事时这一条也得点得到');
/* ⚠️ 回归点：.undo 写了 display:flex，靠的就是文件顶部那条 !important 的
   [hidden] 兜底。删了它，点完撤回条会一直挂在屏幕上。 */
ok(/\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/.test(cssNoComment),
  '撤回条靠文件顶部那条 [hidden]{display:none!important} 收起来（display:flex 压不过它）');
/* 优先级：一条 3px 色条，不铺底 */
ok(/\.item\.pri::before\s*\{[^}]*width\s*:\s*3px/.test(cssNoComment),
  '优先级色条 3px —— 就是这个宽度，再宽就成「一块背景」了');
ok(/\.item\.pri::before\s*\{[^}]*position\s*:\s*absolute/.test(cssNoComment),
  '色条是 ::before 绝对定位画的，不占文字的位置');
ok(/\.item\.pri\s*\{[^}]*padding-left\s*:\s*13px/.test(cssNoComment),
  '有优先级的卡片左边让出地方，色条不压字');
ok(!/\.item\.pri[^:]*\{[^}]*background\s*:/.test(cssNoComment),
  '优先级**不铺整块背景** —— 铺了会把「逾期红」「完成绿」这两件要紧事淹掉');
ok(!/\.pri-hi[^{]*\{[^}]*var\(--critical\)/.test(cssNoComment) &&
   !/\.pri-hi[^{]*\{[^}]*var\(--good\)/.test(cssNoComment),
  '优先级色条不占用红 / 绿 —— 红只留给逾期、绿只留给完成');
ok(/\.item\.pri-hi::before\s*\{[^}]*var\(--series-1\)/.test(cssNoComment),
  '「高」用系列色 1（不是红）');
/* 分区 + 折叠 */
ok(/\.cd-fold\s*>\s*summary\s*\{[^}]*cursor\s*:\s*pointer/.test(cssNoComment),
  '「已完成 N 件」那个头是可点的（收起 / 展开）');
ok(/\.cd-head\s+\.cd-name\s*\{[^}]*font-weight\s*:\s*700/.test(cssNoComment),
  '分区头（今天 / 本周 / 以后）比条目名更重，扫一眼能分段');
ok(/\.item\s+\.pri-sel\s*\{[^}]*border\s*:\s*1px\s+solid\s+transparent/.test(cssNoComment),
  '优先级下拉跟就地编辑框一个手感：平时没边框、点进去才描边');

/* 引一个**不存在**的自定义属性，浏览器会静默忽略整条声明 ——
   这类错没有任何别的机会被发现（假 DOM 不算 CSS，也没人去看渲染结果）。
   这里把「用到的 token」跟「定义过的 token」对一遍。 */
const definedTokens = new Set([...cssNoComment.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedTokens = [...cssNoComment.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
const missingTokens = [...new Set(usedTokens)].filter((t) => !definedTokens.has(t));
ok(missingTokens.length === 0,
  'CSS 里引用的自定义属性都真的定义过：' + (missingTokens.join(' ') || '(没有漏的)'));

console.log('── 登录报错能区分「账号不存在」和「邮箱没确认」──');
ok(/email_not_confirmed/.test(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')),
  '识别 email_not_confirmed，给出「去后台 Confirm email」的具体做法');

console.log('');
if (fails.length) { console.log('❌ ' + fails.length + ' 项没过：'); fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('✅ 全部通过');
process.exit(0);
