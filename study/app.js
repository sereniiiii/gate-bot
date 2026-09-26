/* ══════════════════════════════════════════════════════════════
   学习协作 · app.js

   数据存在 Supabase（Postgres）。安全靠服务端的 RLS，不靠这个文件。
   所以这里的两个常量可以公开：anon key 本来就设计成写在网页里的。
   ⚠️ 绝对不要往这个文件里放 sb_secret_... / service_role —— 那等于把库全交出去。

   口径（改之前先读）：
   · 读全部（两人互相看得到进度），写只能写自己的行 —— 由 setup.sql 的 policy 强制。
     前端不重复实现这个判断，只是不给自己以外的行画按钮。
   · 所有插入的数据都要带 owner = me.id，否则会被 RLS 拒（42501）。
   · 不设 RunAtLoad 之类的东西，这页没有定时任务。
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── 配置 ──────────────────────────────────────────────────── */
  const SUPABASE_URL = 'https://zkkmkrsrygaqlywboodw.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_b3LXxKhxq3NQws8B5DaYpg_rPNFcRom';

  const APP_ID      = 'study-collab';
  const APP_VERSION = 1;

  const MOODS  = ['😞', '😕', '😐', '🙂', '😄'];   // 下标 0..4 → 存 1..5
  const KINDS  = [
    { key: 'book',    label: '工具书', varName: '--series-1' },
    { key: 'course',  label: '网课',   varName: '--series-2' },
    { key: 'teacher', label: '老师',   varName: '--series-3' },
  ];
  const KIND_LABEL   = { book: '工具书', course: '网课', teacher: '老师' };
  const STATUS_LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
  const GOAL_PERIOD_DAYS = 30;

  /* ── 状态 ──────────────────────────────────────────────────── */
  const S = {
    me: null,
    profileMap: {},       // id -> display_name
    avatarMap: {},        // id -> 头像 data URL（空串表示没上传过）
    profileList: [],
    goals: [], tasks: [], subtasks: [], daily: [], resources: [],
    tab: 'home',          // 登录后落在主页
    mood: null,
    month: '',            // 月行程表显示哪个月 'YYYY-MM'，空 = 本月
    /* 「今日完成情况」两组**各自独立**，可以同时选 —— 她问的「学习资源和大任务
       可以同步勾选吗」。按下一次，选中的组全记掉：大任务那一步盖推进戳、资源那一章算完成。
       doneOn[k]  这一组这次要不要记（再点一下选中的那个 = 整组不记）
       doneRef[k] 这一组选中的父项 id
       doneSub[k] 父项下面选中的那一步 / 那一章 id
       默认只开大任务那一组，跟以前一样；要连带记资源自己点一下就行。 */
    doneOn:  { task: true, res: false },
    doneRef: { task: null, res: null },
    doneSub: { task: null, res: null },
    /* 「自己写两句」那个文本框跟着**今天**这一天走，存在 daily_logs.note 里
       （和折叠区那条「补充」是同一个字段，没有新表）。noteDay = 框里现在装的是
       哪一天的文字；noteTouched = 她动过手之后，别拿库里的旧值把正在打的字盖掉。 */
    noteDay: null,
    noteTouched: false,
    resScope: 'all',      // all | me | other
    feedKind: 'all',      // all | done | log | res
    noDoneAt: false,      // 库里还没加 done_at 列时置位（setup-3-feed.sql 跑之前）
  };

  /* ── 小工具 ────────────────────────────────────────────────── */
  const $  = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }
  function daysFromToday(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date();
    return Math.round(
      (Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000
    );
  }
  function pct(a, b) {
    if (!b || b <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
  }

  /* timestamptz → 本地时区的 'YYYY-MM-DD'。
   不能用 done_at.slice(0,10)：库里存 UTC，晚上 8 点后完成的任务
   按 UTC 算是「明天」，日历上会串行到后一格。 */
  function isoDate(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* 按天聚合「那天发生了什么」，月行程表的数据源。
   三张表都算进来：完成的小任务、完成的目标、当天的日记。 */
  function dayStats() {
    const m = {};
    const slot = (k) => (m[k] || (m[k] = { subs: [], goals: [], log: null }));
    for (const x of S.subtasks) {
      if (!x.done) continue;
      if (isTwinEcho(x)) continue;        // 绑着的两条是同一件事，只算一次
      const k = isoDate(x.done_at);
      if (k) slot(k).subs.push(x);
    }
    for (const g of S.goals) {
      if (!g.done) continue;
      const k = isoDate(g.done_at);
      if (k) slot(k).goals.push(g);
    }
    for (const d of S.daily) {
      if (!d.log_date) continue;
      slot(d.log_date).log = d;
    }
    return m;
  }
  /* 那一天一共推进了几件事（小任务 + 目标） */
  const dayCount = (e) => (e ? e.subs.length + e.goals.length : 0);

  /* 判断一个值是不是 DOM 节点。真假 DOM 都能认：真节点有 nodeType，
     假 DOM（smoke-test）的 El 两个都有。 */
  const isNode = (v) => !!v && typeof v === 'object' && (v.nodeType || v.tagName);

  /* DOM 构造器。文字一律走 textContent —— 库里的内容是别人输入的，当不可信数据处理。
     第二参数本该是属性对象。**不要**写成 h('tr', h('td', …)) —— 那传进去的是个节点，
     for...in 会顺着原型链捞到 offsetTop / children 这些**只读**访问器，
     赋值抛 TypeError，把整块渲染（连同后面本该画的兄弟节点）一起带走。
     这个坑在假 DOM 里测不出来（普通对象没有那些只读属性），所以在这里兜一道：
     节点类型就当成子元素，而不是属性。 */
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (isNode(props)) { kids.unshift(props); props = null; }
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class')      n.className = v;
        else if (k === 'text')  n.textContent = v;
        else if (k === 'for')   n.htmlFor = v;
        else if (k === 'style') {
          if (typeof v === 'string') n.setAttribute('style', v);
          else Object.assign(n.style, v);
        }
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in n)        n[k] = v;
        else                    n.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(
        typeof kid === 'object' && kid.nodeType ? kid : document.createTextNode(String(kid))
      );
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  let toastTimer = null;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
  }

  function nameOf(id) {
    return S.profileMap[id] || (id ? String(id).slice(0, 8) : '未知');
  }
  const isMine = (row) => !!S.me && row.owner === S.me.id;

  /* 一条 subtask 的父项可能是大任务，也可能是学习资源（一本书 / 一门网课）——
     二选一，由 setup-4-chapters.sql 里的 subtasks_one_parent 约束保证。
     所以凡是要「往上找父项」的地方都走这几个函数，别各写一遍 if。 */
  const subsOfTask = (id) => S.subtasks.filter((x) => x.task_id === id);
  const subsOfRes  = (id) => S.subtasks.filter((x) => x.resource_id === id);
  function parentOf(x) {
    return x.task_id ? S.tasks.find((t) => t.id === x.task_id)
                     : S.resources.find((r) => r.id === x.resource_id);
  }
  /* 大任务有 title，资源有 name，取名字的地方不一样 */
  const parentName = (x) => {
    const p = parentOf(x);
    return p ? (p.title || p.name || '(无标题)') : null;
  };
  const parentIsRes = (x) => !x.task_id && !!x.resource_id;

  /* ── 「同一件事的两个说法」────────────────────────────────
     两条 subtask 互相指着 = 一本书的一章 就是 大任务里的那一步。
     在任意一边勾完成，另一边跟着变（同步写在 setDone 里，一处覆盖所有入口）。
     绑是**双向**的，所以谁先被勾都一样。
     注意：库里没有 link_id 这一列时，所有行都读不到它 → 就是「没绑过」，
     页面照常（loadAll 用的是 select('*')，缺列不会报错、不会白屏）。 */
  const linkedTo = (x) => (x && x.link_id ? S.subtasks.find((s) => s.id === x.link_id) || null : null);
  /* 绑着的两条在库里是两行，但**是同一件事** —— 日历和动态流里只算一次，
     否则绑一对就把那天的件数灌一倍。id 小的那条算数（uuid 比大小任意但稳定）。 */
  const isTwinEcho = (x) => {
    const t = linkedTo(x);
    return !!(t && t.done && x.done && String(x.id) > String(t.id));
  };
  /* 「属于哪儿」的人话说法，动态流和列表都用它 */
  const parentLabel = (x) => {
    const n = parentName(x);
    if (n === null) return parentIsRes(x) ? '资源已删除' : '大任务已删除';
    return (parentIsRes(x) ? '资源 · ' : '大任务 · ') + n;
  };

  /* 能跟这一条绑成「同一件事」的候选：大任务的步骤 ↔ 资源的章节，一对一。
     已经绑给别人的不再列出来 —— 否则会出现三条互指、勾一下动两条不相干的。
     连不到任何东西时返回空数组，界面上那个入口就不出现。 */
  function linkChoices(sub) {
    const isCh = parentIsRes(sub);
    const out = [];
    const push = (pname, rows) => {
      for (const r of rows) {
        if (r.id === sub.id) continue;
        if (r.link_id && r.link_id !== sub.id) continue;     // 名花有主
        out.push({ id: r.id, label: pname + ' · ' + (r.title || '未填写') });
      }
    };
    if (isCh) for (const t of S.tasks.filter(isMine)) push(t.title || '大任务', subsOfTask(t.id));
    else      for (const r of S.resources.filter(isMine)) push(r.name || '资源', subsOfRes(r.id));
    return out;
  }

  /* 绑 / 解绑。往新对家身上绑之前，先把两边各自旧的那条松开，免得留下单向指针。
     绑完如果两边的完成状态不一样，**问一句**再决定要不要拉平 ——
     她明确说过别替她宣布完成，所以这里绝不自己动手。 */
  async function setLink(sub, targetId) {
    const tgt = targetId ? S.subtasks.find((s) => s.id === targetId) : null;
    if (targetId && !tgt) return { error: { message: '要绑的那一条已经不在了' } };
    if (tgt && tgt.id === sub.id) return { error: { message: '不能和自己绑' } };

    const old = linkedTo(sub);
    const tOld = tgt ? linkedTo(tgt) : null;
    const jobs = [];
    if (old && (!tgt || old.id !== tgt.id)) jobs.push(old);
    if (tOld && tOld.id !== sub.id) jobs.push(tOld);

    /* 先改内存再写库：下面那个 confirm 之后要调 setDone()，而 setDone 靠
       linkedTo() 找对家 —— 内存不先更新的话它会往**旧**对家身上带。 */
    sub.link_id = tgt ? tgt.id : null;
    tgt && (tgt.link_id = sub.id);
    for (const o of jobs) o.link_id = null;

    const res = await Promise.all([
      ...jobs.map((o) => sb.from('subtasks').update({ link_id: null }).eq('id', o.id)),
      sb.from('subtasks').update({ link_id: sub.link_id }).eq('id', sub.id),
      ...(tgt ? [sb.from('subtasks').update({ link_id: sub.id }).eq('id', tgt.id)] : []),
    ]);
    const bad = res.find((r) => r.error);
    if (bad) return bad;

    if (tgt && !!tgt.done !== !!sub.done) {
      const a = (sub.title || '未填写') + (sub.done ? '（已完成）' : '（还没完成）');
      const b = (tgt.title || '未填写') + (tgt.done ? '（已完成）' : '（还没完成）');
      if (confirm('绑好了。但两边现在不一样：' + a + '、' + b + '。\n\n' +
                  '要不要把两条都算完成？（不点确定就保持原样，以后勾哪边都会带着另一边）')) {
        await setDone('subtasks', sub.done ? sub.id : tgt.id, true);
      }
    }
    return { error: null };
  }

  /* 头像：有图用图，没图就用自己的名字首字兜底（不是默认灰头像，两个人颜色可区分） */
  function avatarEl(id, cls) {
    const url = S.avatarMap[id];
    const mine = S.me && id === S.me.id;
    const box = h('span', { class: 'av ' + (mine ? 'me' : 'other') + (cls ? ' ' + cls : '') });
    if (url) box.appendChild(h('img', { src: url, alt: nameOf(id) }));
    else box.textContent = (nameOf(id) || '?').trim().charAt(0).toUpperCase();
    return box;
  }

  /* 相对时间：库里存的是 ISO 串，这里换算成人话 */
  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1)  return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24)  return hr + ' 小时前';
    const day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 7)   return day + ' 天前';
    const d = new Date(t);
    const y = new Date();
    const md = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    return d.getFullYear() === y.getFullYear() ? md : d.getFullYear() + ' 年 ' + md;
  }

  /* ── 后端 ──────────────────────────────────────────────────── */
  let sb = null;

  async function loadAll() {
    const res = await Promise.all([
      sb.from('profiles').select('*'),
      sb.from('goals').select('*').order('created_at', { ascending: false }),
      sb.from('tasks').select('*').order('created_at', { ascending: false }),
      sb.from('subtasks').select('*').order('seq', { ascending: true }),
      sb.from('daily_logs').select('*').order('log_date', { ascending: false }).limit(400),
      sb.from('resources').select('*').order('created_at', { ascending: false }),
    ]);
    const bad = res.find((r) => r.error);
    if (bad) throw new Error(bad.error.message);

    S.profileList = res[0].data || [];
    S.profileMap  = {};
    S.avatarMap   = {};
    S.profileList.forEach((p) => {
      S.profileMap[p.id] = p.display_name;
      S.avatarMap[p.id]  = p.avatar || '';
    });
    S.goals     = res[1].data || [];
    S.tasks     = res[2].data || [];
    S.subtasks  = res[3].data || [];
    S.daily     = res[4].data || [];
    S.resources = res[5].data || [];
  }

  async function refresh() {
    try {
      await loadAll();
      renderCurrent();
    } catch (e) {
      toast('读取失败：' + e.message, true);
    }
  }

  /* 只在出错时刷新（成功时本地状态已经改过了，避免重画打断输入） */
  async function quiet(promise) {
    const { error } = await promise;
    if (error) { toast(error.message, true); await refresh(); return false; }
    return true;
  }

  /* 写操作：报错就重画，成功就整页刷新 */
  async function commit(promise, okMsg) {
    const { error } = await promise;
    if (error) { toast(error.message, true); return false; }
    if (okMsg) toast(okMsg);
    await refresh();
    return true;
  }

  /* 库还没跑 setup-4-chapters.sql 时，提到 resource_id 的报错会被原样吐出来，
     对方看不懂。翻译成一句能直接照做的中文。 */
  function schemaWarn(error) {
    const m = error && error.message ? error.message : String(error || '');
    if (/resource_id/i.test(m)) {
      return '库里还没有章节字段。去 Supabase 后台跑一次 study/setup-4-chapters.sql 再回来。';
    }
    if (/link_id/i.test(m)) {
      return '库里还没有「绑成同一件事」这一列。去 Supabase 后台跑一次 study/setup-5-link.sql 再回来。';
    }
    return m;
  }

  /* 给某个资源加一章。seq 接在现有最大序号后面，不重排已有的 ——
     重排会把「第 5 章」改成别的序号，她勾过的完成状态就对不上了。 */
  async function addChapter(r, existing, title) {
    const seq = existing.length ? Math.max(...existing.map((x) => x.seq || 0)) + 1 : 1;
    const { error } = await sb.from('subtasks').insert({
      resource_id: r.id, owner: S.me.id, seq: seq,
      title: title || ('第 ' + seq + ' 章'), detail: '',
    });
    if (error) { toast(schemaWarn(error), true); return false; }
    await refresh();
    return true;
  }

  /* 勾选完成时顺便写 done_at（主页动态流靠它排序）。
     旧库还没加这一列时自动退化成只写 done —— 按钮不会因此点不动。 */
  /* 改完成状态。**所有入口都走这里**（大任务拆解/资源清单的勾选框、今天的列表、
     今日完成情况的资源那一组），所以「绑了对家就跟着变」只需要写在这一处。 */
  function setDone(table, id, done, patch) {
    const full = Object.assign({ done: done, done_at: done ? new Date().toISOString() : null }, patch || {});
    return sb.from(table).update(full).eq('id', id).then((r) => {
      if (r.error && /done_at/i.test(r.error.message)) {
        S.noDoneAt = true;
        const slim = Object.assign({ done: done }, patch || {});
        return sb.from(table).update(slim).eq('id', id);
      }
      return r;
    }).then((r) => {
      if (r.error || table !== 'subtasks') return r;
      const twin = linkedTo(S.subtasks.find((s) => s.id === id));
      if (!twin) return r;
      /* 对家跟着一起变，done_at 用**同一个时刻** —— 两条是同一件事，
         时间戳一样才不会被算成两天。对家写失败不推翻这次的结果（主那条已经成了），
         刷新之后两边不一致她一眼能看见，再勾一下就好。 */
      return sb.from('subtasks').update(full).eq('id', twin.id).then(() => r, () => r);
    });
  }

  /* 「今天推进了这一步」—— 只盖 done_at，**不动 done**。
     为什么复用 done_at：这一列的语义本来就是「这一天动过它」。
     done=false 且 done_at 有值 = 推进了但没完成；等她自己去「大任务拆解」勾上，
     setDone(true) 会把 done_at 覆盖成真实完成时刻，这条记录就自动从
     「今天动过」变成「已完成」。不新增列、不新增表，她不用再跑 SQL。
     下游口径都只看 done（dayStats / buildFeed / 进度条），所以不会被误读成完成。 */
  function stampStep(id) {
    return sb.from('subtasks').update({ done_at: new Date().toISOString() }).eq('id', id).then((r) => {
      if (r.error && /done_at/i.test(r.error.message)) {
        S.noDoneAt = true;
        return { error: { message: '库里还没有 done_at 列，去 Supabase 后台跑一次 study/setup-3-feed.sql 再回来。' } };
      }
      return r;
    });
  }

  /* ── 实时同步（防打断）─────────────────────────────────────── */
  let rtTimer = null;
  const rtPending = new Set();

  function onRealtime(table) {
    rtPending.add(table);
    if (rtTimer) clearTimeout(rtTimer);
    rtTimer = setTimeout(flushRealtime, 700);
  }
  async function flushRealtime() {
    rtTimer = null;
    const ae = document.activeElement;
    // 正在输入框里打字就先别重画，等手停下来
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.closest && ae.closest('.pane')) {
      rtTimer = setTimeout(flushRealtime, 1200);
      return;
    }
    if (!rtPending.size) return;
    rtPending.clear();
    await refresh();
  }

  /* ── 渲染：通用双人并排 ────────────────────────────────────── */
  function groupByOwner(rows) {
    const m = {};
    for (const r of rows) (m[r.owner] = m[r.owner] || []).push(r);
    if (S.me && !m[S.me.id]) m[S.me.id] = [];   // 自己那栏永远在，空着也说一句
    return m;
  }

  function twoCols(container, rows, renderOne, opts) {
    clear(container);
    const m = groupByOwner(rows);
    /* 「今日完成情况」这类按天过滤的列表要传 {everyone:true}：
       不过滤的话对方今天没动那一栏会整个消失，分不清是「今天没记」还是「根本没这个人」。
       其余页签保持原样 —— 他们没建过目标时不留空栏，是原来就定好的行为。 */
    if (opts && opts.everyone) {
      Object.keys(S.profileMap).forEach((id) => { if (!m[id]) m[id] = []; });
    }
    const ids = Object.keys(m).sort((a, b) => {
      if (a === S.me.id) return -1;
      if (b === S.me.id) return 1;
      return nameOf(a).localeCompare(nameOf(b), 'zh');
    });
    if (!ids.length) { container.appendChild(h('div', { class: 'empty', text: '还没有数据。' })); return; }

    for (const id of ids) {
      const mine = id === S.me.id;
      container.appendChild(
        h('div', { class: 'who ' + (mine ? 'me' : 'other') },
          h('h3', null,
            avatarEl(id, 'sm'),
            h('span', { class: 'nm', text: nameOf(id) }),
            h('span', { class: 'badge', text: mine ? '我' : '对方' })
          ),
          renderOne(id, m[id], mine)
        )
      );
    }
  }

  function emptyNote(txt) { return h('div', { class: 'empty', text: txt }); }

  /* ── 页签一：30 天小目标（前：目标备忘录  后：月行程表）────── */
  function renderGoals() {
    renderGoalMemo();
    renderMonth();
  }

  /* 目标备忘录：两人各自的 30 天目标 + 进度条 */
  function renderGoalMemo() {
    twoCols($('goals-cols'), S.goals, (owner, rows, mine) => {
      if (!rows.length) return emptyNote(mine ? '还没有目标，上面加一个。' : '对方还没添加目标。');
      const wrap = h('div');
      for (const g of rows) {
        const p = pct(g.progress, g.target);
        const end = addDays(g.period_start, GOAL_PERIOD_DAYS - 1);
        const left = daysFromToday(end);
        const periodTxt = left > 0 ? '周期剩 ' + left + ' 天'
                        : left === 0 ? '周期最后一天'
                        : '周期已过 ' + (-left) + ' 天';

        wrap.appendChild(
          h('div', { class: 'item' + (g.done ? ' done' : '') },
            h('div', { class: 't' },
              h('span', { class: 'grow', text: g.title }),
              g.done ? h('span', { class: 'pill ok', text: '已完成' }) : null
            ),
            g.detail ? h('div', { class: 'd', text: g.detail }) : null,
            h('div', { class: 'bar' }, h('i', { style: { width: p + '%' } })),
            h('div', { class: 'bar-txt' },
              h('span', { text: '进度 ' + g.progress + ' / ' + g.target }),
              h('span', { text: periodTxt + '（到 ' + end + '）' })
            ),
            mine ? h('div', { class: 'acts' },
              h('button', { class: 'tiny', text: '−1', onclick: () => bumpGoal(g, -1) }),
              h('button', { class: 'tiny', text: '+1', onclick: () => bumpGoal(g, 1) }),
              h('button', {
                class: 'tiny',
                text: g.done ? '取消完成' : '标记完成',
                onclick: () => commit(
                  setDone('goals', g.id, !g.done, { progress: !g.done ? g.target : g.progress })
                ),
              }),
              h('button', {
                class: 'tiny danger', text: '删除',
                onclick: () => removeRow('goals', g.id, '目标「' + g.title + '」'),
              })
            ) : null
          )
        );
      }
      return wrap;
    });
  }

  /* ── 月行程表 ──────────────────────────────────────────────── */
  const MO_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /* 一格一天。格子深浅 = 那天推进了几件事（完成的小任务 + 完成的目标），
     右上角小表情 = 那天记了心情，右下角数字 = 推进件数。
     数据每次现算，所以在别处勾完任务、或对方那边实时推过来，这里都会跟着变。 */
  function renderMonth() {
    const stats = dayStats();
    const t = today();

    // 没选月份就跟当前月；跨月之后自动跟上来
    if (!/^\d{4}-\d{2}$/.test(S.month || '')) S.month = t.slice(0, 7);
    const [y, m] = S.month.split('-').map(Number);

    const dim   = new Date(y, m, 0).getDate();     // 这个月有几天
    const lead  = new Date(y, m - 1, 1).getDay();  // 1 号是周几（0 = 周日）
    const cells = Math.ceil((lead + dim) / 7) * 7; // 补满整周

    const head = $('mo-head');
    clear(head);
    MO_WEEK.forEach((w) => head.appendChild(h('span', { text: w })));

    let nSub = 0, nGoal = 0, nLog = 0, nDay = 0;
    const grid = $('mo-grid');
    clear(grid);

    for (let i = 0; i < cells; i++) {
      const day = i - lead + 1;
      if (day < 1 || day > dim) { grid.appendChild(h('div', { class: 'mo-d blank' })); continue; }

      const key = S.month + '-' + pad(day);
      const e = stats[key];
      const n = dayCount(e);
      if (n) nDay++;
      if (e) {
        nSub += e.subs.length;
        nGoal += e.goals.length;
        if (e.log) nLog++;
      }
      const lv = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : 3;

      // 悬停看明细 —— 格子上放不下，但这么小的格子必须能查到底做了什么
      const bits = [];
      if (e) {
        e.goals.forEach((g) => bits.push('完成目标：' + (g.title || '(无标题)')));
        e.subs.forEach((x) => {
          bits.push('完成：' + (x.title || '(未填写)') + ' —— ' + parentLabel(x));
        });
        if (e.log) {
          bits.push('心情 ' + (MOODS[e.log.mood - 1] || '—') +
                    (e.log.difficulty ? '：' + e.log.difficulty : ''));
        }
      }

      grid.appendChild(h('div', {
        class: 'mo-d' + (lv ? ' lv' + lv : '') + (key === t ? ' today' : ''),
        title: key + '\n' + (bits.length ? bits.join('\n') : '这天没有记录'),
      },
        h('span', { class: 'dn', text: String(day) }),
        e && e.log ? h('span', { class: 'dm', text: MOODS[e.log.mood - 1] || '' }) : null,
        n ? h('span', { class: 'dc', text: String(n) }) : null
      ));
    }

    // 月份导航
    const nav = $('mo-nav');
    clear(nav);
    const shift = (d) => {
      const dt = new Date(y, m - 1 + d, 1);
      S.month = dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
      renderMonth();          // 只重画日历，不动上面的备忘录，切月不闪
    };
    const thisM = t.slice(0, 7);
    nav.appendChild(h('button', { class: 'tiny', text: '‹ 上月', onclick: () => shift(-1) }));
    nav.appendChild(h('button', {
      class: 'tiny', text: y + ' 年 ' + m + ' 月',
      title: '回到本月', disabled: S.month === thisM,
      onclick: () => { S.month = thisM; renderMonth(); },
    }));
    nav.appendChild(h('button', { class: 'tiny', text: '下月 ›', onclick: () => shift(1) }));

    $('mo-sub').textContent = '这个月推进了 ' + nSub + ' 个小任务、' + nGoal + ' 个目标，' +
      '有 ' + nDay + ' 天在动，记了 ' + nLog + ' 天心情。';

    /* 没有 done_at 列时，已完成的旧记录没有时间戳，日历上会凭空少掉一截。
       与其让她以为日历坏了，不如直接说清楚缺什么、怎么补。 */
    const noTime = S.subtasks.filter((x) => x.done && !x.done_at).length +
                   S.goals.filter((g) => g.done && !g.done_at).length;
    const warn = $('mo-warn');
    if (noTime) {
      warn.textContent = '注意：有 ' + noTime + ' 件已完成的记录没有完成时间（库里还缺 done_at 列），' +
        '它们不会出现在日历格子上。去 Supabase 后台跑一次 study/setup-3-feed.sql 就能补上；' +
        '在那之前，新勾的任务会正常记录时间。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    // 图例：深浅代表推进件数
    const lg = $('mo-legend');
    clear(lg);
    [['无', null], ['1–2 件', 'lv1'], ['3–5 件', 'lv2'], ['6 件以上', 'lv3']].forEach(([txt, lv]) => {
      lg.appendChild(h('span', { class: 'item2' },
        h('span', { class: 'kd' + (lv ? ' ' + lv : '') }),
        h('span', { text: txt })
      ));
    });

    renderMonthTable(dim, stats);
  }

  /* 表格视图 —— 日历格子放不下明细，也给读屏和色觉障碍留一条不靠颜色的路 */
  function renderMonthTable(dim, stats) {
    const box = $('mo-table');
    clear(box);
    const rows = [];
    for (let d = 1; d <= dim; d++) {
      const key = S.month + '-' + pad(d);
      const e = stats[key];
      if (!e) continue;
      const what = [];
      e.goals.forEach((g) => what.push('完成目标：' + (g.title || '(无标题)')));
      e.subs.forEach((x) => {
        what.push('完成：' + (x.title || '(未填写)') + ' —— ' + parentLabel(x));
      });
      rows.push([
        key,
        String(dayCount(e)),
        e.log ? (MOODS[e.log.mood - 1] || '—') : '—',
        what.join('；') || '—',
      ]);
    }
    if (!rows.length) {
      box.appendChild(h('p', { class: 'hint', text: '这个月还没有动静。' }));
      return;
    }
    const tbl = h('table');
    tbl.appendChild(h('thead', null, h('tr', null,
      h('th', { text: '日期' }), h('th', { text: '推进' }),
      h('th', { text: '心情' }), h('th', { text: '做了什么' })
    )));
    const tb = h('tbody');
    rows.forEach((r) => tb.appendChild(h('tr', null,
      h('td', { text: r[0] }), h('td', { text: r[1] }),
      h('td', { text: r[2] }), h('td', { text: r[3] })
    )));
    tbl.appendChild(tb);
    box.appendChild(h('div', { class: 'tblwrap' }, tbl));
  }

  async function bumpGoal(g, d) {
    const v = Math.max(0, Math.min(999999, (g.progress || 0) + d));
    g.progress = v;
    await quiet(sb.from('goals').update({ progress: v, done: v >= g.target ? g.done : false }).eq('id', g.id));
    renderCurrent();
  }

  /* ── 页签二：大任务拆解 ────────────────────────────────────── */

  /* 总览：每个大任务一条完成率横条，按人分色（颜色跟左右分栏的左边框一致）。
     直接标注 n / m，不让人靠猜条长 —— 条是粗略感受，数字是准的。 */
  function renderTaskOverview() {
    const box = $('ov-list'), lg = $('ov-legend'), sub = $('ov-sub');
    clear(box); clear(lg);

    const mineId = S.me && S.me.id;
    const ids = [];
    if (mineId) ids.push(mineId);
    Object.keys(S.profileMap).forEach((id) => { if (id !== mineId) ids.push(id); });
    const owners = ids.filter((id) => S.tasks.some((t) => t.owner === id));

    if (!owners.length) {
      sub.textContent = '还没有大任务，上面创建一个。';
      box.appendChild(emptyNote('创建大任务后，这里显示每个人的推进情况。'));
      return;
    }

    // 两条以上才要图例；只有一个人有任务时，上方的头像+名字已经说明了是谁
    if (owners.length > 1) {
      owners.forEach((id) => lg.appendChild(h('span', { class: 'item2' },
        h('span', { class: 'kdot ' + (id === mineId ? 'me' : 'other') }),
        h('span', { text: nameOf(id) + (id === mineId ? '（我）' : '') })
      )));
    }

    let nTask = 0, nSub = 0, nDone = 0;
    for (const id of owners) {
      const rows = S.tasks.filter((t) => t.owner === id);
      box.appendChild(h('div', { class: 'ov-who' },
        avatarEl(id, 'sm'),
        h('span', { class: 'nm', text: nameOf(id) + (id === mineId ? '（我）' : '') })
      ));
      for (const t of rows) {
        const subs = S.subtasks.filter((x) => x.task_id === t.id);
        const dn = subs.filter((x) => x.done).length;
        const p = subs.length ? pct(dn, subs.length) : 0;
        nTask++; nSub += subs.length; nDone += dn;
        box.appendChild(h('div', {
          class: 'ov-row',
          title: (t.title || '(无标题)') + '：' + dn + ' / ' + subs.length + ' 个小任务已完成',
        },
          h('span', { class: 'ov-nm', text: t.title || '(无标题)' }),
          h('span', { class: 'ov-bar ' + (id === mineId ? 'me' : 'other') },
            h('i', { style: { width: p + '%' } })
          ),
          h('span', { class: 'ov-v', text: subs.length ? dn + ' / ' + subs.length : '未拆解' })
        ));
      }
    }
    sub.textContent = '共 ' + nTask + ' 个大任务 · 拆出 ' + nSub + ' 个小任务，已完成 ' +
      nDone + ' 个（' + pct(nDone, nSub) + '%）';
  }

  function renderTasks() {
    renderTaskOverview();
    twoCols($('tasks-cols'), S.tasks, (owner, rows, mine) => {
      if (!rows.length) return emptyNote(mine ? '还没有大任务，上面创建一个。' : '对方还没添加大任务。');
      const wrap = h('div');
      for (const t of rows) {
        const subs = S.subtasks.filter((x) => x.task_id === t.id);
        const doneN = subs.filter((x) => x.done).length;
        const p = subs.length ? pct(doneN, subs.length) : 0;
        const left = t.due_date ? daysFromToday(t.due_date) : null;

        const list = h('div', { class: 'subs' });
        if (!subs.length) list.appendChild(emptyNote('还没拆出小任务。'));
        subs.forEach((sub) => list.appendChild(subRow(sub, mine)));

        wrap.appendChild(
          h('div', { class: 'item' + (subs.length && doneN === subs.length ? ' done' : '') },
            h('div', { class: 't' },
              h('span', { class: 'grow', text: t.title }),
              subs.length && doneN === subs.length ? h('span', { class: 'pill ok', text: '全部完成' }) : null
            ),
            t.detail ? h('div', { class: 'd', text: t.detail }) : null,
            t.due_date ? h('div', { class: 'm' },
              h('span', { class: 'pill', text: '截止 ' + t.due_date }),
              left < 0 ? h('span', { class: 'pill bad', text: '已过期 ' + (-left) + ' 天' })
                       : h('span', { class: 'pill' + (left <= 3 ? ' bad' : ''), text: '剩 ' + left + ' 天' })
            ) : null,
            /* 分段进度条：一个小任务一段，勾掉哪段就点亮哪段 —— 一眼看出卡在第几步 */
            h('div', { class: 'bar seg' },
              subs.map((x, i) => h('i', {
                class: 'sq' + (x.done ? ' on' : ''),
                title: '第 ' + (i + 1) + ' 步：' + (x.title || '(未填写)') + (x.done ? ' ✅ 已完成' : ' ⬜ 未完成'),
              }))
            ),
            h('div', { class: 'bar-txt' },
              h('span', { text: doneN + ' / ' + subs.length + ' 个小任务' }),
              h('span', { class: 'pct' + (subs.length && p === 100 ? ' full' : ''), text: p + '%' })
            ),
            list,
            mine ? h('div', { class: 'acts' },
              h('button', { class: 'tiny', text: '＋ 加一个小任务', onclick: () => addSub(t, subs) }),
              h('button', {
                class: 'tiny danger', text: '删除大任务',
                onclick: () => removeRow('tasks', t.id, '大任务「' + t.title + '」及其 ' + subs.length + ' 个小任务'),
              })
            ) : null
          )
        );
      }
      return wrap;
    });
  }

  /* 一行小任务 / 一章。两者是同一张表里的同一种东西，只是挂的父不同，
     所以共用这一个渲染函数，文案靠 sub 挂在哪边自己判断，不给调用方加参数。 */
  function subRow(sub, mine) {
    const isCh = parentIsRes(sub);
    const box = h('div', { class: 'sub' + (sub.done ? ' done' : '') },
      h('input', {
        type: 'checkbox', checked: !!sub.done, disabled: !mine,
        onchange: async (e) => {
          const v = e.target.checked;
          sub.done = v;
          await quiet(setDone('subtasks', sub.id, v));
          renderCurrent();
        },
      })
    );

    if (mine) {
      box.appendChild(h('input', {
        type: 'text', class: 'grow', value: sub.title || '',
        placeholder: isCh ? '这一章叫什么' : '这一步要干什么',
        title: sub.detail || '',
        style: sub.done ? { opacity: '.6' } : null,
        onchange: async (e) => {
          const v = e.target.value.trim();
          if (v === (sub.title || '')) return;
          sub.title = v;
          await quiet(sb.from('subtasks').update({ title: v }).eq('id', sub.id));
        },
      }));
      /* ↔ 跟对面的哪一条是同一件事。绑上之后勾任意一边，另一边跟着一起完成 ——
         书那边的章节进度条和大任务这边的步骤进度条就一起动了。
         候选为空（对面还没有任何一条）时这个入口根本不出现。 */
      const choices = linkChoices(sub);
      if (choices.length || sub.link_id) {
        const linked = linkedTo(sub);
        /* 「不绑」放最前面。对家被删掉时（linked 找不到）它还会剩在库里，
           这条兜底把它列出来，省得下拉框显示不出当前到底绑没绑。 */
        const list = [{ id: '', label: '不绑' }];
        if (linked && !choices.some((c) => c.id === linked.id)) {
          list.push({ id: linked.id, label: parentLabel(linked) + ' · ' + (linked.title || '未填写') });
        }
        list.push(...choices);
        box.appendChild(h('select', {
          class: 'tiny link',
          title: '把这一条和对面的一条绑成「同一件事」：勾任意一边，另一边自动跟着完成',
          onchange: async (e) => {
            const v = e.target.value;
            const { error } = await setLink(sub, v || null);
            if (error) { toast('没绑上：' + schemaWarn(error), true); renderCurrent(); return; }
            await refresh();
            toast(v ? '绑好了：这两条以后一起算完成' : '解开了，两边各自算各自的');
          },
        }, list.map((o) => h('option', {
          value: o.id,
          text: '↔ ' + o.label,
          selected: o.id === (sub.link_id || ''),
        }))));
      }
      box.appendChild(h('button', {
        class: 'tiny danger', text: '✕',
        onclick: async () => {
          if (!confirm(isCh ? '删掉这一章？' : '删掉这个小任务？')) return;
          /* 先松开对家，免得留下一根指着空气的指针 */
          const twin = linkedTo(sub);
          if (twin) { twin.link_id = null; await quiet(sb.from('subtasks').update({ link_id: null }).eq('id', twin.id)); }
          await commit(sb.from('subtasks').delete().eq('id', sub.id));
        },
      }));
    } else {
      box.appendChild(h('span', { class: 'grow', text: sub.title || '(待填写)' }));
    }
    return box;
  }

  async function addSub(task, existing) {
    const seq = existing.length ? Math.max(...existing.map((x) => x.seq || 0)) + 1 : 1;
    await commit(
      sb.from('subtasks').insert({ task_id: task.id, owner: S.me.id, seq: seq, title: '', detail: '' })
    );
  }

  /* ── 页签三：今日完成情况 ──────────────────────────────────── */
  /* 主体是「今天完成了什么」：写一条 + 勾它属于哪个大任务 → 同步进那个大任务。
     原有的心情/困难降级到页签底部折叠区，没有删 —— 月行程表右上角的小表情
     和主页动态流都还在用这份数据，把录入入口去掉的话那些就变成只能看不能记了。 */
  function renderDaily() {
    renderDoneForm();
    renderDoneList();
    renderDoneSummary();
    renderMoodList();
    prefillDay();
  }

  /* 谁今天完成了几件；顺带说明「缺 done_at 列」这个会让列表看起来空掉的原因 */
  function renderDoneSummary() {
    const t = today();
    const myId = S.me && S.me.id;
    const ids = Object.keys(S.profileMap);
    if (myId && ids.indexOf(myId) < 0) ids.push(myId);
    ids.sort((a, b) => (a === myId ? -1 : 0) - (b === myId ? -1 : 0));
    const cnt = (id) => S.subtasks.filter((x) => x.owner === id && x.done && isoDate(x.done_at) === t).length;

    const total = ids.reduce((sum, id) => sum + cnt(id), 0);
    $('done-sub').textContent = total
      ? '今天 · ' + ids.map((id) => nameOf(id) + ' ' + cnt(id) + ' 件').join(' · ')
      : '今天两个人都还没有记录。';

    const warn = $('done-warn');
    const noTime = S.subtasks.filter((x) => x.done && !x.done_at && isMine(x)).length;
    if (noTime) {
      warn.textContent = '注意：你有 ' + noTime + ' 条已完成的记录没有完成时间（库里还缺 done_at 列），' +
        '所以不会出现在下面的「今天完成情况」里，月行程表上也看不到。' +
        '去 Supabase 后台跑一次 study/setup-3-feed.sql 就好；在那之前新记的会正常带上时间。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  /* 挂到哪。chip 分两组：大任务 / 学习资源 —— **两组各自独立，可以同时选**。
     以前是互斥的（选了资源，大任务那边自动取消），她问「学习资源和大任务可以同步
     勾选吗」，改成各选各的：按下按钮，选中的组一次全记掉。
     用 chip 而不是下拉：通常就几个，一眼看全比展开菜单快。
     右侧 n/m 是这个父下面已经完成几件 —— 挑的时候不用来回翻页。
     再点一下已经选中的那个 = **这一组这次不记**（整组变回 ☐）—— 只做了一件事时用。 */
  /* 「自己写两句」那个框里现在有什么（还没存进库的也算） */
  const noteText = () => { const el = $('done-note'); return el ? el.value.trim() : ''; };

  function renderDoneForm() {
    const box = $('done-picker');
    const btn = $('done-btn');
    const lead = $('done-lead');
    const plabel = $('done-picker-label');
    const tip = $('done-tip');
    clear(box);

    const lanes = [
      ['task', '大任务', S.tasks.filter(isMine), subsOfTask],
      ['res', '学习资源', S.resources.filter(isMine), subsOfRes],
    ].filter((l) => l[2].length);

    /* 什么都没得挂时，只要她写了字，这个按钮也应该是能按的 —— 光想记两句话
       不该被拦下来。没写字就保持原样，催她去建东西。 */
    if (!lanes.length && noteText()) {
      btn.disabled = false;
      btn.textContent = '只记这段文字（今天）';
      tip.textContent = '就存这段字，不动任何进度条；等你建了大任务或资源，再回来勾。';
      return;
    }

    if (!lanes.length) {
      /* 什么都没得挂 —— 整块退回最开始的样子，以后建了东西回来就是默认状态 */
      S.doneOn = { task: true, res: false };
      S.doneRef = { task: null, res: null };
      S.doneSub = { task: null, res: null };
      box.appendChild(h('p', { class: 'hint', style: { margin: '0' },
        text: '你还没有大任务、也没有学习资源。先去「大任务拆解」或「学习资源」建一个 —— ' +
              '完成的事要挂在某样东西下面，才能同步过去。' }));
      btn.disabled = true;
      return;
    }

    /* 只有一边有东西时，默认就记那一边（不然她得先点一下才有东西可选） */
    if (lanes.length === 1) S.doneOn[lanes[0][0]] = true;

    for (const [kind, , rows] of lanes) {
      /* 选中的那个可能刚被删掉 / 或还没选过，退回这一组的第一个 */
      if (!rows.some((r) => r.id === S.doneRef[kind])) S.doneRef[kind] = rows[0].id;
    }

    for (const [kind, label, rows, subsFn] of lanes) {
      const on = !!S.doneOn[kind];
      box.appendChild(h('div', { class: 'chips-group' },
        h('span', { class: 'cg-label', text: label }),
        h('div', { class: 'chips' },
          rows.map((r) => {
            const sel = on && S.doneRef[kind] === r.id;
            const subs = subsFn(r.id);
            const dn = subs.filter((x) => x.done).length;
            return h('button', {
              type: 'button',
              class: 'chip' + (sel ? ' on' : ''),
              'aria-pressed': sel ? 'true' : 'false',
              title: sel ? '再点一下 = 这一组这次不记' : '',
              onclick: () => {
                if (sel) S.doneOn[kind] = false;
                else { S.doneOn[kind] = true; S.doneRef[kind] = r.id; }
                renderDoneForm();
              },
            },
              h('span', { class: 'ck', text: sel ? '☑' : '☐' }),
              h('span', { class: 'ct', text: r.title || r.name || '(无标题)' }),
              h('span', { class: 'cn', text: dn + '/' + subs.length })
            );
          })
        )
      ));

      /* 这一组选中的那条下面，这次记哪一步 / 哪一章。两组各自摊各自的那一行：
           挂资源   = 勾哪一章（勾了就**算完成**）
           挂大任务 = 今天推进了哪一步（**只记录，不算完成**）
         两组语义故意不一样，所以按钮上会把「算不算完成」写清楚。 */
      if (!on) continue;
      const parent = rows.find((r) => r.id === S.doneRef[kind]);
      const chs = parent ? subsFn(parent.id) : [];
      if (!chs.length) continue;
      if (!chs.some((x) => x.id === S.doneSub[kind])) {
        S.doneSub[kind] = (chs.find((x) => !x.done) || chs[0]).id;
      }
      const isRes = kind === 'res';
      box.appendChild(h('div', { class: 'chips-group' },
        h('span', { class: 'cg-label', text: isRes ? '第几章' : '哪一步' }),
        h('div', { class: 'chips' },
          chs.map((x) => {
            const sel = S.doneSub[kind] === x.id;
            return h('button', {
              type: 'button',
              class: 'chip' + (sel ? ' on' : '') + (x.done ? ' done' : ''),
              'aria-pressed': sel ? 'true' : 'false',
              title: x.done ? (isRes ? '这一章已经勾过了' : '这一步已经完成了') : '',
              onclick: () => { S.doneSub[kind] = x.id; renderDoneForm(); },
            },
              h('span', { class: 'ck', text: x.done ? '✅' : (sel ? '☑' : '☐') }),
              h('span', { class: 'ct', text: x.title || '(未填写)' })
            );
          })
        )
      ));
    }

    /* 这一页没有自由文本框了。以前大任务是「写一条 → 凭空新建一条已完成的小任务」，
       会越记越长、分母越来越大，而且替她宣布了「完成」—— 她明确说不要。
       现在两种模式都是「选一个父项、选其中一条」，小任务该在「大任务拆解」里拆、在那里勾。 */

    /* 按钮上写清楚这一下会记几条、算不算完成 —— 省得她猜 */
    const plan = [];      // 这次真要记的组
    const stuck = [];     // 勾了但记不了的组（大任务还没拆步 / 这本书还没分章）
    for (const [kind, , rows, subsFn] of lanes) {
      if (!S.doneOn[kind]) continue;
      const parent = rows.find((r) => r.id === S.doneRef[kind]);
      if (!parent) continue;
      if (subsFn(parent.id).length) plan.push(kind); else stuck.push(kind);
    }

    plabel.textContent = '这次要记什么（两组可以同时选）';
    lead.textContent = '两组可以只选一组，也可以各选一条同时记 —— 都选就一次记完。' +
      '大任务那一步只记一笔「今天推进了」，不算完成；资源那一章勾掉就算完成。' +
      '下面那个文本框是写给自己看的，跟同一笔记一起存。';

    if (!plan.length) {
      if (stuck.length) {
        const isRes = stuck[0] === 'res';
        const has = !!noteText();
        btn.disabled = !has;
        btn.textContent = has ? '只记这段文字（今天）'
          : isRes ? '这本书还没分章' : '这个大任务还没拆步';
        tip.textContent = (isRes ? '先去「学习资源」里给它「＋ 分章」'
                                 : '先去「大任务拆解」把它拆成几步，再回来记推进') +
          (has ? ' —— 现在按下去只存文字' : '');
      } else if (noteText()) {
        btn.disabled = false;
        btn.textContent = '只记这段文字（今天）';
        tip.textContent = '就存这段字，不动任何进度条。想顺手勾一条，点上面的大任务或学习资源';
      } else {
        btn.disabled = true;
        btn.textContent = '先选一样要记的';
        tip.textContent = '点上面的大任务或学习资源 —— 再点一下选中的那个，就是这组这次不记';
      }
      return;
    }

    btn.disabled = false;
    const both = plan.length === 2;
    const plusNote = noteText() ? '（连文字一起存）' : '';
    btn.textContent = (both ? '两样一起记：推进这一步 + 勾掉这一章'
      : plan[0] === 'res' ? '勾掉这一章（算完成）'
      : '只记一笔：今天推进了这一步') + plusNote;
    tip.textContent = both
      ? '大任务那一步只记一笔推进（还不算完成）；这一章勾掉就算完成'
      : plan[0] === 'res'
        ? '勾完，这本书的章节进度条和月行程表立刻跟着变'
        : '只记录今天动过它，进度条不动 —— 真做完了去「大任务拆解」自己勾';
  }

  /* 今天完成的事 —— 直接来自 subtasks，谁的都列出来。
     不新开一张表：完成的事本来就是大任务的小任务，复用同一份数据才不会两处对不上。 */
  function renderDoneList() {
    const t = today();
    /* 两类，都靠 done_at 认，不需要新表：
         已完成   —— done 且 done_at 是今天
         今天动过 —— done=false 但 done_at 是今天（上面「只记一笔」盖的戳）
       她之后去「大任务拆解」把这一步勾上，setDone(true) 会用真实完成时刻覆盖 done_at，
       这条记录就自动从「今天动过」变成「已完成」—— 一份数据两种读法，不会两处对不上。 */
    const rows = S.subtasks
      .filter((x) => x.done_at && isoDate(x.done_at) === t && !isTwinEcho(x))
      .map((x) => Object.assign({}, x, { __step: !x.done, __twin: linkedTo(x) }))
      .sort((a, b) => (a.__step === b.__step ? 0 : a.__step ? 1 : -1));   // 完成的排前面
    twoCols($('done-cols'), rows, (owner, list, mine) => {
      if (!list.length) return emptyNote(mine ? '今天还没记。上面记一笔。' : '对方今天还没记。');
      const wrap = h('div');
      for (const x of list.slice(0, 60)) {
        const step = x.__step;
        wrap.appendChild(
          h('div', { class: 'item' + (step ? '' : ' done') },
            h('div', { class: 't' },
              h('span', { class: 'grow', text: x.title || '(未填写)' }),
              step ? h('span', { class: 'pill', text: '今天动过' })
                   : h('span', { class: 'pill ok', text: '已完成' })
            ),
            h('div', { class: 'm' },
              h('span', { class: 'pill' + (parentIsRes(x) ? ' res' : ''), text: '→ ' + parentLabel(x) }),
              /* 绑了「同一件事」的另一半，把那边也标出来 —— 免得她看见书那边没反应 */
              x.__twin ? h('span', { class: 'pill' + (parentIsRes(x.__twin) ? ' res' : ''),
                title: '这一条和那一半绑成了同一件事，勾哪边都一起算完成',
                text: '↔ ' + parentLabel(x.__twin) }) : null,
              h('span', { text: relTime(x.done_at) })
            ),
            mine ? h('div', { class: 'acts' },
              step ? h('button', {
                class: 'tiny', text: '撤销推进',
                title: '只抹掉今天这条推进记录，这一步在「大任务拆解」里还是待办',
                onclick: () => commit(setDone('subtasks', x.id, false), '已撤销这条推进记录，它还是待办'),
              }) : h('button', {
                class: 'tiny', text: '撤销完成',
                title: '改回未完成，它会回到大任务里继续待办',
                onclick: () => commit(setDone('subtasks', x.id, false), '已撤销，它回到大任务里待办了'),
              }),
              step ? null : h('button', {
                class: 'tiny danger', text: '删除',
                title: '从大任务里彻底删掉这一条',
                onclick: () => removeRow('subtasks', x.id, '「' + (x.title || '未填写') + '」这一条'),
              })
            ) : null
          )
        );
      }
      return wrap;
    }, { everyone: true });
  }

  /* 记一笔。两组都勾了就**一次记两条**（她问的「学习资源和大任务可以同步勾选吗」）。
     两组语义**故意不一样**，是她明确要求的：
       大任务 —— 只给选中的那一步盖今天的时间戳，**不改完成状态**。
                 真做完了要她自己去「大任务拆解」勾（原话：
                 「不要勾选后就默认大任务的某个阶段完成了」）。
       资源   —— 把选中的那一章勾掉，那就算完成（书就那么几章，不该越读越多）。
     一组失败就停在那里报错，不会闷声只记一半。 */
  async function addDone() {
    const btn = $('done-btn');
    const jobs = [];      // 这次要记的
    const blocked = [];   // 勾了但记不了的（已经完成过），拿第一条告诉她
    const t = today();
    const note = noteText();   // 「自己写两句」那个框，跟这一笔记一起存
    if (S.doneOn.task) {
      const task = S.tasks.find((x) => x.id === S.doneRef.task && isMine(x));
      const step = task ? subsOfTask(task.id).find((x) => x.id === S.doneSub.task) : null;
      if (!task || !step) { toast('先在上面勾一个它属于哪个大任务', true); return; }
      if (step.done) blocked.push('「' + (step.title || '这一步') + '」已经完成了，不用再记推进');
      else jobs.push({ kind: 'task', task, sub: step });
    }

    if (S.doneOn.res) {
      const r = S.resources.find((x) => x.id === S.doneRef.res && isMine(x));
      const ch = r ? subsOfRes(r.id).find((x) => x.id === S.doneSub.res) : null;
      if (!r || !ch) { toast('先在上面选一本书 / 一门课', true); return; }
      if (ch.done) blocked.push('「' + (ch.title || '这一章') + '」已经勾过了');
      else jobs.push({ kind: 'res', res: r, sub: ch });
    }

    /* 光写字、什么都没勾也是合法的一次记录 —— 只存文字，不动任何进度条 */
    if (!jobs.length && !note) {
      toast(blocked.length ? blocked[0] : '先在上面选一样要记的，或者写两句也行', true);
      return;
    }

    btn.disabled = true;
    for (const j of jobs) {
      const { error } = j.kind === 'res'
        ? await setDone('subtasks', j.sub.id, true)
        : await stampStep(j.sub.id);
      if (error) {
        btn.disabled = false;
        toast('没记上：' + (j.kind === 'res' ? schemaWarn(error) : error.message), true);
        return;
      }
    }

    /* 文字落在 daily_logs.note（今天那一行），和折叠区那条「补充」是同一个字段。
       只写 note、不带上 mood / difficulty —— 那两个是折叠区管的，不该被这里悄悄清掉。
       内容没变就不写：免得一次「只勾不做笔记」凭空多出一行空日记。 */
    const cur = S.daily.find((x) => isMine(x) && x.log_date === t);
    const curNote = cur ? (cur.note || '') : '';
    let noteSaved = false;
    if (note !== curNote) {
      const { error } = await sb.from('daily_logs')
        .upsert({ owner: S.me.id, log_date: t, note: note }, { onConflict: 'owner,log_date' });
      if (error) {
        btn.disabled = false;
        toast('勾选记上了，但那两句话没存下：' + error.message, true);
        await refresh();
        return;
      }
      noteSaved = true;
    }
    btn.disabled = false;

    const said = jobs.map((j) => j.kind === 'res'
      ? '勾掉了「' + (j.sub.title || '这一章') + '」'
      : '今天推进了「' + (j.sub.title || '这一步') + '」');
    if (noteSaved) said.push('存下了你写的两句话');
    const hasStep = jobs.some((j) => j.kind === 'task');
    const tied = jobs.filter((j) => linkedTo(j.sub)).length;
    toast((jobs.length ? '记下了：' + said.join('，') + '。' : '存下了。') +
      (hasStep ? '大任务那一步还没算完成 —— 真做完了去「大任务拆解」勾上它。' : '') +
      (tied ? '它绑着的另一半也跟着变了。' : '') +
      (blocked.length ? '（' + blocked[0] + '）' : ''));
    S.noteTouched = false;   // 存过了，之后 refresh 再用库里的值对齐
    await refresh();
  }

  /* 心情与困难：原「每日困难与心情」的内容，整块保留，只是不再占页签主位 */
  function renderMoodList() {
    twoCols($('daily-cols'), S.daily, (owner, rows, mine) => {
      if (!rows.length) return emptyNote(mine ? '还没记过。上面写一条。' : '对方还没记过。');
      const wrap = h('div');
      for (const d of rows.slice(0, 40)) {
        wrap.appendChild(
          h('div', { class: 'item' },
            h('div', { class: 't' },
              h('span', { class: 'grow', text: d.log_date }),
              d.mood ? h('span', { text: MOODS[d.mood - 1] || '' }) : null
            ),
            d.difficulty ? h('div', { class: 'd', text: d.difficulty }) : null,
            d.note ? h('div', { class: 'm', text: d.note }) : null,
            mine ? h('div', { class: 'acts' },
              h('button', {
                class: 'tiny', text: '改这条',
                onclick: () => { $('d-date').value = d.log_date; prefillDay(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
              }),
              h('button', {
                class: 'tiny danger', text: '删除',
                onclick: () => removeRow('daily_logs', d.id, d.log_date + ' 这一天'),
              })
            ) : null
          )
        );
      }
      return wrap;
    });
  }

  function setMood(v) {
    S.mood = v || null;
    const box = $('d-moods');
    clear(box);
    MOODS.forEach((emo, i) => {
      const n = i + 1;
      box.appendChild(h('button', {
        type: 'button', text: emo, class: S.mood === n ? 'on' : '',
        title: '第 ' + n + ' 档',
        onclick: () => setMood(S.mood === n ? null : n),
      }));
    });
  }

  function prefillDay() {
    const d = $('d-date').value || today();
    const row = S.daily.find((x) => isMine(x) && x.log_date === d);
    const note = row ? (row.note || '') : '';
    setMood(row ? row.mood : null);
    $('d-diff').value = row ? (row.difficulty || '') : '';
    $('d-note').value = note;
    $('d-status').textContent = row ? '这一天已记过，保存会覆盖。' : '这一天还没记。';
    /* 折叠区挑的正好是今天时，上面那个「自己写两句」说的是同一个字段 ——
       顺手对齐，免得两个框显示的字不一样、一保存互相盖掉。
       但她正在打的字不能盖：没动过手才拿库里的值对齐。 */
    if (d === today() && !S.noteTouched) {
      S.noteDay = d;
      $('done-note').value = note;
    }
  }

  /* ── 页签四：学习资源 ──────────────────────────────────────── */
  function renderRes() {
    const all = S.resources;
    const scoped = all.filter(inScope);
    const n = (k) => scoped.filter((r) => r.kind === k).length;

    $('res-tiles') && clear($('res-tiles'));
    $('res-tiles').appendChild(tile('资源总数', scoped.length));
    KINDS.forEach((k) => $('res-tiles').appendChild(tile(k.label, n(k.key))));
    $('res-tiles').appendChild(tile('进行中', scoped.filter((r) => r.status === 'doing').length));
    $('res-tiles').appendChild(tile('已完成', scoped.filter((r) => r.status === 'done').length));

    renderResLegend();
    renderResChart();

    twoCols($('res-cols'), all, (owner, rows, mine) => {
      if (!rows.length) return emptyNote(mine ? '还没添加资源。' : '对方还没添加资源。');
      const wrap = h('div');
      for (const r of rows) {
        /* 这一本书 / 这门课被拆成几章、完成到哪了。章就是 subtasks，
           和「今天完成情况」勾的是同一批行 —— 那边勾一下，这里立刻亮一段。 */
        const subs = subsOfRes(r.id);
        const dn = subs.filter((x) => x.done).length;
        const pp = subs.length ? pct(dn, subs.length) : 0;

        wrap.appendChild(
          h('div', { class: 'item' },
            h('div', { class: 't' },
              h('span', { class: 'pill', text: KIND_LABEL[r.kind] || r.kind }),
              h('span', { class: 'grow', text: r.name })
            ),
            (r.platform || r.subject) ? h('div', { class: 'd' },
              [r.platform, r.subject].filter(Boolean).join(' · ')) : null,
            subs.length ? h('div', { class: 'bar seg' },
              subs.map((x, i) => h('i', {
                class: 'sq' + (x.done ? ' on' : ''),
                title: '第 ' + (i + 1) + ' 章：' + (x.title || '(未填写)') + (x.done ? ' ✅ 已完成' : ' ⬜ 未完成'),
              }))
            ) : null,
            subs.length ? h('div', { class: 'bar-txt' },
              h('span', { text: '共 ' + subs.length + ' 章，已完成 ' + dn + ' 章' }),
              h('span', { class: 'pct' + (pp === 100 ? ' full' : ''), text: pp + '%' })
            ) : null,
            subs.length ? h('details', { class: 'subs-fold' },
              h('summary', { text: '章节清单（' + dn + ' / ' + subs.length + '）' }),
              h('div', { class: 'subs' }, subs.map((x) => subRow(x, mine))),
              mine ? h('div', { class: 'acts' },
                h('button', { class: 'tiny', text: '＋ 加一章', onclick: () => addChapter(r, subs) })) : null
            ) : (mine ? h('div', { class: 'acts' },
              h('button', {
                class: 'tiny', text: '＋ 分章',
                title: '把这本书 / 这门课拆成章节，就能一章一章勾进度',
                onclick: () => addChapter(r, subs),
              })) : null),
            mine ? h('div', { class: 'm' },
              h('span', { text: '状态' }),
              h('select', {
                style: { maxWidth: '130px' },
                onchange: async (e) => {
                  r.status = e.target.value;
                  await quiet(sb.from('resources').update({ status: r.status }).eq('id', r.id));
                },
              }, Object.keys(STATUS_LABEL).map((k) =>
                h('option', { value: k, text: STATUS_LABEL[k], selected: r.status === k })))
            ) : h('div', { class: 'm' },
              h('span', { class: 'pill' + (r.status === 'done' ? ' ok' : ''), text: STATUS_LABEL[r.status] || r.status })
            ),
            mine ? h('div', { class: 'acts' },
              h('button', {
                class: 'tiny danger', text: '删除',
                onclick: () => removeRow('resources', r.id, '资源「' + r.name + '」'),
              })
            ) : null
          )
        );
      }
      return wrap;
    });
  }

  function inScope(r) {
    if (S.resScope === 'me')    return isMine(r);
    if (S.resScope === 'other') return !isMine(r);
    return true;
  }

  function tile(k, v) {
    return h('div', { class: 'tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
  }

  function renderResLegend() {
    const box = $('res-legend');
    clear(box);
    const scopeBox = $('res-scope');
    clear(scopeBox);
    [['all', '全部'], ['me', '只看我'], ['other', '只看对方']].forEach(([k, label]) => {
      scopeBox.appendChild(h('button', {
        class: 'tiny' + (S.resScope === k ? ' primary' : ''), text: label,
        onclick: () => { S.resScope = k; renderRes(); },
      }));
    });
    box.appendChild(h('span', { class: 'item2', text: '按学科分组，每个学科一段堆叠条（鼠标停上去看细分）' }));
    KINDS.forEach((k) => {
      box.appendChild(h('span', { class: 'item2' },
        h('span', { class: 'kdot', style: { background: 'var(' + k.varName + ')' } }),
        k.label
      ));
    });
  }

  /* 宏观可视化：学科 × (工具书/网课/老师) 横向堆叠条
     三色 = series-1/2/3，已用 validate_palette.js 全对校验通过；
     每行直接标出总数（对比度不足时的 relief），细分值 hover 可得，并有表格视图兜底。 */
  function renderResChart() {
    const box = $('res-chart');
    clear(box);

    const rows = S.resources.filter(inScope);
    const map = new Map();
    for (const r of rows) {
      const key = (r.subject || '').trim() || '未分类';
      if (!map.has(key)) map.set(key, { book: 0, course: 0, teacher: 0, total: 0 });
      const o = map.get(key);
      const k = KIND_LABEL[r.kind] ? r.kind : 'book';
      o[k]++; o.total++;
    }
    let data = [...map.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));

    if (!data.length) { box.appendChild(emptyNote('这个范围内还没有资源。')); return; }

    const TOPN = 8;
    if (data.length > TOPN) {
      const head = data.slice(0, TOPN);
      const other = { name: '其他', book: 0, course: 0, teacher: 0, total: 0 };
      for (const t of data.slice(TOPN)) {
        other.book += t.book; other.course += t.course; other.teacher += t.teacher; other.total += t.total;
      }
      data = head.concat([other]);
    }

    const xMax = Math.max(1, ...data.map((d) => d.total));
    const W = 720, L = 104, R = 68, PADT = 10, ROWH = 34, BARH = 18;
    const H = PADT + data.length * ROWH + 30;
    const plotW = W - L - R;
    const x = (v) => L + (v / xMax) * plotW;

    const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
                           'aria-label': '按学科统计的学习资源数量' });

    // 纵向网格 + 底部刻度
    const ticks = xMax >= 4 ? [0, Math.round(xMax / 2), xMax] : (xMax >= 2 ? [0, xMax] : [0, 1]);
    const seen = new Set();
    for (const tv of ticks) {
      if (seen.has(tv)) continue;
      seen.add(tv);
      svg.appendChild(s('line', { x1: x(tv), x2: x(tv), y1: PADT, y2: PADT + data.length * ROWH,
                                  stroke: 'var(--grid)', 'stroke-width': 1 }));
      svg.appendChild(s('text', { x: x(tv), y: H - 10, 'text-anchor': 'middle' }, String(tv)));
    }
    svg.appendChild(s('line', { x1: L, x2: W - R, y1: PADT + data.length * ROWH, y2: PADT + data.length * ROWH,
                                stroke: 'var(--axis)', 'stroke-width': 1 }));

    const tip = h('div', { id: 'tip' });
    box.appendChild(svg);
    box.appendChild(tip);

    data.forEach((d, i) => {
      const y = PADT + i * ROWH;
      const barY = y + (ROWH - BARH) / 2;

      svg.appendChild(s('text', { x: L - 12, y: barY + BARH / 2, 'text-anchor': 'end',
                                  'dominant-baseline': 'middle', class: 'cat' }, d.name));

      let cx = L, first = true;
      for (const k of KINDS) {
        const c = d[k.key];
        if (!c) continue;
        if (!first) cx += 2;                       // 段间 2px 表面间隙
        const w = Math.max(2, (c / xMax) * plotW);
        svg.appendChild(s('rect', { x: cx, y: barY, width: w, height: BARH, rx: 3,
                                    fill: 'var(' + k.varName + ')' }));
        cx += w;
        first = false;
      }
      svg.appendChild(s('text', { x: cx + 8, y: barY + BARH / 2, 'dominant-baseline': 'middle',
                                  fill: 'var(--text-secondary)' }, String(d.total)));

      const hit = s('rect', { x: 0, y: y, width: W, height: ROWH, fill: 'transparent' });
      const items = KINDS.map((k) => ({ label: k.label, value: d[k.key], color: 'var(' + k.varName + ')' }));
      hit.addEventListener('pointermove', (ev) => showTip(tip, box, ev, d.name, items));
      hit.addEventListener('pointerenter', (ev) => showTip(tip, box, ev, d.name, items));
      hit.addEventListener('pointerleave', () => { tip.style.opacity = '0'; });
      svg.appendChild(hit);
    });

    // 表格视图：对比度不足时的兜底，也让每个细分值不依赖 hover
    const tbody = h('tbody');
    for (const d of data) {
      tbody.appendChild(h('tr', null,
        h('td', { text: d.name }),
        ...KINDS.map((k) => h('td', { text: String(d[k.key]) })),
        h('td', { text: String(d.total) })
      ));
    }
    box.appendChild(h('details', { style: { marginTop: '12px' } },
      h('summary', { text: '表格视图' }),
      h('div', { class: 'tblwrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { text: '学科' }),
            ...KINDS.map((k) => h('th', { text: k.label })),
            h('th', { text: '合计' })
          )),
          tbody
        )
      )
    ));
  }

  function showTip(tip, box, ev, title, items) {
    clear(tip);
    tip.appendChild(h('div', { class: 'td', text: title }));
    for (const it of items) {
      tip.appendChild(h('div', { class: 'tr' },
        h('span', { class: 'tk', style: { background: it.color } }),
        h('span', { class: 'tn', text: it.label }),
        h('span', { class: 'tv', text: String(it.value) })
      ));
    }
    tip.style.opacity = '1';
    const r = box.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = ev.clientX - r.left + 14;
    if (left + tw > r.width - 4) left = Math.max(4, ev.clientX - r.left - tw - 14);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, ev.clientY - r.top - 10) + 'px';
  }

  /* ── 页签五：导出 / 导入 ──────────────────────────────────── */
  function snapshot() {
    return {
      app: APP_ID,
      version: APP_VERSION,
      exported_at: new Date().toISOString(),
      backend: {
        supabase_url: SUPABASE_URL,
        supabase_key: SUPABASE_KEY,
        tables: ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources'],
        schema_sql: 'study/setup.sql（建表 + RLS 策略，可重复执行）',
      },
      me: S.me ? { id: S.me.id, email: S.me.email, display_name: nameOf(S.me.id) } : null,
      counts: {
        profiles: S.profileList.length, goals: S.goals.length, tasks: S.tasks.length,
        subtasks: S.subtasks.length, daily_logs: S.daily.length, resources: S.resources.length,
      },
      data: {
        profiles: S.profileList, goals: S.goals, tasks: S.tasks,
        subtasks: S.subtasks, daily_logs: S.daily, resources: S.resources,
      },
    };
  }

  function renderData() {
    $('export-meta').textContent =
      '目标 ' + S.goals.length + ' · 大任务 ' + S.tasks.length + ' · 小任务 ' + S.subtasks.length +
      ' · 日记 ' + S.daily.length + ' · 资源 ' + S.resources.length;
  }

  function doExport() {
    const snap = snapshot();
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'study-collab-' + today() + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('已导出');
  }

  async function doImport(file) {
    let snap;
    try { snap = JSON.parse(await file.text()); }
    catch (e) { toast('这个文件不是合法 JSON', true); return; }
    if (!snap || snap.app !== APP_ID || !snap.data) { toast('这不是本页面导出的快照', true); return; }

    const order = ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources'];
    let written = 0, skipped = 0;
    $('import-meta').textContent = '导入中…';

    for (const t of order) {
      const rows = Array.isArray(snap.data[t]) ? snap.data[t] : [];
      const mine = rows.filter((r) => (t === 'profiles' ? r.id === S.me.id : r.owner === S.me.id));
      skipped += rows.length - mine.length;
      if (!mine.length) continue;

      for (let i = 0; i < mine.length; i += 200) {
        const chunk = mine.slice(i, i + 200);
        const { error } = await sb.from(t).upsert(chunk, t === 'daily_logs' ? { onConflict: 'owner,log_date' } : undefined);
        if (error) { toast('导入 ' + t + ' 失败：' + error.message, true); $('import-meta').textContent = ''; return; }
        written += chunk.length;
      }
    }
    $('import-meta').textContent = '写入 ' + written + ' 行，跳过 ' + skipped + ' 行（属于对方的，权限规则不允许我改）';
    toast('导入完成');
    await refresh();
  }

  /* ── 删除（统一确认）───────────────────────────────────────── */
  async function removeRow(table, id, what) {
    if (!confirm('确定删除' + what + '？删了不可恢复。')) return;
    await commit(sb.from(table).delete().eq('id', id), '已删除');
  }

  /* ── 页签零：主页 ──────────────────────────────────────────── */
  /* 动态流是「算」出来的，不额外存一张表：目标/小任务看 done，
     日记和学习资源看建成时间。所以不加新表也能跑。 */
  function buildFeed() {
    const ev = [];

    for (const g of S.goals) {
      if (!g.done) continue;
      ev.push({
        owner: g.owner, at: g.done_at || null, kind: 'done',
        text: '完成了 30 天目标 ', strong: g.title,
        sub: '累计 ' + (g.progress || 0) + ' / ' + g.target,
      });
    }
    for (const s of S.subtasks) {
      if (!s.done) continue;
      if (isTwinEcho(s)) continue;        // 绑着的两条是同一件事，动态流里只出现一次
      ev.push({
        owner: s.owner, at: s.done_at || null, kind: 'done',
        text: parentIsRes(s) ? '完成章节 ' : '完成小任务 ',
        strong: s.title || (parentIsRes(s) ? '（还没填章节名）' : '（还没填名字）'),
        sub: parentName(s) || (parentIsRes(s) ? '（资源已删除）' : '（大任务已删除）'),
      });
    }
    for (const d of S.daily) {
      ev.push({
        owner: d.owner, at: d.created_at, kind: 'log', mood: d.mood,
        text: '记了 ' + d.log_date + ' 的心情与困难', strong: '',
        sub: d.difficulty || '',
      });
    }
    for (const r of S.resources) {
      ev.push({
        owner: r.owner, at: r.created_at, kind: 'res',
        text: '添加了' + (KIND_LABEL[r.kind] || '资源') + ' ', strong: r.name,
        sub: [r.platform, r.subject].filter(Boolean).join(' · '),
      });
    }

    // 没有 done_at 的（加固脚本跑之前的旧数据）排在最后，不假装有时间
    const t = (e) => (e.at ? new Date(e.at).getTime() : -1);
    ev.sort((a, b) => t(b) - t(a));
    return ev;
  }

  function renderFeed() {
    const box = $('feed');
    clear(box);

    const chips = $('feed-filter');
    clear(chips);
    [['all', '全部'], ['done', '完成了什么'], ['log', '每日记录'], ['res', '学习资源']]
      .forEach(([k, label]) => chips.appendChild(h('button', {
        class: 'tiny' + (S.feedKind === k ? ' primary' : ''),
        text: label,
        onclick: () => { S.feedKind = k; renderFeed(); },
      })));

    let ev = buildFeed();
    if (S.feedKind !== 'all') ev = ev.filter((e) => e.kind === S.feedKind);
    if (!ev.length) { box.appendChild(emptyNote('这个范围内还没有动态。')); return; }

    const shown = ev.slice(0, 60);
    for (const e of shown) {
      box.appendChild(h('div', { class: 'feed-item' },
        avatarEl(e.owner, 'sm'),
        h('div', { class: 'bd' },
          h('div', { class: 'tx' },
            nameOf(e.owner) + ' ' + e.text,
            e.strong ? h('b', { text: e.strong }) : null
          ),
          h('div', { class: 'mt' },
            e.at ? relTime(e.at) : '较早完成',
            e.mood ? h('span', { class: 'mo', text: MOODS[e.mood - 1] || '' }) : null,
            e.sub ? h('span', { text: e.sub }) : null
          )
        )
      ));
    }
    if (ev.length > shown.length) {
      box.appendChild(h('div', { class: 'hint',
        text: '只显示最近 ' + shown.length + ' 条，共 ' + ev.length + ' 条。' }));
    }
  }

  function pcRow(k, v, q) {
    return h('div', { class: 'pc-row' },
      h('span', { class: 'k', text: k }),
      h('span', { class: 'v', text: v }),
      q ? h('span', { class: 'q', text: q }) : null
    );
  }

  function renderPeople() {
    const box = $('home-people');
    clear(box);

    const ids = Object.keys(S.profileMap);
    // profiles 万一读不到（比如加固脚本把读权限收紧了但自己还没进名单），也要有自己的卡片
    if (S.me && ids.indexOf(S.me.id) < 0) ids.push(S.me.id);
    ids.sort((a, b) => {
      if (a === S.me.id) return -1;
      if (b === S.me.id) return 1;
      return nameOf(a).localeCompare(nameOf(b), 'zh');
    });

    for (const id of ids) {
      const mine    = !!S.me && id === S.me.id;
      const g       = S.goals.filter((x) => x.owner === id);
      const t       = S.tasks.filter((x) => x.owner === id);
      const subs    = S.subtasks.filter((x) => x.owner === id);
      const subDone = subs.filter((x) => x.done).length;
      const r       = S.resources.filter((x) => x.owner === id);
      const log     = S.daily.find((x) => x.owner === id && x.log_date === today());
      const gProg   = g.reduce((n, x) => n + (x.progress || 0), 0);
      const gTarget = g.reduce((n, x) => n + (x.target || 0), 0);

      box.appendChild(h('div', { class: 'pcard ' + (mine ? 'me' : 'other') },
        h('div', { class: 'pc-head' },
          avatarEl(id, 'lg'),
          h('div', null,
            h('div', { class: 'nm', text: nameOf(id) }),
            h('div', { class: 'rl', text: mine ? '我' : '对方' })
          ),
          mine ? h('button', {
            class: 'tiny pc-edit',
            text: S.avatarMap[id] ? '换头像' : '上传头像',
            onclick: () => $('av-file').click(),
          }) : null
        ),
        h('div', { class: 'pc-rows' },
          pcRow('30 天目标',
            g.length ? g.filter((x) => x.done).length + ' / ' + g.length + ' 个完成' : '还没建',
            g.length ? '累计 ' + gProg + ' / ' + gTarget : ''),
          pcRow('大任务',
            t.length ? t.length + ' 个' : '还没建',
            subs.length ? '小任务 ' + subDone + ' / ' + subs.length : ''),
          pcRow('今天', log ? '已记录' : '还没记',
            log && log.mood ? MOODS[log.mood - 1] : ''),
          pcRow('学习资源',
            r.length ? r.length + ' 个' : '还没加',
            r.length ? '进行中 ' + r.filter((x) => x.status === 'doing').length +
                       ' · 已完成 ' + r.filter((x) => x.status === 'done').length : '')
        )
      ));
    }
  }

  function renderEntries() {
    const box = $('home-entries');
    clear(box);
    [['goals', '30 天目标', '看谁在跑什么目标'],
     ['tasks', '大任务拆解', '推进小任务进度'],
     ['daily', '今日完成情况', '记下今天完成了什么'],
     ['res', '学习资源', '工具书 / 网课 / 老师'],
     ['data', '导出 / 导入', '存一份完整快照']]
      .forEach(([tab, name, desc]) => box.appendChild(h('button', {
        class: 'entry', onclick: () => goTab(tab),
      }, h('span', { class: 'eb' },
        h('span', { class: 'en', text: name }),
        h('span', { class: 'ed', text: desc })
      ))));
  }

  function renderHome() {
    const ids = Object.keys(S.profileMap);
    if (S.me && ids.indexOf(S.me.id) < 0) ids.push(S.me.id);
    const logged = ids.filter((id) => S.daily.some((x) => x.owner === id && x.log_date === today()));
    $('home-sub').textContent = '今天是 ' + today() + ' · ' +
      (logged.length ? logged.map(nameOf).join('、') + ' 已经记了今天'
                     : '两个人都还没记今天');

    renderPeople();
    renderFeed();
    renderEntries();
  }

  /* ── 渲染分发 ──────────────────────────────────────────────── */
  const RENDER = {
    home: renderHome, goals: renderGoals, tasks: renderTasks,
    daily: renderDaily, res: renderRes, data: renderData,
  };
  function renderCurrent() { (RENDER[S.tab] || renderHome)(); }

  /* 页签切换抽出来，主页的入口卡片也要用 */
  function goTab(name) {
    S.tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'pane-' + name; });
    /* 渲染出错必须说话。以前这里是一句光秃秃的 renderCurrent()，
       里面一抛异常就是「整块空白、一点提示都没有」——
       资源列表因为这个毛病坏了一整轮，我对着截图才查出来。
       刷新那条路径有 try/catch，切页签这条也必须一样。 */
    try { renderCurrent(); }
    catch (e) { toast('这一页渲染出错：' + (e && e.message ? e.message : e), true); }
  }

  /* ── 事件绑定 ──────────────────────────────────────────────── */
  function bindUI() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => goTab(btn.dataset.tab));
    });

    $('me-av').addEventListener('click', () => $('av-file').click());
    $('av-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await onAvatarFile(f);
      e.target.value = '';
    });

    $('g-add').addEventListener('click', async () => {
      const title = $('g-title').value.trim();
      if (!title) { toast('先写目标', true); return; }
      const ok = await commit(sb.from('goals').insert({
        owner: S.me.id,
        period_start: $('g-start').value || today(),
        title: title,
        detail: $('g-detail').value.trim(),
        target: Math.max(1, Number($('g-target').value) || 1),
        progress: 0,
      }), '已添加');
      if (ok) { $('g-title').value = ''; $('g-detail').value = ''; }
    });

    $('t-add').addEventListener('click', async () => {
      const title = $('t-title').value.trim();
      if (!title) { toast('先写大任务', true); return; }
      const n = Math.max(1, Math.min(20, Number($('t-n').value) || 1));
      const ins = await sb.from('tasks').insert({
        owner: S.me.id, title: title, detail: $('t-detail').value.trim(),
        due_date: $('t-due').value || null,
      }).select().single();
      if (ins.error) { toast(ins.error.message, true); return; }

      const subs = [];
      for (let i = 1; i <= n; i++) subs.push({ task_id: ins.data.id, owner: S.me.id, seq: i, title: '', detail: '' });
      const ins2 = await sb.from('subtasks').insert(subs);
      if (ins2.error) { toast('大任务建好了，但小任务生成失败：' + ins2.error.message, true); }
      else toast('已创建，拆成 ' + n + ' 个小任务');
      $('t-title').value = ''; $('t-detail').value = '';
      await refresh();
    });

    /* 今日完成情况：勾选 + 一个自己写两句的文本框，同一个按钮一起存。
       框里没字、也没勾任何东西时按钮是灰的，所以这里不用再拦回车 ——
       但输入法还没上屏时按回车不该当成提交（老坑，别再踩）。 */
    $('done-btn').addEventListener('click', addDone);
    const onNoteInput = (e) => {
      if (e && e.isComposing) return;
      S.noteTouched = true;
      renderDoneForm();     // 只为了按钮的可用状态和文案跟着变；不碰这个框本身
    };
    $('done-note').addEventListener('input', onNoteInput);
    $('done-note').addEventListener('change', onNoteInput);

    $('d-date').addEventListener('change', prefillDay);
    $('d-save').addEventListener('click', async () => {
      const d = $('d-date').value || today();
      const btn = $('d-save');
      btn.disabled = true;
      /* 折叠区挑的是今天时，上面「自己写两句」才是在说同一条记录 —— 以那边为准，
         否则会出现「在 A 框写的字，按 B 的保存被旧值盖掉」。 */
      const noteVal = (d === today() ? $('done-note').value : $('d-note').value).trim();
      const { error } = await sb.from('daily_logs').upsert({
        owner: S.me.id, log_date: d, mood: S.mood,
        difficulty: $('d-diff').value.trim(), note: noteVal,
      }, { onConflict: 'owner,log_date' });
      btn.disabled = false;
      if (error) { toast(error.message, true); return; }
      toast('已保存');
      await refresh();
    });

    $('r-add').addEventListener('click', async () => {
      const name = $('r-name').value.trim();
      if (!name) { toast('先写名称', true); return; }
      const btn = $('r-add');
      btn.disabled = true;
      /* .select().single() 是为了拿回新行的 id —— 要拿它去建章节 */
      const { data, error } = await sb.from('resources').insert({
        owner: S.me.id, kind: $('r-kind').value, name: name,
        platform: $('r-platform').value.trim(), subject: $('r-subject').value.trim(),
        url: '', status: $('r-status').value,
      }).select().single();

      if (error) {
        btn.disabled = false;
        toast(error.message, true);
        return;
      }

      /* 建的时候填了「共几章」就一次生成好，省得进去点 n 次「＋ 加一章」 */
      const n = Math.max(0, Math.min(200, parseInt($('r-chapters').value, 10) || 0));
      let chErr = null;
      if (n && data && data.id) {
        const list = [];
        for (let i = 1; i <= n; i++) {
          list.push({ resource_id: data.id, owner: S.me.id, seq: i, title: '第 ' + i + ' 章', detail: '' });
        }
        const res = await sb.from('subtasks').insert(list);
        chErr = res.error;
      }
      btn.disabled = false;

      if (chErr) {
        /* 资源本身建好了，只是章节没建成（多半是 SQL 还没跑）—— 如实说清楚，
           别说成「添加失败」让她以为白填了一遍 */
        toast('资源已加，但章节没生成：' + schemaWarn(chErr), true);
      } else {
        toast(n ? '已添加，并生成 ' + n + ' 章' : '已添加');
      }
      $('r-name').value = '';
      $('r-platform').value = '';
      $('r-subject').value = '';
      $('r-chapters').value = '';
      await refresh();
    });

    $('btn-export').addEventListener('click', doExport);
    $('btn-import').addEventListener('click', () => $('file-import').click());
    $('file-import').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await doImport(f);
      e.target.value = '';
    });

    $('btn-refresh').addEventListener('click', refresh);
    $('btn-logout').addEventListener('click', () => sb.auth.signOut());
  }

  /* ── 实时订阅 ──────────────────────────────────────────────── */
  let rtChannel = null;
  function subscribeRealtime() {
    const pill = $('conn-pill');
    // 退出再登录会再进这里一次；同名的旧频道必须先撤掉，否则 SDK 会报重名
    if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; }
    let ch = sb.channel('study-collab');
    for (const t of ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources']) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onRealtime(t));
    }
    rtChannel = ch;
    ch.subscribe((status) => {
      const ok = status === 'SUBSCRIBED';
      pill.textContent = ok ? '已连接 · 实时同步' : '未连上实时（手动刷新仍可用）';
      pill.className = 'pill' + (ok ? ' ok' : '');
    });
  }

  /* ── 头像 ──────────────────────────────────────────────────── */
  /* 裁成正方形 → 缩到 160px → JPEG。出来的 data URL 约 8~15 KB，
     直接存在 profiles.avatar 这个 text 列里，不占 Storage 配额、
     也不需要多配一套 bucket 权限。 */
  function shrinkImage(file, size) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const s = Math.min(img.width, img.height);
          const c = document.createElement('canvas');
          c.width = c.height = size;
          c.getContext('2d').drawImage(
            img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (err) { URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('不是有效图片')); };
      img.src = url;
    });
  }

  async function onAvatarFile(file) {
    if (!/^image\//.test(file.type)) { toast('请选图片文件', true); return; }
    let dataUrl;
    try { dataUrl = await shrinkImage(file, 160); }
    catch (e) { toast('这张图读不出来：' + e.message, true); return; }
    if (dataUrl.length > 120000) { toast('图片太大，换一张', true); return; }

    const { error } = await sb.from('profiles').update({ avatar: dataUrl }).eq('id', S.me.id);
    if (error) {
      if (/avatar/i.test(error.message)) {
        toast('库里还没有 avatar 列。先跑 study/setup-3-feed.sql，再回来点头像。', true);
      } else toast(error.message, true);
      return;
    }
    S.avatarMap[S.me.id] = dataUrl;
    paintMeAvatar();
    renderCurrent();
    toast('头像已更新');
  }

  function paintMeAvatar() {
    const el = $('me-av');
    if (!el || !S.me) return;
    clear(el);
    el.className = 'av me clickable';
    const url = S.avatarMap[S.me.id];
    el.title = url ? '点头换头像' : '点头上传头像';
    if (url) el.appendChild(h('img', { src: url, alt: nameOf(S.me.id) }));
    else el.textContent = (nameOf(S.me.id) || '?').trim().charAt(0).toUpperCase();
  }

  /* ── 登录 / 启动 ───────────────────────────────────────────── */

  /* 把 Supabase 的登录报错翻成能直接照着做的中文。
     服务端为了防「邮箱枚举」，对「账号不存在」和「密码不对」故意返回同一个
     invalid_credentials —— 这两者它不给区分，所以提示里必须两种都说。
     但 email_not_confirmed 是可以区分的，这种情况账号一定存在。 */
  function loginErrText(error) {
    const msg  = (error && error.message) || '';
    const code = (error && (error.code || error.error_code)) || '';
    const all  = msg + ' ' + code;
    let hint;
    if (/email_not_confirmed|email not confirmed/i.test(all)) {
      hint = '账号在，但这个邮箱还没确认过。去 Supabase 后台 → Authentication → Users，'
           + '找到这一行，点右边 ⋯ 菜单里的 Confirm email。';
    } else if (/invalid_credentials|invalid login credentials/i.test(all)) {
      hint = '账号不存在，或者密码不对。（服务端故意不区分这两种，防止别人试出哪个邮箱注册过）';
    } else if (/email_address_invalid|invalid.*email|unable to validate email/i.test(all)) {
      hint = '邮箱格式不对，检查有没有多打空格。';
    } else if (/rate|too many|over_email_send/i.test(all)) {
      hint = '试太多次被限流了，等几分钟再试。';
    } else if (/failed to fetch|network|load failed/i.test(all)) {
      hint = '连不上 Supabase。挂上代理/换个网络，或者刷新重试。';
    } else {
      hint = msg || '登录失败，原因未知。';
    }
    return code ? hint + '［' + code + '］' : hint;
  }

  function showApp(user) {
    S.me = user;
    S.tab = 'home';
    $('view-login').hidden = true;
    $('view-app').hidden = false;
    $('whoami').textContent = (user.email || '') + ' · 已登录';
    if (!$('g-start').value) $('g-start').value = today();
    if (!$('d-date').value)  $('d-date').value  = today();
    paintMeAvatar();
    loadAll()
      .then(() => { paintMeAvatar(); goTab('home'); })   // 登录后落在主页
      .catch((e) => toast('读取失败：' + e.message, true));
    subscribeRealtime();
  }

  function showLogin() {
    S.me = null;
    $('view-app').hidden = true;
    $('view-login').hidden = false;
  }

  async function boot() {
    $('view-login').hidden = false;   // 先给登录页，避免白屏

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      $('lg-err').textContent = '客户端库没加载出来（supabase.js）。检查网络后刷新。';
      $('lg-err').hidden = false;
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });

    bindUI();
    $('d-date').value = today();
    $('g-start').value = today();
    setMood(null);

    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('lg-err');
      const btn = $('lg-btn');
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = '登录中…';
      const { data, error } = await sb.auth.signInWithPassword({
        email: $('lg-email').value.trim(),
        password: $('lg-pass').value,
      });
      btn.disabled = false;
      btn.textContent = '登录';
      if (error) {
        err.textContent = loginErrText(error);
        err.hidden = false;
        return;
      }
      $('lg-pass').value = '';
      showApp(data.user);
    });

    sb.auth.onAuthStateChange((evt, session) => {
      if (evt === 'SIGNED_OUT' || !session) showLogin();
    });

    const { data } = await sb.auth.getSession();
    if (data && data.session && data.session.user) showApp(data.session.user);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
