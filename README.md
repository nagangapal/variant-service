# variant-service

A self-hosted experimentation platform. Teams define experiments, get deterministic
per-visitor variant assignment, track exposures and conversions, and read results with
confidence intervals — and the customer-facing integration is a single script tag that
degrades to the default experience rather than breaking the page.

Two ideas drive the whole design:

1. **The assignment path never does I/O.** Bucketing is a pure function of
   `(namespace, experimentId, visitorId)`. No database read, no LLM call, no network hop
   on the request that decides what a customer sees.
2. **Every failure mode on the critical path serves the default.** A cold cache, an
   expired snapshot, a lost response, a blocked script, a garbage payload. Each one
   degrades to "show the control experience" rather than an error page.

---

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Integration](#integration)
- [API](#api)
- [How assignment works](#how-assignment-works)
- [How results work](#how-results-work)
- [Configuration cache and failure behaviour](#configuration-cache-and-failure-behaviour)
- [Tracking and idempotency](#tracking-and-idempotency)
- [AI-generated content](#ai-generated-content)
- [Testing and verification](#testing-and-verification)
- [Deployment](#deployment)
- [Repository layout](#repository-layout)
- [Design trade-offs](#design-trade-offs)
- [Known limitations](#known-limitations)

---

## Quick start

Requires Node 22+ and Docker.

```bash
git clone <repo-url> && cd variant-service
cp .env.example .env                      # defaults work for local development

docker compose up -d                      # Postgres on localhost:55432
npm install
npm run migrate                           # apply schema
npm run dev                               # http://localhost:3000
```

Then create and start an experiment, and open the dashboard:

```bash
TOKEN=change-me   # ADMIN_TOKEN from your .env
BASE=http://localhost:3000

curl -s -X POST "$BASE/admin/experiments" -H "x-admin-token: $TOKEN" \
  -H 'content-type: application/json' -d '{
    "namespace": "default",
    "id": "checkout-cta",
    "status": "running",
    "allocationBps": 10000,
    "variants": [
      { "key": "control", "weightBps": 5000, "creative": { "headline": "Start your free trial" } },
      { "key": "urgent",  "weightBps": 5000, "creative": { "headline": "Only 3 seats left", "cta": "Claim one" } }
    ]
  }'

curl -s -X POST "$BASE/admin/experiments/checkout-cta/start" -H "x-admin-token: $TOKEN"
```

| URL | What it is |
| --- | --- |
| `http://localhost:3000/demo` | Live page running the real client snippet |
| `http://localhost:3000/` | Results dashboard |

Load `/demo` several times: the variant stays the same for a given visitor. Open it in
a private window for a different one.

To see it behave correctly under load, with statistical validation:

```bash
npm run simulate -- --visitors 20000
```

---

## What it does

- **Experiments** with a traffic allocation, a set of weighted variants, and a
  draft / running / paused / archived lifecycle.
- **Deterministic assignment** that is stable across processes, restarts, and
  horizontal scaling, with no assignment table to write to or read from.
- **Exposure and conversion tracking** with client-side idempotency, so a
  double-loaded script or a retried beacon does not corrupt counts.
- **Results** with per-variant unique visitors, conversion rates, Wilson confidence
  intervals, lift versus control, significance, and a sample-ratio-mismatch check.
- **AI-generated copy** in the control plane, with schema validation and a
  near-duplicate check so two variants cannot ship the same text.
- **A client snippet** whose contract is that it cannot break the host page.

---

## Integration

One tag. That is the entire integration.

```html
<script async
        src="https://YOUR-HOST/snippet.js"
        data-experiments="checkout-cta,pricing-copy"></script>
```

Mark the elements to be rewritten. The snippet assigns a variant, applies the pinned
creative, and reports an exposure:

```html
<h2 data-vs-target="checkout-cta">Start your 14-day free trial</h2>
<button data-vs-target="checkout-cta" data-vs-cta>Get started</button>
```

Report a conversion the same way. The beacon is fire-and-forget and never blocks
navigation:

```html
<script>window.variantService && window.variantService.convert('checkout-cta', 'signup')</script>
```

### Attributes

| Attribute | Default | Purpose |
| --- | --- | --- |
| `data-experiments` | — | Comma-separated experiment ids. Omit to enrol in all running experiments. |
| `data-endpoint` | script origin + `/v1` | Override the API base URL. |
| `data-selector` | `data-vs-target` | Attribute naming the elements to rewrite. |
| `data-timeout` | `80` | Client-side deadline in milliseconds before rendering defaults. |
| `data-cookie` | `vsid` | Name of the first-party identity cookie. |
| `data-track` | `true` | Set `false` to suppress automatic exposure beacons. |
| `data-debug` | `false` | Log decisions to the console. |

A request may name at most 50 experiments. Within an element, `data-vs-cta` and
`data-vs-body` select the child to receive the CTA and body copy. After applying a
variant the snippet sets `data-vs-variant` and `data-vs-creative` on the element, so a
page can read the assignment for its own analytics without a second request.

### Why the snippet is written the way it is

The requirement is not "works when the service is up". It is **cannot break the page**,
which is a stronger and more useful contract:

- **Client-side deadline (80ms).** A server timeout is not enough, because the failure
  that matters is the one the server never sees — a dropped packet, a captive portal, an
  ad blocker. The request is raced against a timer and defaults win on timeout.
- **`textContent`, never `innerHTML`.** Content may be LLM-generated. A malformed or
  hostile response must not become script execution on the customer's site. This is the
  single most important line in the file.
- **Wrapped so nothing throws.** No exception can escape into the host page's scope.
- **First-party identity cookie.** Unaffected by third-party cookie blocking. If cookies
  are unavailable the snippet falls back to a session-scoped id, which is still stable
  within the visit.
- **`sendBeacon` for conversions**, so a conversion on an unload path still lands.

---

## API

### Customer-facing — never authenticated, never returns a non-2xx

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/assign` | Assign variants. Preferred: one round trip for many experiments. |
| `GET` | `/v1/assign` | Same, via query string. Convenience only — ids land in access logs. |
| `POST` | `/v1/track` | Record exposure or conversion events, singly or batched. |
| `POST` | `/v1/beacon` | `text/plain` variant of track, for `navigator.sendBeacon`. |

```bash
curl -s -X POST http://localhost:3000/v1/assign -H 'content-type: application/json' -d '{
  "visitorId": "visitor-123",
  "namespace": "default",
  "experiments": ["checkout-cta"]
}'
```

```json
{
  "visitorId": "visitor-123",
  "assignments": [
    {
      "experimentId": "checkout-cta",
      "variantKey": "urgent",
      "creativeId": "c_9f2a",
      "reason": null,
      "payload": { "headline": "Only 3 seats left", "cta": "Claim one" }
    }
  ],
  "stale": false
}
```

`reason` explains every non-assignment, so a client never has to infer intent:

| Reason | Meaning |
| --- | --- |
| `null` with a `variantKey` | Assigned. |
| `not_in_allocation` | Outside this experiment's traffic allocation. |
| `experiment_not_found` | Unknown id, or in another namespace. |
| `experiment_paused` / `experiment_archived` / `experiment_not_running` | Lifecycle state. |
| `zero_weight` | All variant weights are zero; misconfiguration. |

`stale: true` means the assignment came from a snapshot that could not be refreshed.
`payload` is `null` and `variantKey` is `null` when nothing is assigned, so the snippet
renders its original markup unchanged.

### Control plane — requires `x-admin-token`

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/experiments` | Create an experiment. |
| `GET` | `/admin/experiments` | List. |
| `GET` | `/admin/experiments/:id` | Detail. |
| `PATCH` | `/admin/experiments/:id` | Update config, including `allocationBps`. |
| `POST` | `/admin/experiments/:id/{start,pause,stop}` | Lifecycle. |
| `POST` | `/admin/experiments/:id/regenerate` | Regenerate copy with the configured LLM. |
| `GET` | `/admin/results/:id` | Readout with statistics. |
| `GET` | `/healthz`, `/readyz` | Liveness and readiness. |

Starting an experiment is refused with `409` if it has no variants, if all weights are
zero, or if any variant lacks a pinned creative. A blank block on a customer's page
should be caught here, not discovered in production.

### Health endpoints are deliberately different

`/healthz` touches **no dependency** and is what the container health check and load
balancer poll. A database blip must not cause a restart loop that turns a degradation
into an outage.

`/readyz` checks Postgres, the config cache, and the tracker, and returns their
individual status. It answers `200` with `status: "degraded"` where it can, because a
service still serving assignments from a stale snapshot is more useful stopped than
restarted.

---

## How assignment works

Bucketing is a pure function. Given a visitor and an experiment, the same variant comes
back from any process, at any time, forever, with no shared state.

```
u   = first_8_bytes( SHA-256( "vs1|alloc|" + namespace + "|" + experimentId + "|" + visitorId ) )
```

Two independent hashes are derived from the visitor:

- **Allocation** decides *whether* the visitor is in the experiment at all, over
  `10_000` buckets, compared against `allocationBps`.
- **Variant** decides *which* variant, by normalizing weights to 10,000 and walking the
  cumulative distribution.

The two use separate domain-separation strings (`vs1|alloc|` and `vs1|variant|`), so
raising or lowering `allocationBps` never reshuffles who gets which variant. That
property matters: you should be able to ramp an experiment from 5% to 50% and know the
visitors who were already in the experiment are still in the same arm.

Bucket selection uses **fastrange** — a multiply-and-shift rather than a modulo — which
avoids the modulo bias that would otherwise appear when 2^64 is not a multiple of
10,000. The bias is tiny; removing it costs one multiply.

The full derivation, including why not to use a database-backed assignment table, is in
[DESIGN.md](./DESIGN.md).

---

## How results work

One grouped query, no per-variant round trips:

- **Unique visitors, not raw events.** A visitor who triggers five exposure beacons is
  counted once. This is the difference between a real conversion rate and a number that
  moves when someone refreshes the page.
- **Conversion requires an exposure.** A conversion from a visitor who was never exposed
  cannot be attributed to a variant. These are counted separately as
  `unattributedConversions` rather than silently dropped, because a high count means
  the tracking integration is broken and you want to know.
- **Wilson score intervals**, not the normal approximation. At 5% conversion on 200
  visitors the normal interval misbehaves badly; Wilson stays inside [0, 1] and is
  accurate at the small counts that decide most early calls.
- **Lift versus control** with a two-proportion z-test, so "is this actually better" is
  answered rather than left to eyeballing two numbers.
- **Sample-ratio-mismatch check.** If the observed split departs from the configured
  split more than chance allows, every result in the readout is suspect and the readout
  says so before showing you a winner. Detecting this is the difference between
  "shipping a real improvement" and "shipping a bug that looks like a lift".

---

## Configuration cache and failure behaviour

Config is loaded into an in-process snapshot and refreshed on a TTL. Refreshes are
**single-flight** (concurrent callers join one in-flight load), and a failed refresh
leaves the last good snapshot in place.

| State | Assignment behaviour |
| --- | --- |
| Cold, no snapshot yet | Bounded wait (default 150ms). If the load does not complete, **fail closed**: no assignment, `stale: true`. |
| Warm | Served from memory. No database access on the request. |
| TTL expired, refresh succeeds | Served from the new snapshot. |
| TTL expired, refresh fails | **Served from the stale snapshot.** A slightly stale split beats breaking customer pages. |
| Stale beyond `CONFIG_MAX_STALE_MS` | Status is `expired` in `/readyz`. Still served — see below. |

Invalidation uses Postgres `LISTEN/NOTIFY`, so an admin change propagates to every
instance in about a millisecond instead of waiting out the TTL. TTL remains as the
fallback for a dropped notification.

**Fail closed on a cold cache, fail open on a warm one.** These look contradictory and
are not. With no snapshot, assigning from nothing would mean inventing a variant, so we
decline. With a snapshot that is an hour old, the experiment's traffic split and pinned
copy are still almost certainly correct, and declining would take a live experiment
offline over a transient database problem.

The stale window is deliberately long. A stale split is a small statistical annoyance;
an outage is a lost experiment.

---

## Tracking and idempotency

Every event carries a client-generated UUID `event_id` with a unique constraint behind
it, so the database is the single authority on what has already been counted. Inserts
use `ON CONFLICT DO NOTHING`, which makes a retry free and a duplicate free in the same
statement.

This matters because beacons are the least reliable part of the system: ad blockers,
flaky mobile networks, `sendBeacon` during unload, and double-loaded scripts all
produce duplicates. The design assumption is that **every event will be sent more than
once**, and that only the `event_id` can distinguish a retry from a genuine repeat.

Writes are bounded by `TRACK_WRITE_TIMEOUT_MS` (default 750ms). If a write does not
confirm in time, the event goes to an **in-memory queue** and the client still gets
`202`. The queue retries on an interval and is capped at `TRACK_QUEUE_MAX`; when full,
it drops oldest-first, because an unbounded queue is a memory-exhaustion vector and a
lost exposure is a smaller problem than a dead process.

The cost of this design is stated plainly: **events held only in the queue are lost if
the process dies.** A visitor whose exposure was queued during a deploy will not appear
in the results. This is a deliberate choice — the alternative, blocking the client until
the write lands, converts a database slowdown into a page slowdown on the customer's
site. In exchange, the tracking endpoint returns in single-digit milliseconds
regardless of database health.

---

## AI-generated content

Copy generation happens **only in the control plane**, on `create` and `regenerate`.
The serving path never calls a model.

```bash
curl -s -X POST "$BASE/admin/experiments" -H "x-admin-token: $TOKEN" \
  -H 'content-type: application/json' -d '{
    "namespace": "default",
    "id": "pricing-copy",
    "allocationBps": 10000,
    "creativeBrief": {
      "objective": "drive a demo request",
      "audience": "engineering managers evaluating observability tools",
      "tone": "direct and concrete",
      "mustAvoid": ["superlatives", "exclamation marks"]
    },
    "variants": [
      { "key": "control",      "weightBps": 5000 },
      { "key": "social-proof", "weightBps": 5000 },
      { "key": "developer",    "weightBps": 0, "creative": { "headline": "Ship it" } }
    ]
  }'
```

- `creativeBrief` produces one generated candidate per variant. A variant that supplies
  its own `creative` uses it verbatim and opts out of generation, which is how a fixed
  control arm is expressed. A brief requires at least one variant that will generate.
- `mustInclude` / `mustAvoid` / `constraints` are available and are validated against
  the generated result.
- An experiment takes 1 to 10 variants.
- **Creatives are pinned.** Generation happens once, the result is stored, and the
  stored copy is what every visitor is served. Regeneration swaps content atomically
  while assignment keeps working.
- **Schema validation.** Every field is length-bounded and type-checked before storage.
- **Near-duplicate rejection.** Variants are compared pairwise on token Jaccard
  similarity; above `0.6` the run is rejected, because an experiment where both arms
  say the same thing measures noise, not a treatment.
- **Static fallback.** If no provider is configured or the call fails, the experiment is
  still created and marked `degraded`, serving the brief's own headline. Experiments are
  never blocked on a third-party API.

Providers: Anthropic, OpenAI, Ollama (local, no key). The Anthropic adapter uses prompt
caching, since the system prompt is identical across candidates for one experiment.

---

## Testing and verification

```bash
npm test          # 131 tests
npm run typecheck
npm run lint
npm run build
npm run simulate -- --visitors 20000   # load test + statistical validation
```

The simulator is not just a load generator. Against a running server it verifies, in
order: assignment latency under concurrency, that the observed split matches the
configured split, that duplicate beacons do not inflate counts, that a known conversion
probability is recovered by the readout, and that stickiness holds end to end over
HTTP.

Representative run against the local build — 20,000 visitors, 50 concurrent, 30% of
exposures duplicated:

```
assignment latency   p50 2.10ms   p90 4.17ms   p99 7.65ms   max 30.12ms
tracking latency     p50 2.65ms   p99 9.18ms
throughput           8,306 visitors/s
errors               0
stickiness           0 violations in 2,000 re-checks
SRM                  chi2=1.15  p=0.5632  consistent with configured split

  arm             exp    conv   raw_exp  rate      95% CI            lift      sig
  control         10029    545    14075    5.43%  [5.01%, 5.90%]     --  no
  social-proof     4936    333     6960    6.75%  [6.08%, 7.48%]    24.1%  yes
  urgent           5035    377     7001    7.49%  [6.79%, 8.25%]    37.8%  yes
```

Note `raw_exp` is ~40% higher than `exp` in every arm — those are the duplicate beacons
being correctly collapsed — while the observed rates recover the configured 5% and 7%
ground truth. That is the property worth demonstrating.

Test coverage is concentrated where correctness is not obvious: bucketing invariants and
distribution, statistical functions against known values, cache failure modes, tracker
idempotency and queue bounds, and the full HTTP contract including the "never returns a
non-2xx" guarantee.

---

## Deployment

The service is a stateless Node process plus Postgres. It runs anywhere with a TCP
address.

```bash
docker build -t variant-service .
docker run -p 3000:3000 -e DATABASE_URL=... -e ADMIN_TOKEN=... variant-service
```

Configuration is entirely environment variables; see [`.env.example`](./.env.example)
for every option with its default. `DATABASE_URL` and `ADMIN_TOKEN` are the only
required values, and the process refuses to start in production without a token.

On Fly.io, [`fly.toml`](./fly.toml) is included:

```bash
fly launch --no-deploy
fly postgres create --name variant-db
fly postgres attach variant-db      # sets DATABASE_URL
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32)
fly deploy
fly ips allocate                    # dedicated IPv4 for sendBeacon traffic
```

Notes for a real deployment:

- **Migrations run separately** (`npm run migrate`), not on boot, so N instances
  starting at once cannot race each other on `CREATE TABLE`.
- **Scale horizontally with no coordination.** Assignment is a pure function, so any
  number of instances is interchangeable. `LISTEN/NOTIFY` reaches all of them.
- **Sticky sessions are not required** and would be a mistake — they would trade a
  guarantee this system already provides for a load-balancer feature you do not control.
- `/healthz` is the liveness probe; `/readyz` is the readiness probe.

---

## Repository layout

```
src/
  core/          bucketing, statistics, shared types -- no I/O, fully pure
  config/        environment parsing and validation
  db/            pool, migrations
  services/      config cache, tracker, results
  llm/           provider adapters, creative generation, distinctness
  routes/        assign, track, experiments, results, health, validation
  server.ts      app assembly, static assets, graceful shutdown
public/
  snippet.js     the customer integration
  dashboard.html results readout
  demo.html      live demo page
scripts/
  simulate.ts    load test and statistical validation
test/            131 tests
```

`src/core` has no imports from `src/services` or `src/routes`. The parts that must be
obviously correct are the parts with no I/O, which is what makes them testable.

---

## Design trade-offs

Full reasoning is in [DESIGN.md](./DESIGN.md). The short version:

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Assignment | Stateless hash | Assignment table | A write on the hottest path is a failure mode; a pure function has none. |
| Staleness | Serve stale config | Refresh or fail | A stale split is an annoyance; an outage is a lost experiment. |
| Event identity | Client UUID + unique index | Timestamp dedup | Only the client can distinguish a retry from a genuine repeat. |
| Slow write | Queue, return 202 | Block the client | Database health must not become page latency. |
| Confidence interval | Wilson | Normal approximation | The normal interval is wrong at the sample sizes that decide early calls. |
| LLM scope | Control plane only | Generate on read | Model latency and failure would land on the critical path. |
| Content safety | `textContent` only | Sanitising HTML | You cannot reliably sanitise model output; do not create the hazard. |

---

## Known limitations

Stated plainly, because a reader should not have to discover these.

- **Queued events are lost on process death.** Inherent to the in-memory retry queue;
  the trade-off is argued above.
- **`ADMIN_TOKEN` is a single static secret.** No users, no roles, no audit log of who
  changed what. A real control plane needs identity, not a shared token.
- **No per-experiment rate limiting or traffic caps** beyond `allocationBps`.
- **Results are computed on read.** Fine to millions of events; a long-running
  experiment with hundreds of millions would need pre-aggregated rollups. The current
  query is a single grouped scan, which is the easy version of that problem.
- **The results query holds a consistent snapshot** for correctness. On a very large
  events table that means a longer read; production would add a statement timeout,
  which is already configurable via `DB_STATEMENT_TIMEOUT_MS`.
- **`LISTEN/NOTIFY` is per-connection.** A pooler in transaction mode breaks it;
  deploy with a direct connection or `session` mode. This is called out because it is a
  silent failure that degrades to TTL-only invalidation.
- **Single-region.** No cross-region read path, so a second region means a second
  primary. Multi-region write routing is not designed for.
