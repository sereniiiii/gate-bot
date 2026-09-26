-- ════════════════════════════════════════════════════════════════
-- setup-8-mottos.sql · 985 大学的校训（登录页和主页随机显示一句）
--
-- 跑法：Supabase 后台 → SQL Editor → 新建查询 → 整段粘进去 → Run
-- 可以重复执行（幂等），跑几次都不会坏数据、也不会把删掉的校训加回来。
--
-- 做的事：新开一张 mottos 表，装上 39 所 985 高校的校训（各校官网口径），
-- 页面每次打开随机挑一句显示。
--
-- 为什么这张表**没有 owner 列**（和别的表不一样）：
--   别的表记的是「谁做了什么」，所以按人分开。校训是**两个人的共同装饰**，
--   你加一句、对方也看得见，两个人共用一份清单。所以它的权限是
--   「登录就能读，成员就能改」，不按 owner 分。
--
-- 跑之前页面照样能用：内置了一份同样的默认清单兜底，
-- 只是那时候改不了、加的也存不下（会明说去跑这个脚本）。
-- ════════════════════════════════════════════════════════════════

create table if not exists public.mottos (
  id         uuid primary key default gen_random_uuid(),
  school     text not null default '',   -- 哪所学校的校训，空着也行（可以只写一句话）
  text       text not null,              -- 校训原文
  sort       int  not null default 100,  -- 想固定顺序就填，数字小的在前；随机显示时无所谓
  created_at timestamptz not null default now()
);

-- 同一所学校的同一句话只留一条。
-- ⚠️ 不能只拿 text 做唯一键 —— 中国人民大学和天津大学的校训都是「实事求是」，
--    只按 text 去重会让种子数据插到第二条就撞唯一键、整段 insert 失败。
create unique index if not exists mottos_school_text_uniq on public.mottos (school, text);

alter table public.mottos enable row level security;

-- 权限口径和 exams 那张表同一套：先探测 setup-2-lock.sql 建没建 is_member()，
-- 再决定用名单制还是开放制。所以本脚本在 setup-2 之前或之后跑都对，
-- 但 setup-2 之后要**再跑一次**（setup-2 的表名单是写死的，不含 mottos）。
do $$
declare strict_mode boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member'
  ) into strict_mode;

  execute 'drop policy if exists mottos_read on public.mottos';
  execute 'drop policy if exists mottos_ins  on public.mottos';
  execute 'drop policy if exists mottos_upd  on public.mottos';
  execute 'drop policy if exists mottos_del  on public.mottos';

  if strict_mode then
    execute $f$create policy mottos_read on public.mottos
      for select to authenticated using (public.is_member())$f$;
    -- 写不校验 owner：这是两个人共用的装饰，谁都能加、都能改、都能删
    execute $f$create policy mottos_ins on public.mottos
      for insert to authenticated with check (public.is_member())$f$;
    execute $f$create policy mottos_upd on public.mottos
      for update to authenticated using (public.is_member())$f$;
    execute $f$create policy mottos_del on public.mottos
      for delete to authenticated using (public.is_member())$f$;
  else
    execute $f$create policy mottos_read on public.mottos
      for select to authenticated using (true)$f$;
    execute $f$create policy mottos_ins on public.mottos
      for insert to authenticated with check (true)$f$;
    execute $f$create policy mottos_upd on public.mottos
      for update to authenticated using (true)$f$;
    execute $f$create policy mottos_del on public.mottos
      for delete to authenticated using (true)$f$;
  end if;
end $$;


-- ── 种子数据：39 所 985 高校的校训 ──────────────────────────────
-- ⚠️ 只在**表是空的**时候灌一次。这样你以后删掉某几条，再跑这个脚本
--    也不会把它们加回来（不像 mottos_text_uniq 那样会被 on conflict 复活）。
insert into public.mottos (school, text, sort)
select v.school, v.text, v.sort
  from (values
    ('清华大学',         '自强不息，厚德载物',                        1),
    ('北京大学',         '爱国、进步、民主、科学',                    2),
    ('中国人民大学',     '实事求是',                                  3),
    ('北京航空航天大学', '德才兼备，知行合一',                        4),
    ('北京理工大学',     '德以明理，学以精工',                        5),
    ('中国农业大学',     '解民生之多艰，育天下之英才',                6),
    ('北京师范大学',     '学为人师，行为世范',                        7),
    ('中央民族大学',     '美美与共，知行合一',                        8),
    ('南开大学',         '允公允能，日新月异',                        9),
    ('天津大学',         '实事求是',                                 10),
    ('大连理工大学',     '团结、进取、求实、创新',                   11),
    ('东北大学',         '自强不息，知行合一',                       12),
    ('吉林大学',         '求实创新，励志图强',                       13),
    ('哈尔滨工业大学',   '规格严格，功夫到家',                       14),
    ('复旦大学',         '博学而笃志，切问而近思',                   15),
    ('同济大学',         '同舟共济',                                 16),
    ('上海交通大学',     '饮水思源，爱国荣校',                       17),
    ('华东师范大学',     '求实创造，为人师表',                       18),
    ('南京大学',         '诚朴雄伟，励学敦行',                       19),
    ('东南大学',         '止于至善',                                 20),
    ('浙江大学',         '求是创新',                                 21),
    ('中国科学技术大学', '红专并进，理实交融',                       22),
    ('厦门大学',         '自强不息，止于至善',                       23),
    ('山东大学',         '学无止境，气有浩然',                       24),
    ('中国海洋大学',     '海纳百川，取则行远',                       25),
    ('武汉大学',         '自强、弘毅、求是、拓新',                   26),
    ('华中科技大学',     '明德厚学，求是创新',                       27),
    ('中南大学',         '知行合一，经世致用',                       28),
    ('湖南大学',         '实事求是，敢为人先',                       29),
    ('国防科技大学',     '厚德博学，强军兴国',                       30),
    ('中山大学',         '博学、审问、慎思、明辨、笃行',             31),
    ('华南理工大学',     '博学慎思，明辨笃行',                       32),
    ('四川大学',         '海纳百川，有容乃大',                       33),
    ('电子科技大学',     '求实求真，大气大为',                       34),
    ('重庆大学',         '耐劳苦、尚俭朴、勤学业、爱国家',           35),
    ('西安交通大学',     '精勤求学，敦笃励志，果毅力行，忠恕任事',   36),
    ('西北工业大学',     '公诚勇毅',                                 37),
    ('西北农林科技大学', '诚朴勇毅',                                 38),
    ('兰州大学',         '自强不息，独树一帜',                       39)
  ) as v(school, text, sort)
 where not exists (select 1 from public.mottos);


-- ── 自检 ──────────────────────────────────────────────────────
-- ① 应该出现 4 行（4 条策略）
select policyname as 策略名, cmd as 动作, qual as 条件
  from pg_policies
 where schemaname = 'public' and tablename = 'mottos'
 order by policyname;

-- ② 应该看到 39 条校训
select count(*) as 校训条数 from public.mottos;

-- ③ 抽 5 条看看内容和格式对不对
select school as 学校, text as 校训 from public.mottos order by sort limit 5;


-- ════════════════════════════════════════════════════════════════
-- 已知限制
--
-- 1. 北大比较特殊：官方口径是「没有正式校训」，长期沿用的一直是
--    「爱国、进步、民主、科学」。这里按通行的说法收录，你要是觉得不妥，
--    删掉或改成「思想自由，兼容并包」都行 —— 页面上就能改。
--
-- 2. 少数几所在不同资料里写法不一（同济、浙大、中国农大、重大、湖南大学）。
--    这里取的是各校官网/多数来源的版本。校训本来就是宣传口径，
--    有出入以学校官网为准 —— 直接改库或改页面上的那一行就行。
--
-- 3. 表没有 owner 列、也没按人分：两个人共用一份清单，谁都能改别人的。
--    就两个人用，这是刻意的（校训是共同装饰，不是谁的数据）。
-- ════════════════════════════════════════════════════════════════
