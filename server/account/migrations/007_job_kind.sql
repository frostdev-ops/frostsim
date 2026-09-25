-- Account-server schema v7 (CLAUDE.md D15): the Loothing droptimizer. Additive; 006 releases never read the new columns.

-- What an integration job is: 'quick', 'compare' or 'droptimizer'. Null on web and Discord jobs, which do not need it.
alter table compute_jobs add column kind text check (kind in ('quick', 'compare', 'droptimizer'));
-- What a droptimizer's report cannot say: which item, slot and bosses each profileset is (loothing-drop.ts DropMeta).
-- Cleared with the request after 7 days, like every other part of a job that is not the ledger.
alter table compute_jobs add column meta jsonb;
-- Loothing jobs before this were quick sims, or compares, whose create audit row counts its characters (integrations.ts).
update compute_jobs j set kind = case when exists (select 1 from audit_log a where a.action = 'loothing.job.create'
    and a.detail->>'jobId' = j.id::text and a.detail ? 'characters') then 'compare' else 'quick' end
  where j.source = 'loothing';
