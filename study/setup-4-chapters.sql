-- ============================================================
--  学习资源分章节（一次性执行）
--  用法：Supabase 后台 → SQL Editor → New query → 全选粘贴 → Run
--  可重复执行
--
--  做的事：让一条 subtask 可以是「某个大任务的小任务」，
--  也可以是「某个学习资源的一章」—— 二选一。
--
--  为什么不另开一张 resource_chapters 表：
--  「今天完成情况」「月行程表」「主页动态流」现在读的都是 subtasks。
--  另开一张表就得在这三处各写一遍合并逻辑，两边还容易对不上。
--  复用同一张表之后，这些地方一行都不用改。
--
--  跑之前页面照样能用，只是资源不能分章。
-- ============================================================

-- 1. 允许挂到学习资源上
alter table public.subtasks add column if not exists resource_id uuid
  references public.resources(id) on delete cascade;

-- 2. task_id 原本是 not null，现在要允许「只挂资源」的行
alter table public.subtasks alter column task_id drop not null;

-- 3. 两个父只能有一个：不能都填，也不能都不填（否则就是一条没人认领的孤儿）
--    已有数据都是 task_id 有值、resource_id 为空，全部满足这个条件，不需要 NOT VALID
alter table public.subtasks drop constraint if exists subtasks_one_parent;
alter table public.subtasks add constraint subtasks_one_parent
  check ((task_id is null) <> (resource_id is null));

-- 4. 按资源查章节会走这个索引
create index if not exists subtasks_resource_id_idx on public.subtasks (resource_id);


-- ============================================================
--  自检：应该出现 2 行
-- ============================================================
select table_name as 表名, column_name as 列名, is_nullable as 可为空
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'subtasks' and column_name in ('task_id', 'resource_id')))
order by column_name;


-- ============================================================
--  已知限制（两个人用，先不处理）
--
--  权限规则只校验 owner = 自己，不校验「挂上去的那个资源是不是自己的」。
--  也就是说，理论上对方能往你的书下面塞一章。要堵住得写一个 security definer
--  函数再在策略里调用 —— 和 setup-2-lock.sql 里 is_member() 那套一样，
--  但收益很小（塞进去也只是多一条记录，不会泄露你的数据），先不做。
-- ============================================================
