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
    profileList: [],
    goals: [], tasks: [], subtasks: [], daily: [], resources: [],
    tab: 'goals',
    mood: null,
    resScope: 'all',      // all | me | other
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

  /* DOM 构造器。文字一律走 textContent —— 库里的内容是别人输入的，当不可信数据处理。 */
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
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
    S.profileList.forEach((p) => { S.profileMap[p.id] = p.display_name; });
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

  function twoCols(container, rows, renderOne) {
    clear(container);
    const m = groupByOwner(rows);
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
          h('h3', null, nameOf(id), h('span', { class: 'badge', text: mine ? '我' : '对方' })),
          renderOne(id, m[id], mine)
        )
      );
    }
  }

  function emptyNote(txt) { return h('div', { class: 'empty', text: txt }); }

  /* ── 页签一：30 天小目标 ───────────────────────────────────── */
  function renderGoals() {
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
                  sb.from('goals').update({ done: !g.done, progress: !g.done ? g.target : g.progress }).eq('id', g.id)
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

  async function bumpGoal(g, d) {
    const v = Math.max(0, Math.min(999999, (g.progress || 0) + d));
    g.progress = v;
    await quiet(sb.from('goals').update({ progress: v, done: v >= g.target ? g.done : false }).eq('id', g.id));
    renderCurrent();
  }

  /* ── 页签二：大任务拆解 ────────────────────────────────────── */
  function renderTasks() {
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
            h('div', { class: 'bar' }, h('i', { style: { width: p + '%' } })),
            h('div', { class: 'bar-txt' },
              h('span', { text: doneN + ' / ' + subs.length + ' 个小任务' }),
              h('span', { text: p + '%' })
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

  function subRow(sub, mine) {
    const box = h('div', { class: 'sub' + (sub.done ? ' done' : '') },
      h('input', {
        type: 'checkbox', checked: !!sub.done, disabled: !mine,
        onchange: async (e) => {
          const v = e.target.checked;
          sub.done = v;
          await quiet(sb.from('subtasks').update({ done: v }).eq('id', sub.id));
          renderCurrent();
        },
      })
    );

    if (mine) {
      box.appendChild(h('input', {
        type: 'text', class: 'grow', value: sub.title || '',
        placeholder: '这一步要干什么',
        title: sub.detail || '',
        style: sub.done ? { opacity: '.6' } : null,
        onchange: async (e) => {
          const v = e.target.value.trim();
          if (v === (sub.title || '')) return;
          sub.title = v;
          await quiet(sb.from('subtasks').update({ title: v }).eq('id', sub.id));
        },
      }));
      box.appendChild(h('button', {
        class: 'tiny danger', text: '✕',
        onclick: async () => {
          if (!confirm('删掉这个小任务？')) return;
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

  /* ── 页签三：每日困难与心情 ────────────────────────────────── */
  function renderDaily() {
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
    prefillDay();
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
    setMood(row ? row.mood : null);
    $('d-diff').value = row ? (row.difficulty || '') : '';
    $('d-note').value = row ? (row.note || '') : '';
    $('d-status').textContent = row ? '这一天已记过，保存会覆盖。' : '这一天还没记。';
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
        wrap.appendChild(
          h('div', { class: 'item' },
            h('div', { class: 't' },
              h('span', { class: 'pill', text: KIND_LABEL[r.kind] || r.kind }),
              h('span', { class: 'grow', text: r.name })
            ),
            (r.platform || r.subject) ? h('div', { class: 'd' },
              [r.platform, r.subject].filter(Boolean).join(' · ')) : null,
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
      tbody.appendChild(h('tr',
        h('td', { text: d.name }),
        ...KINDS.map((k) => h('td', { text: String(d[k.key]) })),
        h('td', { text: String(d.total) })
      ));
    }
    box.appendChild(h('details', { style: { marginTop: '12px' } },
      h('summary', { text: '表格视图' }),
      h('div', { class: 'tblwrap' },
        h('table', null,
          h('thead', null, h('tr',
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

  /* ── 渲染分发 ──────────────────────────────────────────────── */
  const RENDER = { goals: renderGoals, tasks: renderTasks, daily: renderDaily, res: renderRes, data: renderData };
  function renderCurrent() { (RENDER[S.tab] || renderGoals)(); }

  /* ── 事件绑定 ──────────────────────────────────────────────── */
  function bindUI() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        S.tab = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === btn));
        document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'pane-' + S.tab; });
        renderCurrent();
      });
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

    $('d-date').addEventListener('change', prefillDay);
    $('d-save').addEventListener('click', async () => {
      const d = $('d-date').value || today();
      const btn = $('d-save');
      btn.disabled = true;
      const { error } = await sb.from('daily_logs').upsert({
        owner: S.me.id, log_date: d, mood: S.mood,
        difficulty: $('d-diff').value.trim(), note: $('d-note').value.trim(),
      }, { onConflict: 'owner,log_date' });
      btn.disabled = false;
      if (error) { toast(error.message, true); return; }
      toast('已保存');
      await refresh();
    });

    $('r-add').addEventListener('click', async () => {
      const name = $('r-name').value.trim();
      if (!name) { toast('先写名称', true); return; }
      const ok = await commit(sb.from('resources').insert({
        owner: S.me.id, kind: $('r-kind').value, name: name,
        platform: $('r-platform').value.trim(), subject: $('r-subject').value.trim(),
        url: '', status: $('r-status').value,
      }), '已添加');
      if (ok) { $('r-name').value = ''; $('r-platform').value = ''; $('r-subject').value = ''; }
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

  /* ── 登录 / 启动 ───────────────────────────────────────────── */
  function showApp(user) {
    S.me = user;
    $('view-login').hidden = true;
    $('view-app').hidden = false;
    $('whoami').textContent = (user.email || '') + ' · 已登录';
    if (!$('g-start').value) $('g-start').value = today();
    if (!$('d-date').value)  $('d-date').value  = today();
    loadAll().then(renderCurrent).catch((e) => toast('读取失败：' + e.message, true));
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
        err.textContent = error.message === 'Invalid login credentials'
          ? '邮箱或密码不对。' : error.message;
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
