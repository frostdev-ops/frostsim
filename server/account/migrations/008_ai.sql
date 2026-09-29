-- Account-server schema v8 (CLAUDE.md D17): AI explanations and the Discord takeaway. Additive; 007 releases never read these tables.

-- One row per AI call, the ledger for its cost. Inserted at the call's worst case before any upstream request, then set to what
-- OpenRouter billed. It counts toward the plan cost cap (usage.ts) and the monthly AI cap. user_id is nulled, not cascaded, when the
-- account is deleted: a guild's pool and the global cap must keep counting spend that already happened. Nothing personal is kept here.
create table ai_calls (
  id bigserial primary key,
  user_id uuid references users on delete set null,
  guild_id text,
  source text not null check (source in ('web', 'discord')),
  kind text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);
create index ai_calls_user on ai_calls (user_id, created_at);
create index ai_calls_guild on ai_calls (guild_id, created_at) where guild_id is not null;
create index ai_calls_created on ai_calls (created_at);

-- What the explainer noted about a character for next time. character_key is an HMAC of region/realm/name: the name never lands here.
-- Only the note's author reads it back. Deleted with the account.
create table ai_memory (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  character_key text not null,
  note text not null check (length(note) <= 500),
  created_at timestamptz not null default now()
);
create index ai_memory_user_character on ai_memory (user_id, character_key, created_at);
