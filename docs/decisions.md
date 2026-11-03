# Decisions

Engineering decisions for Integration Proof and the reasoning behind them.

## Cache Components stay off

**Decision:** `cacheComponents` is `false` in `next.config.ts`. `partialPrefetching` is removed with
it, because Next.js rejects that option at config validation unless `cacheComponents` is on.

**Why:**

- Nothing here is worth caching. Run pages, traces and store state report what is true right now,
  so the app has no use for `use cache`, `cacheLife` or `cacheTag`.
- Freshness stays the default. Without Cache Components a `GET` Route Handler is dynamic unless it
  opts into caching. With it, `GET` handlers follow the page model and prerender when they touch no
  uncached or runtime data. Assertions evaluate the state returned by `/api/store/[mode]/state`, so
  a stale response would produce a wrong verdict.
- Fewer states to reason about. Cache Components keeps visited routes mounted inside a hidden
  `<Activity>`. A run page that polls status should unmount on leave and start clean on return.

**Consequence:** a page that reads live data and uses no Request-time API must call
`await connection()` before its query. Otherwise Next.js prerenders it at build time.

**Revisit:** when upgrading to Next.js 17. The docs state that both features will be enabled
everywhere in the next major release and that the options will be removed.

**References:**
[cacheComponents](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents),
[partialPrefetching](https://nextjs.org/docs/app/api-reference/config/next-config-js/partialPrefetching),
[Route Handlers with Cache Components](https://nextjs.org/docs/app/getting-started/route-handlers#with-cache-components),
[connection](https://nextjs.org/docs/app/api-reference/functions/connection).

## Analyst runs on Claude Sonnet 5.5

**Decision:** `ANTHROPIC_MODEL` is `claude-sonnet-5-5`. This is a deliberate choice for speed and
cost over `claude-opus-5-5`.

**Why:**

- Speed: the explanation is read on the results page right after a run, so its latency is visible
  to the person waiting for it.
- Cost: list prices are $2 / $10 per million input / output tokens for Sonnet 5.5 and $4 / $20 for
  Opus 5.5, and a full proof can request an explanation for each of its six scenarios.
- The quality risk is bounded. The model never decides PASS/FAIL, its output is validated against a
  zod schema, every evidence item must reference an existing trace step id, and invalid output ends
  in "explanation unavailable" with the verdict still shown.

**Revisit:** if root-cause analysis falls short on real traces. The model is an environment
variable, so changing it needs no code change.

**References:**
[Anthropic model pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked
2026-11-02.

## Headless buyer confirms the card before a separate capture

**Decision:** the runner creates the order with no payment source, sends the card to
`confirm-payment-source`, then captures in its own request. The vaulted wallet fallback is not
built.

**Why:**

- The capture has to be its own request, because S1, S2 and S3 fault that request in the proxy. With
  `payment_source.card` on create order the sandbox returns `COMPLETED` in one call, so there is no
  capture to fault.
- The flow needs no buyer, browser or payer action: `CREATED`, `APPROVED`, then `COMPLETED`.
- Card processing is enabled on the sandbox account, so the fallback has no job to do.

**Consequence:** the store still creates and captures the order. The runner plays the buyer between
those two calls by sending the card to `confirm-payment-source`, which leaves the store's capture as
the request the proxy faults.

**Revisit:** if the runner has to cover 3D Secure, which was not tested and needs a payer action.

**References:** [sandbox findings](sandbox-findings.md#headless-card-purchase).

## PayPal calls use our fetch client, not the server SDK

**Decision:** `lib/paypal/client.ts` stays a fetch client with an injectable base URL.
`@paypal/paypal-server-sdk` is not a dependency.

**Why:** the store has to reach PayPal through `/api/proxy/{runId}` during a run. SDK 2.5.0 has no
base URL option: the host comes from an enum of two hard-coded values. Its outbound proxy setting
keeps PayPal as the target, and `unstable_httpClientOptions` is not a supported route to the same
result.

**Revisit:** if a later SDK release adds a base URL option. The fetch client would still be the
smaller dependency.

**References:** [sandbox findings](sandbox-findings.md#custom-base-url-in-the-server-sdk).

## Harm is counted per cart, not per order

**Decision:** assertions count charges per buyer cart. `chargesPerCart` is the number of completed
captures across every order a run created for one cart, read from PayPal with
`GET /v2/checkout/orders/{id}`. S2 passes when the order ends PAID with exactly one charge. S3 passes
when `chargesPerCart` is 1 and the order is PAID. This replaces judging S2 by the
`PayPal-Request-Id` on the retry.

**Why:**

- PayPal allows one capture per `intent: CAPTURE` order. A second capture with a new key or no key
  returns 422 `ORDER_ALREADY_CAPTURED`, so a per-order count is 1 for both stores and separates
  nothing.
- A buyer's double charge comes from a second order. A store that records a paid capture as failed
  sends the buyer back to checkout, and PayPal captures the new order like any other.
- The key on the S2 retry does not separate the stores either. The mocked 500 never reaches a real
  capture, so the retry captures once whatever key it sends. What separates them is whether the store
  retries at all: a store that gives up loses a sale the buyer was ready to pay for.
- PayPal is the source of truth. After S3 the naive store's own rows say FAILED, so a count taken
  from them would hide the second charge.

**Consequence:**

- Every order row stores a `cartId`, and the runner keeps the id of every order it creates for a
  cart.
- In S3 the runner, acting as the buyer, checks out the same cart again when the store reports a
  failed payment. The hardened store reconciles the timeout with `GET /v2/checkout/orders/{id}`, so
  it reports PAID and no second checkout happens.
- The hardened store still sends a stable `PayPal-Request-Id` on capture. If an attempt did capture,
  a retry with the same key returns 200 and the original capture id instead of a 422 that reads like
  a failed payment.
- Product copy, including analyst explanations, never claims that a retry charges the same order
  twice. The harms shown are a lost sale (S2) and a second charge on a new order for the same cart
  (S3).

**Revisit:** when the fault-injection proxy runs S3 end to end. A lost response after a successful
capture has not been observed yet; record the real sequence in sandbox findings.

**References:** [capture replay and repeated capture](sandbox-findings.md#capture-replay-and-repeated-capture),
[retry after a mocked 500](sandbox-findings.md#retry-after-a-mocked-500),
[Orders v2 errors](https://developer.paypal.com/api/rest/reference/orders/v2/errors/).

## Timeouts wait for a measurement from the hosting region

**Decision:** the store timeout and the full-proof time budget are set from latency measured on the
deployed service, not from local runs. Until then the capability check allows 30 seconds per call. A
call with no response is reported as an outcome of that call, not as a crash.

**Why:** local calls took 5.1 s at the median and up to 11.4 s, but an unauthenticated 401 took
about as long and a reference host was also slow, so most of that time belongs to the local network
path. One local request also lost its connection before PayPal captured anything.

**Consequence:** the runner and proxy treat a missing response as a normal trace entry.

**References:** [sandbox findings](sandbox-findings.md#latency-and-connection-failures).

## Postgres through node-postgres, not Neon's HTTP driver

**Decision:** the app talks to Neon with `pg` and `drizzle-orm/node-postgres`, one pool per process.

**Why:**

- The service is a long-running Node process on Render, so a TCP pool stays warm across requests.
- The hardened store claims an event id and applies its effect in one transaction that branches on
  the result of the claim. The HTTP driver runs single statements or fixed batches, which cannot
  express that.

**References:** [Drizzle with PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql).

## Webhooks drive fulfilment in both stores

**Decision:** an order ships when its `PAYMENT.CAPTURE.COMPLETED` webhook is applied. The capture
response only decides what the buyer is told.

**Why:**

- One trigger in both stores keeps S4 about event dedupe alone. If the capture response also shipped,
  the naive store would ship twice on every ordinary checkout and the scenario would prove nothing.
- Shipping on the webhook also covers a capture whose response never arrived.

**Consequence:** `fulfilments` has no unique constraint, so a duplicate event in the naive store
produces a second row. The hardened store prevents it with the primary key on
`webhook_events.event_id`, inside the same transaction as the shipment.

## The hardened store asks PayPal on every event

**Decision:** after a verified, unseen event, the hardened store reads the order with
`GET /v2/checkout/orders/{id}` and takes the order status from the latest capture. The event type only
decides whether to ship. The naive store applies the status each event type suggests, in arrival
order.

**Why:** deliveries can arrive out of order (S5). The current capture status at PayPal is the source
of truth, so the result no longer depends on delivery order.

**Consequence:** one extra GET per new event. If PayPal cannot be read, the router answers 503 and
PayPal delivers the event again later.

## Node.js 24 everywhere

**Decision:** `.node-version` pins Node.js `24.22.2` and `engines.node` in `package.json` is `24.x`.
Render reads `.node-version` before `engines`, so every build and the running service use that
exact version. A `NODE_VERSION` variable in the Render dashboard would override both, so the service
sets none.

**Why:**

- Next.js 16 requires Node.js 20.9 or later, but the 20 line reached end of life on 2026-04-30 and
  gets no security fixes. Vitest's Vite also needs 20.19 or later on that line.
- 24 is an LTS line with security fixes until 2028-04-30, and the line the app is developed and
  tested on.
- An exact pin keeps a build from moving to a new release on its own. Render resolves an open range
  such as `>=20.9` to the latest Node.js, which can change the major version.
- `24.x` in `engines` has the upper bound Render asks for and makes npm warn on any other major.

**Revisit:** when moving to Node.js 26, the active LTS line since 2026-10-28, and in any case
before 24 reaches end of life on 2028-04-30.

**References:**
[Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16#nodejs-runtime-and-browser-support),
[Render: setting your Node.js version](https://render.com/docs/node-version),
[Node.js release schedule](https://github.com/nodejs/Release#release-schedule), checked 2026-11-03.

## S4 and S5 replay real deliveries

**Decision:** S4 and S5 deliver real PayPal events by replaying a recorded delivery: its original
body and transmission headers, posted to the webhook router again. Neither scenario forges or
simulates an event.

**Why:**

- A replay passes `verify-webhook-signature` just as the original did, so the stores receive a
  delivery that is genuine in every respect except that it has been seen before. Webhooks Simulator
  events cannot be verified by postback, so they would not reach the hardened store's state logic.
- Verification cannot catch a replay. A store that verifies signatures but does not dedupe by event
  id ships a replayed event again. S4 therefore tests the event-id dedupe and S6 tests verification,
  and neither depends on the other.

**Consequence:**

- S4: the runner waits for the real `PAYMENT.CAPTURE.COMPLETED`, then replays it. The naive store
  records a second fulfilment; the hardened store answers `duplicate`.
- S5: PayPal decides the order of its own deliveries, so the runner cannot make a later event arrive
  first. It refunds the capture right after it, then replays the earlier event once the later one
  has been applied: the store has the later state when the stale event arrives. The naive store
  applies the stale status. In the hardened store the replay stops at the event-id dedupe, but
  PayPal's own `PAYMENT.CAPTURE.COMPLETED` already arrived after the refund, and the hardened store
  read the order on it, found the capture refunded and shipped nothing.
- The runner replays as soon as the original is recorded. A replay 48 seconds after transmission
  verified; an older one was not tried.

**Revisit:** if a replay fails verification, for example because of its transmission age.

**References:** [replay of a recorded delivery](sandbox-findings.md#replay-of-a-recorded-delivery),
[a real delivery on the deployed service](sandbox-findings.md#a-real-delivery-on-the-deployed-service).

## Scenarios run in parallel and wait for webhooks with a deadline

**Decision:** the scenarios of a run execute concurrently. After its last action, a scenario waits
until the store has acknowledged a `PAYMENT.CAPTURE.COMPLETED` for every capture PayPal reports for
the cart, so the assertion sees the state the webhook leaves behind. While it waits, its status reads
"waiting for PayPal webhook". The wait ends after 90 seconds; a missed webhook is recorded in the
trace and does not crash the run.

**Why:**

- The one measured delivery reached the store 49 seconds after its capture. Waiting for each
  scenario in turn would add that delay once per scenario that captures, and S5 waits for two
  deliveries. In parallel, a run takes about as long as its slowest scenario.
- Scenarios cannot interfere with each other. Each one has its own cart and orders, and the proxy
  faults only the requests of the scenario they belong to.
- 90 seconds is almost twice the measured delay and keeps a full proof within two minutes.

**Consequence:** run time is set by webhook delivery, not by the number of scenarios. Every wait is a
trace step with its duration, so each run adds a latency measurement.

**Revisit:** when recorded waits show the 90-second deadline is too short or far too long.

**References:** [delivery latency](sandbox-findings.md#delivery-latency).

## Each scenario has a secret key to the proxy

**Decision:** every scenario of a run gets a random 256-bit run key. The runner sends it with the
store's create order request, and the store then sends that order's PayPal calls to
`/api/proxy/{runId}/{runKey}`. The proxy finds the scenario by the key. The key is stored only in
`run_scenarios`, never returned by the runs API, and redacted from traces.

**Why:**

- Run ids are public: they appear in the run's URL. With only a run id and a scenario id in the proxy
  URL, anyone could send requests into a running scenario. One early capture through the proxy would
  use up S2's mocked first attempt and turn the naive store's FAIL into a PASS.
- A cart id is not a secret either, because the trace shows the requests that carry it. The store
  therefore accepts a run's proxy for a new order only with the matching key. The runner reads store
  state for its cart and its run, so an order someone else creates for the same cart is not counted.
- The proxy needs to know the scenario before an order exists. Create order is the first call, and
  the store records its order only after PayPal answers, so the URL has to carry it.

**Consequence:** the proxy forwards only the Orders v2 create, get and capture calls, and only while
the scenario is running. Anything else returns 404 before a request reaches PayPal.

## One Neon database for the deployed service and local development

**Decision:** the deployed service and local development share one Neon database. This is a
deliberate trade-off. Render builds with `npm ci && npm run db:migrate && npm run build`, so a deploy
applies pending migrations before it builds.

**Why:**

- PayPal delivers webhooks only to the URL registered on the sandbox app, which is the deployed
  router. A local run sees a webhook only because the deployed router writes it to the same database.
  A separate local database would need its own sandbox app and a public tunnel for every session.
- One database holds one record of sandbox orders, deliveries and traces, so a local run and the
  deployed service never disagree about what happened.

**Cost:** the deployed code and the code on a local branch use one schema at the same time, and test
data written locally shows up on the deployed service.

**Rules:**

- **Migrations only add:** new tables, new enum types, new indexes, and new columns that are
  nullable or have a default. No drops, renames or type changes, because the deployed code must keep
  working against a schema a newer branch has already migrated. Removing something is a separate
  decision, taken once no running code uses it.
- **An applied migration is never rewritten.** `drizzle-kit migrate` stores each file's hash in
  `drizzle.__drizzle_migrations` but never compares it. An edited file would not run again, and the
  schema would silently differ from the files. A change is a new migration.
- **Migrations apply in merge order.** Only migrations newer than the newest recorded one run, so a
  migration generated earlier but applied later is skipped without an error. Generate a migration
  on a branch that is up to date with `main`, and apply it to the shared database from that branch
  only, just before it merges.
- **Test data is cleared with `npm run db:reset`.** It prints the row count of every table and
  deletes only with `--yes`, keeping the schema and the migration history. The database is shared,
  so a reset also clears the runs the deployed service shows.

**Consequence:** all pending migrations run in one transaction. A migration that fails leaves the
schema as it was, and the `&&` chain stops the build before `next build`, so the previous deploy
keeps serving.

**Verified on 2026-11-03** with `sslmode=verify-full`:

- `npm run db:migrate` ran twice on the shared database and twice on a temporary empty database,
  which was dropped afterwards. Every run exited 0, and the second run recorded nothing new.
- Both databases ended with the same tables and enums, and the recorded timestamps and hashes match
  the files.
- The output shows neither credentials nor node-postgres's SSL warning.
- A connection that trusted only an unrelated root CA was refused with
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, so the server certificate is verified.

**Revisit:** when the service stores anything beyond sandbox data or a second developer runs
migrations. Each environment then gets its own Neon branch.

**References:** [Drizzle migrations](https://orm.drizzle.team/docs/migrations),
[Neon branching](https://neon.com/docs/introduction/branching).

## Proof runs use a shorter store timeout

**Decision:** during a run the store's PayPal calls time out after `storeTimeoutMs`, 8 seconds by
default, instead of the 15 seconds of normal checkout. In S3 the proxy holds PayPal's answer for
`proxyHoldMs`, 10 seconds by default and always longer than the store timeout. Both are stored on
the run and can be set per run in `POST /api/runs`.

**Why:**

- S3 needs the store to give up before PayPal's answer arrives. With the normal timeout every S3
  capture would cost at least 15 seconds, and the naive store's second checkout adds the same again.
- One timeout for every call of the run keeps all scenarios on the configuration a store would
  really use. 8 seconds is well above the longest call seen through the proxy, 3.3 seconds, so other
  scenarios do not time out by accident.
- The proxy writes the held capture to the trace as soon as PayPal answers. The evidence does not
  depend on how long the store waits.

**Consequence:** a store under test sees a short timeout only inside a run. Normal checkout keeps
`PAYPAL_CALL_TIMEOUT_MS`.

**Revisit:** with the latency measured on the deployed service. A lower timeout makes S3 faster;
one close to real call latency makes other scenarios fail for the wrong reason.

**References:** [webhook waits in full proofs](sandbox-findings.md#webhook-waits-in-full-proofs),
[timeouts wait for a measurement](#timeouts-wait-for-a-measurement-from-the-hosting-region).
