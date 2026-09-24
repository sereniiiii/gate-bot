-- ============================================================
--  学习协作页 · 第二道锁（一次性执行，加固用）
--  用法：Supabase 后台 → SQL Editor → New query → 全选粘贴 → Run
--  可重复执行，跑第二遍不会报错
--
--  为什么需要它：
--  setup.sql 的读策略是「任何登录用户可读全部」。而这个页面在公开仓库里，
--  网页源码里带着 anon key，项目又开着自助注册（disable_signup = false）
--  —— 任何人拿到网址就能注册账号、登录、把两个人的数据全部读走。
--
--  这个脚本把口径从「登录就能读」收紧成「在名单里才能读写」：
--  · 名单外的账号登录后看不到任何一行、也写不进任何一行
--  · 名单只能从后台 SQL 改，前端（只拿得到 anon key）永远改不动它
--  · 会把你现有的账号自动收进名单，不需要你手查 uid
-- ============================================================

-- ── 1. 成员名单 ──────────────────────────────────────────────
create table if not exists public.members (
  uid      uuid primary key references auth.users(id) on delete cascade,
  label    text not null default '成员',
  added_at timestamptz not null default now()
);

alter table public.members enable row level security;
grant select on public.members to authenticated;

-- ── 2. 判定函数（必须建在 members 的策略之前，见下面的说明）──
-- security definer：函数以创建者（postgres，表主）身份读 members，
-- 表主默认不受 RLS 约束 ⇒ 不会自己套自己，避免
-- "infinite recursion detected in policy for relation members"。
-- 它对外只回答「你本人在不在名单里」一个布尔值，不外泄名单内容。
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.members where uid = auth.uid());
$$;

grant execute on function public.is_member() to authenticated;

-- ── 3. 名单策略：能看名单，不能改名单 ────────────────────────
-- 故意不建 insert / update / delete 策略 ⇒ 前端没有增删改名单的路径。
-- 注意这里调 is_member()，不能写成对 members 的子查询 —— 那会递归。
drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (public.is_member());

-- ── 4. 把现有账号收进名单 ────────────────────────────────────
-- 就是你之前建好的账号（包括你自己）。已经收过的不重复收。
insert into public.members (uid, label)
select id,
       coalesce(nullif(raw_user_meta_data->>'display_name', ''), split_part(email, '@', 1))
from auth.users
on conflict (uid) do nothing;

-- ── 5. 六张表换成「名单制」策略 ──────────────────────────────
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (public.is_member());

do $$
declare t text;
begin
  foreach t in array array['goals', 'tasks', 'subtasks', 'daily_logs', 'resources'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_ins  on public.%I', t, t);
    execute format('drop policy if exists %I_upd  on public.%I', t, t);
    execute format('drop policy if exists %I_del  on public.%I', t, t);

    -- 名单内：读得到所有人的（两人互相看进度）
    execute format($f$create policy %I_read on public.%I
      for select to authenticated using (public.is_member())$f$, t, t);
    -- 名单内：只能写自己的行（互不干涉）
    execute format($f$create policy %I_ins on public.%I
      for insert to authenticated
      with check (public.is_member() and owner = auth.uid())$f$, t, t);
    execute format($f$create policy %I_upd on public.%I
      for update to authenticated
      using (public.is_member() and owner = auth.uid())
      with check (owner = auth.uid())$f$, t, t);
    execute format($f$create policy %I_del on public.%I
      for delete to authenticated
      using (public.is_member() and owner = auth.uid())$f$, t, t);
  end loop;
end $$;

-- ── 6. 自检查（跑完看这两张结果表）──────────────────────────
-- 6a. 名单里有谁 —— 应该只有你自己的账号
select m.label as 名字, u.email as 邮箱, m.added_at as 加入时间
from public.members m
join auth.users u on u.id = m.uid
order by m.added_at;

-- 6b. 策略数 —— 应该看到 7 张表，每张 3~4 条
select tablename as 表名, count(*) as 策略数
from pg_policies
where schemaname = 'public'
group by tablename
order by tablename;


-- ============================================================
--  以后要加人（比如你的搭档）：
--  1) 后台 → Authentication → Users → Add user 建账号，勾上 Auto Confirm User
--  2) 回 SQL Editor 跑下面这句，把邮箱换成对方的
--
--  insert into public.members (uid, label)
--  select id, split_part(email, '@', 1)
--  from auth.users
--  where email = '对方的邮箱@example.com'
--  on conflict (uid) do nothing;
--
--  另：建议顺手把自助注册关掉（双保险）——
--  Authentication → Sign In / Providers → Email → 关掉 "Allow new users to sign up"
--  上面这道锁已经能挡住名单外的人，关了注册是再少一个口子。
-- ============================================================
