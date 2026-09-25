-- Account-server schema v7 (CLAUDE.md D15): the Loothing droptimizer. Additive; 006 releases never read the new columns.

-- What an integration job is: 'quick', 'compare' or 'droptimizer'. Null on web and Discord jobs, which do not need it.
alter table compute_jobs add column kind text check (kind in ('quick', 'compare', 'droptimizer'));
-- What a droptimizer's report cannot say: which item, slot and bosses each profileset is (loothing-drop.ts DropMeta).
-- Cleared with the request after 7 days, like every other part of a job that is not the ledger.
alter table compute_jobs add column meta jsonb;
-- Loothing jobs before this were quick sims, or compares, whose create audit row counts its characters (integrations.ts). One
-- scan of audit_log, not one per job. A compare whose audit row was lost (audit is best-effort) reads as 'quick'.
update compute_jobs set kind = 'quick' where source = 'loothing';
update compute_jobs j set kind = 'compare'
  from (select distinct detail->>'jobId' as id from audit_log where action = 'loothing.job.create' and detail ? 'characters') a
  where j.source = 'loothing' and j.id::text = a.id;
