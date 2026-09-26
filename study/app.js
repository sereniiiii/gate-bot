/* ══════════════════════════════════════════════════════════════
   乐观者永远前行 · app.js

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

  /* 站名（登录页和主页那两个 h1、以及浏览器标签页标题）。
     库里的 site 表有值时用库里的，没有就用这个 —— 见 setup-10-site.sql。
     改默认值要同时改 index.html 里那三处写死的 <title> / <h1>（兜底那句话）。 */
  const DEFAULT_TITLE = 'Alano';
  const TITLE_MAX = 24;

  const MOODS  = ['😞', '😕', '😐', '🙂', '😄'];   // 下标 0..4 → 存 1..5
  const KINDS  = [
    { key: 'book',    label: '工具书', varName: '--series-1' },
    { key: 'course',  label: '网课',   varName: '--series-2' },
    { key: 'teacher', label: '老师',   varName: '--series-3' },
  ];
  const KIND_LABEL   = { book: '工具书', course: '网课', teacher: '老师' };
  const STATUS_LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
  /* 考试成绩分两类：学校统一考的 vs 自己找卷子做的。 */
  const EXAM_KINDS     = [
    { key: 'school', label: '学校考试' },
    { key: 'paper',  label: '自己做的试卷' },
  ];
  const EXAM_KIND_LABEL = { school: '学校考试', paper: '自己做的试卷' };

  /* 39 所 985 高校的校训，登录页和主页随机挑一句显示。
     这是**兜底清单**：setup-8-mottos.sql 跑过之后，页面读的是库里的 mottos 表
     （可以在「导出 / 导入」页改），这份就只在表还没建时用。
     ⚠️ 改这里等于只改了兜底 —— 库建好之后要改的是库。两份内容本来一致，
        想同步的话照着 setup-8-mottos.sql 里的种子数据抄。 */
  const MWORDS = [
    ['清华大学', '自强不息，厚德载物'],
    ['北京大学', '爱国、进步、民主、科学'],
    ['中国人民大学', '实事求是'],
    ['北京航空航天大学', '德才兼备，知行合一'],
    ['北京理工大学', '德以明理，学以精工'],
    ['中国农业大学', '解民生之多艰，育天下之英才'],
    ['北京师范大学', '学为人师，行为世范'],
    ['中央民族大学', '美美与共，知行合一'],
    ['南开大学', '允公允能，日新月异'],
    ['天津大学', '实事求是'],
    ['大连理工大学', '团结、进取、求实、创新'],
    ['东北大学', '自强不息，知行合一'],
    ['吉林大学', '求实创新，励志图强'],
    ['哈尔滨工业大学', '规格严格，功夫到家'],
    ['复旦大学', '博学而笃志，切问而近思'],
    ['同济大学', '同舟共济'],
    ['上海交通大学', '饮水思源，爱国荣校'],
    ['华东师范大学', '求实创造，为人师表'],
    ['南京大学', '诚朴雄伟，励学敦行'],
    ['东南大学', '止于至善'],
    ['浙江大学', '求是创新'],
    ['中国科学技术大学', '红专并进，理实交融'],
    ['厦门大学', '自强不息，止于至善'],
    ['山东大学', '学无止境，气有浩然'],
    ['中国海洋大学', '海纳百川，取则行远'],
    ['武汉大学', '自强、弘毅、求是、拓新'],
    ['华中科技大学', '明德厚学，求是创新'],
    ['中南大学', '知行合一，经世致用'],
    ['湖南大学', '实事求是，敢为人先'],
    ['国防科技大学', '厚德博学，强军兴国'],
    ['中山大学', '博学、审问、慎思、明辨、笃行'],
    ['华南理工大学', '博学慎思，明辨笃行'],
    ['四川大学', '海纳百川，有容乃大'],
    ['电子科技大学', '求实求真，大气大为'],
    ['重庆大学', '耐劳苦、尚俭朴、勤学业、爱国家'],
    ['西安交通大学', '精勤求学，敦笃励志，果毅力行，忠恕任事'],
    ['西北工业大学', '公诚勇毅'],
    ['西北农林科技大学', '诚朴勇毅'],
    ['兰州大学', '自强不息，独树一帜'],
  ];

  /* ── 状态 ──────────────────────────────────────────────────── */
  const S = {
    me: null,
    profileMap: {},       // id -> display_name
    avatarMap: {},        // id -> 头像 data URL（空串表示没上传过）
    profileList: [],
    goals: [], tasks: [], subtasks: [], daily: [], resources: [], exams: [],
    tab: 'home',          // 登录后落在主页
    mood: null,
    month: '',            // 月行程表显示哪个月 'YYYY-MM'，空 = 本月
    /* 「今日完成情况」两组**各自独立，而且都可以多选**（她 2026-09-26 的原话：
       「可以勾选多个大任务或者学习资源，对应的大任务可以勾选对应做到了哪一步，
       也可以多选；对应的学习资源可以勾选对应多少章节，也可以多选」）。
       donePick.task / donePick.res —— 勾中的**父项**（大任务 / 学习资源）id 集合
       doneStep —— 大任务侧勾中的**步** id 集合，一条 = 今天推进了这一步，**不算完成**
       doneCh   —— 资源侧勾中的**章** id 集合，一条 = 把这一章勾掉，**算完成**
       用普通对象当集合（id 是 uuid 字符串，Set 存不住也不好转 JSON）。
       ⚠️ 两组的语义不对称是**故意的**（见 addDone 的注释），别顺手统一。
       ⚠️ 子项一律**不预勾** —— 多选之后预勾会让按钮上「记 N 条」的 N 跟她看到的对不上。 */
    donePick: { task: {}, res: {} },
    doneStep: {},
    doneCh: {},
    /* 「自己写两句」那个文本框跟着**今天**这一天走，存在 daily_logs.note 里
       （和折叠区那条「补充」是同一个字段，没有新表）。noteDay = 框里现在装的是
       哪一天的文字；noteTouched = 她动过手之后，别拿库里的旧值把正在打的字盖掉。 */
    noteDay: null,
    noteTouched: false,
    resScope: 'all',      // all | me | other
    feedKind: 'all',      // all | done | log | res
    noDoneAt: false,      // 库里还没加 done_at 列时置位（setup-3-feed.sql 跑之前）
    /* 考试成绩。这张表是**独立一张**，不掺进上面六个数组的任何一条链路。
       exScope   all | me | other（和资源同一个口径）
       exSubject 空串 = 不筛科目；否则只看这一科
       exEdit    正在改的那一场的 id，null = 新建 */
    exScope: 'all',
    exSubject: '',
    exEdit: null,
    exNoTable: false,     // 库里还没建 exams 表时置位（setup-6-exams.sql 跑之前）
    /* 倒计时。条目就是 goals 表里 due_date 非空的行（不新开表，见 setup-7-countdown.sql）。
       cdNoCol = 库里还没有 due_date 那一列时置位（setup-7 跑之前）。 */
    cdNoCol: false,
    /* priNoCol = 库里还没有 priority 那一列（setup-11 跑之前）。
       那一列是加分项，没有它只是不显示「优先级」那个下拉，别的照常用。 */
    priNoCol: true,
    /* 倒计时跟学习资源一样**没有**编辑态 —— 标题 / 说明 / 截止日就是卡片上的
       输入框，改完失焦自动存（见 cdRow 里的 patch）。上面那张表单只管新建。 */
    /* 学习资源**没有**编辑态 —— 名称 / 平台 / 学科就是卡片上的输入框，
       改完失焦自动存（见 resRow 里的 patch）。上面那张表单只管新建。 */
    /* 校训。两个人的共同装饰，不按 owner 分（见 setup-8-mottos.sql）。
       mtNoTable = 表还没建，这时用内置的 MWORDS 兜底显示，只是改不了。
       mtEdit    正在改的那一条的 id，null = 没在改 */
    mottos: [],
    mtNoTable: false,
    mtEdit: null,
    mtNow: null,          // 此刻显示的那一条（登录页与主页共用同一条）
    /* 「同一件事」的关联，多对多，存在 links 表里（见 setup-9-links.sql）。
       旧的 subtasks.link_id（一对一）**没删也没搬**，读的时候当作一条额外关联
       折算进来（peersOf 里那一段）—— 一行数据都没丢。
       lkNoTable = links 表还没建，这时退回「只能一对一」的旧样子。 */
    links: [],
    lkNoTable: false,
    /* 站名。和校训一样是两个人的共同装饰，不按 owner 分（见 setup-10-site.sql）。
       stNoTable = site 表还没建，这时用 DEFAULT_TITLE + 本机记住的那个，
       页面上改不了（会明说去跑脚本）。
       siteTitle 就是此刻该显示的名字 —— document.title 和两个 h1 都从它来。 */
    siteTitle: DEFAULT_TITLE,
    stNoTable: false,
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
  /* 从今天往后数到最近的星期 dow（0=周日 … 6=周六）。
     skipToday=true 时「就是今天」也算下一个 —— 「下周一」在周一那天不该给出今天。
     用 new Date(y, m-1, d) 构造本地日期：'YYYY-MM-DD' 直接丢进 new Date()
     是按 UTC 解析的，晚上八点后算出来会差一天。 */
  function nextDow(dow, skipToday) {
    const [y, m, d] = today().split('-').map(Number);
    let delta = (dow - new Date(y, m - 1, d).getDay() + 7) % 7;
    if (!delta && skipToday) delta = 7;
    return addDays(today(), delta);
  }
  /* 倒计时新建表单上那四个快捷按钮各填哪一天（周六 = 6，周一 = 1）。 */
  const QUICK_DUE = {
    'cd-today':    () => today(),
    'cd-tomorrow': () => addDays(today(), 1),
    'cd-weekend':  () => nextDow(6, false),
    'cd-nextmon':  () => nextDow(1, true),
  };
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

  /* 按天聚合「那天发生了什么」—— 月度任务视图的数据源。
   五张表全算进来，不只看目标：完成的小任务 / 完成的目标 / 只推进未完成的那一步 /
   那天考的试 / 那天加的学习资源 / 当天的日记。全部现算，没有新表；
   哪张表还没建（比如 exams 没跑 SQL）就自然为空，不影响别的。

   注意：**完成**（subs + goals）才是格子深浅和右下角数字的口径；
   pushes（推进未完成）、考试、资源只进悬停明细、表格视图和统计句，不点亮格子。 */
  function dayStats() {
    const m = {};
    const slot = (k) => (m[k] || (m[k] = {
      subs: [], goals: [], pushes: [], exams: [], res: [], due: [], log: null,
    }));
    for (const x of S.subtasks) {
      if (isLinkEcho(x)) continue;        // 关联着的几条是同一件事，只算一次
      const k = isoDate(x.done_at);
      if (!k) continue;
      if (x.done) slot(k).subs.push(x);   // 完成
      else slot(k).pushes.push(x);        // 记了「今天推进了」但还没完成
    }
    for (const g of S.goals) {
      if (g.done) {
        const k = isoDate(g.done_at);
        if (k) slot(k).goals.push(g);
      } else if (g.due_date) {
        /* 还没完成的倒计时：标在**截止日**那一格（不是完成日）。
           完成了就不再提醒 —— 那天会以「完成」的身份出现在它自己的格子里。 */
        slot(g.due_date).due.push(g);
      }
    }
    /* 成绩：exam_date 是 date 列，PostgREST 直接给 'YYYY-MM-DD' 纯文本，
       拿它当键就行 —— 反而是过一遍 new Date() 会被时区带偏一天。 */
    for (const e of S.exams) {
      if (e.exam_date) slot(e.exam_date).exams.push(e);
    }
    /* 学习资源：按添加时间落格（库里没有单独的「学了没」时间戳） */
    for (const r of S.resources) {
      const k = isoDate(r.created_at);
      if (k) slot(k).res.push(r);
    }
    for (const d of S.daily) {
      if (!d.log_date) continue;
      slot(d.log_date).log = d;
    }
    return m;
  }
  /* 那一天一共完成了几件事（小任务 + 目标）—— 只有这个进格子深浅 */
  const dayCount = (e) => (e ? e.subs.length + e.goals.length : 0);

  /* 那天有动静吗（完成 / 推进 / 考试 / 加了资源 / 记了心情，任意一样） */
  const dayActive = (e) => !!e && (dayCount(e) + e.pushes.length + e.exams.length + e.res.length > 0 || !!e.log);

  /* 格子上考试的小标记：一场有分就写分，多场只报场数。
     分数是给人扫一眼的，不写「/满分」—— 格子里放不下，全量在悬停和表格视图里。 */
  function examMark(list) {
    if (!list.length) return '';
    if (list.length > 1) return '考×' + list.length;
    const s = list[0].score;
    return (s === null || s === undefined || s === '') ? '考' : '考' + fmtNum(s);
  }

  /* 格子右下角的截止日小标记：只有「还没完成、截止日在这天」的倒计时才标。
     不写还剩几天 —— 格子里放不下，而且那天本身就是答案。 */
  /* 「截」= 那天有还没完成的倒计时任务到期。
     桌面端把**第一件事的标题也写出来** —— 不然格子里只有一个「截」字，
     她得逐格悬停才知道是哪件事。同一天两件以上只写件数（剩下的靠悬停看全）；
     窄屏（≤560px）一行放不下，CSS 里把 .dt 藏掉，只留「截」。 */
  function dueMarkEl(list) {
    if (!list.length) return null;
    const head = list.length > 1 ? '截×' + list.length : '截';
    return h('span', { class: 'dl' },
      h('span', { class: 'dlc', text: head }),
      list.length === 1 ? h('span', { class: 'dt', text: (list[0] && list[0].title) || '(无标题)' }) : null
    );
  }

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

  /* ── 「同一件事」的关联（多对多）────────────────────────────
     一本书的一章，可能就是大任务里的那一步；一步也可能同时是两本书的某几章；
     30 天小目标也可能是大任务里的某几步。所以是一张**多对多**的表 links
     （见 setup-9-links.sql），一行 = 一对。

     旧的 subtasks.link_id（一对一那一套，setup-5-link.sql）**数据一行没删**：
     下面 peersOf() 把它折算成一条额外的关联一起返回，标 legacy=true。
     要不要留着由她决定 —— 界面上点掉那条 chip 才会真的清空它。

     库里没有 link_id 这一列时所有行都读不到它 → 就是「没绑过」；没有 links
     表时 S.links 是空的 → 退回旧的一对一那套，页面照常，不会白屏。 */
  const linkedTo = (x) => (x && x.link_id ? S.subtasks.find((s) => s.id === x.link_id) || null : null);
  /* 「属于哪儿」的人话说法，动态流和列表都用它 */
  const parentLabel = (x) => {
    const n = parentName(x);
    if (n === null) return parentIsRes(x) ? '资源已删除' : '大任务已删除';
    return (parentIsRes(x) ? '资源 · ' : '大任务 · ') + n;
  };

  /* 关联的两端只有这两种：大任务的一步 / 资源的一章（都是 subtasks），
     以及 30 天小目标（goals 里 due_date 为空的那种）。
     倒计时（goals 里 due_date 非空）不参与 —— 它是 0/1 的截止日，没有拆解的余地。 */
  const kindOfGoal = (g) => (g && g.due_date ? null : 'goal');
  const itemOf = (kind, id) => (kind === 'goal'
    ? S.goals.find((g) => g.id === id) || null
    : S.subtasks.find((s) => s.id === id) || null);
  const lkKey = (kind, id) => kind + ':' + id;
  /* 显示用的一句话：「资源 · 线性代数应该这样学 · 第 2 章」/「30 天小目标 · 背完 300 个单词」 */
  const itemLabel = (kind, id) => {
    const it = itemOf(kind, id);
    if (!it) return '（已删除）';
    return kind === 'goal' ? '30 天小目标 · ' + (it.title || '未填写')
                           : parentLabel(it) + ' · ' + (it.title || '未填写');
  };

  /* 这一条挂着的所有对家。两个方向都查 —— 万一有行是反着存的也照样读得到。
     找不到对家的行（对家被删了、又没删干净）直接跳过：宁可不显示，
     也不要显示成「关联到空气」。旧的一对一那列折算成一条 legacy 关联。 */
  function peersOf(kind, id) {
    const out = [];
    for (const r of S.links) {
      const p = r.a_kind === kind && r.a_id === id ? { kind: r.b_kind, id: r.b_id }
              : r.b_kind === kind && r.b_id === id ? { kind: r.a_kind, id: r.a_id }
              : null;
      if (!p || !itemOf(p.kind, p.id)) continue;
      if (out.some((o) => o.kind === p.kind && o.id === p.id)) continue;
      out.push({ kind: p.kind, id: p.id, linkId: r.id, legacy: false });
    }
    if (kind === 'subtask') {
      const t = linkedTo(itemOf('subtask', id));
      if (t && !out.some((o) => o.kind === 'subtask' && o.id === t.id)) {
        out.push({ kind: 'subtask', id: t.id, linkId: null, legacy: true });
      }
    }
    return out;
  }
  const peersOfSub = (x) => (x ? peersOf('subtask', x.id) : []);

  /* 一圈「同一件事」：从这一条出发，把它挂着的、那些挂着的都收进来。
     为什么要整圈而不是只走一跳：A 挂着 B、B 又挂着 C 时，三条都是同一件事。
     只传一跳的话，勾 C 会把 A 落下 —— 留下「A 和 C 都等于 B，却互相不一致」
     的怪状态，日历上的件数也会跟着飘。圈再大也有限（都是她自己的几十条），
     收完就停，不会无限转。返回 [{kind, item}]。 */
  function linkedGroup(kind, id) {
    const seen = new Set([lkKey(kind, id)]);
    const out = [];
    const q = [{ kind: kind, id: id }];
    while (q.length) {
      const cur = q.shift();
      for (const p of peersOf(cur.kind, cur.id)) {
        const k = lkKey(p.kind, p.id);
        if (seen.has(k)) continue;
        seen.add(k);
        const it = itemOf(p.kind, p.id);
        if (!it) continue;
        out.push({ kind: p.kind, item: it });
        q.push({ kind: p.kind, id: p.id });
      }
    }
    return out;
  }

  /* 关联着的几条在库里是**好几行**，但在日历和动态流里是同一件事，只算一次。
     否则勾一步就把那天的件数灌成好几件。
     判据：这一圈里已经完成的、id 比我小的只要有一条，就由它代表，我这边算回声。
     不看 done_at —— 她可能分开勾，那样时间戳就不一样了；id 序虽然任意但稳定。 */
  const isLinkEcho = (x) => {
    if (!x || !x.done) return false;
    return linkedGroup('subtask', x.id).some((g) =>
      g.kind === 'subtask' && g.item.done && String(g.item.id) < String(x.id));
  };

  /* 能跟这一条关联的候选。跟以前那条一对一的规则比，只有一处变化：
     **不再把「已经挂给别人的」排除掉** —— 多对多就是要能挂多条。
     自己、已经关联过的、对方的东西都不列。没有候选时返回空数组，
     界面上那个「＋ 关联…」就不出现。 */
  function linkChoices(kind, row) {
    const have = new Set(peersOf(kind, row.id).map((p) => lkKey(p.kind, p.id)));
    const out = [];
    const add = (k, r) => {
      if (!r || !isMine(r)) return;
      if (k === kind && r.id === row.id) return;
      const key = lkKey(k, r.id);
      if (have.has(key)) return;
      out.push({ kind: k, id: r.id, key: key, label: itemLabel(k, r.id) });
    };
    if (kind === 'subtask') {
      /* 大任务的一步 ↔ 资源的章节：**跨父项**才算（自己同一父项下的兄弟姐妹不列，
         那本来就是同一个大任务里的两步，不是「同一件事的两种说法」）。 */
      const xs = parentIsRes(row) ? S.subtasks.filter((s) => s.task_id)
                                  : S.subtasks.filter((s) => s.resource_id);
      xs.forEach((s) => add('subtask', s));
      /* 30 天小目标也能挂上（倒计时那些不算，kindOfGoal 返回 null 就跳过） */
      S.goals.filter((g) => kindOfGoal(g)).forEach((g) => add('goal', g));
    } else {
      S.subtasks.forEach((s) => add('subtask', s));
    }
    return out;
  }

  /* 关联一条。写之前先把这一对**排好序**：(a_kind,a_id) <= (b_kind,b_id)。
     这样正着点反着点都落在同一行上，唯一索引挡得住重复。
     links 表还没建时明确说去跑哪个脚本（schemaWarn）。 */
  async function addLink(kind, row, target) {
    const A = lkKey(kind, row.id), B = lkKey(target.kind, target.id);
    const [a_kind, a_id, b_kind, b_id] = A <= B
      ? [kind, row.id, target.kind, target.id]
      : [target.kind, target.id, kind, row.id];
    const r = await sb.from('links').insert({ owner: S.me.id, a_kind, a_id, b_kind, b_id });
    if (r.error) { toast('没关联上：' + schemaWarn(r.error), true); return; }
    await refresh();
    toast('关联上了：' + itemLabel(kind, row.id) + ' ↔ ' + itemLabel(target.kind, target.id));

    /* 关联完这一圈的完成状态可能不一样 → **问一句**，绝不自己替她宣布完成。
       只算 subtask（这一步自己和同一圈里的章/步）：30 天小目标有自己的进度计数，
       勾一步就把它标成完成太越权，所以它只是被挂上、状态不动。 */
    const others = linkedGroup(kind, row.id)
      .filter((g) => g.kind === 'subtask')
      .map((g) => g.item);
    const group = (kind === 'subtask' ? [row] : []).concat(others)
      .filter((s, i, a) => a.findIndex((t) => t.id === s.id) === i);   // 去重
    const todo = group.filter((s) => !s.done);
    /* 一圈里全都没完成、或全都完成了 = 本来就对齐，不用问 */
    if (!others.length || !todo.length || todo.length === group.length) return;
    const st = (s) => (s.title || '未填写') + (s.done ? '（已完成）' : '（还没完成）');
    if (!confirm('关联好了。但这几条现在不一样：' + group.map(st).join('、') + '。\n\n'
      + '要不要把这几条都算完成？（不点确定就保持原样，以后勾哪边都会带着其它几条）')) return;
    const stamp = new Date().toISOString();
    await Promise.all(todo.map((s) =>
      sb.from('subtasks').update({ done: true, done_at: stamp }).eq('id', s.id)));
    await refresh();
  }

  /* 解开一条。legacy 那种（旧的一对一列）要把**两边**的 link_id 都清掉，
     不留单向指针；新的走 links 表，删那一行就行。 */
  async function dropLink(kind, rowId, peer) {
    const jobs = [];
    if (peer.legacy) {
      jobs.push(sb.from('subtasks').update({ link_id: null }).eq('id', rowId));
      const other = itemOf('subtask', peer.id);
      if (other && other.link_id === rowId) {
        jobs.push(sb.from('subtasks').update({ link_id: null }).eq('id', other.id));
      }
    } else {
      jobs.push(sb.from('links').delete().eq('id', peer.linkId));
    }
    const res = await Promise.all(jobs);
    const bad = res.find((r) => r.error);
    if (bad) { toast('没解开：' + schemaWarn(bad.error), true); return; }
    await refresh();
    toast('解开了，两边各自算各自的');
  }

  /* 删掉一条东西（小任务 / 章节 / 目标）时，把挂着它的关联一起清掉。
     没有外键约束，所以这几句得前端来（见 setup-9-links.sql 的已知限制）。
     按 a_id / b_id 各删一次：id 是 uuid，两种 kind 之间不会撞。 */
  function dropLinksOf(id) {
    if (S.lkNoTable) return Promise.resolve();
    return Promise.all([
      sb.from('links').delete().eq('a_id', id),
      sb.from('links').delete().eq('b_id', id),
    ]).then(() => {}, () => {});
  }

  /* 一行底下那条「↔ 同一件事」：已经挂着的每条一个 chip（点一下解开），
     右边一个「＋ 关联…」的下拉。没有候选、也没挂着东西时整条不出现。 */
  function linkBar(kind, row) {
    const peers = peersOf(kind, row.id);
    const choices = linkChoices(kind, row);
    if (!peers.length && !choices.length) return null;
    const box = h('div', { class: 'lks' },
      h('span', { class: 'lks-h', text: '↔ 同一件事' }));
    for (const p of peers) {
      box.appendChild(h('span', {
        class: 'lk',
        title: '点一下解开：' + itemLabel(p.kind, p.id)
          + (p.legacy ? '（这是旧的一对一绑定，点掉就清了）' : ''),
        text: itemLabel(p.kind, p.id),
        onclick: () => dropLink(kind, row.id, p),
      }));
    }
    if (choices.length) {
      box.appendChild(h('select', {
        class: 'tiny link',
        title: '再关联一条。可以挂好几条：一步 = 两本书的那几章，或者 = 某个 30 天小目标。'
             + '同一圈的会一起算完成',
        onchange: async (e) => {
          const v = e.target.value;
          e.target.value = '';                 // 选完就弹回「＋ 关联…」，方便接着挂下一条
          if (!v) return;
          /* 值是 'kind:uuid'。形状不对（老的浏览器缓存、别人拼的）就直接不理，
             否则会拿半截字符串当 id 往库里写一行垃圾。 */
          const i = v.indexOf(':');
          const k = v.slice(0, i), id = v.slice(i + 1);
          if (i < 0 || (k !== 'subtask' && k !== 'goal') || !itemOf(k, id)) {
            toast('这一条已经不在了，刷新一下再关联', true);
            return;
          }
          await addLink(kind, row, { kind: k, id: id });
        },
      }, [h('option', { value: '', text: '＋ 关联…', selected: true })].concat(
        choices.map((c) => h('option', { value: c.key, text: '↔ ' + c.label }))
      )));
    }
    return box;
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
    /* 都过一遍 live()：还在「5 秒撤回窗口」里的行不能因为一次刷新又冒回来 */
    S.goals     = live(res[1].data);
    S.tasks     = live(res[2].data);
    S.subtasks  = live(res[3].data);
    S.daily     = live(res[4].data);
    S.resources = live(res[5].data);
    /* 倒计时的 due_date 搭 goals 这条车就回来了，不用多发一次请求：
       列在的话 select('*') 会把 due_date 带出来（值是 null 也带 key）。
       一行目标都没有时判断不了 —— 那就等真去写的时候报错再说（schemaWarn）。 */
    S.cdNoCol = S.goals.length > 0 && !S.goals.some((g) => 'due_date' in g);
    await loadPriorityCol();    // 同上，但这一列是加分项，探测一次更准（见函数注释）
    await loadExams();          // 单独一条，失败不影响上面任何一张表
    await loadMottos();         // 同上：校训表没建也不能连累谁
    await loadLinks();          // 同上：关联表没建就退回旧的一对一
    await loadSite();           // 同上：站名表没建就退回写死的默认名
    /* 池子换成库里的那份之后要重画一次 —— showApp() 里那次抽签发生在
       loadAll 之前，抽的是兜底清单；不在这儿补一刀的话，
       库里明明有校训，页面却一直显示内置那条。
       pickMotto() 在「池子里还有当前这条」时不会换，所以反复刷也稳定。 */
    pickMotto();
  }

  /* priority 这一列在不在（setup-11-priority.sql 跑没跑）。
     单独去问一次，不靠「行里带不带这个 key」猜 —— goals 一行都没有时猜不出来，
     而那种情况恰恰是第一次用、最需要知道那个下拉该不该出现的时候。
     列不存在时这里只报一次错，不连累别的表（跟 loadExams 一个路子）。
     不确定的时候宁可**不显示**下拉：显示了、她选完、插入却整个失败，
     那就成了「因为标了个优先级，任务反而加不上了」。 */
  async function loadPriorityCol() {
    const r = await sb.from('goals').select('priority').limit(1);
    S.priNoCol = !!r.error;
  }

  /* 考试成绩**不能塞进上面那个 Promise.all** —— 那个数组里任何一条报错，
     整个 loadAll 就抛，六张表一起读不出来。setup-6-exams.sql 还没跑时
     exams 表不存在（PostgREST 报 schema cache 找不到），这时：
     其余页面照常用，只把 exNoTable 置位，「考试成绩」那一页明说去跑脚本。 */
  async function loadExams() {
    const r = await sb.from('exams').select('*').order('exam_date', { ascending: false });
    if (r.error) {
      S.exNoTable = true;
      S.exams = [];
      return false;
    }
    S.exNoTable = false;
    S.exams = live(r.data);      // 同上：撤回窗口里删掉的考试不能刷新一下又回来
    return true;
  }

  /* 校训也是**单独一条**，同理不能进 loadAll 那个 Promise.all。
     表没建时退回内置的 MWORDS —— 登录页照样有校训可看，只是改不了。
     注意 `??` 不是 `||`：库里真的空表时也要老实显示空（让管理卡片去提示加一条），
     不能因为读到 [] 就假装没读到、把兜底那 39 条又贴回去。 */
  async function loadMottos() {
    const r = await sb.from('mottos').select('*').order('sort', { ascending: true });
    if (r.error) {
      S.mtNoTable = true;
      S.mottos = [];
      return false;
    }
    S.mtNoTable = false;
    S.mottos = r.data || [];
    return true;
  }

  /* 关联表（多对多）也是单独一条，理由同上：setup-9-links.sql 没跑过时
     links 表不存在，不能让整页跟着读不出来。
     没建表时 lkNoTable 置位 → 页面退回旧的「一对一」那套（link_id 那一列），
     一行数据都不丢；只是挂不了第二条，并且明说去跑哪个脚本。 */
  async function loadLinks() {
    const r = await sb.from('links').select('*');
    if (r.error) {
      S.lkNoTable = true;
      S.links = [];
      return false;
    }
    S.lkNoTable = false;
    S.links = r.data || [];
    return true;
  }

  /* 站名也是**单独一条**，理由同上：setup-10-site.sql 没跑过时 site 表不存在，
     不能让整页跟着读不出来。表没建时退回「本机记住的上次那个 / 默认名」，
     页面上明说去跑脚本，其余功能一概不受影响。
     limit(1)：这张表物理上只有一行（主键恒为 true + check 约束），
     写 limit 是为了万一有人在 SQL 里硬塞进来第二行时，页面拿到的仍是确定的一条。 */
  async function loadSite() {
    const r = await sb.from('site').select('*').limit(1);
    if (r.error) {
      S.stNoTable = true;
      S.siteTitle = cachedTitle() || DEFAULT_TITLE;
      applyTitle();
      return false;
    }
    S.stNoTable = false;
    const row = (r.data || [])[0];
    S.siteTitle = (row && row.title) ? row.title : DEFAULT_TITLE;
    cacheTitle(S.siteTitle);
    applyTitle();
    return true;
  }

  /* ── 站名：本机记住一份 ──────────────────────────────────────
     为什么需要这个：登录页那两个 h1 在**登录之前**就要显示名字，
     而库里的名字要登录后才读得到（RLS 只给登录的人读）。
     不记的话，每次打开页面都先从 Alano 闪一下再变成自己的名字。
     localStorage 不是哪都有（隐私模式会抛、Node 里跑测试根本没有），
     所以一律 try/catch 兜住：取不到就当没记过，不影响用。 */
  const TITLE_KEY = 'study-collab:title';
  function cachedTitle() {
    try { return localStorage.getItem(TITLE_KEY) || ''; } catch (e) { return ''; }
  }
  function cacheTitle(v) {
    try { localStorage.setItem(TITLE_KEY, v); } catch (e) { /* 记不住就算了 */ }
  }

  /* 一次刷三处：浏览器标签页标题、登录页那个 h1、页头那个 h1。
     两个 h1 显示的是**同一个名字** —— 各写各的会让同一屏里两个名字打架。 */
  function applyTitle() {
    const t = S.siteTitle || DEFAULT_TITLE;
    document.title = t;
    const a = $('lg-title');
    const b = $('home-title');
    if (a) a.textContent = t;
    if (b) b.textContent = t;
  }

  /* 显示用的那一份：库里有就用库里的，没有就用兜底清单。
     两个地方（登录页、主页）显示的是**同一条** —— 每次渲染抽一次，
     不各抽各的，否则一个小页面里两句话对不上，看着像出了 bug。 */
  function mottoPool() {
    if (S.mottos.length) {
      return S.mottos.map((m) => ({ id: m.id, school: m.school || '', text: m.text || '' }))
                     .filter((m) => m.text);
    }
    return MWORDS.map((p) => ({ id: '', school: p[0], text: p[1] }));
  }

  /* 一条的显示格式：「博学而笃志，切问而近思」 · 复旦大学
     摘抄走同一个格式，出处那格写书名 / 作者就行。
     **不加「类型」字段**（校训 / 摘抄）：显示上本来就分得开（学校名 vs 书名），
     多一列只会多一个填错的入口。
     出处可以空着（她只想加一句话也行），那就只显示引号里那句。 */
  const mottoText = (m) => '「' + m.text + '」' + (m.school ? ' · ' + m.school : '');

  /* 抽一条来显示。**不是每次渲染都重抽** —— renderCurrent() 每改一个字段都会被调，
     每次重抽的话页面上的校训会跟着她点哪儿乱跳，像出了 bug。
     只在三种情况下换：① 第一次（还没抽过）；② 池子变了（兜底 → 库里的，
       且库里没有当前这条）；③ 她明确点了「换一条」。 */
  function pickMotto(force) {
    const pool = mottoPool();
    if (!pool.length) {
      S.mtNow = null;
    } else if (force || !S.mtNow || !pool.some((m) => m.text === S.mtNow.text && m.school === S.mtNow.school)) {
      S.mtNow = pool[Math.floor(Math.random() * pool.length)];
    }
    paintMotto();
  }

  /* 登录页和主页显示的是**同一条**，一次刷两处 —— 各抽各的会让同一屏里两句话打架 */
  function paintMotto() {
    const txt = S.mtNow ? mottoText(S.mtNow) : '';
    const a = $('lg-motto');
    const b = $('home-motto');
    if (a) a.textContent = txt;
    if (b) b.textContent = txt;
  }

  async function refresh() {
    try {
      await loadAll();
      /* 页头那个头像圆不在任何一个页签里，renderCurrent() 管不到它 ——
         得在这里单独画一次，否则对方在另一台设备改了头像 / 名字，这边
         刷新之后页头还是旧的（改名那条路自己也画了一次，这里是兜底）。 */
      paintMeAvatar();
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
    /* 列不存在时 PostgREST 说的是 "Could not find the 'due_date' column of 'goals' …" */
    if (/due_date/i.test(m)) {
      return '库里还没有「截止日」这一列。去 Supabase 后台跑一次 study/setup-7-countdown.sql 再回来。';
    }
    /* 表整个不存在时 PostgREST 说的是 "Could not find the table 'public.exams'
       in the schema cache" —— 别把原文甩给她。 */
    if (/exams/i.test(m) && /(schema cache|does not exist|relation|not find)/i.test(m)) {
      return '库里还没有考试成绩这张表。去 Supabase 后台跑一次 study/setup-6-exams.sql 再回来。';
    }
    if (/mottos/i.test(m) && /(schema cache|does not exist|relation|not find)/i.test(m)) {
      return '库里还没有校训这张表。去 Supabase 后台跑一次 study/setup-8-mottos.sql 再回来。';
    }
    /* links 表整个不存在时 PostgREST 说的是 "Could not find the table 'public.links'
       in the schema cache" —— 翻译成去跑哪个脚本 */
    if (/links/i.test(m) && /(schema cache|does not exist|relation|not find)/i.test(m)) {
      return '库里还没有「同一件事」这张关联表。去 Supabase 后台跑一次 study/setup-9-links.sql，'
           + '在那之前只能一条对一条地绑。';
    }
    /* 名字长度那道闸门（site_title_len）没过。页面上 maxlength=24 已经拦了一道，
       这里管的是「从别处塞进来的超长名字」—— 说清楚是长度问题，别甩约束名给她。
       ⚠️ 这条必须排在下面那条「表不存在」**前面**：约束报错的原话是
       `new row for relation "site" violates check constraint "site_title_len"`，
       里面既有 relation 又有带引号的 site，会被「表还没建」那条整条吃掉。 */
    if (/site_title_len/i.test(m)) {
      return '这个名字存不下：要 1~' + TITLE_MAX + ' 个字（现在太短、太长、或者全是空格）。';
    }
    if (/\bsite\b/i.test(m) && /(schema cache|does not exist|relation|not find)/i.test(m)) {
      return '库里还没有站名这张表。去 Supabase 后台跑一次 study/setup-10-site.sql 再回来。';
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
      /* 同一圈里的 subtask 跟着一起变，done_at 用**同一个时刻** ——
         它们是同一件事，时间戳一样才不会被算成两天。
         传的是**整圈**（见 linkedGroup），不是只传一跳：只传一跳会留下
         「两章都等于同一步，却互相不一致」的怪状态。
         写完就停：这里直接写库、不调 setDone()，所以不会再触发下一轮传播。
         30 天小目标不跟着变 —— 它有自己的进度计数，勾一步就宣布一个 30 天目标
         完成太越权了，她自己去「月度任务」那一页标。
         对家写失败不推翻这次的结果（主那条已经成了），刷新之后两边不一致
         她一眼能看见，再勾一下就好。 */
      const peers = linkedGroup('subtask', id)
        .filter((g) => g.kind === 'subtask' && g.item.id !== id)
        .map((g) => g.item);
      if (!peers.length) return r;
      /* 内存里也先跟上：调用方（勾选框）用的是 quiet()，成功时**不刷新**、
         直接重画。不先改这里的话，勾了书的一章，大任务那一步的勾选框
         要等下一次刷新才亮起来 —— 看着像没联动。 */
      peers.forEach((y) => { y.done = done; y.done_at = full.done_at; });
      return Promise.all(peers.map((y) => sb.from('subtasks').update(full).eq('id', y.id)))
        .then(() => r, () => r);
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

  /* ── 页签一：月度任务（倒计时 + 月度任务视图）────────────────
     这一页就是两块：「几月几号要完成什么」（倒计时）和「这个月做了什么」（日历）。
     2026-09-26 她要求「30 天小目标这一栏不再保留」，于是原来折在最底下那份
     备忘录（renderGoalMemo）连同新建表单一起撤了。
     ⚠️ **只撤了界面，库里的 goals 行一条没删**（没有 due_date 的那些）。
     导出快照里还在，主页动态流里「完成了 30 天目标」那些历史条目也还在。 */
  function renderGoals() {
    renderCountdown();
    renderMonth();
  }

  /* ── 倒计时：几月几号要完成什么 ──────────────────────────────
     数据就是 goals 表里 due_date 非空的行（不新开表，见 setup-7-countdown.sql）。
     没跑那个 SQL 时 S.cdNoCol 为真 —— 只提示、不假装能存。
     排序刻意分两段：未完成的按截止日**从近到远**在最上面（要盯的先看到），
     已完成的按完成时间倒序跟在后面（最近的战果在上），中间加一条分隔线。
     未完成的不显示进度条 —— 倒计时任务的「进度」永远是 0/1，画出来是噪音。 */
  function renderCountdown() {
    const warn = $('cd-warn');
    warn.hidden = !S.cdNoCol;
    if (S.cdNoCol) {
      warn.textContent = '库里还没有「截止日」这一列（due_date）。去 Supabase 后台 → SQL Editor，'
        + '跑一次 study/setup-7-countdown.sql，再回来点「刷新」。在那之前这一页存不了倒计时。';
    }
    if (!$('cd-due').value) $('cd-due').value = addDays(today(), 7);
    $('cd-pri').hidden = S.priNoCol;

    const all = S.goals.filter((g) => g.due_date);
    const open = all.filter((g) => !g.done);
    const shut = all.filter((g) => g.done);

    // 一句话总览：最近那个截止日是哪天、还剩几天
    if (!all.length) {
      $('cd-sub').textContent = '还没有倒计时任务。写上「几月几号要完成什么」，'
        + '它会自动出现在上面的月历格子里（标「截」），也会按剩余天数排在最前面。';
    } else if (!open.length) {
      $('cd-sub').textContent = '当前 ' + shut.length + ' 件事全部完成，没有待办的截止日。'
        + '再加一件就在下面。';
    } else {
      /* 排最前的那条未必是「未来最近的」，也可能是已经欠着的 ——
         所以说的是「最急」而不是「最近」。 */
      const next = open.slice().sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
      const n = daysFromToday(next.due_date);
      $('cd-sub').textContent = '待办 ' + open.length + ' 件，最急的是「'
        + (next.title || '(无标题)') + '」——' + dateText(next.due_date) + '，'
        + cdLeftText(n) + '。'
        + (shut.length ? '已经完成 ' + shut.length + ' 件。' : '');
    }

    twoCols($('cd-cols'), all, (owner, list, mine) => {
      if (!list.length) {
        return emptyNote(mine
          ? '你还没有倒计时任务，上面加一个（填标题 + 截止日就行）。'
          : '对方还没添加倒计时任务。');
      }
      const wrap = h('div');
      for (const g of cdBuckets(list)) {
        wrap.appendChild(cdSection(g, mine));
      }
      const done = list.filter((g) => g.done)
        .sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
      if (done.length) wrap.appendChild(cdDoneFold(done, mine));
      return wrap;
    });
  }

  /* 有待办的分成三段：今天（含逾期的）/ 本周（7 天内）/ 以后。
     逾期的不单独开一段 —— 它最急，就该顶在「今天」的最上面（排序按截止日升序，
     逾期的日子最小，自然排最前），旁边挂个红药丸说清楚已经欠了几天。
     「以后」这段是必须的：只分三段的话，8 天以后的任务会从列表里凭空消失。 */
  const CD_BUCKETS = [
    { key: 'today', label: '今天', max: 0 },
    { key: 'week',  label: '本周', max: 7 },
    { key: 'later', label: '以后', max: Infinity },
  ];
  function cdBuckets(list) {
    const todo = list.filter((g) => !g.done)
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    return CD_BUCKETS.map((b) => Object.assign({}, b, { list: [] }))
      .map((b, i, arr) => {
        const lo = i === 0 ? -Infinity : arr[i - 1].max + 1;
        b.list = todo.filter((g) => {
          const n = daysFromToday(g.due_date);
          return n >= lo && n <= b.max;
        });
        return b;
      })
      .filter((b) => b.list.length);
  }

  function cdSection(b, mine) {
    return h('div', { class: 'cd-group' },
      h('div', { class: 'cd-head' },
        h('span', { class: 'cd-name', text: b.label }),
        h('span', { class: 'cd-n', text: b.list.length + ' 件' })
      ),
      b.list.map((g) => cdRow(g, mine))
    );
  }

  /* 完成区默认收起 —— 完成的事是「存档」，天天摊在眼前就是噪音。
     用 <details> 不是自己写开关：键盘、读屏、点击热区这些浏览器都替我们做了。 */
  function cdDoneFold(list, mine) {
    return h('details', { class: 'cd-fold' },
      h('summary', { text: '已完成 ' + list.length + ' 件' }),
      h('div', { class: 'cd-fold-body' }, list.map((g) => cdRow(g, mine, true)))
    );
  }

  const PRI_LABEL = { hi: '高', mid: '中', lo: '低' };

  /* ── 卡片上就地改一个字段（倒计时 / 大任务 / 小任务共用）──────────
     点一下就能改、改完点别处自动存，没有「保存」按钮那一道中转。
     rec：那条记录。**先改本地再写库** —— 写失败时 quiet() 会 refresh 把真值
       拉回来，不会留下「界面上改了、库里没改」的假象。
     redraw：存成功后要不要重画。决定分组 / 排序 / 分区 / 色条的字段要重画；
       别的不要 —— 重画会把光标从输入框里踢出去，接着打字就打到空气里。
     emptyMsg：空值时弹这句并且不写库；传 null 表示这个字段允许空着。
       空值那一支是**把框里的值写回原值**，不是重画 —— 重画会把光标踢出去，
       而这里她十有八九是手滑清空了、正要接着改；把旧值还回去就够了。 */
  /* 三个键位（行内编辑的标配，少一个都会让人卡住）：
     Enter = 存；Esc = 还原；Tab = 浏览器默认的「跳到下一个可聚焦元素」——
     跳走时也会补一个 change，所以 Tab 那一支不用自己写。
     前两个都靠 blur() 收尾：change 只在「值跟聚焦时不一样」时才发，
     所以 Esc 把原值写回去再 blur，库里一次请求都不会发（不是「发了再撤回」）。 */
  const editKeys = (rec, key) => (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { e.target.value = rec[key] || ''; e.target.blur(); }
  };

  function inlineText(rec, table, key, placeholder, redraw, emptyMsg) {
    return h('input', {
      class: 'inline', type: 'text', value: rec[key] || '', placeholder: placeholder,
      title: '点一下就能改，改完点别处自动存；Enter 存，Esc 还原',
      onkeydown: editKeys(rec, key),
      onchange: (e) => {
        const v = e.target.value.trim();
        if (!v && emptyMsg) {
          toast(emptyMsg, true);
          e.target.value = rec[key] || '';   // 不留一个空格在那儿当她的「新标题」
          return;
        }
        if (v === (rec[key] || '')) return;
        Object.assign(rec, { [key]: v });
        quiet(sb.from(table).update({ [key]: v }).eq('id', rec.id)).then((done) => {
          if (!done) return;              // 失败时 quiet 已经报了错、还把真值拉了回来
          if (redraw) redraw();
          toast('已保存');                 // 就地改没有「保存」那一下，不说一声她不知道存上没有
        });
      },
    });
  }

  /* 日期那一路。空值**不写库** —— date 框被清空时 value 是 ''，
     存进去这一条就落到「今天」那一段里骗人；真库那一列也未必允许空。 */
  function inlineDate(rec, table, key, redraw) {
    return h('input', {
      class: 'inline', type: 'date', value: rec[key] || '',
      title: '点一下改日期，会自动换到对应那一段；Enter 存，Esc 还原',
      onkeydown: editKeys(rec, key),
      onchange: (e) => {
        const v = e.target.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast('得选一个日期', true); if (redraw) redraw(); return; }
        if (v === rec[key]) return;
        Object.assign(rec, { [key]: v });
        quiet(sb.from(table).update({ [key]: v }).eq('id', rec.id)).then((done) => {
          if (!done) return;
          if (redraw) redraw();
          toast('已保存');
        });
      },
    });
  }

  /* 一行倒计时。**就地可改**：标题、说明、截止日本身就是输入框，优先级是下拉，
     点一下改、点别处自动存 —— 跟学习资源那张卡是同一套（见 resRow），
     不再有「点『改』→ 滚回上面找表单」那一道中转。 */
  function cdRow(g, mine, isDone) {
    const n = daysFromToday(g.due_date);

    /* 标题 / 说明的大小写就两处：标题决定这条排在哪一段、空着不行；
       说明允许空着、也不影响位置（见 inlineText 上面那段注释）。 */
    const textLine = (key, placeholder, needRedraw) =>
      inlineText(g, 'goals', key, placeholder, needRedraw ? renderCountdown : null,
                 key === 'title' ? '标题不能空着' : null);
    /* 截止日：换一天就可能换一段（今天 → 本周 → 以后），必须重画 */
    const dueLine = mine ? inlineDate(g, 'goals', 'due_date', renderCountdown) : null;

    /* 优先级不是文本字段，单独走这里：先改本地 → 写库 → 重画（色条要立刻出来）。 */
    const patch = (fields, needRedraw) => {
      Object.assign(g, fields);
      quiet(sb.from('goals').update(fields).eq('id', g.id)).then((done) => {
        if (!done) return;              // 失败时 quiet 已经报了错、还把真值拉了回来
        if (needRedraw) renderCountdown();
        toast('已保存');
      });
    };

    /* 优先级列还没建时（setup-11 没跑）不给下拉 —— 给了也是一写就报错。
       S.priNoCol 跟 cdNoCol 一样，是「列在不在」的判断，不是「值有没有」。 */
    const priOpts = [h('option', { value: '', text: '不标', selected: !g.priority })]
      .concat(Object.keys(PRI_LABEL).map((k) =>
        h('option', { value: k, text: PRI_LABEL[k], selected: g.priority === k })));

    return h('div', {
      class: 'item'
        + (isDone ? ' done' : '')
        + (g.priority && PRI_LABEL[g.priority] ? ' pri pri-' + g.priority : ''),
    },
      h('div', { class: 't' },
        mine ? textLine('title', '要完成什么', false)
             : h('span', { class: 'grow', text: g.title }),
        isDone ? h('span', { class: 'pill ok', text: '已完成' }) : cdPill(n)
      ),
      mine ? textLine('detail', '说明（可选）', false)
           : (g.detail ? h('div', { class: 'd', text: g.detail }) : null),
      h('div', { class: 'bar-txt' },
        /* 自己这一栏的截止日就是那个能改的日期框，不再多印一遍同样的日期；
           对方那栏是只读文本。 */
        mine ? h('span', { class: 'cd-due' }, h('span', { text: '截止' }), dueLine)
             : h('span', { text: '截止 ' + dateText(g.due_date)
                 + (isDone && g.done_at ? '，' + isoDate(g.done_at) + ' 完成' : '') }),
        mine && isDone && g.done_at ? h('span', { text: isoDate(g.done_at) + ' 完成' }) : null
      ),
      mine && !S.priNoCol ? h('div', { class: 'm two' },
        h('span', { text: '优先级' }),
        h('select', {
          class: 'pri-sel', style: { maxWidth: '84px' },
          /* 必须重画：优先级的反馈是**卡片左边那条色条**，而色条是在渲染时定到
             class 上的 —— 不重画的话她选完看不到任何变化，会以为没生效。
             （说明字段不重画是因为它自己那个框里已经显示新值了。）
             select 的 change 本来就意味着她选完了，重画不算打断。 */
          onchange: (e) => patch({ priority: e.target.value }, true),
        }, priOpts)
      ) : null,
      mine ? h('div', { class: 'acts' },
        isDone ? h('button', {
            class: 'tiny', text: '取消完成',
            onclick: () => commit(setDone('goals', g.id, false), '已取消完成标记'),
          })
          : h('button', {
            class: 'tiny', text: '完成',
            onclick: () => commit(
              setDone('goals', g.id, true, { progress: g.target || 1 }),
              '完成了倒计时任务「' + (g.title || '') + '」'),
          }),
        h('button', {
          class: 'tiny danger', text: '删除',
          onclick: () => removeRow('goals', g.id, '倒计时任务「' + g.title + '」'),
        })
      ) : null
    );
  }

  /* 还剩几天 —— 说人话，不说「剩余 0 天」这种要翻译的句子 */
  function cdLeftText(n) {
    if (n > 1) return '还剩 ' + n + ' 天';
    if (n === 1) return '明天到期';
    if (n === 0) return '今天到期';
    if (n === -1) return '昨天到期';
    return '已过期 ' + (-n) + ' 天';
  }

  /* 日期状态的药丸。颜色只是辅助 —— 药丸里永远带着话，色觉障碍下也读得出。
     warning 那档特意用「黄边 + 主文字色」而不是黄字：黄字在浅色底上对比度不够。 */
  function cdPill(n) {
    const cls = n <= 1 ? 'pill bad' : n <= 3 ? 'pill warn' : 'pill';
    return h('span', { class: cls, text: cdLeftText(n) });
  }

  /* 加一条倒计时。goals 表的 period_start 是 not null，这儿拿今天占位 ——
     页面不显示它（那是 30 天小目标周期用的），只是为了满足约束。 */
  /* 把上面那张表单清回「新建」的样子。
     它现在只管新建 —— 改是在卡片上就地改的（见 cdRow），没有编辑态。 */
  function resetCdForm() {
    $('cd-title').value = '';
    $('cd-detail').value = '';
    $('cd-due').value = addDays(today(), 7);
    $('cd-pri').value = '';
  }

  async function addCountdown() {
    const title = $('cd-title').value.trim();
    if (!title) { toast('先写要完成什么', true); $('cd-title').focus(); return; }
    const due = $('cd-due').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { toast('选一个截止日', true); return; }
    const detail = $('cd-detail').value.trim();

    /* period_start 是 not null，拿今天占位；页面不显示它（那是 30 天小目标周期用的）。
       priority 只在那一列真的存在时才带 —— 没跑 setup-11 就写它，整条插入会失败，
       变成「因为选了个优先级，任务都加不上了」，那不合理。 */
    const fields = {
      title: title, detail: detail, due_date: due,
      period_start: today(), target: 1, progress: 0, done: false,
    };
    if (!S.priNoCol && $('cd-pri').value) fields.priority = $('cd-pri').value;

    const r = await sb.from('goals').insert(Object.assign({ owner: S.me.id }, fields));

    if (r.error) {
      if (/due_date/i.test(r.error.message)) S.cdNoCol = true;   // 下次刷新前就知道列没建
      if (/priority/i.test(r.error.message)) S.priNoCol = true;
      toast(schemaWarn(r.error), true);
      renderCountdown();
      return;
    }
    resetCdForm();
    toast('加上了，' + dateText(due) + '截止');
    await refresh();
    /* 光标送回标题框：连着录十条能一路敲下去，不用每条都去够一次鼠标。
       滚动位置不用管 —— 这里本来就不滚（新建是往列表里插一行）。 */
    $('cd-title').focus();
  }

  /* ── 月度任务视图 ──────────────────────────────────────────── */
  const MO_WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /* 一格一天。这一页不只看目标：其他表在当月更新的东西都同步到这儿。
     格子深浅 + 右下角数字 = 那天**完成**了几件事（小任务 + 目标）；
     左上角下面一行 = 那天考的试（「考108」/「考」/「考×2」）；
     右上角小表情 = 那天记了心情；
     右下角「截」= 那天有**还没完成**的倒计时任务到期。
     「推进未完成」、加的学习资源、当天写的那两句，不占格子（放不下），
     但悬停明细和下面的表格视图里一条不少。
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

    let nSub = 0, nGoal = 0, nLog = 0, nActive = 0;
    let nPush = 0, nExam = 0, nRes = 0, nScored = 0, scGot = 0, scFull = 0, nDue = 0;
    const grid = $('mo-grid');
    clear(grid);

    for (let i = 0; i < cells; i++) {
      const day = i - lead + 1;
      if (day < 1 || day > dim) { grid.appendChild(h('div', { class: 'mo-d blank' })); continue; }

      const key = S.month + '-' + pad(day);
      const e = stats[key];
      const n = dayCount(e);
      if (dayActive(e)) nActive++;
      if (e) {
        nSub += e.subs.length;
        nGoal += e.goals.length;
        nPush += e.pushes.length;
        nRes += e.res.length;
        nDue += e.due.length;
        if (e.log) nLog++;
        for (const ex of e.exams) {
          nExam++;
          // 平均分只算「得分和满分都填了」的场 —— 缺一个就不是一个可比的数
          if (ex.score != null && ex.score !== '' && Number(ex.full_score) > 0) {
            nScored++; scGot += Number(ex.score); scFull += Number(ex.full_score);
          }
        }
      }
      const lv = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : 3;

      // 悬停看明细 —— 格子上放不下，但这么小的格子必须能查到底做了什么
      const bits = [];
      if (e) {
        e.goals.forEach((g) => bits.push('完成目标：' + (g.title || '(无标题)')));
        e.subs.forEach((x) => {
          bits.push('完成：' + (x.title || '(未填写)') + ' —— ' + parentLabel(x));
        });
        e.pushes.forEach((x) => {
          bits.push('推进未完成：' + (x.title || '(未填写)') + ' —— ' + parentLabel(x));
        });
        e.exams.forEach((ex) => bits.push('考试：' + examLine(ex)));
        e.due.forEach((g) => bits.push('截止：' + (g.title || '(无标题)')));
        e.res.forEach((r) => bits.push('加了资源：' + (r.name || '(未命名)') + '（' +
          (KIND_LABEL[r.kind] || '资源') + '）'));
        if (e.log) {
          bits.push('心情 ' + (MOODS[e.log.mood - 1] || '—') +
                    (e.log.difficulty ? '：' + e.log.difficulty : '') +
                    (e.log.note ? '（' + e.log.note + '）' : ''));
        }
      }

      const mark = e ? examMark(e.exams) : '';
      const dMark = e ? dueMarkEl(e.due) : null;
      grid.appendChild(h('div', {
        class: 'mo-d' + (lv ? ' lv' + lv : '') + (key === t ? ' today' : ''),
        title: key + '\n' + (bits.length ? bits.join('\n') : '这天没有记录'),
      },
        h('span', { class: 'dn', text: String(day) }),
        mark || dMark ? h('span', { class: 'drow' },
          mark ? h('span', { class: 'de', text: mark }) : null,
          dMark
        ) : null,
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

    /* 统计句：把五张表在当月的动静并成一句话。
       平均分只算有满分的场次，并写明是几场 —— 不然「平均」会被缺分的那几场稀释掉。 */
    const avgTxt = nScored > 0 ? '（有满分的 ' + nScored + ' 场，折算下来平均 ' +
      Math.round(scGot / scFull * 1000) / 10 + '%）' : '';
    $('mo-sub').textContent = '这个月完成 ' + nSub + ' 个小任务、' + nGoal + ' 个目标' +
      (nPush ? '，另有 ' + nPush + ' 步只推进未完成' : '') + '；' +
      (nExam ? '考了 ' + nExam + ' 场试' + avgTxt + '；' : '') +
      (nRes ? '加了 ' + nRes + ' 个学习资源；' : '') +
      (nDue ? '另有 ' + nDue + ' 件事在这个月到期（格子里标「截」）；' : '') +
      '有 ' + nActive + ' 天有记录，记了 ' + nLog + ' 天心情。';

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

    // 图例：深浅代表完成件数；「考」「截」是另外两路的标记，写成字符块，别混进色阶里
    const lg = $('mo-legend');
    clear(lg);
    [['无', null], ['1–2 件', 'lv1'], ['3–5 件', 'lv2'], ['6 件以上', 'lv3']].forEach(([txt, lv]) => {
      lg.appendChild(h('span', { class: 'item2' },
        h('span', { class: 'kd' + (lv ? ' ' + lv : '') }),
        h('span', { text: txt })
      ));
    });
    lg.appendChild(h('span', { class: 'item2' },
      h('span', { class: 'kd lbl', text: '考' }),
      h('span', { text: '那天有考试（格子里的「考」+ 得分）' })
    ));
    lg.appendChild(h('span', { class: 'item2' },
      h('span', { class: 'kd lbl', text: '截' }),
      h('span', { text: '那天有倒计时任务到期（未完成的才算）' })
    ));

    renderMonthTable(dim, stats);
  }

  /* 一场考试压成一行字，格子的悬停明细和表格视图共用 */
  function examLine(ex) {
    const s = ex.score;
    const has = !(s === null || s === undefined || s === '');
    const full = Number(ex.full_score) > 0 ? Number(ex.full_score) : null;
    const sc = has
      ? fmtNum(s) + (full ? ' / ' + fmtNum(full) + '（' + pct(Number(s), full) + '%）' : '')
      : '没填分';
    return (ex.name || '考试') + (ex.subject ? '（' + ex.subject + '）' : '') + '：' + sc;
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
      e.pushes.forEach((x) => {
        what.push('推进未完成：' + (x.title || '(未填写)') + ' —— ' + parentLabel(x));
      });
      e.res.forEach((r) => what.push('加了资源：' + (r.name || '(未命名)')));
      if (e.log && e.log.note) what.push('心情补充：' + e.log.note);
      rows.push([
        key,
        dayCount(e) ? String(dayCount(e)) : '—',
        e.exams.length ? e.exams.map(examLine).join('；') : '—',
        e.due.length ? e.due.map((g) => g.title || '(无标题)').join('；') : '—',
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
      h('th', { text: '日期' }), h('th', { text: '完成' }),
      h('th', { text: '考试' }), h('th', { text: '截止' }),
      h('th', { text: '心情' }), h('th', { text: '做了什么' })
    )));
    const tb = h('tbody');
    rows.forEach((r) => tb.appendChild(h('tr', null,
      h('td', { text: r[0] }), h('td', { text: r[1] }), h('td', { text: r[2] }),
      h('td', { text: r[3] }), h('td', { text: r[4] }), h('td', { text: r[5] })
    )));
    tbl.appendChild(tb);
    box.appendChild(h('div', { class: 'tblwrap' }, tbl));
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
            /* 名字 / 说明 / 截止日跟倒计时那边一样是**就地可改**的，不分「已建立的」
               和「新加的」—— 她：「大任务拆解里已经建立的任务也要变得可以编辑」。
               只有自己这一栏能改；对方那栏还是只读文本（改也只该改自己那份）。
               名字决定这条排在哪、空着不行 → 重画；说明不影响位置 → 不重画。 */
            h('div', { class: 't' },
              mine ? inlineText(t, 'tasks', 'title', '大任务叫什么', renderTasks, '大任务名不能空着')
                   : h('span', { class: 'grow', text: t.title }),
              subs.length && doneN === subs.length ? h('span', { class: 'pill ok', text: '全部完成' }) : null
            ),
            mine ? inlineText(t, 'tasks', 'detail', '说明（可选）', null, null)
                 : (t.detail ? h('div', { class: 'd', text: t.detail }) : null),
            t.due_date ? h('div', { class: 'm' },
              /* 自己这一栏的日期就是那个能改的日期框，不再多印一遍同样的日子 */
              mine ? h('span', { class: 'cd-due' }, h('span', { text: '截止' }),
                       inlineDate(t, 'tasks', 'due_date', renderTasks))
                   : h('span', { class: 'pill', text: '截止 ' + t.due_date }),
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
      /* ↔ 跟哪几条是同一件事。挂上之后勾任意一边，另外那几条跟着一起完成 ——
         书那边的章节进度条和大任务这边的步骤进度条就一起动了。
         可以挂**好几条**（一步 = 两本书的那几章，或者 = 某个 30 天小目标）。
         没有候选、也没挂着东西时整条不出现。 */
      const lk = linkBar('subtask', sub);
      if (lk) box.appendChild(lk);
      box.appendChild(h('button', {
        class: 'tiny danger', text: '✕',
        /* 问都不问，删了给 5 秒撤回 —— 跟别处的删除一个规矩。
           「这一章」还是「这一步」看它挂在谁身上（同一个渲染函数管两种）。 */
        onclick: () => removeRow('subtasks', sub.id,
          (isCh ? '章节「' : '小任务「') + (sub.title || '未命名') + '」',
          () => {
            /* links 那张表由 removeRow 里的 dropLinksOf 负责；这里管的是**反方向** ——
               对端那条 subtask 自己的 link_id 正指着即将被删掉的这一条。
               不清的话它就成了指着一个不存在 id 的孤儿，两边勾选联动会勾到空气。 */
            const twin = linkedTo(sub);
            if (twin) {
              twin.link_id = null;
              return quiet(sb.from('subtasks').update({ link_id: null }).eq('id', twin.id));
            }
          }),
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
        '所以不会出现在下面的「今天完成情况」里，「月度任务」那张日历上也看不到。' +
        '去 Supabase 后台跑一次 study/setup-3-feed.sql 就好；在那之前新记的会正常带上时间。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  /* 挂到哪。chip 分两组：大任务 / 学习资源 —— 两组各自独立，**每组里面都可以勾好几条**。
     她 2026-09-26 的要求：「可以勾选多个大任务或者学习资源，对应的大任务可以勾选对应
     做到了哪一步，也可以多选；对应的学习资源可以勾选对应多少章节，也可以多选」。
     所以**父项和子项都是多选**：
       点父项 = 这一组加上它（再点一下 = 去掉它，连同它下面勾着的子项一起清掉）
       点子项 = 这一条这次要记（再点一下 = 去掉这一条）
     右侧 n/m 是这个父下面**已经完成**几件，跟以前一样 —— 挑的时候不用来回翻页。
     用 chip 而不是下拉：通常就几个，一眼看全比展开菜单快。
     ⚠️ 子项一律**不预勾**：以前是「选中父项就自动挑第一条没完成的」，多选之后这套会
        让她按下去才发现记的不是想记的那条。现在父项勾上只是摊开子项，勾哪几条她自己点。
     ⚠️ 已经完成的子项直接 disabled，不给勾 —— 勾了也只能在按下时被跳过，
        不如一开始就让她看见「这条已经完事了」。 */
  /* 「自己写两句」那个框里现在有什么（还没存进库的也算） */
  const noteText = () => { const el = $('done-note'); return el ? el.value.trim() : ''; };

  /* 勾选里可能留着**已经不存在**的 id（对方删了、刷新换了人、父项被删连带子项没了）。
     不扫一遍的话，按钮上写着「记 3 条」，按下去只记到 2 条 —— 对不上就是骗人。 */
  const stepBag = (kind) => (kind === 'task' ? S.doneStep : S.doneCh);
  function pruneDonePick() {
    for (const kind of ['task', 'res']) {
      const rows = (kind === 'task' ? S.tasks : S.resources).filter(isMine);
      for (const id of Object.keys(S.donePick[kind])) {
        if (!rows.some((r) => r.id === id)) delete S.donePick[kind][id];
      }
    }
    const alive = {};
    for (const x of S.subtasks) alive[x.id] = true;
    for (const bag of [S.doneStep, S.doneCh]) {
      for (const id of Object.keys(bag)) if (!alive[id]) delete bag[id];
    }
  }
  /* 记完 / 整组去掉之后清干净。不清的话大任务那几步 done 还是 false，
     留着 ☑ 再按一下会把同一笔记第二遍。 */
  function clearDonePick() {
    S.donePick = { task: {}, res: {} };
    S.doneStep = {};
    S.doneCh = {};
  }

  function renderDoneForm() {
    const box = $('done-picker');
    const btn = $('done-btn');
    const lead = $('done-lead');
    const plabel = $('done-picker-label');
    const tip = $('done-tip');
    clear(box);
    pruneDonePick();

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
      clearDonePick();
      box.appendChild(h('p', { class: 'hint', style: { margin: '0' },
        text: '你还没有大任务、也没有学习资源。先去「大任务拆解」或「学习资源」建一个 —— ' +
              '完成的事要挂在某样东西下面，才能同步过去。' }));
      btn.disabled = true;
      return;
    }

    for (const [kind, label, rows, subsFn] of lanes) {
      const pick = S.donePick[kind];
      const bag  = stepBag(kind);
      box.appendChild(h('div', { class: 'chips-group' },
        h('span', { class: 'cg-label', text: label }),
        h('div', { class: 'chips' },
          rows.map((r) => {
            const on   = !!pick[r.id];
            const subs = subsFn(r.id);
            const dn   = subs.filter((x) => x.done).length;
            const nSel = subs.filter((x) => bag[x.id]).length;
            return h('button', {
              type: 'button',
              class: 'chip' + (on ? ' on' : '') + (!subs.length ? ' bare' : ''),
              'aria-pressed': on ? 'true' : 'false',
              title: !subs.length ? '它下面一条都还没拆出来，先在「' + (kind === 'res' ? '学习资源' : '大任务拆解') + '」里加'
                : on ? '再点一下 = 这一组这次不记（连同下面勾着的几条）'
                : '点一下开始勾它下面的' + (kind === 'res' ? '章' : '步'),
              onclick: () => {
                if (on) {
                  delete pick[r.id];
                  /* 整组去掉时连着子项一起清 —— 只去掉父项、子项还留着 ☑ 的话，
                     按钮上的条数会跟她看到的不一致 */
                  for (const x of subs) delete bag[x.id];
                } else {
                  pick[r.id] = true;
                }
                renderDoneForm();
              },
            },
              h('span', { class: 'ck', text: on ? '☑' : '☐' }),
              h('span', { class: 'ct', text: r.title || r.name || '(无标题)' }),
              /* 这一格永远是「已完成 n / 共 m」——不跟着勾选变，免得同一个位置
                 一会儿是完成数一会儿是选中数，看的人得每次重新猜 */
              h('span', { class: 'cn', text: dn + '/' + subs.length })
            );
          })
        )
      ));
    }

    /* 勾中的父项各自摊一行子项 —— **一条父项一行**。多选之后会有好几组，
       所以父项名字要单独占一行写在前面，不然两个大任务的步混在一起分不出谁是谁。
         挂资源   = 勾哪几章（勾了就**算完成**）
         挂大任务 = 今天推进了哪几步（**只记录，不算完成**）
       两组语义故意不一样，所以按钮上会把「算不算完成」写清楚。 */
    for (const [kind, , rows, subsFn] of lanes) {
      const bag   = stepBag(kind);
      const isRes = kind === 'res';
      for (const r of rows) {
        if (!S.donePick[kind][r.id]) continue;
        const chs = subsFn(r.id);
        if (!chs.length) continue;
        box.appendChild(h('div', { class: 'sub-pick' },
          h('div', { class: 'sp-head' },
            (isRes ? '第几章 · ' : '哪一步 · '),
            h('b', { text: r.title || r.name || '(无标题)' }),
            '（可以勾好几条，再点一下取消）'),
          h('div', { class: 'chips' },
            chs.map((x) => {
              const sel = !!bag[x.id];
              return h('button', {
                type: 'button',
                class: 'chip' + (sel ? ' on' : '') + (x.done ? ' done' : ''),
                'aria-pressed': sel ? 'true' : 'false',
                disabled: x.done ? true : null,
                title: x.done ? (isRes ? '这一章已经勾过了' : '这一步已经完成了')
                              : sel ? '再点一下 = 这条这次不记' : '点一下勾上这条',
                onclick: () => {
                  if (sel) delete bag[x.id]; else bag[x.id] = true;
                  renderDoneForm();
                },
              },
                h('span', { class: 'ck', text: x.done ? '✅' : (sel ? '☑' : '☐') }),
                h('span', { class: 'ct', text: x.title || '(未填写)' })
              );
            })
          )
        ));
      }
    }

    /* 这一页没有自由文本框了。以前大任务是「写一条 → 凭空新建一条已完成的小任务」，
       会越记越长、分母越来越大，而且替她宣布了「完成」—— 她明确说不要。
       现在两种模式都是「选父项、再选其中几条」，小任务该在「大任务拆解」里拆、在那里勾。 */

    /* 把这次真正会写进库的条目先算出来，按钮上写清楚这一下会记几条、算不算完成 —— 省得她猜 */
    const plan    = [];   // 真要记的：{ kind, sub }
    const noChild = [];   // 勾了父项，但它下面一条都还没拆出来
    const noStep  = [];   // 勾了父项、也拆了条，但一条都没挑
    const allDone = [];   // 勾了父项，它下面的条**全都已经完成**了（这里没什么可记的）
    for (const [kind, , rows, subsFn] of lanes) {
      const bag = stepBag(kind);
      for (const r of rows) {
        if (!S.donePick[kind][r.id]) continue;
        const chs = subsFn(r.id);
        if (!chs.length) { noChild.push(kind); continue; }
        let picked = 0;
        for (const x of chs) {
          if (!bag[x.id] || x.done) continue;   // 已完成的勾不上（上面 disabled 了），这里再挡一道
          picked++;
          plan.push({ kind, sub: x });
        }
        /* 「没挑」和「没得挑」是两回事：全都完成了的话，让她去点子项是白指路 */
        if (!picked) (chs.every((x) => x.done) ? allDone : noStep).push(kind);
      }
    }
    const nTask = plan.filter((j) => j.kind === 'task').length;
    const nRes  = plan.filter((j) => j.kind === 'res').length;
    const has   = !!noteText();

    plabel.textContent = '这次要记什么（大任务和资源都可以勾好几条）';
    lead.textContent = '大任务、学习资源都能勾好几条；点开它，再勾它下面具体做到了哪几步 / 哪几章，' +
      '也可以一条一条换着勾。大任务那几步只记一笔「今天推进了」，不算完成；' +
      '资源那几章勾掉就算完成。下面那个文本框是写给自己看的，跟这笔记一起存。';

    if (!plan.length) {
      /* 没有任何一条能记。分三种卡住的原因，各自说清点哪儿 ——
         多选之后可能两组同时卡住，所以两种原因可以**同时**出现，得一起说出来。 */
      const both = (arr) => arr.includes('task') && arr.includes('res');
      const who  = (arr) => (both(arr) ? '大任务和资源' : arr.includes('task') ? '大任务' : '资源');
      const name = who(noStep.concat(noChild, allDone));
      if (noStep.length || noChild.length || allDone.length) {
        /* 三种原因按「最该先做的」排序说：先挑具体哪一条（最容易漏），
           再是「一条都还没拆」，最后是「全都完事了、不用再记」。 */
        btn.disabled = !has;
        btn.textContent = has ? '只记这段文字（今天）'
          : noStep.length ? '还没挑具体哪' + (name === '资源' ? '一章' : name === '大任务' ? '一步' : '一步 / 一章')
          : noChild.length ? (name === '资源' ? '这本书还没分章' : '这个大任务还没拆步')
          : '这一项已经都完事了';
        const how = noStep.length
          ? '上面勾着的「' + name + '」还没挑具体哪一条：' +
            (name === '资源' ? '去它下面点一章或多章'
              : name === '大任务' ? '去它下面点一步或多步'
              : '大任务那边点一步或多步，资源那边点一章或多章')
          : noChild.length
            ? (name === '资源' ? '先去「学习资源」里给它「＋ 分章」'
                               : '先去「大任务拆解」把它拆成几步，再回来记推进')
            : '上面勾着的「' + name + '」下面已经一条不剩了，不用再记 —— 想加新的就去它那儿加一条';
        tip.textContent = how + '。' +
          (noStep.length && noChild.length ? '（还有勾着的没拆出步骤 / 章节，这次跳过。）' : '') +
          (has ? '现在按下去只存文字。' : '');
      } else if (has) {
        btn.disabled = false;
        btn.textContent = '只记这段文字（今天）';
        tip.textContent = '就存这段字，不动任何进度条。想顺手勾一条，点上面的大任务或学习资源';
      } else {
        btn.disabled = true;
        btn.textContent = '先选一样要记的';
        tip.textContent = '点上面的大任务或学习资源；勾上之后再点它下面的步 / 章，勾几条都行';
      }
      return;
    }

    btn.disabled = false;
    const parts = [];
    if (nTask) parts.push('推进 ' + nTask + ' 步');
    if (nRes)  parts.push('勾掉 ' + nRes + ' 章');
    btn.textContent = '记下：' + parts.join(' + ') + (has ? '（连文字一起存）' : '');
    tip.textContent =
      (nTask && nRes ? '大任务那 ' + nTask + ' 步只记一笔推进（还不算完成）；这 ' + nRes + ' 章勾掉就算完成。'
       : nTask ? (nTask > 1 ? '这 ' + nTask + ' 步只记一笔「今天推进了」，进度条不动 —— 真做完了去「大任务拆解」自己勾。'
                            : '只记录今天动过它，进度条不动 —— 真做完了去「大任务拆解」自己勾。')
       : '勾完就算完成 —— 这本书的章节进度条和「月度任务」那张日历立刻跟着变。')
      + (noStep.length ? '（有几项勾着但还没挑具体哪一条，这次不会记它们。）' : '')
      + (noChild.length ? '（有几项还没拆出步骤 / 章节，这次跳过。）' : '')
      + (allDone.length ? '（有几项勾着的已经全都完事了，没有什么可记。）' : '');
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
      .filter((x) => x.done_at && isoDate(x.done_at) === t && !isLinkEcho(x))
      .map((x) => Object.assign({}, x, { __step: !x.done, __peers: peersOfSub(x) }))
      .sort((a, b) => (a.__step === b.__step ? 0 : a.__step ? 1 : -1));   // 完成的排前面
    twoCols($('done-cols'), rows, (owner, list, mine) => {
      if (!list.length) return emptyNote(mine ? '今天还没记。上面记一笔。' : '对方今天还没记。');
      const wrap = h('div');
      for (const x of list.slice(0, 60)) {
        const step = x.__step;
        /* 关联着的另外几条也标出来 —— 免得她看见书那边没反应。
           挂了好几条时（一步 = 两本书的那几章）每条一个药丸，最多列三个，
           再多折成「↔ 还有 N 条」，不然一行挤不下。 */
        const peerPills = x.__peers.slice(0, 3).map((p) => {
          const it = itemOf(p.kind, p.id);
          const isRes = p.kind === 'goal' || (!!it && parentIsRes(it));
          return h('span', {
            class: 'pill' + (isRes ? ' res' : ''),
            title: '这一条和它关联成了同一件事',
            text: '↔ ' + itemLabel(p.kind, p.id),
          });
        });
        if (x.__peers.length > 3) {
          peerPills.push(h('span', {
            class: 'pill', title: '还有几条也是同一件事',
            text: '↔ 还有 ' + (x.__peers.length - 3) + ' 条',
          }));
        }
        wrap.appendChild(
          h('div', { class: 'item' + (step ? '' : ' done') },
            h('div', { class: 't' },
              h('span', { class: 'grow', text: x.title || '(未填写)' }),
              step ? h('span', { class: 'pill', text: '今天动过' })
                   : h('span', { class: 'pill ok', text: '已完成' })
            ),
            h('div', { class: 'm' },
              h('span', { class: 'pill' + (parentIsRes(x) ? ' res' : ''), text: '→ ' + parentLabel(x) }),
              peerPills,
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

  /* 记一笔。勾了几条就**一次记几条** —— 大任务和资源可以混着勾，每组内部也能勾好几条。
     两组语义**故意不一样**，是她明确要求的：
       大任务 —— 给勾中的那几步**各盖一个今天的时间戳**，**不改完成状态**。
                 真做完了要她自己去「大任务拆解」勾（原话：
                 「不要勾选后就默认大任务的某个阶段完成了」）。
       资源   —— 把勾中的那几章勾掉，那就算完成（书就那么几章，不该越读越多）。
     一条失败就停在那里报错，不会闷声只记一半。 */
  async function addDone() {
    const btn = $('done-btn');
    const jobs = [];      // 这次要记的
    const blocked = [];   // 勾了但记不了的（刚好已经不是待办了），拿第一条告诉她
    const t = today();
    const note = noteText();   // 「自己写两句」那个框，跟这一笔记一起存

    /* 从**勾中的子项**反推父项，不单独存父项 —— 勾选状态只有一份，不会两处对不上 */
    for (const kind of ['task', 'res']) {
      const bag  = stepBag(kind);
      const rows = kind === 'task' ? S.tasks : S.resources;
      for (const id of Object.keys(S.donePick[kind])) {
        const parent = rows.find((x) => x.id === id && isMine(x));
        if (!parent) continue;      // 刚被删了，跳过（pruneDonePick 下次也会扫掉）
        const subs = kind === 'task' ? subsOfTask(parent.id) : subsOfRes(parent.id);
        for (const sub of subs) {
          if (!bag[sub.id]) continue;
          /* 渲染时已完成的 chip 是 disabled 的，正常点不到；能走到这儿说明库里
             刚被别处改成完成了（实时同步）。跳过但**说出来**，不闷声吞掉。 */
          if (sub.done) {
            blocked.push('「' + (sub.title || (kind === 'res' ? '这一章' : '这一步')) + '」已经完成了，不用再记');
            continue;
          }
          jobs.push({ kind, sub });
        }
      }
    }

    /* 光写字、什么都没勾也是合法的一次记录 —— 只存文字，不动任何进度条 */
    if (!jobs.length && !note) {
      toast(blocked.length ? blocked[0] : '先在上面勾一样要记的，或者写两句也行', true);
      return;
    }

    btn.disabled = true;
    let failed = null;
    for (const j of jobs) {
      const { error } = j.kind === 'res'
        ? await setDone('subtasks', j.sub.id, true)
        : await stampStep(j.sub.id);
      if (error) { failed = { j, error }; break; }
    }

    /* 记完（或中途出错）都把勾清掉：大任务那几步 done 还是 false，留着 ☑ 再按一下
       会把同一笔记第二遍；资源那几章 refresh 之后会显示成已完成，也不该还勾着。 */
    clearDonePick();
    if (failed) {
      btn.disabled = false;
      toast('没记上：' + (failed.j.kind === 'res' ? schemaWarn(failed.error) : failed.error.message), true);
      await refresh();
      return;
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

    /* 条数按**实际记成的**说 —— 勾了 5 条、其中 1 条轮不到，就说 4 条，不把跳过的那条算进去 */
    const nRes  = jobs.filter((j) => j.kind === 'res').length;
    const nTask = jobs.length - nRes;
    const bits = [];
    if (nTask) bits.push('今天推进了 ' + nTask + ' 步（还没算完成）');
    if (nRes)  bits.push('勾掉了 ' + nRes + ' 章（算完成）');
    if (noteSaved) bits.push('存下了你写的两句话');
    const tied = jobs.filter((j) => peersOfSub(j.sub).length).length;
    toast((bits.length ? '记下了：' + bits.join('，') + '。' : '这段字今天本来就在库里，没重复存。') +
      (nTask ? (nTask > 1 ? ' 那 ' + nTask + ' 步在「大任务拆解」里都还是待办，真做完了自己去勾。'
                          : ' 那一步在「大任务拆解」里还是待办，真做完了自己去勾。') : '') +
      (tied ? ' 它关联着的那几条也跟着变了。' : '') +
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
  /* 一栏里的资源摆成「学科 → 类型」两层。资源攒到十几本之后平铺着看，
     想找「数学那几本」得一行行扫过去；分两层之后一眼就知道哪一科堆了多少。
     **口径跟上面那张宏观图是同一份**（都是 subject 分组、组内按 kind 细分），
     免得图和列表各说各的。 */
  function resGroups(rows) {
    const bySub = new Map();
    for (const r of rows) {
      const key = (r.subject || '').trim() || '未分类';
      if (!bySub.has(key)) bySub.set(key, []);
      bySub.get(key).push(r);
    }
    const groups = [...bySub.entries()].map(([name, list]) => {
      const byKind = KINDS
        .map((k) => ({ kind: k, list: list.filter((r) => r.kind === k.key) }))
        .filter((g) => g.list.length);
      /* 库里 kind 是脏值的行不能凭空消失 —— 兜进一个「其他」小组 */
      const rest = list.filter((r) => !KIND_LABEL[r.kind]);
      if (rest.length) byKind.push({ kind: { key: 'other', label: '其他', varName: '--muted' }, list: rest });
      return { name, byKind, n: list.length };
    });
    /* 「未分类」永远排最后 —— 没填学科的那些不该顶在最前面，把分好类的挤下去。
       其余按数量降序、同数按名字（和宏观图一致）。 */
    return groups.sort((a, b) => {
      const au = a.name === '未分类', bu = b.name === '未分类';
      if (au !== bu) return au ? 1 : -1;
      return b.n - a.n || a.name.localeCompare(b.name, 'zh');
    });
  }

  /* 一行资源。抽出来是因为它现在要挂在「学科 → 类型」两层里。
     **字段就地可编辑**：名称 / 平台 / 学科本身就是输入框，点一下就能改，
     改完点别处自动存；类型和状态是下拉。没有「改」那个中转按钮 —— 资源一多，
     「点改 → 滚回上面找表单 → 填 → 保存」这一圈太绕，直接在原地改就行。
     对方那一栏永远是只读文本（RLS 也只让改自己的行）。 */
  function resRow(r, mine) {
    /* 这一本书 / 这门课被拆成几章、完成到哪了。章就是 subtasks，
       和「今天完成情况」勾的是同一批行 —— 那边勾一下，这里立刻亮一段。 */
    const subs = subsOfRes(r.id);
    const dn = subs.filter((x) => x.done).length;
    const pp = subs.length ? pct(dn, subs.length) : 0;

    /* 就地改一个字段：先把本地那份改了再写库 —— 写失败时 quiet() 会 refresh
       把真值拉回来，不会留下「界面上改了、库里没改」的假象。
       needRedraw：名称 / 类型 / 学科决定这条排在哪一组，得重画；
       平台和状态不影响分组，重画反而会把光标从输入框里踢出去。 */
    const patch = (fields, needRedraw) => {
      Object.assign(r, fields);
      quiet(sb.from('resources').update(fields).eq('id', r.id)).then((done) => {
        if (!done) return;                 // 失败时 quiet 已经报了错、还把真值拉了回来
        if (needRedraw) renderRes();
        /* 就地改没有「保存」那一下，不说一声她不知道到底存上没有 */
        toast('已保存');
      });
    };
    const textLine = (key, placeholder, needRedraw) => h('input', {
      class: 'inline', type: 'text', value: r[key] || '', placeholder: placeholder,
      title: '点一下就能改，改完点别处自动存',
      onchange: (e) => {
        const v = e.target.value.trim();
        /* 名称不能空着 —— 空名字在列表上就是一条看不见的东西。
           不写库，把卡片重画回原值，并说一句为什么。 */
        if (!v && key === 'name') { toast('名字不能空着', true); renderRes(); return; }
        if (v === (r[key] || '')) return;
        patch({ [key]: v }, needRedraw);
      },
    });
    /* 库里 kind 是脏值的行，下拉里得有个对得上的选项，不然会显示成「工具书」骗人 */
    const kindOpts = KINDS.map((k) =>
      h('option', { value: k.key, text: k.label, selected: r.kind === k.key }));
    if (!KIND_LABEL[r.kind]) kindOpts.push(h('option', { value: r.kind, text: '其他', selected: true }));

    return h('div', { class: 'item' },
      h('div', { class: 't' },
        mine ? textLine('name', '名称', true)
             : h('span', { class: 'grow', text: r.name })
      ),
      /* 提示文字就两个字。写「平台（B站 / Coursera…）」这种长句，那个框空着时
         半行都是灰字，看着像内容 —— 长的那份放进 title。两个框之间也不加「·」：
         空值时它会变成夹在中间的一个孤儿，而且两个框各自悬停会浮出边框，
         本来就有分隔感。 */
      mine ? h('div', { class: 'd two' },
          textLine('platform', '平台', false),
          textLine('subject', '学科', true))
        : ((r.platform || r.subject) ? h('div', { class: 'd' },
            [r.platform, r.subject].filter(Boolean).join(' · ')) : null),
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
      /* 类型和状态放同一行，都在卡片上直接改。
         卡片上的类型下拉跟上面那个小组头是重复的 —— 但改它就会换组，
         这个反馈比「去别处改」直观，留着。 */
      mine ? h('div', { class: 'm two' },
        h('span', { text: '类型' }),
        h('select', {
          style: { maxWidth: '96px' },
          onchange: (e) => patch({ kind: e.target.value }, true),
        }, kindOpts),
        h('span', { text: '状态' }),
        h('select', {
          style: { maxWidth: '96px' },
          onchange: (e) => patch({ status: e.target.value }, false),
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
    );
  }

  /* 把上面那张表单清回「新建」的样子。
     它现在只管新建 —— 改是在卡片上就地改的（见 resRow），没有编辑态。 */
  function resetResForm() {
    $('r-name').value = '';
    $('r-platform').value = '';
    $('r-subject').value = '';
    $('r-chapters').value = '';
  }

  /* 加一条资源。改走的是卡片上的就地编辑，这个按钮只管新建。 */
  async function addRes() {
    const name = $('r-name').value.trim();
    if (!name) { toast('先写名称', true); $('r-name').focus(); return; }
    const btn = $('r-add');
    /* 新建时「共几章」只能在这儿填（一次生成好，省得进去点 n 次「＋ 加一章」）；
       改章数不在这儿管 —— 那是卡片上「＋ 分章」的事。 */
    const fields = {
      kind: $('r-kind').value, name: name,
      platform: $('r-platform').value.trim(), subject: $('r-subject').value.trim(),
      status: $('r-status').value,
    };

    btn.disabled = true;

    /* .select().single() 是为了拿回新行的 id —— 要拿它去建章节 */
    const { data, error } = await sb.from('resources')
      .insert(Object.assign({ owner: S.me.id, url: '' }, fields)).select().single();

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
    resetResForm();
    await refresh();
  }

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
      for (const g of resGroups(rows)) {
        wrap.appendChild(h('div', { class: 'res-group' },
          /* 组头写学科名 + 这一科有几样。个数直接标出来，不用她数 */
          h('div', { class: 'rg-head' },
            h('span', { class: 'rg-name', text: g.name }),
            h('span', { class: 'rg-n', text: g.n + ' 个' })
          ),
          /* 学科里面再按类型分一层 —— 色点跟上面那张宏观图同一套（series-1/2/3） */
          g.byKind.map((k) => h('div', { class: 'res-kind' },
            h('div', { class: 'rk-head' },
              h('span', { class: 'kdot', style: { background: 'var(' + k.kind.varName + ')' } }),
              h('span', { class: 'rk-name', text: k.kind.label }),
              h('span', { class: 'rk-n', text: String(k.list.length) })
            ),
            k.list.map((r) => resRow(r, mine))
          ))
        ));
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

  /* ── 页签五：考试成绩 ──────────────────────────────────────── */
  /* 这一页是**独立一张表**（exams），不在原来六张表的任何一条链路上：
     读取单独一条、失败单独降级，不进 loadAll 的 Promise.all；
     不参与进度条和动态流（考试分数和「今天推进了什么」是两回事）。
     但**月度任务视图**会按 exam_date 把它收进来（只在悬停明细和表格视图里出现，
     不参与格子深浅），这样「这个月做了什么」是一整幅图，不用来回翻页签。 */

  const fmtNum = (n) => {
    const v = Number(n);
    return isFinite(v) ? String(Math.round(v * 100) / 100) : String(n == null ? '' : n);
  };
  /* 空串要变成 null 而不是 0 —— 0 分和「还没出分」是两回事 */
  function numOrNull(v) {
    const t = String(v == null ? '' : v).trim();
    if (!t) return null;
    const n = Number(t);
    return isFinite(n) ? n : null;
  }

  const examInScope = (e) => {
    if (S.exScope === 'me')    return isMine(e);
    if (S.exScope === 'other') return !isMine(e);
    return true;
  };
  const examInSubject = (e) => !S.exSubject || (e.subject || '').trim() === S.exSubject;

  /* 出现过的科目。考试表里的和「学习资源」里的合在一起 —— 同名就能对上，
     省得同一科写两个名字（比如「数学」和「数分」）。 */
  function examSubjects() {
    const set = new Set();
    for (const e of S.exams) { const s = (e.subject || '').trim(); if (s) set.add(s); }
    for (const r of S.resources) { const s = (r.subject || '').trim(); if (s) set.add(s); }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  /* 9月20日 · 周六。库里是 date 字符串，别过 new Date() 再取本地日 ——
     直接解析 'YYYY-MM-DD'，免得时区把它挪一天。考试的日期和倒计时的截止日共用它。 */
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function dateText(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '没填日期';
    const [, y, mo, d] = m.map(Number);
    const wd = WD[new Date(y, mo - 1, d).getDay()];
    const md = mo + ' 月 ' + d + ' 日';
    return (y === new Date().getFullYear() ? md : y + ' 年 ' + md) + ' ' + wd;
  }

  function examScoreEl(e) {
    if (e.score == null || e.score === '') return h('div', { class: 'exscore none', text: '没填分' });
    const s = Number(e.score);
    const f = (e.full_score == null || e.full_score === '') ? null : Number(e.full_score);
    const p = (f && f > 0) ? Math.round((s / f) * 100) : null;
    return h('div', { class: 'exscore' },
      h('b', { text: fmtNum(s) }),
      f != null ? h('span', { class: 'fs', text: ' / ' + fmtNum(f) }) : null,
      p != null ? h('span', { class: 'pc', text: p + '%' }) : null
    );
  }

  function renderExams() {
    const warn = $('ex-warn');
    warn.hidden = !S.exNoTable;
    if (S.exNoTable) {
      warn.textContent = '库里还没有考试成绩这张表。去 Supabase 后台 → SQL Editor，'
        + '跑一次 study/setup-6-exams.sql，再回来点「刷新」。在那之前这一页记不了东西。';
    }
    $('ex-lead').textContent = S.exNoTable
      ? '先跑一次 setup-6-exams.sql，这一页才能存。'
      : '记下哪天考的、哪一科、考了多少分。得分和满分都可以留空（还没出分就先记个日期），'
        + '留空就只显示分数、不算百分比。同一场考试的分数只属于你自己，对方看得到但改不了。';

    if (!$('ex-date').value) $('ex-date').value = today();

    /* 科目候选：自己写过的 + 学习资源里的学科 */
    const dl = $('ex-subject-list');
    clear(dl);
    for (const s of examSubjects()) dl.appendChild(h('option', { value: s }));

    const scoped = S.exams.filter(examInScope);
    renderExamScopeChips();
    renderExamSubjectChips(scoped);
    renderExamSummary(scoped);

    twoCols($('ex-cols'), scoped.filter(examInSubject), (owner, rows, mine) => {
      if (!rows.length) {
        /* 空栏有三种原因，说错哪一种都会让她以为数据丢了：
           ① 表还没建；② 这一栏被筛掉了（只看我/只看对方 + 科目筛）；
           ③ 真的还没记过。`twoCols` 有一条「自己那栏永远在」的规矩，
           所以 ② 一定会出现空栏 —— 不解释清楚就成了「我的记录不见了」。 */
        if (S.exNoTable) return emptyNote('考试成绩这张表还没建，先跑一次 study/setup-6-exams.sql。');
        const hidden = S.exams.filter((e) => (mine ? isMine(e) : !isMine(e))).length;
        if (hidden) return emptyNote('有 ' + hidden + ' 场，被上面的筛选挡住了 —— 切回「全部」。');
        return emptyNote(mine ? '还没记过考试。上面填一场试试。' : '对方还没记过考试。');
      }
      const wrap = h('div');
      for (const e of rows) {
        wrap.appendChild(h('div', { class: 'item' },
          h('div', { class: 't' },
            h('span', { class: 'grow', text: e.name || (e.subject || '没写名称') }),
            examScoreEl(e)
          ),
          h('div', { class: 'm' },
            h('span', { text: dateText(e.exam_date) }),
            h('span', { class: 'pill', text: EXAM_KIND_LABEL[e.kind] || '学校考试' }),
            e.subject ? h('span', { class: 'pill', text: e.subject }) : null
          ),
          e.note ? h('div', { class: 'd', text: e.note }) : null,
          mine ? h('div', { class: 'acts' },
            h('button', { class: 'tiny', text: '改这一场', onclick: () => editExam(e) }),
            h('button', {
              class: 'tiny danger', text: '删除',
              onclick: () => removeRow('exams', e.id,
                '这场考试记录（' + dateText(e.exam_date) + ' ' + (e.name || e.subject || '') + '）'),
            })
          ) : null
        ));
      }
      return wrap;
    });
  }

  function renderExamScopeChips() {
    const box = $('ex-scope');
    clear(box);
    [['all', '全部'], ['me', '只看我'], ['other', '只看对方']].forEach(([k, label]) => {
      box.appendChild(h('button', {
        class: 'tiny' + (S.exScope === k ? ' primary' : ''), text: label,
        onclick: () => { S.exScope = k; S.exSubject = ''; renderExams(); },
      }));
    });
  }

  function renderExamSubjectChips(scoped) {
    const box = $('ex-subj');
    clear(box);
    /* 候选科目按**当前范围**里真出现过的算，不把全库的科目都列出来 */
    const seen = new Map();
    for (const e of scoped) {
      const s = (e.subject || '').trim();
      if (!s) continue;
      seen.set(s, (seen.get(s) || 0) + 1);
    }
    if (!seen.size && !S.exSubject) return;
    const items = [['', '全部科目']].concat(
      [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([s, n]) => [s, s + ' ' + n])
    );
    for (const [key, label] of items) {
      box.appendChild(h('button', {
        class: 'tiny' + (S.exSubject === key ? ' primary' : ''), text: label,
        onclick: () => { S.exSubject = key; renderExams(); },
      }));
    }
  }

  function renderExamSummary(scoped) {
    const rows = scoped.filter(examInSubject);
    if (!rows.length) { $('ex-sub').textContent = S.exNoTable ? '这张表还没建。' : '还没有记录。'; return; }

    const school = rows.filter((e) => e.kind !== 'paper').length;
    let txt = '这个范围里一共 ' + rows.length + ' 场（学校考试 ' + school
      + ' · 自己做的试卷 ' + (rows.length - school) + '）';

    /* 百分比只在有满分的那些场里算 —— 混进没满分的会把平均拉歪。
       所以这里明说「按满分折算 n 场」，不假装是全体的平均。 */
    const withPct = rows
      .filter((e) => e.score != null && e.score !== '' && Number(e.full_score) > 0)
      .map((e) => (Number(e.score) / Number(e.full_score)) * 100);
    if (withPct.length) {
      const avg = Math.round(withPct.reduce((a, b) => a + b, 0) / withPct.length);
      txt += ' · 按满分折算平均 ' + avg + '%（' + withPct.length + ' 场有满分）';
    }
    $('ex-sub').textContent = txt;
  }

  /* 表单：新建 / 改这一场共用。S.exEdit 是 null 就是新建。
     改的时候按钮变「保存修改」，旁边冒出一个「取消」——
     不然她点进「改」之后没有退路。 */
  function resetExamForm() {
    S.exEdit = null;
    $('ex-name').value = '';
    $('ex-subject').value = '';
    $('ex-score').value = '';
    $('ex-full').value = '';
    $('ex-note').value = '';
    $('ex-kind').value = 'school';
    $('ex-date').value = today();
    $('ex-add').textContent = '记下这一场';
    $('ex-cancel').hidden = true;
  }

  function editExam(e) {
    S.exEdit = e.id;
    $('ex-date').value = e.exam_date || today();
    $('ex-name').value = e.name || '';
    $('ex-subject').value = e.subject || '';
    $('ex-kind').value = e.kind === 'paper' ? 'paper' : 'school';
    $('ex-score').value = (e.score == null || e.score === '') ? '' : fmtNum(e.score);
    $('ex-full').value  = (e.full_score == null || e.full_score === '') ? '' : fmtNum(e.full_score);
    $('ex-note').value = e.note || '';
    $('ex-add').textContent = '保存修改';
    $('ex-cancel').hidden = false;
    $('ex-name').focus();
  }

  async function addExam() {
    if (S.exNoTable) { toast(schemaWarn({ message: 'exams schema cache' }), true); return; }
    const name    = $('ex-name').value.trim();
    const subject = $('ex-subject').value.trim();
    /* 名称和科目至少要有一个，否则列表里会出现一行什么都认不出来的记录 */
    if (!name && !subject) { toast('至少写个考试名称或科目', true); return; }

    const payload = {
      owner:      S.me.id,
      exam_date:  $('ex-date').value || today(),
      name:       name,
      subject:    subject,
      kind:       $('ex-kind').value === 'paper' ? 'paper' : 'school',
      score:      numOrNull($('ex-score').value),
      full_score: numOrNull($('ex-full').value),
      note:       $('ex-note').value.trim(),
    };

    const btn = $('ex-add');
    const editing = S.exEdit;
    btn.disabled = true;
    /* 改的时候走 update —— insert 会多出一条；owner 照样带着，
       RLS 的 update 策略 with check 里也要 owner = auth.uid()（本来就是我自己的行）。 */
    const r = editing
      ? await sb.from('exams').update(payload).eq('id', editing)
      : await sb.from('exams').insert(payload);
    btn.disabled = false;

    if (r.error) { toast(schemaWarn(r.error), true); return; }
    const wasEditing = !!editing;
    resetExamForm();
    toast(wasEditing ? '已更新' : '记下了');
    await refresh();
  }

  /* ── 页签六：导出 / 导入 ──────────────────────────────────── */
  function snapshot() {
    return {
      app: APP_ID,
      version: APP_VERSION,
      exported_at: new Date().toISOString(),
      backend: {
        supabase_url: SUPABASE_URL,
        supabase_key: SUPABASE_KEY,
        tables: ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources',
                 'exams', 'mottos', 'links', 'site'],
        schema_sql: 'study/setup.sql + setup-3-feed.sql + setup-4-chapters.sql + setup-5-link.sql'
                  + ' + setup-6-exams.sql + setup-7-countdown.sql + setup-8-mottos.sql'
                  + ' + setup-9-links.sql + setup-10-site.sql（都可重复执行）',
      },
      /* 站名单独放在**顶层**，不塞进 data —— data 里每张表按 owner 过滤（各导各的），
         而 site 没有 owner：塞进去会被当成「对方的行」跳掉，导入说明里就多出一句
         莫名其妙的「跳过 1 行」。这里只是把当前站名记下来，供人/CI 看。 */
      site: { title: S.siteTitle || DEFAULT_TITLE, table_ready: !S.stNoTable },
      me: S.me ? { id: S.me.id, email: S.me.email, display_name: nameOf(S.me.id) } : null,
      counts: {
        profiles: S.profileList.length, goals: S.goals.length, tasks: S.tasks.length,
        subtasks: S.subtasks.length, daily_logs: S.daily.length, resources: S.resources.length,
        exams: S.exams.length,
        // 倒计时不是独立的表，是 goals 里 due_date 非空的那部分，这里单独给个数便于对账
        countdown: S.goals.filter((g) => g.due_date).length,
        mottos: S.mottos.length,
        links: S.links.length,
      },
      data: {
        profiles: S.profileList, goals: S.goals, tasks: S.tasks,
        subtasks: S.subtasks, daily_logs: S.daily, resources: S.resources,
        exams: S.exams, mottos: S.mottos, links: S.links,
      },
    };
  }

  function renderData() {
    const nCd = S.goals.filter((g) => g.due_date).length;
    $('export-meta').textContent =
      '倒计时 ' + nCd + ' · 目标 ' + S.goals.length + ' · 大任务 ' + S.tasks.length +
      ' · 小任务 ' + S.subtasks.length +
      ' · 日记 ' + S.daily.length + ' · 资源 ' + S.resources.length +
      ' · 考试 ' + S.exams.length +
      ' · 关联 ' + S.links.length;
    renderNameAdmin();
    renderSiteAdmin();
    renderMottoAdmin();
  }

  /* ── 我的名字（「导出 / 导入」页，在站名上面）────────────────────
     `profiles.display_name` 本来就存着这个名字（页头头像上的字、状态卡、
     动态流里显示的都是它），只是以前**没有任何地方能改** —— 一直停在注册时写死的
     那个「小 A / 小 B」。这张卡就是给它开个口子。
     跟站名的区别：站名是两个人共用的（`site` 表，没有 owner），
     这个名字是**各改各的**（RLS 的 profiles 策略只让改自己那一行），
     所以这里没有「改对方名字」的入口，文案里也写清楚了。 */
  const NAME_MAX = 12;

  function renderNameAdmin() {
    const input = $('pn-name');
    if (!input || !S.me) return;
    /* 正在这个框里打字时不回填 —— 同站名那张卡的理由：
       renderCurrent() 每次改动（含对方推来的实时事件）都会重画这一页。 */
    if (document.activeElement !== input) input.value = S.profileMap[S.me.id] || '';
  }

  async function saveMyName() {
    if (!S.me) return;
    const t = $('pn-name').value.trim();
    if (!t) { toast('名字不能是空的', true); $('pn-name').focus(); return; }
    /* 页面上 maxlength=12 已经拦了一道，这里再拦一道：绕过输入框（粘贴、
       改 HTML）时也得给一句人话，而不是把数据库的报错甩出去。 */
    if (t.length > NAME_MAX) { toast('名字最多 ' + NAME_MAX + ' 个字', true); $('pn-name').focus(); return; }

    const btn = $('pn-save');
    btn.disabled = true;
    const r = await sb.from('profiles').update({ display_name: t }).eq('id', S.me.id);
    btn.disabled = false;
    if (r.error) { toast(schemaWarn(r.error), true); return; }

    /* 本地两处都要改：`profileMap` 是**显示**用的（nameOf 读它），
       `profileList` 是**导出快照**用的 —— 漏掉后者，导出的 JSON 里还是旧名字。 */
    S.profileMap[S.me.id] = t;
    const row = S.profileList.find((p) => p.id === S.me.id);
    if (row) row.display_name = t;

    paintMeAvatar();     // 页头那个大圆里的字取名字第一个字，得跟着换
    renderNameAdmin();
    renderCurrent();
    toast('名字改好了');
  }

  /* ── 站名管理（「导出 / 导入」页最下面那一块，在校训上面）────────
     和校训同一套路：一张**没有 owner** 的共同表，谁改两边都变。
     区别是这张表只有一行，所以不画列表，就一个输入框 + 保存。 */
  function renderSiteAdmin() {
    $('st-warn').textContent = S.stNoTable
      ? '库里还没有这张表 —— 去 Supabase 后台跑一次 study/setup-10-site.sql。'
        + '在那之前显示的是页面里写死的名字，改了存不下。'
      : '';

    /* 正在这个框里打字时不回填 —— renderCurrent() 每次改动（包括对方那台设备
       推过来的实时事件）都会重画这一页，不挡一下的话，她打到一半会被库里的
       旧名字盖掉。 */
    const input = $('st-title');
    if (input && document.activeElement !== input) input.value = S.siteTitle || DEFAULT_TITLE;
  }

  /* 存站名。走 upsert 不走 update：万一那一行不在了（有人在 SQL 里删过），
     update 会「改 0 行但不报错」，页面显示改好了、其实什么都没发生；
     upsert 会把它建回来，自己就能修好。两条策略（ins/upd）setup-10 里都给了。 */
  async function saveSiteTitle() {
    const t = $('st-title').value.trim();
    if (!t) { toast('名字不能是空的', true); $('st-title').focus(); return; }
    /* 页面上 maxlength=24 已经拦了一道，这里再拦一道：绕过输入框（粘贴脚本、
       改 HTML）时也得给一句人话，而不是把数据库的约束报错甩出去。 */
    if (t.length > TITLE_MAX) { toast('名字最多 ' + TITLE_MAX + ' 个字', true); $('st-title').focus(); return; }

    const btn = $('st-save');
    btn.disabled = true;
    const r = await sb.from('site').upsert({ id: true, title: t }, { onConflict: 'id' });
    btn.disabled = false;
    if (r.error) { toast(schemaWarn(r.error), true); return; }
    S.siteTitle = t;
    cacheTitle(t);        // 下次打开页面，登录页还没读库时先显示这个名字
    applyTitle();
    renderSiteAdmin();
    toast('站名改好了');
  }

  /* ── 校训管理（「导出 / 导入」页最下面那一块）──────────────────
     这张表**没有 owner**，两个人共用一份清单 —— 所以这里不按人分栏，
     也不用 twoCols。谁都能加、都能改、都能删（就两个人，刻意的）。 */
  function renderMottoAdmin() {
    $('mt-warn').textContent = S.mtNoTable
      ? '库里还没有这张表 —— 去 Supabase 后台跑一次 study/setup-8-mottos.sql。'
        + '在那之前显示的是内置的 39 条，加不了也改不了。'
      : '';

    $('mt-now').textContent = S.mtNow ? '现在显示的是：' + mottoText(S.mtNow) : '';

    const box = $('mt-list');
    clear(box);
    if (S.mtNoTable) return;         // 表都没有，列表点了也存不下，不画
    if (!S.mottos.length) {
      box.appendChild(emptyNote('库里一条都没有，现在顶上显示的是**内置的 39 条校训**。'
        + '在上面加一条自己的（校训或摘抄都行），它就会顶掉内置那份。'));
      return;
    }

    for (const m of S.mottos) {
      if (S.mtEdit === m.id) { box.appendChild(mottoEditRow(m)); continue; }
      box.appendChild(h('div', { class: 'item' },
        h('div', { class: 't' },
          h('span', { class: 'grow', text: m.text }),
          h('span', { class: 'pill', text: m.school || '没写出处' })
        ),
        h('div', { class: 'acts' },
          h('button', {
            class: 'tiny', text: '改',
            onclick: () => { S.mtEdit = m.id; renderMottoAdmin(); },
          }),
          h('button', {
            class: 'tiny danger', text: '删除',
            onclick: async () => {
              if (!confirm('删掉这条？\n\n' + m.text)) return;
              if (S.mtNow && S.mtNow.text === m.text) S.mtNow = null;  // 删的正好是显示的那条，下次重抽
              await commit(sb.from('mottos').delete().eq('id', m.id), '删掉了');
            },
          })
        )
      ));
    }
  }

  /* 就地编辑一行。走 update 不走 insert —— insert 会多出一条。 */
  function mottoEditRow(m) {
    const t  = h('input', { type: 'text', class: 'grow', value: m.text || '', placeholder: '一句话' });
    const sc = h('input', { type: 'text', value: m.school || '', placeholder: '出处：学校 / 书名 / 作者',
                            style: { maxWidth: '170px' } });
    return h('div', { class: 'item' },
      h('div', { class: 't' },
        t,
        h('button', {
          class: 'tiny primary', text: '保存',
          onclick: async () => {
            const text = t.value.trim();
            if (!text) { toast('一句话不能是空的', true); return; }
            S.mtEdit = null;
            if (S.mtNow && S.mtNow.id === m.id) S.mtNow = null;   // 显示的那条被改了，重新抽
            await commit(sb.from('mottos').update({ text: text, school: sc.value.trim() }).eq('id', m.id), '改好了');
          },
        }),
        h('button', { class: 'tiny', text: '取消', onclick: () => { S.mtEdit = null; renderMottoAdmin(); } })
      ),
      h('div', { class: 'm' }, sc)
    );
  }

  async function addMotto() {
    const text = $('mt-text').value.trim();
    if (!text) { toast('先写一句话', true); $('mt-text').focus(); return; }
    const school = $('mt-school').value.trim();
    const btn = $('mt-add');
    btn.disabled = true;
    const r = await sb.from('mottos').insert({ text: text, school: school });
    btn.disabled = false;
    if (r.error) { toast(schemaWarn(r.error), true); return; }
    $('mt-text').value = '';
    $('mt-school').value = '';
    /* 刚加完就把这一条显示出来 —— 否则「加上了」之后页面顶上还是别人，
       她会以为没存进去。（去「导出 / 导入」页改校训，看的却不是自己刚加的那条，很怪。） */
    S.mtNow = { id: '', school: school, text: text };
    paintMotto();
    toast('加上了');
    await refresh();
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

    const order = ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources', 'exams'];
    let written = 0, skipped = 0, noTable = '', noCol = 0;
    $('import-meta').textContent = '导入中…';

    for (const t of order) {
      const rows = Array.isArray(snap.data[t]) ? snap.data[t] : [];
      /* 表还没建就跳过（放在最后，前面几张表已经写完了）——
         别让「考试成绩这张表还没跑 SQL」把整次导入弄成失败。 */
      if (t === 'exams' && S.exNoTable) { if (rows.length) noTable = 'exams'; continue; }
      const mine = rows.filter((r) => (t === 'profiles' ? r.id === S.me.id : r.owner === S.me.id));
      skipped += rows.length - mine.length;
      if (!mine.length) continue;

      /* 库里的 goals 还没有 due_date 列时，带着这一列的行会被 PostgREST 整批拒掉，
         连带同一批里的旧目标一起写不进去。剥掉它再写 —— 少一列，其余数据保住。 */
      let write = mine;
      if (t === 'goals' && S.cdNoCol) {
        const had = mine.filter((r) => 'due_date' in r).length;
        if (had) {
          noCol = had;
          write = mine.map((r) => { const c = Object.assign({}, r); delete c.due_date; return c; });
        }
      }

      for (let i = 0; i < write.length; i += 200) {
        const chunk = write.slice(i, i + 200);
        const { error } = await sb.from(t).upsert(chunk, t === 'daily_logs' ? { onConflict: 'owner,log_date' } : undefined);
        if (error) { toast('导入 ' + t + ' 失败：' + error.message, true); $('import-meta').textContent = ''; return; }
        written += chunk.length;
      }
    }
    $('import-meta').textContent = '写入 ' + written + ' 行，跳过 ' + skipped + ' 行（属于对方的，权限规则不允许我改）'
      + (noTable ? '；快照里的考试成绩没导 —— 库里还没这张表，先跑 study/setup-6-exams.sql' : '')
      + (noCol ? '；有 ' + noCol + ' 行倒计时的截止日没导 —— 库里还没这一列，先跑 study/setup-7-countdown.sql，'
               + '再导一次就能补上' : '');
    toast(noTable || noCol ? '导入完成（有一小部分没导，见下方说明）' : '导入完成');
    await refresh();
  }

  /* ── 删除：不弹确认框，改成 5 秒内能点回来 ────────────────────
     弹一个「确定删除？」能防住误删，可每一次正经删除也得多点一下；
     「删完 5 秒内可以撤回」两样都占：不打断顺手删，误删也救得回来。
     实现是**延迟真删** —— 先把这一行从界面上摘掉、记在 trash 里，
     5 秒之后才真发 delete。不选「先真删、撤回时再 insert 回去」是因为：
     那样 id 会变，外键级联没了的小任务和关联都得一条条重建，那才是真会出错的路。
     what 用在提示条上（「已删除资源『线性代数』」），说清楚删掉的是哪一条。 */
  const UNDO_MS = 5000;
  const trash = new Map();          // id → { timer }：这 5 秒里等着真删的行
  /* 表名 → S 里那个数组的名字。daily_logs 存在 S.daily 里，跟表名不一样。 */
  const S_ARR = { goals: 'goals', tasks: 'tasks', subtasks: 'subtasks',
                  daily_logs: 'daily', resources: 'resources', exams: 'exams' };
  /* 待删的行不能因为一次界面刷新又冒回来（refresh 会重新从库里拉一遍）。
     库里那份确实还在 —— 删除请求还没发出去 —— 但界面上既然已经摘掉了，
     就不该自己长回来；真想让它回来只有一条路：点「撤回」。 */
  const live = (rows) => (rows || []).filter((r) => !trash.has(r.id));
  let undoTimer = null;

  function hideUndo() {
    clearTimeout(undoTimer);
    $('undo').hidden = true;
    clear($('undo'));
  }

  /* 只删了一条就把那一条的名字写出来（「已删除倒计时任务『交开题报告』」），
     5 秒里连删了好几条就只报个数 —— 条就那么宽，列一串名字反而看不清删了几件。
     文案按当前的 trash 现算，所以删完一条、条上的数字会跟着变。 */
  function showUndo() {
    clearTimeout(undoTimer);
    const bar = $('undo');
    clear(bar);
    bar.hidden = false;
    const only = trash.size === 1 ? [...trash.values()][0].what : '';
    const words = only ? '已删除' + only : '已删除 ' + trash.size + ' 项';
    /* 名字长的时候条上会截断（CSS 里那行 ellipsis），所以整句也挂到 title 上 ——
       悬停能看全，不用为了看清删的是哪条去点撤回。 */
    bar.appendChild(h('span', { class: 'grow', text: words, title: words }));
    bar.appendChild(h('button', { class: 'tiny', text: '撤回', onclick: undoTrash }));
    undoTimer = setTimeout(hideUndo, UNDO_MS);
  }

  /* 撤回：这几秒里库里的行一行没动（删除请求还没发出去），所以重新拉一次
     就是原样 —— 不用自己算「该插回数组的哪个位置」，也就不会插错地方。 */
  async function undoTrash() {
    trash.forEach((t) => clearTimeout(t.timer));
    trash.clear();
    hideUndo();
    await refresh();
    toast('已恢复');
  }

  /* what：撤回条上写「已删除 ___」用的。
     它得在**按下删除的那一刻**就取好 —— 等到 5 秒后真删的时候，那条记录
     可能已经被别的操作改过名了（撤回条上就会写着一个她没见过的名字）。
     beforeDelete：真删之前要顺带收拾的东西（可选）。小任务要拿它清对端那条
     的 link_id —— 不清的话对端还指着一个马上就不存在的 id，勾选联动会勾到空气。
     钩子抛错不拦着删除继续走（它只是个清理动作，卡住反而把删除也卡死了）。 */
  function removeRow(table, id, what, beforeDelete) {
    const arr = S[S_ARR[table]];
    const i = arr ? arr.findIndex((r) => r.id === id) : -1;
    if (i < 0) return;
    arr.splice(i, 1)[0];            // 先从界面上摘掉，看着就是「删掉了」
    renderCurrent();

    const entry = { timer: null, what: what };
    entry.timer = setTimeout(() => {
      trash.delete(id);
      /* 挂着它的关联要一起清掉，否则 links 里会留下指着空气的行。
         （id 是 uuid，别的表不会有同号的，所以这里不用管 table 是哪张） */
      dropLinksOf(id)
        .then(() => (beforeDelete ? beforeDelete() : null))
        .catch(() => null)
        .then(() => commit(sb.from(table).delete().eq('id', id)));
      if (trash.size) showUndo(); else hideUndo();     // 条上的数字跟着变
    }, UNDO_MS);
    trash.set(id, entry);
    showUndo();
  }

  /* ── 页签零：主页 ──────────────────────────────────────────── */
  /* 动态流是「算」出来的，不额外存一张表：目标/小任务看 done，
     日记和学习资源看建成时间。所以不加新表也能跑。 */
  function buildFeed() {
    const ev = [];

    for (const g of S.goals) {
      if (!g.done) continue;
      /* 有截止日的是倒计时任务，没有的是以前的 30 天小目标 —— 同一条动态
         说法不一样，别把「交开题报告」说成「累计 1 / 1」。 */
      ev.push({
        owner: g.owner, at: g.done_at || null, kind: 'done',
        text: g.due_date ? '完成了倒计时任务 ' : '完成了 30 天目标 ',
        strong: g.title,
        sub: g.due_date ? '截止 ' + g.due_date : '累计 ' + (g.progress || 0) + ' / ' + g.target,
      });
    }
    for (const s of S.subtasks) {
      if (!s.done) continue;
      if (isLinkEcho(s)) continue;        // 关联着的几条是同一件事，动态流里只出现一次
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
      /* goals 表现在装两种东西：有截止日的 = 倒计时，没有的 = 以前的 30 天小目标。
         卡片上只数前者（2026-09-26 之后 30 天小目标不再出现在界面里），
         没有 due_date 的那些行照样在库里躺着，只是不往这里算。 */
      const cd      = g.filter((x) => x.due_date);
      const cdOpen  = cd.filter((x) => !x.done);
      const cdNext  = cdOpen.slice().sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
      const t       = S.tasks.filter((x) => x.owner === id);
      const subs    = S.subtasks.filter((x) => x.owner === id);
      const subDone = subs.filter((x) => x.done).length;
      const r       = S.resources.filter((x) => x.owner === id);
      const log     = S.daily.find((x) => x.owner === id && x.log_date === today());

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
          pcRow('倒计时',
            cd.length ? '待办 ' + cdOpen.length + ' / ' + cd.length + ' 件' : '还没建',
            /* 「最急的」而不是「最近的」—— 排最前的很可能是已经欠着的那件，
               说「最近」会让人以为它在未来。和倒计时卡片上的说法保持一致。 */
            cdNext ? '最急的 ' + dateText(cdNext.due_date) + ' · ' +
                     cdLeftText(daysFromToday(cdNext.due_date))
                   : cd.length ? '全部完成' : ''),
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
    [['goals', '月度任务', '倒计时 + 这个月做了什么，一格一天'],
     ['tasks', '大任务拆解', '推进小任务进度'],
     ['daily', '今日完成情况', '记下今天完成了什么'],
     ['res', '学习资源', '工具书 / 网课 / 老师'],
     ['exams', '考试成绩', '记下每场考了多少分'],
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
    daily: renderDaily, res: renderRes, exams: renderExams, data: renderData,
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

    $('cd-add').addEventListener('click', addCountdown);

    /* 截止日的四个快捷按钮。**只填值，不抢焦点** —— 她点这个说明正定到一半，
       这时候把光标拽回标题框是打断。（她原来是「写标题 → 翻开日历点 → 加上」，
       现在中间那步从 5 次操作变成 1 次。） */
    for (const [id, pick] of Object.entries(QUICK_DUE)) {
      $(id).addEventListener('click', () => { $('cd-due').value = pick(); });
    }

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
      $('t-title').focus();       // 同上：建完一个接着建下一个
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

    $('r-add').addEventListener('click', addRes);

    /* 考试成绩：一次记一场。改的时候同一个按钮变成保存。 */
    $('ex-add').addEventListener('click', addExam);
    $('ex-cancel').addEventListener('click', () => { resetExamForm(); toast('没改，表单已清空'); });

    $('btn-export').addEventListener('click', doExport);
    $('btn-import').addEventListener('click', () => $('file-import').click());
    $('file-import').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await doImport(f);
      e.target.value = '';
    });

    $('pn-save').addEventListener('click', saveMyName);
    /* 回车 = 保存（跟站名那张卡一样，输入框里按回车不用去够按钮） */
    $('pn-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveMyName(); }
    });
    $('st-save').addEventListener('click', saveSiteTitle);
    $('mt-add').addEventListener('click', addMotto);
    $('mt-shuffle').addEventListener('click', () => { pickMotto(true); renderMottoAdmin(); });

    $('btn-refresh').addEventListener('click', refresh);
    $('btn-logout').addEventListener('click', () => sb.auth.signOut());
  }

  /* ── 实时订阅 ──────────────────────────────────────────────── */
  /* **一张表一条频道**。以前是九张表挤在一条频道上，只要有一张订不上
     （表不存在，或者表存在但没进 realtime 发布），Supabase 会给整条频道回错误 ——
     结果是一张表出问题，另外八张跟着一起不实时。
     2026-09-26 发现 exams 就一直没进发布（setup.sql 里的表名单是写死的），
     那颗小药丸大概一直是「未连上实时」。拆开之后谁也不连累谁。
     代价是频道多了几条 —— 两个人、这个量级，无所谓。 */
  let rtChannels = [];
  let rtStatus = {};      // 表名 -> 连上没有，只用来写药丸上那句话
  function subscribeRealtime() {
    const pill = $('conn-pill');
    // 退出再登录会再进这里一次；同名的旧频道必须先撤掉，否则 SDK 会报重名
    rtChannels.forEach((c) => sb.removeChannel(c));
    rtChannels = [];
    rtStatus = {};

    const tables = ['profiles', 'goals', 'tasks', 'subtasks', 'daily_logs', 'resources'];
    /* 新加的表还没跑 SQL 时先不订它（表都不存在，订了必错）：
       exams 见 setup-6，mottos 见 setup-8，links 见 setup-9，site 见 setup-10。
       刚跑完 SQL 那一次要刷新页面，订阅才会补上。 */
    if (!S.exNoTable) tables.push('exams');
    if (!S.mtNoTable) tables.push('mottos');
    if (!S.lkNoTable) tables.push('links');
    if (!S.stNoTable) tables.push('site');

    const paint = () => {
      const n = tables.filter((t) => rtStatus[t]).length;
      const ok = n === tables.length;
      pill.textContent = ok ? '已连接 · 实时同步'
                          : n ? '部分同步（' + n + '/' + tables.length + ' 张表，手动刷新仍可用）'
                              : '未连上实时（手动刷新仍可用）';
      pill.className = 'pill' + (ok ? ' ok' : '');
    };
    paint();

    for (const t of tables) {
      const ch = sb.channel('study-' + t)
        .on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onRealtime(t))
        .subscribe((status) => { rtStatus[t] = status === 'SUBSCRIBED'; paint(); });
      rtChannels.push(ch);
    }
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
    pickMotto();   // 库里那份读到之后，池子换了一茬，这里会跟着换成库里的
    if (!$('d-date').value)  $('d-date').value  = today();
    paintMeAvatar();
    /* 订阅要等 loadAll 之后 —— 得先知道 exams 表在不在，才决定订不订它。
       finally 保证读失败时也会连上实时（否则读挂了就永远停在「连接中…」）。 */
    loadAll()
      .then(() => { paintMeAvatar(); goTab('home'); })   // 登录后落在主页
      .catch((e) => toast('读取失败：' + e.message, true))
      .finally(() => subscribeRealtime());
  }

  function showLogin() {
    S.me = null;
    $('view-app').hidden = true;
    $('view-login').hidden = false;
  }

  async function boot() {
    $('view-login').hidden = false;   // 先给登录页，避免白屏
    /* 登录页在登录**之前**就要有名字，而库里的要登录后才读得到 ——
       先把本机记住的上次那个贴上去，没有就用默认名，别让页头空着。 */
    S.siteTitle = cachedTitle() || DEFAULT_TITLE;
    applyTitle();
    pickMotto();                      // 还没登录时用内置那份兜底，别让登录页空着一行

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
