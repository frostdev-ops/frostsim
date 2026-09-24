-- Account-server schema v1 (CLAUDE.md D14, D15; DESIGN.md C5). schema_migrations is created by migrate.ts before any file runs.
-- Later files are additive only: a rollback is a symlink switch, so the previous release must still work on the new schema.

create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  suspended_at timestamptz,
  stripe_customer_id text unique,
  -- Admin-comped allowance; adds to whatever the subscriptions grant.
  comp_core_seconds bigint not null default 0,
  comp_max_threads int,
  created_at timestamptz not null default now()
);

-- OAuth identities: (provider, subject, name) only; provider tokens are never stored (DESIGN.md A9).
create table identities (
  provider text not null,
  subject text not null,
  user_id uuid not null references users on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);
create index identities_user_id on identities (user_id);

-- id_hash = sha256 hex of the cookie value; the value itself is never stored.
create table sessions (
  id_hash text primary key,
  user_id uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index sessions_user_id on sessions (user_id);

-- items = [{ lookupKey, quantity, coreHours? }]; coreHours comes from the Stripe Price metadata core_hours.
-- stripe_updated = the Stripe timestamp of the state written, used to reject out-of-order webhook writes.
create table subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references users on delete cascade,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  items jsonb not null default '[]',
  guild_id text,
  stripe_updated bigint,
  updated_at timestamptz not null default now()
);
create index subscriptions_user_id on subscriptions (user_id);
create index subscriptions_guild_id on subscriptions (guild_id) where guild_id is not null;

-- Webhook idempotency.
create table stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

create table workers (
  id uuid primary key default gen_random_uuid(),
  hcloud_id bigint unique,
  server_type text,
  -- sha256 hex of the worker's bearer token.
  token_hash text unique,
  cores int,
  status text,
  hourly_eur numeric,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  deleted_at timestamptz
);

-- The queue AND the usage ledger: usage = SUM(core_seconds) over a period (usage.ts).
create table compute_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users on delete cascade,
  guild_id text,
  source text not null check (source in ('web', 'discord', 'loothing')),
  pack_id text not null,
  threads int not null,
  request jsonb,
  -- The assembled { profile, args } handed to the worker.
  payload jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  worker_id uuid references workers on delete set null,
  attempts int not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  wall_seconds real,
  core_seconds real not null default 0,
  summary jsonb,
  error text
);
create index compute_jobs_queued on compute_jobs (created_at) where status = 'queued';
create index compute_jobs_user on compute_jobs (user_id, created_at);
create index compute_jobs_guild on compute_jobs (guild_id, created_at);

-- raw = the addon export text (6.5 KB typical, capped at 64 KB), re-parsed on both ends.
create table cloud_characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  label text not null,
  raw text not null,
  bytes int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cloud_characters_user_id on cloud_characters (user_id);

-- Unlisted hosted shares; the blob lives in R2 at shares/<id>.json.gz.
create table shares (
  id text primary key check (id ~ '^[0-9A-Za-z]{10,}$'),
  user_id uuid not null references users on delete cascade,
  title text,
  bytes int,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index shares_user_id on shares (user_id);

create table integration_grants (
  user_id uuid not null references users on delete cascade,
  integration text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, integration)
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users on delete set null,
  actor text not null,
  action text not null,
  detail jsonb
);
create index audit_log_user_id on audit_log (user_id, at);
