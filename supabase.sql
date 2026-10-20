-- Shoob scraper schema. Run once in Supabase SQL Editor.
-- Keep SUPABASE_SERVICE_ROLE_KEY server-side only; never place it in browser code.
create extension if not exists pgcrypto;

create table if not exists public.cards (
  id text primary key,
  name text not null,
  tier text,
  series text,
  image_url text,
  author text,
  author_link text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists cards_tier_idx on public.cards (tier);
create index if not exists cards_series_idx on public.cards (series);
create index if not exists cards_name_idx on public.cards using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(series,'')));

create table if not exists public.event_cards (
  id text primary key,
  name text not null,
  tier text,
  series text,
  image_url text,
  author text,
  author_link text,
  event_slug text not null,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists event_cards_event_idx on public.event_cards (event_slug);
create index if not exists event_cards_tier_idx on public.event_cards (tier);

create table if not exists public.catalog_state (
  catalog text primary key check (catalog in ('cards','events')),
  record_count bigint not null default 0,
  storage_path text not null,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  status text not null default 'missing',
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  catalog text not null,
  trigger text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_found bigint,
  records_added bigint,
  error text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists sync_runs_started_idx on public.sync_runs (started_at desc);

create table if not exists public.system_logs (
  id text primary key,
  timestamp timestamptz not null default now(),
  level text not null,
  component text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb
);
create index if not exists system_logs_timestamp_idx on public.system_logs (timestamp desc);
create index if not exists system_logs_level_timestamp_idx on public.system_logs (level, timestamp desc);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  key_hash text not null unique,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  disabled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

-- Tables are accessed by the trusted Render service role. Browser access is denied by RLS.
alter table public.cards enable row level security;
alter table public.event_cards enable row level security;
alter table public.catalog_state enable row level security;
alter table public.sync_runs enable row level security;
alter table public.system_logs enable row level security;
alter table public.api_keys enable row level security;
-- Intentionally no anon/authenticated policies: use server-side service role for admin and sync.

-- Create a private Storage bucket named `shoob-catalogs` in Supabase Storage.
-- Expected object paths: cards.json and events.json. Keep bucket private unless you deliberately choose public exports.
