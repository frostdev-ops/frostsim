-- Signed Discord interaction roles used to authorize queued guild jobs against current role allowances at claim.
-- Null identifies legacy jobs whose member authorization cannot be re-established without a new interaction.
alter table compute_jobs add column guild_role_ids jsonb
  check (guild_role_ids is null or jsonb_typeof(guild_role_ids) = 'array');
