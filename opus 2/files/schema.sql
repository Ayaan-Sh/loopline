-- Loopline Console — database schema
-- Run this once in the Supabase SQL editor (Database → SQL → New query).
-- Safe to re-run: every statement is guarded.

create extension if not exists "pgcrypto";

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null default 'Unknown',
  phone          text,
  email          text,
  source         text not null default 'manual',
  campaign_id    text,
  campaign_name  text,
  property_type  text,
  locality       text,
  budget         numeric,
  timeline       text,
  stage          text not null default 'NEW',
  score          integer not null default 0,
  band           text not null default 'COLD',
  consent        boolean not null default false,
  attempts       integer not null default 0,
  notes          text default '',
  external_id    text,
  owner_id       uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_contact_at timestamptz
);

create unique index if not exists leads_phone_key on public.leads (phone) where phone is not null;
create unique index if not exists leads_external_key on public.leads (external_id) where external_id is not null;
create index if not exists leads_stage_idx on public.leads (stage);
create index if not exists leads_band_idx on public.leads (band);
create index if not exists leads_created_idx on public.leads (created_at desc);
create index if not exists leads_campaign_idx on public.leads (campaign_id);

alter table public.leads
  drop constraint if exists leads_stage_check;
alter table public.leads
  add constraint leads_stage_check check (stage in
    ('NEW','WORKING','ENGAGED','QUALIFIED','SV_BOOKED','NEGOTIATION','WON','LOST','DNC'));

alter table public.leads
  drop constraint if exists leads_band_check;
alter table public.leads
  add constraint leads_band_check check (band in ('HOT','WARM','COLD'));

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

create table if not exists public.lead_messages (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  direction   text not null check (direction in ('inbound','outbound')),
  channel     text not null default 'whatsapp',
  body        text not null,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists lead_messages_lead_idx on public.lead_messages (lead_id, created_at);

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

create table if not exists public.lead_activity (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  type        text not null,
  channel     text,
  summary     text not null default '',
  actor       text not null default 'console',
  created_at  timestamptz not null default now()
);

create index if not exists lead_activity_lead_idx on public.lead_activity (lead_id, created_at desc);

/* ------------------------------------------------------------------ */
/* Follow-up queue                                                     */
/* ------------------------------------------------------------------ */

create table if not exists public.followup_tasks (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  step        integer not null default 1,
  channel     text not null default 'whatsapp',
  body        text not null default '',
  due_at      timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  created_at  timestamptz not null default now()
);

create index if not exists followup_due_idx on public.followup_tasks (status, due_at);
create index if not exists followup_lead_idx on public.followup_tasks (lead_id);

/* ------------------------------------------------------------------ */
/* Keep updated_at honest                                              */
/* ------------------------------------------------------------------ */

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------------ */
/* Reporting view                                                      */
/* ------------------------------------------------------------------ */

create or replace view public.pipeline_summary as
select
  band,
  stage,
  count(*)                                   as leads,
  coalesce(sum(budget), 0)                   as pipeline_value,
  round(avg(score))                          as avg_score,
  count(*) filter (where last_contact_at > now() - interval '3 days') as touched_recently
from public.leads
group by band, stage;

/* ------------------------------------------------------------------ */
/* Row level security                                                  */
/* ------------------------------------------------------------------ */
-- The server talks to Supabase with the service role key, which bypasses RLS.
-- These policies only matter if you also query from a browser with the anon
-- key. Default posture: deny everything to anon, allow signed-in staff.

alter table public.leads          enable row level security;
alter table public.lead_messages  enable row level security;
alter table public.lead_activity  enable row level security;
alter table public.followup_tasks enable row level security;

drop policy if exists "staff read leads" on public.leads;
create policy "staff read leads" on public.leads
  for select to authenticated using (true);

drop policy if exists "staff write leads" on public.leads;
create policy "staff write leads" on public.leads
  for all to authenticated using (true) with check (true);

drop policy if exists "staff read messages" on public.lead_messages;
create policy "staff read messages" on public.lead_messages
  for select to authenticated using (true);

drop policy if exists "staff read activity" on public.lead_activity;
create policy "staff read activity" on public.lead_activity
  for select to authenticated using (true);

drop policy if exists "staff read tasks" on public.followup_tasks;
create policy "staff read tasks" on public.followup_tasks
  for select to authenticated using (true);
