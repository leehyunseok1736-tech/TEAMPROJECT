-- YakSokSigan user data schema
-- Run this file in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  patient_age smallint check (patient_age is null or patient_age between 0 and 130),
  breakfast_time time,
  lunch_time time,
  dinner_time time,
  bedtime_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.medications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  legacy_id text,
  name text not null check (char_length(name) between 1 and 200),
  amount text,
  times text[] not null default '{}',
  label text,
  product jsonb,
  start_date date not null default current_date,
  duration_days integer not null default 0 check (duration_days >= 0),
  duration text,
  schedule_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, legacy_id)
);

create table if not exists public.dose_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete cascade,
  dose_date date not null,
  dose_time time not null,
  status text not null check (status in ('taken', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (medication_id, dose_date, dose_time)
);

create index if not exists medications_user_id_idx
  on public.medications(user_id);

create index if not exists dose_records_user_date_idx
  on public.dose_records(user_id, dose_date);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists medications_set_updated_at on public.medications;
create trigger medications_set_updated_at
before update on public.medications
for each row execute function public.set_updated_at();

drop trigger if exists dose_records_set_updated_at on public.dose_records;
create trigger dose_records_set_updated_at
before update on public.dose_records
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.medications enable row level security;
alter table public.dose_records enable row level security;

revoke all on public.profiles from anon;
revoke all on public.medications from anon;
revoke all on public.dose_records from anon;

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.medications to authenticated;
grant select, insert, update, delete on public.dose_records to authenticated;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
on public.profiles for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "medications_select_own" on public.medications;
create policy "medications_select_own"
on public.medications for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "medications_insert_own" on public.medications;
create policy "medications_insert_own"
on public.medications for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "medications_update_own" on public.medications;
create policy "medications_update_own"
on public.medications for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "medications_delete_own" on public.medications;
create policy "medications_delete_own"
on public.medications for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "dose_records_select_own" on public.dose_records;
create policy "dose_records_select_own"
on public.dose_records for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "dose_records_insert_own" on public.dose_records;
create policy "dose_records_insert_own"
on public.dose_records for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.medications
    where medications.id = medication_id
      and medications.user_id = (select auth.uid())
  )
);

drop policy if exists "dose_records_update_own" on public.dose_records;
create policy "dose_records_update_own"
on public.dose_records for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.medications
    where medications.id = medication_id
      and medications.user_id = (select auth.uid())
  )
);

drop policy if exists "dose_records_delete_own" on public.dose_records;
create policy "dose_records_delete_own"
on public.dose_records for delete
to authenticated
using ((select auth.uid()) = user_id);
