-- ════════════════════════════════════════════════════════════════
-- setup-11-priority.sql · 倒计时任务的「优先级」
--
-- 跑法：Supabase 后台 → SQL Editor → 新建查询 → 整段粘进去 → Run
-- 可以重复执行（幂等）：跑第二次不会报错，也不会把已经标好的优先级改掉。
--
-- 做的事：给已有的 goals 表加一列 priority（高 / 中 / 低 / 不标）。
-- 页面上的样子：卡片**左边一条 3px 的色条**，不加整块背景
--   —— 她原话「优先级只给左边 3px 色条，不加整块背景」，
--   理由写在 app.css 里：铺了底会把「逾期红」「完成绿」这两件更要紧的事淹掉。
--
-- 为什么是加一列、不是新开一张表：
--   优先级就是倒计时任务自己的一个属性（一件事一行），
--   跟 setup-3 / setup-4 / setup-5 一样，加一列就完事，不用重新录数据。
--
-- ⚠️ 不跑这个脚本页面照样能用：探测到没有 priority 这一列时，
--    卡片上那个下拉**整个不显示**（不是显示了再写失败）。
--    宁可不给标，也不能让她标完发现「因为标了个优先级、任务反而加不上了」。
--
-- 值只有四种，页面上是下拉，选不出别的东西：
--   ''    不标（默认）—— 左边不留色条，跟别的卡片左对齐
--   'hi'  高 —— 系列色 1
--   'mid' 中 —— 系列色 2
--   'lo'  低 —— 中性灰（--muted）
--   注意「高」用的是**系列色**，不是红色：红只留给逾期、绿只留给完成。
-- ════════════════════════════════════════════════════════════════

-- 加列。默认值给空串而不是 null：空串和「没标」在页面上是同一件事，
-- 存两种写法（null / ''）以后统计「标了几条」要对两种都判一次，容易漏。
alter table public.goals add column if not exists priority text not null default '';


-- 值域闸门：绕过页面直接改库（或以后写脚本）时，脏值会被挡在这儿。
-- 挡在这一层而不是只在页面上拦，是因为页面上那个下拉读的就是这一列 ——
-- 库里存进一个列表上没有的值，那一行会变成一个选不中任何项的空下拉。
alter table public.goals drop constraint if exists goals_priority_chk;
alter table public.goals add  constraint goals_priority_chk
  check (priority in ('', 'hi', 'mid', 'lo'));


-- 权限：这次**不用动 RLS**。优先级是 goals 表上的一列，
-- 沿用那张表原有的策略（登录可读、只写自己的），加列不会改变任何一条策略。
-- 也就是说：跑过 setup-2-lock.sql（名单制）的，这次不用重新跑 setup-2。


-- ── 自检 ──────────────────────────────────────────────────────
-- ① 列应该在了：应该恰好 1 行，类型 text，默认值 ''::text
select column_name as 列名, data_type as 类型, is_nullable as 可空, column_default as 默认值
  from information_schema.columns
 where table_schema = 'public' and table_name = 'goals' and column_name = 'priority';

-- ② 约束应该在：应该出现 1 行 goals_priority_chk
select conname as 约束名, pg_get_constraintdef(oid) as 定义
  from pg_constraint
 where conrelid = 'public.goals'::regclass and conname = 'goals_priority_chk';

-- ③ 现有的行应该全是「不标」（跑完这一列才刚有，谁都没标过）
select coalesce(nullif(priority, ''), '(不标)') as 优先级, count(*) as 条数
  from public.goals group by 1 order by 1;

-- ④ 脏值确实是挡住的（会报 goals_priority_chk 违反，报错就是对的；
--    不想看见红字就别跑这一句）
-- insert into public.goals (owner, title, priority, period_start)
--   values (auth.uid(), '试试脏值', 'urgent', current_date);


-- ════════════════════════════════════════════════════════════════
-- 已知限制
--
-- 1) 优先级只有四档，且**不影响排序** —— 倒计时的顺序始终按截止日排
--    （逾期的自然排最前）。加优先级是为了在一堆都急的事里一眼看出哪个更要紧，
--    不是重排列表。要重排的话得先说清楚「按优先级还是按日期」，
--    两套并存会让人猜不出这一行为什么在上面。
--
-- 2) 色条只在**自己那一栏**显示；对方那一栏是只读的样子，优先级也不显示
--    —— 自己标自己的，别人看到的还是按日期排的那份。
--
-- 3) 这一列不参与「导出 / 导入」页的统计口径，也不上月历。
-- ════════════════════════════════════════════════════════════════
