-- EstimateAce AI Receptionist spam controls (Nov 2026)
-- Run once in Supabase SQL Editor (project jiujzujkednnkjymawdk) when the PR merges.
-- Safe to re-run.
--
-- Leads themselves stay in the SETTINGS profile JSON (profile.aiReceptionistMessages);
-- each call lead now carries spam / spamReason / callSid there. These tables add:
--   1) a per-contractor caller blocklist ("Mark as spam")
--   2) a one-row-per-CallSid ledger so a call produces exactly one lead + one notification

-- 1) Blocked caller numbers (owner-only via RLS)
create table if not exists public.receptionist_blocked_numbers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  phone_e164 text not null,
  reason text,
  source_lead_id text,
  created_at timestamptz not null default now(),
  constraint receptionist_blocked_numbers_user_phone_key unique (user_id, phone_e164)
);

create index if not exists receptionist_blocked_numbers_user_idx
  on public.receptionist_blocked_numbers (user_id);

alter table public.receptionist_blocked_numbers enable row level security;

drop policy if exists "blocked numbers: owner select" on public.receptionist_blocked_numbers;
create policy "blocked numbers: owner select" on public.receptionist_blocked_numbers
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "blocked numbers: owner insert" on public.receptionist_blocked_numbers;
create policy "blocked numbers: owner insert" on public.receptionist_blocked_numbers
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "blocked numbers: owner delete" on public.receptionist_blocked_numbers;
create policy "blocked numbers: owner delete" on public.receptionist_blocked_numbers
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.receptionist_blocked_numbers from anon;
grant select, insert, delete on public.receptionist_blocked_numbers to authenticated;

-- 2) Call finalization ledger (service role only — RLS on, no policies)
create table if not exists public.receptionist_call_finalizations (
  call_sid text primary key,
  user_id uuid references auth.users (id) on delete cascade,
  outcome text not null default 'pending',
  lead_id text,
  is_spam boolean not null default false,
  spam_reason text,
  caller_words integer,
  notified boolean not null default false,
  trigger text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists receptionist_call_finalizations_user_idx
  on public.receptionist_call_finalizations (user_id, created_at desc);

alter table public.receptionist_call_finalizations enable row level security;
revoke all on public.receptionist_call_finalizations from anon, authenticated;
