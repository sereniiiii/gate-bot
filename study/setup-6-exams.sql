-- ============================================================
--  考试成绩（一次性执行）
--  用法：Supabase 后台 → SQL Editor → New query → 全选粘贴 → Run
--  可重复执行，跑第二遍不会报错
--
--  做的事：新开一张 exams 表，记「几月几号、哪一科、学校考试还是自己做的
--  试卷、考了多少分」。
--
--  为什么这次**必须**新开一张表（前面几次都特意避开了）：
--  之前的数据（小任务、章节、日记）本来就是「一件事一行」，能塞进已有的表里，
--  所以 setup-3 / setup-4 / setup-5 都是加一列就完事，不用她重新录数据。
--  考试不行 —— 它的字段（日期 / 科目 / 得分 / 满分 / 哪一类）跟原来六张表
--  任何一张都对不上，硬塞就得借别人的列名，以后自己都看不懂。
--
--  跑之前页面照样能用，「考试成绩」那一页会明说去跑这个脚本。
--
--  ⚠️ 如果你以后要跑 setup-2-lock.sql（名单制那一道锁）：
--     它的表名单是写死的六张，不含 exams。跑完 setup-2 之后
--     **把本脚本再跑一次**，exams 就会跟着换成名单制。本脚本可重复执行。
-- ============================================================

create table if not exists public.exams (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  exam_date  date not null,                  -- 几月几号考的
  name       text not null default '',       -- 这场考试叫什么
  subject    text not null default '',       -- 哪一科（和学习资源的「学科」同名就能对上）
  kind       text not null default 'school', -- school = 学校考试 | paper = 自己做的试卷
  score      numeric,                        -- 得分。可以空着（还没出分），之后回来补
  full_score numeric,                        -- 满分。空着就只显示得分，不显示百分比
  note       text not null default '',
  created_at timestamptz not null default now()
);

-- 按人 + 日期倒序翻是最常见的读法；按科目筛也走索引
create index if not exists exams_owner_date_idx on public.exams (owner, exam_date desc);
create index if not exists exams_subject_idx    on public.exams (subject);

alter table public.exams enable row level security;

-- 权限口径和原来六张表一致：登录后可读全部（两人互相看进度），只能写自己的。
-- 但如果你已经跑过 setup-2-lock.sql（名单制），这里要跟着升级成名单制 ——
-- 所以先探测 is_member() 在不在，再决定用哪一套策略。少一张表漏在外面。
do $$
declare strict_mode boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member'
  ) into strict_mode;

  execute 'drop policy if exists exams_read on public.exams';
  execute 'drop policy if exists exams_ins  on public.exams';
  execute 'drop policy if exists exams_upd  on public.exams';
  execute 'drop policy if exists exams_del  on public.exams';

  if strict_mode then
    execute $f$create policy exams_read on public.exams
      for select to authenticated using (public.is_member())$f$;
    execute $f$create policy exams_ins on public.exams
      for insert to authenticated
      with check (public.is_member() and owner = auth.uid())$f$;
    execute $f$create policy exams_upd on public.exams
      for update to authenticated
      using (public.is_member() and owner = auth.uid())
      with check (owner = auth.uid())$f$;
    execute $f$create policy exams_del on public.exams
      for delete to authenticated
      using (public.is_member() and owner = auth.uid())$f$;
  else
    execute $f$create policy exams_read on public.exams
      for select to authenticated using (true)$f$;
    execute $f$create policy exams_ins on public.exams
      for insert to authenticated with check (owner = auth.uid())$f$;
    execute $f$create policy exams_upd on public.exams
      for update to authenticated using (owner = auth.uid())
      with check (owner = auth.uid())$f$;
    execute $f$create policy exams_del on public.exams
      for delete to authenticated using (owner = auth.uid())$f$;
  end if;
end $$;


-- ============================================================
--  自检：应该出现 4 行（4 条策略）
-- ============================================================
select policyname as 策略名, cmd as 动作, qual as 条件
from pg_policies
where schemaname = 'public' and tablename = 'exams'
order by policyname;


-- ============================================================
--  已知限制（两个人用，先不处理）
--
--  1) 「科目」是自由文本，不是一张表。写「数学」和「数学 」会被当成两科
--     （前后空格前端会 trim，但错别字不会）。做成一门一行的表要她先录科目，
--     记一场考试得先建科目，太麻烦。保持文本，前端用已出现过的科目做下拉候选。
--  2) 得分和满分都是 numeric、不带约束，可以填「得分 > 满分」这种数。
--     前端只做展示，不做校验 —— 她自己记的东西，报错反而是打扰。
-- ============================================================
