-- ════════════════════════════════════════════════════════════════
-- setup-9-links.sql · 「同一件事」改成可以挂好几条
--
-- 跑法：Supabase 后台 → SQL Editor → 新建查询 → 整段粘进去 → Run
-- 可以重复执行（幂等），跑几次都不会坏数据。
--
-- 做的事：新开一张 links 表，记「哪两条东西其实是同一件事」。
-- 和 setup-5-link.sql 那一列 link_id 的关系：
--   link_id 是**一对一**（A 指 B、B 指 A），一条行只能挂一个对家；
--   现在要的是**多对多** —— 大任务里的「第 5-8 讲」可能同时就是
--   两本书的某几章，30 天小目标也可能就是大任务里的某几步。
--   所以新开一张表，一行 = 一对。
--
--   ⚠️ 旧数据一行都没删：subtasks.link_id 保持原样，页面**照读**
--      （当作一条额外的关联显示出来）。她哪天在界面上点掉它，才会被清空。
--      所以跑完这个脚本，页面上原来绑着的那几对还在，只是旁边多了
--      「＋ 关联…」可以再挂几条。
--
--   ⚠️ 跑之前页面照样能用：旧的那一对一的还能绑（下拉还在），
--      只是挂不了第二条 —— 那时会明说去跑这个脚本。
--
-- 两端可以是 subtask（大任务的一步 / 资源的一章），也可以是 goal
-- （30 天小目标）。倒计时那些 goals（due_date 非空）不参与 ——
-- 它们是 0/1 的截止日，没有「拆解」的余地。
-- ════════════════════════════════════════════════════════════════

create table if not exists public.links (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  a_kind     text not null check (a_kind in ('subtask', 'goal')),
  a_id       uuid not null,
  b_kind     text not null check (b_kind in ('subtask', 'goal')),
  b_id       uuid not null,
  created_at timestamptz not null default now(),
  -- 自己不能跟自己是一件事
  constraint links_not_self check (a_kind <> b_kind or a_id <> b_id)
);

-- 同一对只留一行。
-- ⚠️ 前端写之前会先把这一对**排好序**（(a_kind,a_id) <= (b_kind,b_id)），
--    所以正着写反着写都落在同一行上，不会出现「A→B 和 B→A 两条」。
--    读的时候两个方向都认，所以万一有行是反着存的也照样读得到。
create unique index if not exists links_pair_uniq
  on public.links (a_kind, a_id, b_kind, b_id);

-- 反查用：「这条挂着谁」「谁挂着这条」
create index if not exists links_a_idx on public.links (a_kind, a_id);
create index if not exists links_b_idx on public.links (b_kind, b_id);
-- 页面每次刷新都要把这张表整个读一遍（两个人、几百条量级，够用）
create index if not exists links_owner_idx on public.links (owner);


alter table public.links enable row level security;

-- 权限口径和 exams 那张表同一套：先探测 setup-2-lock.sql 建没建 is_member()，
-- 再决定用名单制还是开放制。所以本脚本在 setup-2 之前或之后跑都对，
-- 但 setup-2 之后要**再跑一次**（setup-2 的表名单是写死的，不含 links）。
do $$
declare strict_mode boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member'
  ) into strict_mode;

  execute 'drop policy if exists links_read on public.links';
  execute 'drop policy if exists links_ins  on public.links';
  execute 'drop policy if exists links_upd  on public.links';
  execute 'drop policy if exists links_del  on public.links';

  if strict_mode then
    -- 读是成员都能读：另一端在对方那儿时（同一个大任务两个人各自拆的步），
    -- 界面上要能显示出来。写只动自己的行。
    execute $f$create policy links_read on public.links
      for select to authenticated using (public.is_member())$f$;
    execute $f$create policy links_ins on public.links
      for insert to authenticated
      with check (public.is_member() and owner = auth.uid())$f$;
    -- 关联本身没有「内容」可改，改就是把旧的一对删掉再建一对，
    -- 所以这里不需要 update 策略；留着是为了以后万一加备注列。
    execute $f$create policy links_upd on public.links
      for update to authenticated
      using (public.is_member() and owner = auth.uid())
      with check (owner = auth.uid())$f$;
    execute $f$create policy links_del on public.links
      for delete to authenticated
      using (public.is_member() and owner = auth.uid())$f$;
  else
    execute $f$create policy links_read on public.links
      for select to authenticated using (true)$f$;
    execute $f$create policy links_ins on public.links
      for insert to authenticated with check (owner = auth.uid())$f$;
    execute $f$create policy links_upd on public.links
      for update to authenticated using (owner = auth.uid())
      with check (owner = auth.uid())$f$;
    execute $f$create policy links_del on public.links
      for delete to authenticated using (owner = auth.uid())$f$;
  end if;
end $$;

-- 实时同步：她那边绑一对，这边不刷新也能看见。
--
-- ⚠️ 顺手把 exams 和 mottos 也补进去。setup.sql 里那份表名单是**写死的**
--    （只含最初六张表），后面新加的表没人把她们加进 realtime 发布。
--    没进发布的表被前端订阅时，Supabase 会给整条频道回一个错误 ——
--    表现是页头那颗小药丸一直显示「未连上实时」，而且**连累前面六张表一起同步不了**。
--    所以这一句不只是为了 links，也是把前面漏掉的两张补上。
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['links', 'exams', 'mottos'] loop
      begin
        if not exists (
          select 1 from pg_publication_tables
           where pubname = 'supabase_realtime'
             and schemaname = 'public' and tablename = t
        ) then
          execute format('alter publication supabase_realtime add table public.%I', t);
          raise notice '已把 % 加进实时同步', t;
        else
          raise notice '% 早就在实时同步里了，跳过', t;
        end if;
      exception when undefined_table then
        -- exams / mottos 还没建（对应的 setup 脚本没跑过）—— 跳过，不影响 links
        raise notice '没有 % 这张表，跳过', t;
      when others then
        raise notice '没能把 % 加进实时同步（不影响使用）：%', t, sqlerrm;
      end;
    end loop;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════
--  自检
-- ════════════════════════════════════════════════════════════════

-- ① 表建好了：应该出现 7 行（id / owner / a_kind / a_id / b_kind / b_id / created_at）
select column_name as 列名, data_type as 类型
  from information_schema.columns
 where table_schema = 'public' and table_name = 'links'
 order by ordinal_position;

-- ② 策略：应该出现 4 行
select policyname as 策略名, cmd as 动作, qual as 条件
  from pg_policies
 where schemaname = 'public' and tablename = 'links'
 order by policyname;

-- ③ 现在挂了几对（刚跑完是 0，除非你已经在页面上关联过）
select count(*) as 关联对数 from public.links;

-- ④ 旧的那一对一的绑定还在不在（应该有值，没被这个脚本动过）
select count(*) as 还在用旧一对一绑定的行数
  from public.subtasks where link_id is not null;

-- ⑤ 实时同步里现在有哪些表 —— 跑完这个脚本后应该能看到 links / exams / mottos
select tablename as 表名
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;


-- ════════════════════════════════════════════════════════════════
--  已知限制（两个人用，先不处理）
--
--  1) 没有外键约束。删掉一条小任务时，由**前端**把挂着它的 links 行删掉
--     （两句话的事，见 app.js 里的 dropLinksOf）。万一没删干净，
--     页面会把找不到对家的那条关联**忽略掉**，不会显示成「关联到空气」。
--     想人工清一遍：delete from public.links where a_id not in
--     (select id from public.subtasks) and a_kind = 'subtask';  （b 端同理）
--  2) 勾一条会**同时**把同一圈里的 subtask 都标完成（一步 = 两本书的那几章，
--     这一步做完了那几章当然也完了；连着好几跳的那一圈也一起）。
--     30 天小目标**不跟着变** —— 它有自己的进度计数，勾一步就宣布一个 30 天
--     目标完成太越权了；她自己去「月度任务」那一页标。
--     日历和动态流里同一圈只算一件（前端按 id 序挑了代表）。
--  3) 关联是「我自己的东西之间」的。对方的步骤/章节不出现在候选里。
-- ════════════════════════════════════════════════════════════════
