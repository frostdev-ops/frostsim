-- Account-server schema v2 (CLAUDE.md D15; DESIGN.md C4, C5): additive only, so the 001 release still runs on it.

-- The lease sweep (status = 'running' and lease_until < now) otherwise reads the whole job ledger, which is never trimmed.
create index compute_jobs_running on compute_jobs (lease_until) where status = 'running';

-- One identity per provider per user. oauth.ts link() already enforces it under the user-row lock; this is the second guard.
create unique index identities_user_provider on identities (user_id, provider);

comment on column subscriptions.stripe_updated is
  'Epoch ms when billing fetched this state from Stripe; a write with an older value is dropped. Not a Stripe event time.';
