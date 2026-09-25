-- Account-server schema v5 (CLAUDE.md D15): per-role compute allowances inside a Discord server's pool. Additive; 004 releases
-- never read it.

-- A member's monthly share of the guild pool, by Discord role. role_id = guild_id is @everyone. core_seconds null: up to the pool.
create table guild_role_limits (
  guild_id text not null,
  role_id text not null,
  core_seconds integer check (core_seconds >= 0),
  primary key (guild_id, role_id)
);
