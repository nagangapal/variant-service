# Design

Why this system is shaped the way it is. The [README](./README.md) covers how to run it;
this covers the reasoning, including the things I got wrong and the things I left undone.

---

## 1. The problem, restated

An experimentation platform has one genuinely hard constraint, and everything else
follows from it:

> **The decision that changes what a customer sees must not depend on anything that can
> fail slowly.**

Assignment sits on the page-render path. Tracking sits next to a conversion. If either
one waits on a dependency, the dependency's health becomes the product's health. Every
major decision below is a consequence of taking that constraint literally.

Two paths, deliberately asymmetric:

| | Assignment (read) | Tracking (write) | Control plane |
| --- | --- | --- | --- |
| Latency budget | 150ms total, 80ms client-side | 750ms, then queue | Seconds to minutes |
| May touch the network? | Only once, to warm an in-process cache | Yes, writes | Yes, including LLMs |
| May fail the customer? | **Never** | **Never** | Yes, freely |

---

## 2. Stateless assignment

### The decision

The variant is a pure function:

```
variant = f(namespace, experimentId, visitorId, config)
```

No table, no lookup, no coordination.

### What was rejected

A `(visitor, experiment) -> variant` table, written on first sight, is the obvious design
and is what most systems do. It is worse on three axes:

1. **It puts a write on the render path.** A page load that must wait on a database write
   is a page load that can fail, and it fails at exactly the moment traffic spikes.
2. **It makes the service stateful.** Every instance must see every write, which
   constrains deploys, scaling, and failover for data that is derivable.
3. **It is the largest table in the system.** O(visitors x experiments), growing forever,
   to store a function of inputs we already hold.

### What this buys

- **Stickiness by construction.** Verified across a restart: 300 visitors, 0 changed.
- **Horizontal scaling with no coordination.** Instances are interchangeable, so sticky
  sessions become unnecessary rather than merely discouraged.
- **Idempotence.** A retry cannot disagree with the original, because there is no
  original state to disagree with.
- **The read path is CPU-only.** No I/O means no dependency to be slow.

### Cost accepted

Mutual exclusion between experiments is impossible. Two experiments hashing the same
visitor independently can both enrol them. The standard mitigation — layered hash rings
with exclusions — is deliberately not built, because it is a large amount of machinery
for a problem that only arises with overlapping audiences. This is named rather than
hidden.

Stateful allocation (contextual bandits) is also out of reach, and for the same reason.

### Two hashes, not one

Allocation and variant selection use separate domain-separation strings:

```
"vs1|alloc|"   + namespace + experimentId + visitorId
"vs1|variant|" + namespace + experimentId + visitorId
```

This is the property that makes ramping safe. If one hash served both purposes, raising
`allocationBps` from 5% to 50% would reshuffle *who gets which variant* among the
visitors already enrolled, invalidating the experiment mid-flight. With separate
domains, the variant assignment is completely unaffected by allocation changes. You can
ramp traffic without touching results.

### Bucket reduction

10,000 buckets, selected with a multiply-shift ("fastrange") rather than a modulo.
Modulo introduces bias when the range is not a multiple of 10,000; the bias is
negligible, and removing it costs one multiply.

Weights are normalized to 10,000 and walked as a cumulative distribution, so operators
can express `1:1` and `1:2:1` without arithmetic, and the variant order is canonicalized
by key. **Reordering the variants in the config must not reshuffle visitors** — that is
a correctness property with a test.

### Cost

SHA-256 is measured at ~520-590ns per hash on an Apple M4, ~1.1µs for a full assignment,
~2.97µs for five experiments. Fast enough to be free, and hardware-accelerated
(SHA-NI) on modern cores. I benchmarked SHA-256 against alternatives before committing;
for this input size the difference is tens of nanoseconds and not worth trading
cryptographic quality for.

---

## 3. The configuration cache

### The decision

Config lives in an in-process snapshot, refreshed on a TTL, invalidated by
`LISTEN/NOTIFY`, and **served stale when a refresh fails**.

### Fail closed when cold, fail open when warm

This is the part worth arguing carefully, because the two halves sound contradictory.

**Cold** (no snapshot, first request, or a cold start): we decline to assign. We have
nothing, and inventing a variant would be worse than declining — a visitor would see
something no one configured. The request waits up to `ASSIGNMENT_DEADLINE_MS` (150ms)
for the initial load, and if that does not complete, returns no assignment with
`stale: true`. The page shows its default.

**Warm** (a snapshot exists but refreshes are failing): we serve it. The snapshot holds
traffic splits and pinned copy that are almost certainly still correct, because
experiments do not change shape every second. Declining here would take a live
experiment offline because of a transient database problem.

So: **never invent, but keep serving what you already know.** The asymmetry is
deliberate and is the whole design.

`CONFIG_MAX_STALE_MS` is one hour. That is a long time to serve stale config, and it is
chosen because the cost of being wrong is asymmetric:

- Serving a slightly stale split: a small statistical annoyance, self-correcting.
- Refusing to serve: a broken page for every visitor in the experiment.

A cold instance after a bad deploy briefly serves nothing; a warm instance serves the
last known truth. Both are correct given what each knows.

### Single-flight

Concurrent refresh attempts join one in-flight load rather than stampeding the database.
Without it, a TTL expiry under load triggers N concurrent full-table reads, which is
how a cache becomes the outage it was meant to prevent. `singleFlightJoins` is exposed in
`/readyz` precisely so this is observable.

### `LISTEN/NOTIFY` with TTL as backup

An admin change propagates to every instance in about a millisecond instead of waiting
out the TTL. TTL remains the fallback, so a dropped notification degrades latency of
change, not correctness.

**Operational caveat, stated because it fails silently:** `LISTEN` is per-connection. A
connection pooler in transaction mode breaks it, and the symptom is not an error — it is
invalidation quietly falling back to TTL-only. Deploy with a direct connection or
`session` mode.

---

## 4. Tracking and idempotency

### The decision

Every event carries a client-generated UUID with a unique constraint behind it, and
inserts use `ON CONFLICT DO NOTHING`.

### Why client-generated ids

The only component that can distinguish *"the client is retrying"* from *"this really
happened twice"* is the client. Timestamp-based dedup fails on both real duplicates
(rapid repeat events) and legitimate retries (a slow network). A client-generated id
that the client reuses across retries is the only mechanism that gets both right.

The database is the single authority: a race between two in-flight retries resolves at
the constraint, not in application logic.

### Why the client should be allowed to lie

`sendBeacon` fires during page unload, where the network is about to disappear. Beacons
get dropped, duplicated, and reordered. The design assumption is **every event will be
sent more than once**, and that only `event_id` distinguishes a retry from a genuine
repeat. This is why duplicate handling is a first-class database constraint rather than
best-effort application logic.

The measured effect: with 30% of exposures duplicated, unique visitors came out at
exactly 50/25/25 while raw event counts were ~40% higher per arm.

### Why a queue rather than blocking

Writes are bounded by `TRACK_WRITE_TIMEOUT_MS` (750ms). On timeout the event goes to an
in-memory queue and the client still gets `202`.

The alternative — block until the write lands — converts a database slowdown into page
latency on the customer's site. The brief is explicit that tracking must not degrade the
experience, and this is the mechanism that delivers it. Tracking returns in single-digit
milliseconds regardless of database health.

The queue retries on an interval and is capped at `TRACK_QUEUE_MAX`, dropping
oldest-first. An unbounded queue is a memory-exhaustion vector; a lost exposure is a
smaller problem than a dead process.

### Cost, stated plainly

**Events held only in the queue are lost if the process dies.** A visitor whose exposure
was queued during a deploy will not appear in results. I considered writing to disk and
rejected it as disproportionate for a metrics path, but the honest framing is that this
is a deliberate accuracy-for-latency trade, and it is lossy under process death.

---

## 5. Results

### The decision

One grouped query, returning per-variant unique visitors, rates, Wilson intervals, lift,
and a sample-ratio-mismatch check.

### The query was catastrophically wrong first

The first implementation computed attribution with a correlated `NOT EXISTS` subquery per
variant. On the 20,000-visitor dataset it took **2,777ms** and the planner showed
**15.1 million** row comparisons.

Rewritten as a single pass — group all events once, then resolve attribution in memory —
it takes **13.9ms**. About 200x, and the difference between a usable dashboard and one
nobody opens.

The lesson is the one worth keeping: attribution is a *set* problem, and expressing it
as a per-row correlated subquery turns it into a quadratic scan. The number to watch is
the planner's row estimate, not the wall clock.

### Unique visitors, not raw events

A visitor who triggers five exposure beacons is counted once. Without this, the
conversion rate moves when someone refreshes, and refresh frequency correlates with
engagement — so the bias is not even noise, it is structured.

### Attribution requires an exposure

A conversion from a visitor who was never exposed cannot be attributed to a variant. These
are counted as `unattributedConversions` rather than dropped, because a high count means
the integration is broken and you want to know. Silently discarding them would convert a
bug into a plausible-looking number.

### Wilson, not the normal approximation

The normal approximation is wrong exactly where it gets used. At 5% conversion on 200
visitors, a point estimate of 0.05 has a normal interval that misbehaves near the
boundary, and Wilson stays inside [0, 1] and is accurate at the small counts that decide
most early calls.

I checked coverage empirically rather than trusting the formula. At n=200 Wilson
*over*-covers (96.8%) because a discrete count distribution is lumpy — conservative rather
than anti-conservative, which is the safe direction — and it converges to ~95% as n
grows. The test asserts both, because "conservative at small n" and "accurate at large n"
are separate claims and the second is the one that matters for reading a result.

That test originally used `Math.random` and flaked about 1 run in 3. It now uses a seeded
PRNG. **A statistical test that fails intermittently is worse than no test**, because it
trains you to re-run failures instead of reading them.

### SRM, and why it comes first

If the observed split departs from the configured split beyond chance, every number in
the readout is suspect — including an impressive-looking lift. A broken assignment, a
bot, or a tracking bug all produce a split anomaly, and all of them can also produce a
"winner."

So the check runs before any interpretation is offered, and the readout says
`Integrity check skipped` or the mismatch reason rather than presenting results as
trustworthy. **Detecting this is the difference between shipping a real improvement and
shipping a bug that looks like one.**

---

## 6. LLM content generation

### The decision

Generation happens only in the control plane, on `create` and `regenerate`. The serving
path never calls a model.

### Why not generate on read

A model call is 500ms-10s with a tail, an availability profile worse than the database's,
and a cost per call. Putting any of that on the path that decides what a customer sees
would be indefensible. The model is a *tool for the operator*, not part of the request.

Consequently: generation happens **once**, and the output is **pinned** to the variant.
Regeneration is an explicit, separately-named endpoint.

### Pinning is what makes it safe

Because creatives are pinned, a model that is slow, down, or changed its mind cannot
affect a running experiment. Copy stays constant for the life of the experiment, which
also means the comparison stays valid — copy that changes mid-flight confounds the
treatment.

### Three bugs found by testing the documented examples

Worth recording, because all three were invisible to the unit tests and all three would
have shipped a visible defect.

**1. An explicit creative was silently overwritten.** The README example supplied a
fixed `creative` for the control arm. The response said `source: "llm"` and returned
generated text. The explicit creative was being used only as a *fallback* if generation
failed, which defeats the entire purpose of pinning a fixed control — and the operator
would only discover it by reading the response carefully. Fixed so an explicit creative
is authoritative and opts that variant out of generation. Regression test added.

**2. The create response omitted the pinned copy.** You had to issue a second request to
see what the model actually produced. For a step whose output is unreviewed model text
going live on a customer page, that is backwards. The response now includes the pinned
creatives.

**3. A failed generation put the variant key on the page as visible headline text.** This
one is the worst of the three, and it only appeared once I tested the recommended
self-hosted model rather than the good one. The fallback for a failed generation was
`headline: variantKey`, so an arm that failed to generate rendered the literal string
`social-proof` to every visitor. The fallback is now neutral placeholder copy, and —
more importantly — a fallback creative is stored with `source: 'fallback'`, distinct from
a deliberate `'static'` one, and `start` **refuses** to run an experiment containing any
fallback creative.

That last part is the real lesson. The original fallback was "never block the operator on
a third-party API," which is sound as far as it goes, but it had no way to distinguish
"the experiment is created with a placeholder" from "the experiment has content." Because
the two looked identical, the start guard could not protect the customer page. A
degradation that cannot be *detected* cannot be guarded against, so the fix was to make
the degradation visible in the data model rather than to make the fallback nicer.

All three came from running the documented examples and the recommended deployment path
end to end, rather than from the unit tests. The tests were green the whole time.

### Validation and distinctness

Every field is length-bounded and type-checked before storage, because the input is model
output and model output is not trusted.

Variants are compared pairwise on token Jaccard similarity; above `0.6` the run is
flagged. An experiment whose arms say the same thing measures noise and produces a null
result that is indistinguishable from "no effect". I report the collision rather than
hard-failing, because subtle copy tests are legitimate — but the operator is told, and
`worstSimilarity` is in the response.

### Fallback, and why it has to be visible

If no provider is configured or the call fails, the variant is still stored so the
experiment is not lost — with `source: 'fallback'` and neutral placeholder copy.

The important part is that the fallback is **distinguishable in the data model**. It was
originally `'static'`, indistinguishable from a deliberately chosen static headline,
which meant the start guard could not tell a real experiment from one running on filler.
A degradation that cannot be detected cannot be guarded against, so the fix was a schema
change (`002_creative_source_fallback.sql`) and a start guard, not a nicer placeholder.

`start` now returns `409 placeholder_creative` if any arm is on placeholder copy, and
tells the operator to supply an explicit creative or fix the provider. Running such an
experiment would compare a real headline against filler and consume traffic to learn
nothing — worse than not running it.

### Providers

Anthropic, OpenAI, and Ollama behind one interface. The Anthropic adapter uses prompt
caching, since the system prompt is identical across candidates within an experiment and
should be paid for once rather than three times.

---

## 7. The client snippet

The requirement is not "works when the service is up". It is **cannot break the page**,
which is a stronger and more testable contract.

- **Client-side deadline (80ms).** A server timeout is not sufficient, because the failure
  that matters is the one the server never sees — a dropped packet, a captive portal, an
  ad blocker. The request races a timer; defaults win on timeout.
- **`textContent`, never `innerHTML`.** Content is model-generated. You cannot reliably
  sanitise model output, so the correct move is to never create the hazard: there is no
  HTML parsing path in the snippet at all.
- **Wrapped so nothing throws.** No exception can escape into the host page's scope.
- **First-party identity cookie.** Unaffected by third-party cookie blocking, with a
  session-scoped fallback so identity is still stable within a visit.
- **`sendBeacon` for conversions**, so a conversion on an unload path still lands.

---

## 8. What I would do next

In priority order, with the reason each is not in the current build.

1. **Persist the retry queue.** The one real correctness gap. A bounded disk-backed queue
   removes the "lost on process death" caveat. Deliberately deferred: disproportionate for
   a metrics path, and I would rather name the gap than paper over it.
2. **Pre-aggregated results rollups.** Results are computed on read. Fine to millions of
   events; a long-running experiment at hundreds of millions needs rollups. The current
   single grouped scan is the easy version of that problem.
3. **Real control-plane identity.** `ADMIN_TOKEN` is a single shared secret. No users, no
   roles, no record of who changed what. For an experimentation platform, where a bad
   allocation change silently corrupts results, "who did this" is not a nice-to-have.
4. **Experiment mutual exclusion.** Layered hash rings. Only worth it with overlapping
   audiences, and it makes assignment stateful again — the trade needs justifying against
   the cost already paid.
5. **Streaming exports.** Readout pagination for large experiments.
6. **Per-experiment traffic caps and rate limits.** `allocationBps` bounds enrolment, but
   nothing bounds event volume from a misbehaving client.

---

## 9. Honest assessment of the weak points

- **The queue is lossy under process death.** Argueable, but it is a real gap.
- **Single shared admin token.** The weakest part of the security posture.
- **Results on read.** Correct and fast now; wrong at a scale I have not tested.
- **Mutual exclusion is absent.** Named, not solved.
- **The Monte Carlo tests are seeded, which makes them reproducible but means they verify
  a specific sample.** They are evidence of correctness, not proof of it.
- **`LISTEN/NOTIFY` fails silently behind a transaction-mode pooler.** I have not built a
  runtime check for the listener being attached; `/readyz` reports notification counts,
  which is how you would notice, but it is not an assertion.
