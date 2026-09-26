-- ════════════════════════════════════════════════════════════════
-- setup-10-site.sql · 站名（首页和登录页顶上那个名字）
--
-- 跑法：Supabase 后台 → SQL Editor → 新建查询 → 整段粘进去 → Run
-- 可以重复执行（幂等）：跑第二次不会报错，也不会把改过的名字改回 Alano。
--
-- 做的事：新开一张**只有一行**的 site 表，装站名。默认 'Alano'。
-- 页面在「导出 / 导入」页最下面给了输入框，改完两台设备都会跟着变。
--
-- 为什么只有一行：站名是「这一页叫什么」，不是谁的数据。
--   一行 = 一个名字，没有主键要挑、也没有第二条可选，前端 update 时
--   不用先查 id 再决定改哪条。
--
-- 为什么这张表**没有 owner 列**（和 mottos 一样）：
--   站名是两个人共用的，谁改两边都变。权限是「登录就能读、成员就能改」。
--
-- ⚠️ 没有 delete 策略：这一行删掉页面就没名字可显示了，
--    所以不给删。要还原成默认值就在页面上把名字改成 Alano，或者直接跑：
--      update public.site set title = 'Alano' where id;
--
-- 跑之前页面照样能用：名字用页面里写死的默认值 + 本机记住的上一次那个，
-- 只是改了存不下（会明说去跑这个脚本）。
-- ════════════════════════════════════════════════════════════════

create table if not exists public.site (
  -- 恒为 true 的主键 = 这张表物理上只容得下一行。
  -- 想在 SQL 里写第二条会直接撞主键，不用靠自觉。
  id         boolean primary key default true,
  title      text not null default 'Alano',
  updated_at timestamptz not null default now(),
  constraint site_one_row check (id),
  -- 名字长度闸门。空名字会让页头 h1 变成一个空行、看着像页面坏了；
  -- 太长的名字会把登录卡片顶变形（h1 是 20px，卡片宽 360）。
  -- 页面上那个输入框 maxlength=24，这里再兜一道（绕过页面直接改库时也拦得住）。
  constraint site_title_len check (char_length(btrim(title)) between 1 and 24)
);

-- updated_at 要跟着改动走。只有 insert 时给默认值是没用的 ——
-- 那一列会一直停在「建表那一刻」，看的人以为名字从没改过。
create or replace function public.site_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists site_touch on public.site;
create trigger site_touch
  before update on public.site
  for each row execute function public.site_touch();

alter table public.site enable row level security;

-- 权限口径和 mottos / exams 同一套：先探测 setup-2-lock.sql 建没建 is_member()，
-- 再决定用名单制还是开放制。所以本脚本在 setup-2 之前或之后跑都对，
-- 但 setup-2 之后要**再跑一次**（setup-2 的表名单是写死的，不含 site）。
do $$
declare strict_mode boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member'
  ) into strict_mode;

  execute 'drop policy if exists site_read on public.site';
  execute 'drop policy if exists site_ins  on public.site';
  execute 'drop policy if exists site_upd  on public.site';

  if strict_mode then
    execute $f$create policy site_read on public.site
      for select to authenticated using (public.is_member())$f$;
    -- insert 策略是给「那一行不在了」兜底的：前端用的是 upsert，
    -- 一行都没有时它得能把这行建出来，不然名字永远存不下。
    execute $f$create policy site_ins on public.site
      for insert to authenticated with check (public.is_member())$f$;
    execute $f$create policy site_upd on public.site
      for update to authenticated using (public.is_member())$f$;
  else
    execute $f$create policy site_read on public.site
      for select to authenticated using (true)$f$;
    execute $f$create policy site_ins on public.site
      for insert to authenticated with check (true)$f$;
    execute $f$create policy site_upd on public.site
      for update to authenticated using (true)$f$;
  end if;
end $$;


-- ── 种子数据：那一行本身 ────────────────────────────────────────
-- on conflict do nothing：她以后把名字改成别的，再跑这个脚本**不会**改回 Alano。
-- （这里不用 mottos 那种 where not exists 的写法，因为主键已经保证了唯一，
--   on conflict 是同一件事的现成说法。）
insert into public.site (id, title) values (true, 'Alano')
  on conflict (id) do nothing;


-- ── 实时同步 ──────────────────────────────────────────────────
-- 不加这一句，改完名字对方那台设备要手动刷新才看得到。
-- 写法跟 setup-9 里那段一样：幂等（已经在发布里就跳过），
-- 表不存在也只提示不报错。
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'site'
    ) then
      execute 'alter publication supabase_realtime add table public.site';
      raise notice '已把 site 加进实时同步';
    else
      raise notice 'site 早就在实时同步里了，跳过';
    end if;
  end if;
exception when undefined_table then
  raise notice '没有 site 这张表，跳过实时同步（不影响使用）';
end $$;


-- ── 自检 ──────────────────────────────────────────────────────
-- ① 表结构：应该出现 4 行（id / title / updated_at / 约束不在此列）
select column_name as 列名, data_type as 类型, column_default as 默认值
  from information_schema.columns
 where table_schema = 'public' and table_name = 'site'
 order by ordinal_position;

-- ② 那一行应该在，名字是 Alano：应该恰好 1 行
select id as 单行标记, title as 站名, updated_at as 最后改动时间 from public.site;

-- ③ 策略：应该出现 3 行（read / ins / upd），**没有 delete** 才对
select policyname as 策略名, cmd as 动作, qual as 条件
  from pg_policies
 where schemaname = 'public' and tablename = 'site'
 order by policyname;

-- ④ 试着改一次看触发器跟不跟（跑完这里 updated_at 应该从上面那个值变新）
--    不想留痕就别跑这一句 —— 它真的会把站名改成「测试站名」。
-- update public.site set title = '测试站名' where id;

-- ⑤ 实时同步里现在有哪些表 —— 跑完应该能看到 site（以及 exams / mottos / links）
select tablename as 表名
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;


-- ════════════════════════════════════════════════════════════════
-- 已知限制
--
-- 1) 没有 delete 策略，故意的：这一行删掉页面顶上就没名字了。
--    要还原默认值就把名字改成 Alano，或在 SQL 里跑
--    update public.site set title = 'Alano' where id;
--
-- 2) 两个人共用一行，谁都能改、改了对方下次刷新就变 —— 这是要的效果。
--    但没有「谁改的」记录（没记改动人）。就两个人用，不值得为它加一列。
--
-- 3) 名字限 1~24 个字。超了会被约束挡下来，页面上会弹一句「名字最多 24 个字」。
--
-- 4) 名字只影响浏览器标签页标题和登录页/主页那两个 h1。
--    仓库名、Pages 地址（sereniiiii.github.io/gate-bot/study/）都不受影响 ——
--    那些是 GitHub 那边的，改库改不到。
-- ════════════════════════════════════════════════════════════════
