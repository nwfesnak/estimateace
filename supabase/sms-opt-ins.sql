-- Public / keyword SMS consent log (A2P compliance trail)
create table if not exists public.sms_opt_ins (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  opted_in boolean not null default true,
  method text not null default 'web_form',
  source text,
  ip text,
  user_agent text,
  confirmed_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_opt_ins_phone_idx on public.sms_opt_ins (phone);
create unique index if not exists sms_opt_ins_phone_unique on public.sms_opt_ins (phone);

alter table public.sms_opt_ins enable row level security;
