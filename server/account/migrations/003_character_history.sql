-- Account-server schema v3 (CLAUDE.md D15; DESIGN.md C5): gear and DPS history for cloud characters, and patch re-sims. Additive,
-- so the 002 release still runs on it (it never names the new tables, and its job inserts use sources the new check still allows).

-- One row per distinct equipped set saved to a slot: the addon's own names and item levels, not the export itself.
create table character_snapshots (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references cloud_characters on delete cascade,
  created_at timestamptz not null,
  item_level real,
  gear jsonb not null
);
create index character_snapshots_character on character_snapshots (character_id, created_at);

-- One row per recorded sim of a slotted character: a Quick Sim the user ran, in the browser or the cloud (report_id is the browser's
-- own report id, so a re-sync never adds it twice), or a patch re-sim the server queued (job_id).
create table character_sims (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references cloud_characters on delete cascade,
  created_at timestamptz not null,
  source text not null check (source in ('run', 'patch')),
  dps real not null,
  dps_error real,
  fight_style text,
  targets int,
  game_build text,
  report_id text,
  job_id uuid references compute_jobs on delete set null,
  unique (character_id, report_id),
  unique (job_id)
);
create index character_sims_character on character_sims (character_id, created_at);

-- The game build a character was last re-simmed on (or saved on), so a new build queues one patch re-sim.
alter table cloud_characters add column patch_build text;
-- Name, class, spec, realm and region from the export at save time, so the list can match slots to local characters without raw.
alter table cloud_characters add column who jsonb;

alter table compute_jobs add column character_id uuid references cloud_characters on delete set null;
alter table compute_jobs drop constraint compute_jobs_source_check;
alter table compute_jobs add constraint compute_jobs_source_check check (source in ('web', 'discord', 'loothing', 'patch'));
create index compute_jobs_patch on compute_jobs (finished_at) where source = 'patch';
