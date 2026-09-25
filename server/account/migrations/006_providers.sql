-- Account-server schema v6 (CLAUDE.md D14): EC2 Spot workers beside Hetzner, and what each job cost us. Additive; 005 releases
-- never read the new columns and keep writing hcloud_id and hourly_eur.

alter table workers add column provider text not null default 'hetzner' check (provider in ('hetzner', 'ec2'));
-- The provider's own id: the hcloud server id, or the EC2 instance id.
alter table workers add column provider_id text;
-- USD per hour as billed at most: Hetzner gross converted at USD_PER_EUR, EC2 the Spot max price plus the public IPv4 and disk.
-- Null on rows written before this migration, which spend reads as hourly_eur converted.
alter table workers add column hourly_usd numeric;
update workers set provider_id = hcloud_id::text where hcloud_id is not null;
create unique index workers_provider_id on workers (provider, provider_id) where provider_id is not null;

-- What a job cost: its core seconds at its worker's rate plus its share of fleet idle (fleet.ts idleFactor). reserve_usd is the
-- worst case held while it runs, and caps cost_usd, so a user's spend never passes what the plan paid (queue.ts costProblem).
alter table compute_jobs add column cost_usd numeric not null default 0;
alter table compute_jobs add column reserve_usd numeric;
