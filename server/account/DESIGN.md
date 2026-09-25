# Frostsim Cloud: design

Optional online features on top of the browser app: accounts, Stripe billing, cloud compute on native simc,
cloud character slots, hosted report links, and a Discord bot with a Loothing integration. They live on the
long-lived `cloud` branch. `main` carries only the pieces that change nothing for users: the pure request
assembly both sides share, a remote-engine seam that is `null` by default, a build flag that is off by default,
the local `/api/v1` pass-through and the surface guard.

Code comments cite this file as `DESIGN.md <id>`: `A` architecture, `C` contracts, `P` protocols, `R` risks.

## Guarantees

- The browser is the default for everyone without a compute plan, and always the fallback. Anonymous, browser-only use, the local IndexedDB library,
  fragment share links (`#/r/`, `#/share/`) and the GET-only `/api/wow` proxy are unchanged.
- Everything new is opt-in and off by default: `VITE_FEATURE_ACCOUNTS` at build time, `FEATURES` on the server.
  A flag-off build contains no account code, no quoted `"/api/v1` literal and no `frostsim.account` string, and
  makes no `/api/v1` request. `scripts/check-surface.mjs` enforces this in CI.
- Nothing is sent to the account server until the user signs in or opens the account dialog (marker
  `localStorage['frostsim.account']`).

## Architecture (A)

| # | Decision |
| --- | --- |
| A1 | One Node service, `server/account-server.mjs` on `127.0.0.1:3012`, its own systemd unit, user and env file. The Battle.net proxy (`server/api-server.mjs`, `functions/api/**`) is untouched. |
| A2 | nginx gets one block, `location ^~ /api/v1/`, proxied to 3012 with the same security headers. `/api/wow/*` still matches `location /api/`. |
| A3 | Plain fetch handler: a regex route table, per-route body caps, no framework. |
| A4 | Dependencies: `postgres`, `aws4fetch`, `ioredis`. Stripe, Hetzner, OAuth and Discord use `fetch`; HMAC and Ed25519 use `node:crypto`. |
| A5 | Redis is a cache, never the record: sessions (5 min), rate-limit windows, single-use OAuth states (10 min), job progress lines (the last 500, 1 h), native-build lookups (10 min, 1 min for a miss) and Discord reply tokens (15 min). Every key has a TTL and the `frostsim:` prefix. Without Redis, sessions read Postgres, rate limits fail open, progress lines are dropped and a Discord `/sim` is cancelled because its result could not be posted. |
| A6 | Job progress reaches the browser by polling about once a second. No SSE. |
| A7 | One job runs on one worker, at the plan's width capped by the configured server type's cores (`HCLOUD_SERVER_TYPE`, default CPX62: 16 shared AMD vCPU at €0.245/h, which measured faster per run than the dedicated CCX33 (CCX43 and CCX53 were not measurable under the project's core limit); CCX53 once the project may create 32 dedicated cores). Jobs are not split across servers. A Hetzner project's dedicated-core limit bounds both the type and `WORKER_MAX`: set `WORKER_MAX` to at most limit ÷ cores. |
| A8 | The Discord bot is an HTTP interactions endpoint inside the account server. No gateway process. `/sim` and `/compare` (2-6 cloud or Armory characters, a fight or one of the site's dungeon routes) edit their reply (ephemeral unless `share:true`) with a progress embed every few seconds, then a result embed built from the job's report (`discord-embeds.ts`) with a hosted-report link and a "Post in channel" button (a component interaction that posts the stored result once, for the invoker only, for 24 h). A Dungeon Route compare with tanks or healers enqueues one job per role (`role-share.ts`) and merges them. |
| A9 | OAuth provider tokens are never stored, only `(provider, subject, display_name)`. |

## Contracts (C)

**C1 Runtime.** Logic lives in `server/account/**/*.ts` with extensionless imports and is always bundled with
esbuild (`npm run account:build`, target `node22`, with a `createRequire` banner). Production runs Node 22, so no
newer API is used. The server may import the pure browser modules it shares: `src/lib/simc/assemble.ts`,
`options.ts`, `quick-request.ts`, `presets.ts`, `report.ts`, `detail.ts`, `src/lib/import/character.ts`, `src/lib/battlenet/contract.ts`,
`src/lib/store/records.ts`, `src/lib/store/report-share.ts`. Never `job.ts`, `capability.ts`, `versions.ts` or
anything using `import.meta.env`. `tsconfig.server.json` type-checks `server/**` and `functions/**` in
`npm run check`.

**C2 HTTP.** Request bodies are streamed under a per-route cap (413 over it): 64 KiB by default, 256 KiB for cloud
characters, 1 MiB for compute submits, worker results and the Stripe webhook, 16 MiB for share blobs. `Set-Cookie` headers are written
individually. Responses stream. The request origin is `PUBLIC_ORIGIN`, never the Host header. Every
state-changing session route requires `Origin === PUBLIC_ORIGIN`, and any body it carries must be JSON (for blob
uploads, `application/gzip`). Errors are `{ error, message }` and never echo an upstream body. Every response
carries `Cache-Control: no-store` and `nosniff`. Background work runs as named tasks that never overlap
themselves.

**C3 Config.** Environment names are printed at startup, values never. `FEATURES` is a comma list of
`accounts`, `billing`, `compute`, `shares`, `discord`; a disabled group answers 404, and disabled compute answers
503 so the browser runs the sim itself. Any enabled feature makes `DATABASE_URL` and a `SESSION_SECRET` of at least
32 bytes mandatory: without them the process refuses to start. An enabled feature without its own credentials (Stripe
keys for `billing`, the R2 keys for `compute` and `shares`, the Discord public key and application id for `discord`)
answers 503 `unconfigured`.
`ADMIN_ONLY=1` restricts sessions and jobs to admins (staging); `ADMIN_IDENTITIES` promotes `provider:subject`
pairs on login. `R2_ENDPOINT` overrides the R2 account endpoint (jurisdiction endpoints, S3-compatible testing).

**C4 Storage.** Postgres is the record: a pool of 5, plain `.sql` migrations applied at startup under an advisory
lock, each compatible with the previous release. R2 is reached only by the server; the browser gets our own
URLs. Engines bucket: `engines/<packId>/simc-linux-x64.zst` with `x-amz-meta-sha256` and a sibling `.sha256`.
Data bucket: `shares/<id>.json.gz`, `results/<jobId>.json.gz` (a 1-day lifecycle rule).

**C5 Data model** (`migrations/`): `users` (role, suspension, Stripe customer, comped allowance), `identities`
(unique per provider per user), `sessions` (sha256 of the cookie only), `subscriptions` (items with lookup key,
quantity and `core_hours` from the Price metadata), `stripe_events` (idempotency), `compute_jobs` (the usage
ledger), `workers`, `cloud_characters` (the addon export text, not a parsed record, plus `who`: name, class, spec,
realm and region at save time), `character_snapshots`, `character_sims`, `shares`, `integration_grants`, `audit_log`, `guild_role_limits` (migration 005: per-role
allowances inside a Discord server's pool, P5).

Slots are the characters (2026-09-25). Signed in, every character on a device sits in a slot: the Character page's
roster is the slot list, an import or update fills or rewrites the character's slot, a rename relabels it and a delete
frees it on every device (`src/lib/account/slots.svelte.ts`, through `setCharacterSync` in `app.svelte.ts`). A sync on
sign-in and on each visit to the Character page brings down characters saved elsewhere, drops ones deleted elsewhere and
puts characters without a slot into free ones, newest first; the rest stay on that device only. `POST /characters`
replaces the account's character that is the same one in the game (name, class, realm, region) instead of taking a
second slot, and both writes answer `updatedAt` so the browser knows which side changed.

Character history (migration 003). A save whose equipped set differs from the newest snapshot adds one to
`character_snapshots`: the addon's own item names and levels, and the game's 16-slot average. The Character page uploads
this device's finished Quick Sims of a slotted character to `character_sims` (`POST /characters/:id/sims`, deduped on the
browser's report id). The `patch-resims` task (compute feature, every 10 minutes) compares each character's `patch_build`
with the game build of the newest native pack: a character with none takes the current build without a run, and one
behind queues a Patchwerk Quick Sim as a `patch` job on the owner's allowance. A plan refusal skips that build; a full
queue or no capacity retries it. Finished patch jobs become `character_sims` rows. At most 200 snapshots and 500 sims are
kept per character, and all of it is deleted with the character and included in the account export.

**C6 Entitlements.** One plan table, `src/lib/account/plans.ts`, feeds the server catalog, the account dialog and
`scripts/stripe-catalog.mjs`, which creates the Stripe Prices. Lookup keys are `<plan>_<term>`, with terms `monthly`,
`semiannual` and `yearly`:

| Plan (shown as) | Core-hours a month | Threads | Character slots | Hosted links | Monthly | 6 months | Yearly |
| --- | --- | --- | --- | --- | --- | --- | --- |
| No plan (Free) | - (runs stay in the browser) | - | 1 | no | free | - | - |
| `compute_s` (Frostbite) | 20 (≈ 6,400 standard sims) | 8 | 2 | yes | $3 | $16 | $29 |
| `compute_m` (Glacier) | 50 (≈ 16,000) | 16 | 3 | yes | $5 | $27 | $48 |
| `compute_l` (Avalanche) | 120 (≈ 38,000) | 16 (32 once the Hetzner project allows it) | unlimited (fair use: 100) | yes | $10 | $54 | $96 |
| `discord_guild` (Guild Cloud, one Discord server's pool) | 80 (≈ 25,000) | 8 | - | - | $10 | $54 | $96 |

Slots do not stack across plans: an account has 1 plus its best plan's extra, up to the fair-use ceiling. Characters over
the limit after a downgrade stay (download, replace, delete), and a new save waits for a free slot. A Price's `core_hours` metadata overrides the table's hours, so a promotion needs no
deploy. `entitlementsFor` is pure. Active statuses are `active`, `trialing`, `past_due`; a subscription stops granting 3
days after its stored period ends (a missed renewal webhook), and an hourly task re-reads such rows from Stripe. Usage is
`SUM(core_seconds)` over the current period, and 6-month and yearly periods are metered in monthly slices from their start
(the day clamped to short months), so the allowance is monthly on every term. Guild jobs count only against the guild.
Admins can comp core-hours and threads. Without a plan an account has 1 slot and no compute or hosted shares. "Standard sim" is 4,000
iterations of a typical profile, about 11.2 CPU seconds (Phase 0); the dialog shows allowances and remainders in it.

**C7 Auth.** `__Host-fs_sid`: 32 random bytes, only its sha256 stored, `HttpOnly; Secure; SameSite=Lax; Path=/`,
30 days. `__Host-fs_oauth`: an HMAC-signed state, PKCE verifier, mode and return path, same attributes, 10 minutes,
consumed once. Return paths must match `#/...`. Sign-in starts only from our own pages or a typed URL (Fetch Metadata
`Sec-Fetch-Site`), at most 30 starts per IP per 10 minutes. Linking never merges accounts; the last
identity cannot be unlinked, and unlinking rotates the session and signs out other devices. Suspended users have
no session.

**C8 Compute.** The server decides threads (the plan's width); the client never sends one. It accepts only a
structured request, validates it with the browser's own `validateRequest` and `assembleRun`, and refuses Expert
Mode raw scripts, injection slots, HTML reports, template variables (`$(...)`), control characters, bare tokens simc
would open as a file, every file option and the options the app sets itself. Refusals: 400 invalid, 402 no plan or
no allowance, 403 suspended (or not an admin under `ADMIN_ONLY`), 409 no native build for the pack, 429 more than 30
submits a minute or 3 jobs already queued per user or guild, 503 disabled, unconfigured or no capacity. One job per
user or guild runs at a time; claims skip a scope with a running job. The allowance is checked again at claim. A queued job
fails after 15 minutes without a claim while nothing else of its user or guild runs. A job whose worker stops renewing its lease is requeued once, unmetered.
Metering is the CPU seconds systemd accounted to the job (the worker reports them from `systemd-run --wait`), capped at
threads × the worker's wall seconds clamped to the coordinator's claim-to-complete time; on shared vCPUs a busy neighbour
lengthens the wall time, not the CPU time. An agent that reports no CPU time is metered at the cap. A cancel or failure
while running is metered threads × claim-to-then, capped at 1800 s. The request and assembled run are kept 7 days,
then only the ledger columns remain. Native simc is built per engine pack by `scripts/update-engines.mjs`
from the pack's own source, so native and wasm are the same revision.

**C9 Browser seam.** `job.ts` exports `setRemoteEngine(fn | null)`, `null` by default. It is consulted after the
engine capability check, and only for a published engine pack (`/engine/versions/<id>/`) and a guided request without
Expert Mode text or an HTML report. `src/lib/simc/remote.ts` returns a Worker-shaped object speaking the existing
worker protocol: it submits the job, polls every second, reports queueing and progress, fetches and decompresses the
result and posts `done`, so the report renders exactly like a browser run. It replays the run on the real browser
engine, and says so, when the submit is refused (any error status) or unreachable, when polls keep failing for 60 s,
when no server claims the job within 150 s (again after a requeue), when the job fails or is cancelled elsewhere, and
when the result download fails or takes over 150 s. Closing the page cancels the cloud job. Cloud runs carry
`placement: 'cloud'` and the arguments the worker actually ran.

Placement (`src/lib/account/placement.svelte.ts`): with a compute plan, runs go to the cloud by default, and a "Run on" switch beside
the character picker on every tool screen keeps an explicit choice. Avalanche (`compute_l`) adds Hybrid, its default
(`src/lib/simc/hybrid.ts`): a run made of two or more independent sims (pieces) runs on this browser and Frostsim Cloud at once,
in chunks from one queue, and concatenates the chunk reports into one. Estimates come from one cost model shared with the server
(`src/lib/simc/cost.ts`): work is pieces x iterations x fight seconds; iterations for a target error come from the DPS spread; a
side's speed is a fitted start-up plus seconds per unit per thread. This device fits its own speed and spread from its finished
runs (`speed-store.ts`, localStorage); the server fits the cloud's from its last 200 finished jobs and returns them from
`GET /api/v1/compute/capacity` (`capacityView` in `compute/queue.ts`), with where a job of the user's width would start and when:
`warm`, `booting` (the rest of its boot), `cold` (median created-to-first-claim of the last 20 workers, plus half a tick), `queued`
(a slot simulation: running jobs finish at their own pace from their progress, queued jobs ahead take slots for their predicted
run) or `none`, which runs everything here without submitting. Each side takes the next chunk when it is free: half of the share
that makes both finish together, counting start-ups and the cloud's wait, so chunks shrink and the split corrects itself as live
paces replace past ones; a side that would finish after the other could do everything alone takes nothing. At the end an idle
side takes back a cloud chunk no server has claimed, or races the other side's last chunk when it would finish it 25% sooner, and
cancels the loser. At most 8 cloud jobs per run; with no measurements, chunks follow thread share. When one
side alone is predicted to finish sooner, the whole run goes there, and the run panel says why. Three kinds split: profileset candidates (Top Gear,
Droptimizer, Crest and Compare batches; profileset results appended), the characters of a multi-character Quick Sim (each its own
sim under `single_actor_batch=1`; the first character stays local and the cloud's players are appended) and Stat Weights by
`scale_only` stat (each player's `scale_factors`, `scale_factors_all` and `scale_deltas` unioned; with `normalize_scale_factors`
the primary stat runs on both sides so each side normalizes against its own measurement, and the local value is kept). Nothing
statistical is merged; a single-actor Quick Sim is never split and goes to the cloud whole. A declined cloud share replays here
only after the local share's engine has shut down, because one engine run needs about 2 GB. Progress counts candidates finished on
both sides; the other kinds show the running side's own progress. The run panel states the placement of every run
(`src/lib/account/run-place.svelte.ts`, set by the engines): the hybrid split by count or name, a whole cloud run and why a hybrid
choice did not split, or a run the cloud handed back to this browser.

**C10 Account UI.** Code under `src/lib/account/` is loaded only by dynamic import behind the flag. Hosted links are
`#/s/<id>` with a 22-character base62 id. Hosted share payload: `gzip(JSON(makePortable('report', { shared, rawReport })))`, at most 16 MiB compressed and 32 MiB
inflated, validated with `validateReport` on both ends. Blobs are served as `application/gzip` with
`Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: attachment` and `nosniff`; simc's
HTML report is never hosted. Limits: 10 share writes a minute per user, 120 views a minute per IP. A share never
uploaded within a day is revoked. When a user loses hosted shares, their shares expire 30 days later unless they
resubscribe first.

## Protocols (P)

**P1 Worker protocol.** Workers pull over HTTPS with a per-server bearer token (only its sha256 is stored).
- Every authenticated worker call is a heartbeat. A worker silent for 3 minutes (10 after creation) is deleted and
  its jobs released.
- `POST /api/v1/worker/claim { freeCores, agentVersion }` long-polls up to 25 s. It returns `{ jobId, threads, profile, args, engine: { url, sha256 }, resultPut: { url }, leaseSeconds }` or 204.
  Presigned URLs last 4200 s. Nothing in a claim identifies the user.
- `POST /api/v1/worker/jobs/:id/progress { lines }` (at most 200) extends the 60 s lease and answers `{ cancel }`.
- `POST .../complete { wallSeconds, cpuSeconds?, summary, notices? }` and `POST .../fail { error, notices? }`. `notices` is at
  most 200 lines of simc's stderr, 500 characters each. A worker that no longer holds the job gets 409.
- Servers boot from a snapshot with `frostsim-worker.service` disabled; cloud-init writes
  `/etc/frostsim/worker.env` (coordinator URL and token) and enables it. simc runs under `systemd-run` as a
  dynamic user with no network, no capabilities and a syscall filter, in an empty root that sees only `/usr`, the
  engine cache (read-only) and its own job directory. Its share of memory and CPU, 512 tasks, 1 GiB per file and
  1800 s are its limits. Only the profile and report paths are mapped to the job directory; the agent refuses any
  other argument that could open a file.

**P2 Engine pack for jobs without a browser** (Discord, Loothing): the newest pack in the updater's index with
this release's compat and a native build.

**P3 Compute API** (`compute/queue.ts`): `enqueueJob`, `jobView` (lines by cursor; `notices` and `effective`
once done), `resultBytes`, `cancelJob`. Every source goes through the same checks.

Loothing contract (`integrations.ts`, agreed with the Loothing bot 2026-09-25). POST `jobs` takes an `Idempotency-Key`
(1-64 of `[A-Za-z0-9_-]`, Loothing sends the Discord interaction id): a repeat for the same user, or a concurrent create
that loses the unique index (migration 004), answers 200 with the first job. 429 and 503 refusals carry `Retry-After`
(rate-limited 60 s, too-many-jobs 15 s, capacity and compute-disabled 30 s). A job reads as `{id, status, position?,
error?, summary?, characterId, characterLabel, fightStyle, createdAt, finishedAt?}`; only Loothing's own jobs for that
user are visible. DELETE cancels (a queued job is free, a running one is metered to the cancel) and answers 409
`finished` once terminal. Loothing retries a create only after a network error or a non-JSON 5xx, with the same key.

Agent additions (agreed with Loothing 2026-09-25, for its Discord agent). POST `jobs` takes `characterIds` (2-6 distinct slots)
in place of `characterId`: one compare job, built like Discord `/compare`, counted and metered as one job, with `characterId`
null; a set simc cannot run together answers 422 `unbuildable`. An optional `origin` (`agent` or `command`) goes into the audit
row only. GET `jobs` takes `days` (1-30, default 1) and `limit` (1-100, default 20); the summary is kept for good. GET
`jobs/:id/detail` is `loothing-detail.ts`'s compact report (engine, fight, and per character the DPS distribution, fight length,
talents, gear, buffed stats, top 15 abilities and buffs, resource overflow and measured stat weights), read from the stored
result: 409 `not-done` until the job is done, 410 `expired` once R2's one-day lifecycle has removed it. `/resolve` adds each
slot's `name`, `class`, `spec`, `realm`, `region` (from `who`) and `itemLevel` (latest snapshot) where recorded. Loothing
may store its own copy of the summaries and detail of jobs it started (allowed by the operator 2026-09-25).

**P4 Sign-in landing.** The callback redirects to `/?account=<code>#<return>` (`signed-in`, `linked`,
`error-<reason>`). The UI shows the message only when `/me` agrees with it and strips the parameter. Stripe
returns with `billing-success` or `billing-cancelled`.

**P5 Guild checkout.** `/frostsim subscribe` (Manage Server, from the signed payload) mints a 15-minute signed
token for that guild and that Discord user, and links to `#/account/guild/<token>`. Checkout of
`discord_guild_monthly` succeeds only for the Frostsim account linked to that Discord user (403 otherwise); the
guild id travels in the subscription metadata. A `/sim` whose guild pool is used up for the period runs on the
member's own allowance instead, and the reply says so.

Role allowances (`guild-roles.ts`). The payer of a guild subscription sets, at `#/discord`, each Discord role's monthly share of
the pool in core-seconds, or no limit, or none. A role set explicitly overrides @everyone (role id = guild id); among a member's
explicit roles the largest wins; with nothing set a member may use the whole pool. `/sim` reads the member's role ids from the
signed interaction, and a member past their share runs on their own plan, as when the pool is used up. `/usage` shows the share.

Armory characters. `/sim` takes a saved character, or `name`, `realm` and `region` instead. The account server asks the Battle.net
proxy (`WOW_API_ORIGIN`, default `http://127.0.0.1:3011`, the only holder of the Blizzard credential) for
`/api/wow/character-profile/<region>/<realm>/<name>`, which builds the addon-shaped profile with `src/lib/import/armory.ts`.
The run has no `character_id`. The `realm` option autocompletes from the proxy's `/api/wow/realms?region=` for the chosen region.

Shared results. Replies are ephemeral, except with `share:true` on `/sim` or `/compare`: the reply is public from the start, so the
channel sees the progress embed and pixel battle, and that same message becomes the result (DPS, and the hosted link when the
invoker's plan has one) naming the invoker. A refusal, failure or cancel of a shared run is public too, since it replaces the same
message.
The page lists the guild's name and roles through the bot token; managed (bot) roles are left out.

**P6 Account API** (all under `/api/v1`): `auth/providers`, `auth/:provider/start|callback`, `auth/logout`;
`me` (GET, PATCH, DELETE), `me/export`, `me/identities/:provider` (DELETE), `me/integrations/loothing` (PUT,
DELETE); `admin/users` (GET), `admin/users/:id` (GET, PATCH, DELETE);
`billing`, `billing/checkout`, `billing/portal`, `stripe/webhook`; `characters` (GET, POST, and GET, PUT, DELETE
by id), `characters/:id/history` (GET), `characters/:id/sims` (POST); `shares` (GET, POST), `shares/:id` (public GET, owner DELETE), `shares/:id/blob` (owner PUT, public GET);
`compute/capacity` (GET), `compute/jobs` (POST), `compute/jobs/:id` (GET, DELETE), `compute/jobs/:id/result`; `worker/*` (P1);
`discord/interactions`, `discord/install` (302 to Discord's add-to-server page), `discord/guilds` (GET: the guilds the
user pays for), `discord/guilds/:id` (PUT: role allowances); `integrations/loothing/resolve`, `integrations/loothing/jobs` (POST, GET: up to 30 days),
`integrations/loothing/jobs/:id` (GET, DELETE), `integrations/loothing/jobs/:id/detail` (GET) (bearer token, a linked Discord identity and a grant); `health` (always on, 503 while Postgres is down with any
feature enabled).

## Risks (R)

- **R1 Hetzner cost runaway or leaked servers.** Label reconciliation, `WORKER_MAX` and
  `WORKER_MONTHLY_EUR_CAP` with prices read from the Hetzner API, heartbeat reaping, and a snapshot build that
  deletes its temporary server on any failure. The euro cap is soft by at most two billed hours per worker.
- **R2 Untrusted simc input on workers.** The browser's own validation, a server refusal list that is a superset
  of the worker's, and a sandboxed simc on ephemeral servers that hold no credentials beyond their own token.
- **R3 Native and wasm drift.** Native is built from each pack's own source, jobs name their pack, and results
  record their placement. Measured locally: native 181,468 ± 87 and wasm 181,388 ± 89 DPS on the same profile.
- **R4 Contention on the shared host.** A 512 MB and one-CPU cap on the service, a 5-connection pool, TTLs on every
  Redis key, health probes shared for 5 s.
- **R5 Legal text.** Nothing is enabled in production before the privacy policy and terms describe accounts,
  payments and server-side runs.
