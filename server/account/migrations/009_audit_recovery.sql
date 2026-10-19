-- Retry scheduling is separate from the successful provider read used to order subscription state.
alter table subscriptions add column resync_attempted_at timestamptz;
create index subscriptions_resync_attempt on subscriptions (resync_attempted_at nulls first, stripe_subscription_id)
  where status in ('active', 'trialing', 'past_due');

-- New share uploads use immutable attempt keys; null object_key preserves reads of older fixed-key shares.
alter table shares add column object_key text;
alter table shares add column upload_token text;
alter table shares add column upload_started_at timestamptz;
-- Keep every staged key indexed until removed, including failed cleanup and attempts replaced after their lease expired.
create table share_uploads (
  token text primary key,
  share_id text not null references shares on delete cascade,
  object_key text not null unique,
  started_at timestamptz not null
);
create index share_uploads_share on share_uploads (share_id);
