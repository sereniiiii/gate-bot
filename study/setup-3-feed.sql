-- ============================================================
--  学习协作页 · 主页动态流 + 头像（一次性执行）
--  用法：Supabase 后台 → SQL Editor → New query → 全选粘贴 → Run
--  可重复执行
--
--  加三列：
--  · profiles.avatar    头像（浏览器里裁成 160px JPEG 后的 data URL，约 8~15 KB）
--  · goals.done_at      什么时候完成的（主页动态流按它排序）
--  · subtasks.done_at   同上
--
--  跑之前页面照样能用：勾「完成」会退化成不写时间戳，
--  动态流里这些条目会显示成「较早完成」，不假装有时间。
-- ============================================================

alter table public.profiles add column if not exists avatar  text default '';
alter table public.goals    add column if not exists done_at timestamptz;
alter table public.subtasks add column if not exists done_at timestamptz;

-- 动态流按完成时间倒序取，给两列加个索引（数据量小，加了也不亏）
create index if not exists goals_done_at_idx    on public.goals    (done_at desc);
create index if not exists subtasks_done_at_idx on public.subtasks (done_at desc);


-- ============================================================
--  自检：应该出现 3 行
-- ============================================================
select table_name as 表名, column_name as 列名, data_type as 类型
from information_schema.columns
where table_schema = 'public'
  and column_name in ('avatar', 'done_at')
order by table_name, column_name;


-- ============================================================
--  说明：头像为什么不用 Supabase Storage
--
--  Storage 要多开一个 bucket，还要给它单独写一套策略，
--  而且每个文件都会占免费额度。头像缩到 160px 之后只有 8~15 KB，
--  直接存进 profiles 这一行的文本列里最省事：
--  读 profiles 一次就把两个人的头像都带回来了，不用额外的请求。
--  代价是头像列会跟着每条 select * 一起传 —— 两个人用，无所谓。
-- ============================================================
