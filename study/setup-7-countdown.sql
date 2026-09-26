-- ════════════════════════════════════════════════════════════════
-- setup-7-countdown.sql · 倒计时（几月几号要完成什么）
--
-- 跑法：Supabase 后台 → SQL Editor → 新建查询 → 整段粘进去 → Run
-- 可以重复执行（幂等），跑几次都不会坏数据。
--
-- 这一版**只加一列**，不动任何数据：
--   goals.due_date = 这件事的截止日
--     · 有值 → 页面「月度任务」页最上面那块「倒计时」里的条目
--     · 空   → 以前的 30 天小目标，原样留着（进度、完成状态都在）
--
-- 为什么加在 goals 表上、不新开一张表：
--   倒计时和原来的小目标是同一类东西（一件要完成的事 + 一个日期），
--   复用一张表意味着 RLS、实时同步、导出导入、月度任务视图都不用改，
--   也不会多出一套「旧目标是 goals、新任务是 countdowns」的概念。
--
-- 为什么不用 period_start 当截止日：
--   那一列现在的含义是「30 天周期的起始日」，已有的行是这么存的。
--   改它的含义 = 悄悄改掉已经存在的数据的语义，不做。
--
-- 不用重跑 setup-2-lock.sql：那个脚本管的是**表**级别的读取策略，
-- 这里只是给已有的 goals 表加一列，策略是按表走的，自动覆盖新列。
-- ════════════════════════════════════════════════════════════════

alter table public.goals add column if not exists due_date date;

comment on column public.goals.due_date is
  '倒计时任务的截止日（页面按它算还剩几天）。为空 = 以前的 30 天小目标。';

-- 页面按「未完成 + 截止日」排序取数，给它一个索引
create index if not exists goals_due_idx on public.goals (owner, due_date);

-- ── 自检：应该看到 10 行，最后一行是 due_date（date，可为空） ──
select ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'goals'
 order by ordinal_position;

-- ── 顺带看一眼现在有几条、各有几个截止日 ──────────────────────
select count(*)                                      as 目标总数,
       count(due_date)                               as 有截止日的,
       count(*) filter (where done)                   as 已完成的
  from public.goals;


-- ════════════════════════════════════════════════════════════════
-- 已知限制（写在这里，不在页面上说）
--
-- 1. 倒计时条目在库里仍然是 goals 的一行，所以老三列的含义是"占位"：
--    period_start = 加它的那天、target = 1、progress = 0/1。
--    页面**不显示**这三样（倒计时那块只画标题、截止日、说明），
--    但如果直接看数据库，别被它们误导。
--
-- 2. 没有数据库层面的约束保证 due_date >= period_start 之类的一致性 ——
--    截止日可以填过去的日期，页面会正常显示成「已过期 N 天」
--    （这是故意的：有些事就是已经误期了，得能记下来）。
--
-- 3. 想让「倒计时」完全独立成一张表（而不是复用 goals），
--    要新写一整套建表 + RLS + 索引，并且把导出/导入/实时订阅/月历都改一遍 ——
--    除非有明确理由，不建议。
-- ════════════════════════════════════════════════════════════════
