-- Account-server schema v4 (CLAUDE.md D15; DESIGN.md P3): integration job idempotency. Additive; 003 releases never write it.

-- A caller's key for one job (Loothing sends the Discord interaction id): a repeat of the same POST maps to the first job
-- instead of starting a second paid run.
alter table compute_jobs add column idempotency_key text;
create unique index compute_jobs_idempotency on compute_jobs (source, user_id, idempotency_key) where idempotency_key is not null;
