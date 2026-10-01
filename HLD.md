# High-Level Design

**System:** `variant-service` — a multi-tenant experimentation service that answers
"which variant should this visitor see right now?" on the page-render path, and later
reports which variant won.

**Status:** deployed and live. See [README](./README.md) for the live URL.

---

## 0. What this document is, and what it is not

This is the **HLD**: the shape of the system. Its job is to let a reviewer understand the
architecture, the contracts, the topology, and the failure behaviour without reading the
implementation.

It deliberately does **not** explain *why* each decision was made. That reasoning, the
rejected alternatives, and two postmortems of bugs I shipped are in
[DESIGN.md](./DESIGN.md). The split is intentional: DESIGN.md argues, this document
describes. A reader should be able to use this document to navigate the code, and
DESIGN.md to evaluate the judgement.

Where the two overlap, DESIGN.md is authoritative on reasoning and this one on
structure.

---

## 1. Goals and non-goals

### Goals

| # | Goal | How it is met |
| --- | --- | --- |
| G1 | Sticky, deterministic assignment | Pure function of `(namespace, experiment, visitor)`; nothing is stored |
| G2 | Never break a customer's page | Assignment is a cache read; failure degrades to a default, never a non-2xx |
| G3 | Correct, trustworthy counts | Client-generated idempotency keys; exposure-required attribution; SRM before statistics |
| G4 | Keep slow dependencies off the hot path | LLM is control-plane only; writes are queued, not awaited |
| G5 | Horizontally scalable | No session affinity, no per-visitor state, no sticky routing requirement |
| G6 | Small, reviewable core | Three runtime dependencies; the interesting SQL is visible, not behind an ORM |

### Non-goals

Stated so the boundary is explicit, not discovered later.

- **Not an analytics warehouse.** Results are computed on read. This is correct and fast
  at the scale it was built for and wrong at a scale it has not been tested at.
- **Not a real-time dashboard.** Readouts are query-time, not pushed.
- **Not an identity system.** The control plane has one shared secret, not users and
  roles. Named as the weakest part of the security posture in DESIGN.md §10.
- **Not a general CDP.** No user profiles, no cross-site identity stitching, no
  third-party data.
- **Not multi-region active/active.** One region, one writer, N stateless readers.
- **Not a CDP-grade allocation engine.** Fixed splits only. Smarter allocation
  (multi-armed bandits) is named as future work, not built.

---

## 2. System context

```
                        ┌──────────────────────────┐
                        │  Customer website        │
                        │  (uncontrolled client)   │
                        │                          │
                        │  1. GET/POST snippet.js  │──┐
                        │  2. renders variant      │  │  control plane
                        └──────────────────────────┘  │  (authenticated)
                                                       │
                          ┌────────────────────────────┴───────────┐
                          │           variant-service              │
                          │  ┌────────────┐  ┌──────────────────┐  │
                          │  │ data plane │  │  control plane   │  │
                          │  │ (no auth)  │  │  (ADMIN_TOKEN)   │  │
                          │  └────────────┘  └──────────────────┘  │
                          └───┬──────────────────────┬──────────────┘
                              │                      │
                    ┌─────────▼──────────┐  ┌────────▼─────────┐
                    │  Neon Postgres     │  │  LLM provider    │
                    │  (pooled + direct) │  │  (control plane  │
                    │  aws-us-west-2     │  │   only, optional) │
                    └────────────────────┘  └──────────────────┘
```

**Trust boundary.** The data plane is reachable by anyone on the internet. It is
authenticated by *nothing*, by design — the customer has no API key, because the snippet
runs in every visitor's browser where any key would be public. The control plane is
authenticated by a shared secret and is the only surface that can change what visitors
see. Everything else in this document is about keeping the unauthenticated path cheap
and unbreakable.

**Actors:**

| Actor | Surface | Reaches |
| --- | --- | --- |
| End user (unauthenticated) | `/v1/assign`, `/v1/track`, `/v1/beacon`, `/` , `/demo`, `/dashboard` | Assignment and event ingestion |
| Customer operator (authenticated) | `/admin/*` | Experiment config, lifecycle, results |
| Platform (authenticated) | LLM provider | Content generation |
| Platform (out-of-band) | DB, container runtime | Migrations, deploys, logs |

---

## 3. Component architecture

```
                          ┌─────────────────────────────────────┐
                          │             Fastify app             │
                          │                                     │
  /v1/assign ────────────▶│  ┌───────────┐   ┌───────────────┐  │
                          │  │  zod      │──▶│  ConfigCache  │  │──┐
                          │  │  validate │   │  (in-process  │  │  │
                          │  └───────────┘   │   snapshot)   │  │  │ read
  /v1/track  ────────────▶│  ┌───────────┐   └───────────────┘  │  │ compiled
  /v1/beacon ────────────▶│  │  Tracker  │──┐                    │  │ config
                          │  │  (bounded │  │  ┌─────────────┐  │  │
                          │  │   queue)  │  └─▶│  pg.Pool    │──┼──┼──▶ Neon
                          │  └───────────┘     │  (pooled)    │  │     (pooled)
                          │                    └─────────────┘  │
                          │                                      │
  /admin/* ──────────────▶│  ┌───────────┐   ┌─────────────┐  ┌──┴──────┐
                          │  │  zod +    │──▶│  LLM        │  │ pg.Client│
                          │  │  auth     │   │  (generate, │  │ (direct) │
                          │  └───────────┘   │   pin)      │  │  LISTEN  │
                          │                    └─────────────┘  └─────────┘
                          │                                      │
  /healthz /readyz ──────▶│  health snapshot (cache + tracker)  │──▶ Neon (direct)
                          └─────────────────────────────────────┘
```

### Components

| Component | Responsibility | State | On the hot path |
| --- | --- | --- | --- |
| **Validation** (`routes/validation.ts`) | Every network boundary is parsed with zod; `.strict()` so unknown keys are rejected | None | Yes |
| **Bucketing** (`core/bucketing.ts`) | Deterministic `hash32` → 10,000 buckets → fastrange; two independent domains | None | Yes |
| **ConfigCache** (`services/configCache.ts`) | In-process snapshot of compiled experiments; single-flight refresh; TTL + max-stale; `LISTEN/NOTIFY` invalidation | In-memory snapshot | Yes |
| **Tracker** (`services/tracker.ts`) | Bounded in-memory retry queue; returns 202; drops oldest when full | In-memory queue | Write path |
| **Results** (`services/results.ts`, `core/stats.ts`) | One grouped query; unique visitors; Wilson intervals; two-proportion tests; SRM | None | No |
| **LLM** (`llm/*`) | Generate copy, validate, check distinctness, pin to a row | None | No |
| **Postgres** (`db/pool.ts`) | Raw `pg`. One pooled client set, one dedicated direct client | External | Read + write |

### Two database connections, and why there are two

This is the single most surprising thing in the architecture, so it is stated at HLD
level rather than buried.

```
  all queries  ──────────────▶ DATABASE_URL          (pooled, -pooler, PgBouncer)
  LISTEN/NOTIFY ─────────────▶ DATABASE_URL_UNPOOLED (direct, dedicated session)
```

PgBouncer in transaction mode cannot hold a session. It *will* accept a `LISTEN` and
return success, and then never deliver a notification — no error, no warning. Config
invalidation would silently degrade to TTL-only, so an operator's change would take up to
`CONFIG_TTL_MS` to take effect while every health check stayed green. This was found
empirically, not reasoned about in advance, and the regression test for it is
`test/listenConnection.test.ts`.

`DATABASE_URL_UNPOOLED` is optional and falls back to `DATABASE_URL`, so a single-URL or
local-Postgres deployment is unchanged.

---

## 4. Runtime and deployment topology

**Current (live):** one Railway container + one Neon Postgres project.

```
   Internet
      │  HTTPS
      ▼
 ┌──────────────────────────────────────────────┐
 │ Railway edge                                 │
 │  variant-service-production.up.railway.app   │
 └───────────────────────┬──────────────────────┘
                         │  HTTP :3000
                         ▼
 ┌──────────────────────────────────────────────┐
 │ Container (node:22-alpine, non-root)         │
 │  ┌────────────────────────────────────────┐  │
 │  │ Fastify 5 · pg 8 · zod 3                │  │
 │  │ ConfigCache snapshot · Tracker queue    │  │
 │  └────────────────────────────────────────┘  │
 │  HEALTHCHECK → /healthz every 15s            │
 └────┬───────────────────────────┬─────────────┘
      │ pooled                    │ direct
      ▼                           ▼
 ┌──────────────────┐   ┌──────────────────────────┐
 │ Neon PgBouncer   │   │ Neon compute             │
 │ (-pooler host)   │   │ (direct host)            │
 └──────────────────┘   └──────────────────────────┘
      one Neon project, region aws-us-west-2
```

**Why the process is shaped this way:**

- **Two-stage Docker build.** Runtime stage carries production dependencies only.
- **Non-root** (`USER node`), which `node:alpine` provides.
- **Preflight before listening.** `SELECT 1 FROM schema_migrations` — a missing migration
  is a clean crash and redeploy, never a stream of 500s to customers.
- **Graceful shutdown.** `SIGTERM` → stop accepting, drain in-flight, flush the tracker
  queue, exit, bounded at 15s. A deploy that drops in-flight requests is a deploy that
  breaks pages.
- **Liveness ≠ readiness.** `/healthz` touches neither Postgres nor the LLM, so a failing
  dependency surfaces as *unhealthy* rather than a restart loop. `/readyz` does check the
  database.

**Scaling shape.** Stateless. N replicas behind the LB with no affinity requirement, no
shared session, no coordination. The only cross-instance coupling is the config
invalidation broadcast (§8, flow 3), which is why horizontal scaling costs one extra
listener connection per instance and nothing else.

**Not deployed, but specified and tested:** `fly.toml` and `fly.ollama.toml` provide a
self-hosted-generation variant with Ollama on a private network; `render.yaml` is a
ready blueprint for a paid Render account. The live topology is a deployment choice, not
a hard constraint of the design.

---

## 5. Interfaces

Full request/response detail is in the README. Contracts that matter at HLD level:

### Data plane — never authenticated, never returns a non-2xx

| Method | Path | Contract |
| --- | --- | --- |
| `GET`/`POST` | `/v1/assign` | Returns assignments for a visitor. Always 200 with a per-experiment `reason` on failure. `stale` flag reports config freshness. |
| `POST` | `/v1/track` | Accepts one event or a batch (≤100). `202` on accept, whether written or queued. |
| `GET` | `/v1/beacon` | `sendBeacon` transport for the same event shape. |

Assignment `reason` values are part of the contract, not diagnostics: `assigned`,
`not_in_allocation` (holdout), `experiment_not_found`, `experiment_paused`,
`experiment_not_running`, `no_variants`.

The no-non-2xx rule is the contract that makes the service safe to call from a page
render: a failure is expressed in the body, never as an exception the customer's page
has to handle.

### Control plane — requires `x-admin-token`

| Method | Path | Purpose |
| --- | --- | --- |
| `POST`/`GET` | `/admin/experiments` | Create / list |
| `GET`/`PATCH` | `/admin/experiments/:id` | Read / update config, including `allocationBps` |
| `POST` | `/admin/experiments/:id/{start,pause,stop}` | Lifecycle |
| `POST` | `/admin/experiments/:id/regenerate` | Regenerate copy via the configured LLM |
| `GET` | `/admin/results/:id` | Exposures, conversions, rate, CI, lift, p-value, significance, SRM, plus `leadingVariant`, `powerHint`, and a human-readable `interpretation` |

### Static

`/` (dashboard), `/demo`, `/dashboard`, `/snippet.js`. Loaded once at boot and served
from memory; a missing optional asset does not prevent boot.

### Health

| Path | Checks | Used by |
| --- | --- | --- |
| `/healthz` | Process liveness only. No database, no LLM. | Container `HEALTHCHECK` |
| `/readyz` | Database reachable, migrations present; reports cache status, notification count, tracker counters | Load balancer / operator |

`CacheHealth.status` is one of `cold` | `warm` | `stale` | `expired`, and is derived from
an explicit `lastRefreshFailed` flag — not from whether an error string happens to be
truthy. That distinction is the subject of a shipped-bug postmortem in DESIGN.md §3.

---

## 6. Data model

Four tables plus a migration ledger. Ownership is shared between the control plane
(writes config) and the data plane (appends events).

```
  experiments ──┬──< variants          (control plane; FK, ON DELETE CASCADE)
                └──< creatives         (control plane; FK; one pinned per variant
   namespace, id │                            via partial unique index)
   status, allocation_bps, salt, version
                       ╎
                       ╎  no foreign key, deliberately
                       ╎  (cheap appends; possible orphans, reaped by retention)
                       ▼
                    events                (data plane; append-only)
                       event_id  PK UNIQUE  ← idempotency is a schema constraint
                       type, namespace, experiment_id, variant_key,
                       visitor_id, goal, properties(JSONB),
                       ts (client, clamped), received_at (server)
```

### The most important absence

**There is no assignment table.** Assignment is a pure function of
`(namespace, experiment, visitor)`, so a table would store a redundant copy of something
that can be recomputed in ~1.1µs. This single omission is what makes the service
horizontally scalable with no affinity, and it is why "what did we store about this
visitor" has the answer "nothing".

### Modelling decisions

- **Natural keys, not UUIDs,** for `namespace` and experiment `id`. Customers write
  these into their own JavaScript; an opaque token would make their code unreadable.
- **`events` is denormalised** — no FK to `experiments`, namespace/id repeated as text.
  At high insert volume an FK costs a probe per row and blocks vacuum on the parent. We
  accept possible orphans in exchange for cheap appends and reap them in a retention
  job.
- **Idempotency is a hard constraint,** `event_id UUID NOT NULL UNIQUE`, not an
  application check. Only the client can distinguish a retried beacon from a genuine
  repeat, so the key must come from the client and be enforced by the database.
- **Client time is clamped** server-side (`normaliseTs`, 24h max) so a wrong clock cannot
  corrupt the results window.
- **One pinned creative per variant,** enforced by
  `CREATE UNIQUE INDEX ... WHERE pinned`, so swapping copy is one atomic transaction.

### Indexes, and what each is for

| Index | Serves |
| --- | --- |
| `events_results_cover (namespace, experiment_id, type, variant_key, visitor_id)` | Covers the `COUNT(DISTINCT visitor_id)` results scan |
| `events_attribution (namespace, experiment_id, visitor_id, type)` | "Was this visitor actually exposed before converting?" |
| `events_received (received_at)` | Retention/reaping |
| `creatives_one_pinned_per_variant` (partial) | Exactly one pinned creative per variant |

---

## 7. Assignment algorithm

Two independent hashes, and the separation is a correctness property.

```
  allocationBucket = fastrange( hash32([ns, id, salt, 'alloc', visitor]) )  → 0..9999
       │
       ├─ bucket >= allocationBps  ─────────────────────────▶  not_in_allocation (holdout)
       │
       ▼
  variantBucket   = fastrange( hash32([ns, id, salt, 'var',   visitor]) )  → 0..9999
       │
       └─ walk cumulative boundaries over variants sorted canonically by key
                                                              → assigned
```

- **32 bits of SHA-256** over a domain-separated field tuple, reduced to 10,000 buckets.
- **Fastrange (multiply-shift), not modulo.** Modulo biases when the range is not a
  multiple of 10,000; the bias is negligible and removing it costs one multiply.
- **Two domains, `'alloc'` and `'var'`.** Using one hash for both would couple enrolment
  to variant: re-running enrolment would reshuffle variants for visitors already in the
  experiment. Separate domains mean *which* visitors are enrolled is independent of
  *which* variant they see.
- **Canonical ordering by variant key.** Reordering variants in the config must not
  reshuffle visitors. This has a test.
- **Weights normalised at read time,** so operators can write `1:1` or `1:2:1` without
  arithmetic, and a zero-weight variant is distinguishable from "no weights at all".

---

## 8. Key flows

### Flow 1 — Assignment (the critical path)

```
visitor ─▶ GET /v1/assign?visitorId=…
            │
            ├─▶ zod validate ───────────────▶ 400 on malformed input
            ├─▶ ConfigCache.get(ns, id)
            │     snapshot hit? ──yes──▶ assign() ──▶ 200 { assignments[], stale }
            │     no                     │              │
            └─ single-flight load ◀───────┘              └─ deadline exceeded
                    │                                         ▶ null variant +
                    │                                           reason, still 200
                    ▼
              one DB read, N concurrent requests share it
```

No database call on a warm cache. A cold cache that misses the deadline returns the
default experience with a reason — **fail closed**, because showing a wrong variant
silently corrupts a result, whereas showing the default is visible and safe.

### Flow 2 — Tracking

```
client ─▶ POST /v1/track
           │
           ├─▶ validate ─▶ normalise ts (clamp 24h)
           ├─▶ INSERT ... ON CONFLICT (event_id) DO NOTHING
           │     │
           │     ├─ within TRACK_WRITE_TIMEOUT_MS ──▶ 202
           │     └─ timeout / connection error ──▶ enqueue (bounded, drop oldest) ──▶ 202
           │
           └─ background retry loop drains the queue at TRACK_RETRY_INTERVAL_MS
```

Returns `202` whether the row was written or queued, so the client's retry policy is
simple. Duplicate beacons are no-ops at the database, not an application check.

### Flow 3 — Config change propagation

```
operator ─▶ PATCH /admin/experiments/:id
              │
              ├─▶ UPDATE … (bump version)
              └─▶ pg_notify(channel, ns)          ──────────────┐
                                                                 │
   ┌───────────────────────── every instance ────────────────────┴──────┐
   │  dedicated direct pg.Client (LISTEN)                                │
   │      └─ on notification ─▶ invalidate namespace ─▶ next get()      │
   │                            refreshes from DB (single-flight)        │
   └────────────────────────────────────────────────────────────────────┘
```

TTL (`CONFIG_TTL_MS`) is the backstop, so a missed notification self-heals. **Stale-when-warm
is the deliberate asymmetry:** a warm cache serves a slightly outdated split rather than
failing, because a stale split is an annoyance and an outage is a lost experiment. A cold
cache with no snapshot has nothing safe to serve, so it fails closed.

### Flow 4 — Results

```
operator ─▶ GET /admin/results/:id
             │
             ├─▶ ONE grouped query, COUNT(DISTINCT visitor_id)
             ├─▶ attribution: conversions without a prior exposure are
             │   counted separately as unattributed, never silently credited
             ├─▶ Wilson interval per arm (not the normal approximation —
             │   wrong at the sample sizes that decide early calls)
             ├─▶ two-proportion test vs control ──▶ lift, p-value, significance
             │
             └─▶ SRM check, and the human-readable `interpretation`:
                   SRM mismatch short-circuits everything and returns
                     "Results are not trustworthy. Check assignment and event
                      delivery before reading further."
                   not enough exposure ──▶ "Not enough data", no winner named
                   overlapping CIs ─────▶ "No variant is beating control yet"
```

The response also carries `leadingVariant` (null unless a winner is genuinely clear) and
`powerHint`, which tells the operator what sample size their target effect needs rather
than letting them stop early on noise.

Live check, from the seeded `demo-signup-flow` experiment:

```
interpretation: treatment is currently leading with a confidence interval clear of
                control. Confirm the sample size meets your target before shipping.
srm.mismatch: False   srm.checked: True
```

Note the ordering honestly: the per-variant statistics are **computed** before the SRM
check, because they are always reported as raw data. What SRM gates is the
*interpretation* — the sentence that names a winner. A dashboard that only prints
numbers will eventually be read by someone who does not know that a 40-visitor
experiment means nothing, so the service refuses to name a winner unless the traffic
split validates and the intervals clear. Saying "not enough data" is a feature.

### Flow 5 — LLM generation (control plane only)

```
operator ─▶ POST /admin/experiments { creativeBrief, variants[] }
             │
             ├─▶ generate N candidates per variant
             ├─▶ validate structure (the documented provider examples found 3 bugs)
             ├─▶ distinctness check across variants (similarity < 0.6)
             ├─▶ pin the first valid candidate  ──▶ creatives table
             └─ on failure ─▶ source='fallback', flagged, and generation failure
                              BLOCKS the experiment rather than shipping broken copy
```

**The placement decision, in one line:** generation happens at experiment-creation time,
never on read, so model latency, cost, and failure land on an authenticated operator
action instead of every customer page render. Keys stay server-side. If generation fails,
the experiment does not start — the alternative is a customer page rendering an empty
block in production.

---

## 9. Capacity and sizing

Measured baseline, from `npm run simulate` (20,000 visitors, 50 concurrent, 30% of
exposures duplicated, local Postgres, warm process):

```
assignment latency   p50 2.10ms   p90 4.17ms   p99 7.65ms   max 30.12ms
tracking latency     p50 2.65ms   p99 9.18ms
throughput           8,306 visitors/s
stickiness           0 violations in 2,000 re-checks
SRM                  chi2=1.15  p=0.5632
```

### The asymmetry, which is the whole design

| | Assignment | Tracking |
| --- | --- | --- |
| Work per call | ~1.1µs hashing | One durable insert |
| Touches the DB? | **No** (warm cache) | Yes, eventually |
| Cost growth | Sublinear in visitors | Linear in events |
| Growth driver | CPU, fan-out | Insert rate, storage |
| Degradation under load | Fails closed (safe) | Queues, then drops oldest |
| Scaling lever | Add replicas | Vertical, then rollups |

Reads scale by *not happening*: a million assignment calls on one experiment cost one
config read and ~1.1s of total CPU. Writes scale by durability: at 8,000 visitors/s a
single experiment generates 8,000 event rows/s, and the queue absorbs database latency
by converting it into bounded memory growth.

**Sizing rules of thumb:**

| Resource | Per replica | Driver |
| --- | --- | --- |
| Memory | ~90MB resident + snapshot + queue | `TRACK_QUEUE_MAX` bounds the queue |
| DB connections | `DB_POOL_MAX` (5 live) + 1 direct listener | Instance count, not traffic |
| Event rows | 1–2 per assignment | Retention policy is the only real lever |
| CPU | Saturates ~800k assignments/s/core | SHA-256 is hardware-accelerated |

**The first thing that breaks at real scale is the results query**, not the write path.
It is O(events); reads are O(1) per visitor forever. A year of production data needs the
pre-aggregated rollups in DESIGN.md §9.

---

## 10. Failure domains and degradation

| Failure | Detection | Behaviour | Customer impact |
| --- | --- | --- | --- |
| Cache cold, DB slow/unreachable | deadline miss; `/readyz` | **Fail closed** — default variant + reason, HTTP 200 | Sees default experience; experiment data is wrong-looking but not corrupted |
| Cache warm, DB unreachable | `lastRefreshFailed` → `status: 'stale'` | **Fail open** — serve last good snapshot up to `CONFIG_MAX_STALE_MS` | None, up to 1h; admin changes lag |
| Cache older than max-stale | `status: 'expired'` | Stop serving; fail closed | Default experience |
| `LISTEN` silently dead behind a pooler | `/readyz` notification count | Invalidation degrades to TTL-only | Change takes up to `CONFIG_TTL_MS`; no error |
| DB write slow (> `TRACK_WRITE_TIMEOUT_MS`) | write timeout | Enqueue, return 202, retry in background | None — but `/dashboard` reports queue depth |
| Queue full (`TRACK_QUEUE_MAX`) | counter | Drop **oldest**, count it | Metrics lost, page fine. Bounded memory beats OOM |
| Process death with events queued | — | **Events lost.** The known gap, stated in DESIGN.md §10 | Undercounted metrics |
| LLM provider down/fails | generation error | Fallback creative, `source='fallback'`, **start blocked** | None if operator retries; never a broken page |
| Bad `ADMIN_TOKEN` | auth check | 401 | None |
| Missing migration | preflight `SELECT 1 FROM schema_migrations` | `exit 1` → clean redeploy | Brief outage, never 500s |

**The governing rule:** every failure mode is chosen so the unauthenticated hot path
returns a valid, safe answer. The service degrades in *data quality* before it degrades
in *availability*, because a customer page that renders is worth more than a metric that
is precise.

---

## 11. Security

| Concern | Measure |
| --- | --- |
| LLM keys | Server-side only, env vars. The data plane never calls a provider |
| Control plane | Single shared `ADMIN_TOKEN` via `x-admin-token`. **Weakest link** — no users, roles, or audit log |
| Data plane auth | Deliberately none; a browser snippet cannot hold a secret |
| Injection | Parameterised queries throughout — including `SELECT pg_notify($1, $2)` — and identifiers are zod-constrained to `[A-Za-z0-9._-]` before reaching a `NOTIFY` channel |
| XSS | Model output is inserted with `textContent` only. Sanitising HTML you did not generate is not reliable, so the hazard is never created |
| Unbounded input | Every field length-capped; `visitorId` ≤ 256, arrays capped, batch ≤ 100 |
| Log hygiene | `authorization`, `cookie`, `x-admin-token`, `visitorId`, and `events` are redacted |
| Secrets in repo | `.env` and `.neon` gitignored; `.env.example` carries no real values |
| Transport | TLS terminated at the platform edge; `sslmode` left at the driver default (a deprecation warning is logged for review) |

**Known gaps:** one shared admin secret; the in-memory queue is not durable; no
per-experiment rate limiting, so `allocationBps` bounds enrolment but nothing bounds
event volume from a misbehaving client.

---

## 12. Observability

Structured JSON logs (Fastify logger) with the fields above redacted. No metrics
backend — counters are exposed through `/readyz` rather than scraped, which is a
deliberate simplification appropriate to a single-service deployment and named as such.

Exposed counters: cache `status`, `lastError`, `lastRefreshAt`, `refreshCount`,
`refreshFailureCount`, `singleFlightJoins`, `notificationCount`; tracker `written`,
`queued`, `dropped`, `queueDepth`. Process `uptimeMs` on `/healthz`.

The counters that matter operationally are `notificationCount` (proves invalidation is
actually attached — the failure mode that has no error) and `dropped` (the only silent
data loss in the system).

---

## 13. Operations

| Task | Command |
| --- | --- |
| Install / build / test | `npm ci`, `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` |
| Local database | `docker compose up -d` |
| Migrations | `DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run migrate` |
| Local run | `npm run dev` |
| Load / correctness harness | `npm run simulate` |
| Deploy | `railway up --service variant-service` (or the `render.yaml` blueprint) |
| Required env | `DATABASE_URL`, `ADMIN_TOKEN`; `DATABASE_URL_UNPOOLED` recommended |

**Migrations are a separate step, not a boot step**, on purpose: N instances starting
together must not race each other on `CREATE TABLE`. There is no migration framework —
the schema is small enough that ordered `.sql` files and a ledger table are clearer than
a dependency.

**Rollback** is a redeploy of the previous image. Schema changes are additive and
backward-compatible in practice, which is what makes that safe; a destructive migration
would need a real down-path and is called out as future work.

---

## 14. Evolution

Near-term, in the order I would do it:

1. **Persist the retry queue** — closes the one real correctness gap (loss on process death).
2. **Pre-aggregated results rollups** — the O(n) scan is the first thing that will not
   survive a year of data.
3. **Real control-plane identity** — users, roles, and an audit log of config changes.
4. **Layered hash rings** for experiment mutual exclusion, if overlapping audiences
   justify making assignment stateful again.
5. **Per-experiment rate limits** to bound event volume from a misbehaving client.
6. **Smarter allocation** — multi-armed bandits, replacing the fixed split.

Each is deliberately not built, with the reason, in DESIGN.md §9.

---

## 15. Traceability to the brief

| Brief requirement | Where it is addressed |
| --- | --- |
| Architecture | §3, §4 |
| Determinism | §7, §6 ("most important absence") |
| Scale | §9, DESIGN.md §8 |
| Reliability and failure modes | §10, DESIGN.md §3 |
| Correctness and statistical validity | §6, §8 flow 4, DESIGN.md §5 |
| The LLM decision | §8 flow 5, §3 (control plane), DESIGN.md §6 |
| Trade-offs and next steps | §1 non-goals, §14, DESIGN.md §9, §10 |
| Deploy everything | §4, README |
| Demo | README, `/demo`, `npm run simulate` |
| No company named | Verified across code, docs, commits, and repository name |
