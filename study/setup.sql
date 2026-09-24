-- ============================================================
--  学习协作页 · Supabase 建表脚本（一次性执行）
--  用法：Supabase 后台 → 左侧 SQL Editor → New query → 全选粘贴 → Run
--  可重复执行（带 if not exists / drop policy if exists，跑第二遍不会报错）
-- ============================================================

-- ── 1. 用户档案 ──────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '学习者',
  created_at   timestamptz not null default now()
);

-- ── 2. 每 30 天的小目标 ──────────────────────────────────────
create table if not exists public.goals (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users(id) on delete cascade,
  period_start date not null,               -- 这个 30 天周期的起始日
  title        text not null,
  detail       text default '',
  target       int  not null default 1,     -- 目标次数（比如「背 300 个单词」填 300）
  progress     int  not null default 0,     -- 当前进度
  done         boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ── 3. 大任务 ────────────────────────────────────────────────
create table if not exists public.tasks (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  detail     text default '',
  due_date   date,
  created_at timestamptz not null default now()
);

-- ── 4. 子任务（拆几个自己定）────────────────────────────────
create table if not exists public.subtasks (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  owner      uuid not null references auth.users(id) on delete cascade,
  seq        int  not null default 0,       -- 排序用
  title      text not null,
  detail     text default '',               -- 「需要干什么」
  done       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── 5. 每日困难与心情 ────────────────────────────────────────
create table if not exists public.daily_logs (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  log_date   date not null,
  mood       int,                           -- 1..5，空着也行
  difficulty text default '',               -- 今天遇到的困难
  note       text default '',               -- 补充
  created_at timestamptz not null default now(),
  unique (owner, log_date)                  -- 每人每天只有一条
);

-- ── 6. 学习资源（工具书 / 网课 / 老师）──────────────────────
create table if not exists public.resources (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  kind       text not null,                 -- 'book' | 'course' | 'teacher'
  name       text not null,                 -- 书名 / 课程名 / 老师名
  platform   text default '',               -- 网课平台（B站 / Coursera / …）
  url        text default '',
  subject    text default '',               -- 学科领域，宏观可视化按这个分组
  status     text not null default 'todo',  -- todo | doing | done
  created_at timestamptz not null default now()
);


-- ============================================================
--  权限规则（RLS）—— 这是「真安全」的核心
--
--  口径：登录后才能读；读得到所有人的（互相看进度）；
--        但只能增删改自己的（互不干涉）。
--  anon key 公开写在网页里也没关系，因为真正的门在这里。
-- ============================================================

alter table public.profiles   enable row level security;
alter table public.goals      enable row level security;
alter table public.tasks      enable row level security;
alter table public.subtasks   enable row level security;
alter table public.daily_logs enable row level security;
alter table public.resources  enable row level security;

-- profiles：所有人可读（要显示对方名字），只能改自己的
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_ins    on public.profiles;
drop policy if exists profiles_upd    on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);
create policy profiles_ins  on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_upd  on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- 其余五张表：读全部，写自己的
do $$
declare t text;
begin
  foreach t in array array['goals','tasks','subtasks','daily_logs','resources'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_ins  on public.%I', t, t);
    execute format('drop policy if exists %I_upd  on public.%I', t, t);
    execute format('drop policy if exists %I_del  on public.%I', t, t);

    execute format('create policy %I_read on public.%I for select to authenticated using (true)', t, t);
    execute format('create policy %I_ins  on public.%I for insert to authenticated with check (owner = auth.uid())', t, t);
    execute format('create policy %I_upd  on public.%I for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid())', t, t);
    execute format('create policy %I_del  on public.%I for delete to authenticated using (owner = auth.uid())', t, t);
  end loop;
end $$;


-- ============================================================
--  新用户注册时自动建 profile（否则登录后没有档案行）
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
--  实时同步：把这几张表加进 realtime 发布
--  （两人互相看到对方进度靠这个。报错说「已在发布中」属正常，忽略即可）
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['goals','tasks','subtasks','daily_logs','resources','profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;   -- 已经加过了，跳过
    end;
  end loop;
end $$;


-- ============================================================
--  自检：跑完应该看到 6 张表，每张都有 4 条策略（profiles 是 3 条）
-- ============================================================
select tablename, count(*) as 策略数
from pg_policies
where schemaname = 'public'
group by tablename
order by tablename;
