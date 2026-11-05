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
Revisited on 2026-11-04: the deadline is now 150 seconds, see
[INCONCLUSIVE when PayPal does not deliver in time](#inconclusive-when-paypal-does-not-deliver-in-time).

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

## INCONCLUSIVE when PayPal does not deliver in time

**Decision:** when a webhook that S4, S5 or S6 needs has not reached the store by the deadline, the
scenario gets the verdict INCONCLUSIVE with the reason "PayPal did not deliver <event> within <N> s",
not FAIL, PASS or an error. The deadline is 150 seconds instead of 90. The run summary counts
INCONCLUSIVE apart from passes and failures. S1 to S3 wait for webhooks only so the state can settle,
and are judged whether the webhooks came or not.

**Why:**

- A missing delivery says nothing about the store under test. FAIL would blame the store for PayPal's
  delay, PASS would claim a test that never ran, and an error reads like a crash of the product.
- S5 waits for two deliveries. One naive run on 2026-11-04 waited 138.3 seconds for them, more than
  the old 90-second deadline allowed.
- The page counts the seconds while a scenario waits, so a long wait reads as waiting, not as a hang.

**Consequence:** a full proof can take up to two and a half minutes when PayPal is slow. An
INCONCLUSIVE scenario is analysed like a failure; the analyst explains what the trace shows about the
delivery and proposes no patch unless the store's own answers stopped PayPal from delivering.

**Revisit:** when recorded waits regularly come close to 150 seconds.

## Claude explains a failure; the verdict stays deterministic

**Decision:** once a scenario ends FAIL or INCONCLUSIVE, the analyst (`lib/ai/analyst.ts`) asks the
model in `ANTHROPIC_MODEL` for the root cause, the business impact, evidence that cites trace steps,
a fix as a unified diff against the real store file, links to PayPal documentation, how to verify the
fix, and a confidence. It starts after the verdict is recorded and the run does not wait for it.

**Input:** the scenario's definition and PASS criterion, the verdict and its reason, the redacted
trace without links and personal data, and the store file under test in full. Next to it, read-only:
the exported declarations, with doc comments, of `lib/store/shared`, `lib/store/repository` and every
`lib/paypal` module, the row types the store reads, and the configuration variable names from
`.env.example` without values. No implementation of those modules and nothing of the hardened store
is sent. The declarations are generated by the TypeScript compiler into
`lib/ai/context.generated.json` (`npm run analyst:context`), and a test fails when that file is out
of date. Patches then use the project's real helpers and configuration, such as
`PAYPAL_WEBHOOK_ID`, instead of guessing them.

**Output and checks:**

- Structured output (`output_config.format` with the SDK's `zodOutputFormat`) on `messages.create`.
  `messages.parse` throws when the answer misses the schema, and that loses the token usage and the
  answer the retry needs. Forced `tool_choice` returns 400 on Claude Sonnet 5.5, so tool use would
  not guarantee the format.
- Code checks every answer: the schema; every evidence `stepId` exists in the trace; documentation
  links only on `developer.paypal.com` or `docs.paypal.ai`; no PayPal order, capture or event id in
  the text, because the analysis is reused for runs whose ids differ. An invalid answer gets one retry
  with the reasons. A second invalid answer, a refusal or a failed API call ends in "analysis
  unavailable", and the verdict stands.
- The patch is applied to the real file with jsdiff's `applyPatch`. Hunk line counts are recounted as
  `git apply --recount` does; the context must match exactly. A patch that does not apply is shown as
  "patch needs review", never hidden.
- Revisited on 2026-11-05: the model now writes edits and code builds the diff, see
  [Claude proposes edits; code writes the diff](#claude-proposes-edits-code-writes-the-diff).

**Untrusted data:** everything from the trace (PayPal responses, webhook bodies, the forged event of
S6) sits in an `<untrusted_trace>` section, with `<` escaped so no content can close the section or
open another. The system prompt says it is data and not instructions, and a mid-conversation system
message after it repeats that through the operator channel, which text inside the trace cannot
imitate.

**Cost:**

- The `analyses` table caches results under a hash of the scenario, the model, the store files and a
  trace signature. The signature keeps methods, paths, statuses, faults and outcomes and drops ids,
  times and durations. A run that fails the same way with the same code spends no tokens.
- The store files come first in the prompt behind a cache breakpoint, so the analyses of one run
  share that prefix.
- Effort is `high`, because the patch has to apply to the real file.

**Tracing:** every model call is a trace step of the scenario, with actor `analyst`, the model,
input, cached and output tokens, the duration and the outcome. A cache hit is a step that says so.

**No server-side fallback:** the reminder is a mid-conversation system message, which Claude Sonnet
5.5 accepts and its fallback model Claude Sonnet 5 rejects. A refusal therefore ends as "analysis
unavailable" with its category.

**Verified on 2026-11-04** with a full proof of the naive store and `claude-sonnet-5-5`:

- All five failures were analysed, each valid on the first attempt. Every evidence `stepId` exists
  in its trace.
- All five patches apply to `lib/store/naive.ts`, three of them after recounting hunk headers. Each
  patched file passes `tsc`.
- Each analysis took 21 to 35 seconds, all running alongside the scenarios. The last one finished
  29 seconds after the 46-second run.
- Tokens: 78,889 input in total and 18,863 output. Of the input, 11,493 were written to the cache by
  the first analysis and 45,972 were read from it by the other four.
- The next two runs failed the same way and reused all five analyses with no model call.

**Revisit:** when analyses of customer code replace the reference stores. That code is untrusted as a
whole and needs the same treatment as the trace.

## The result pages say what happened in plain words

**Decision:** every verdict carries a headline from the same deterministic code that decides it:
"Buyer charged twice", "Order shipped twice", "Refunded order shown as paid", "Forged refund
accepted", "Sale lost on a transient error", or for a pass "Charged once, no second checkout". The
assertion derives it from the facts it checked. S3 says "Buyer charged twice" only when PayPal shows
two charges, and "Paid order shown as failed" when it shows one.

**Why:** a reader should see what the failure costs before reading a reason sentence. A headline
picked per scenario would claim a harm that a particular run did not show.

**Consequence:** runs recorded before headlines existed fall back to the scenario's usual headline
on the page.

## The trace is a grid of who did what

**Decision:** each scenario's trace is an AG Grid Community table with the columns step, actor,
call, HTTP status, duration, debug_id and detail. Actors are named as a reader sees them:
- `buyer`: the headless buyer;
- `store`: a store call to PayPal through the proxy;
- `proxy`: such a call when the proxy faulted it;
- `PayPal`: its webhook deliveries, from the runner's wait;
- `runner`;
- `Claude`.

An evidence link in the analysis scrolls to its step and marks the row.

**Why:** steps with no request line, such as a webhook wait or a cached analysis, read as empty rows
in a plain list. A grid with a call and a detail column shows every step's content. Its colors come
from the site's tokens, so it follows the light and dark themes.

**Consequence:** the grid loads in the browser on first use, so the page itself stays light.

## A demo can ask Claude again

**Decision:** `POST /api/runs?fresh=<token>`, and `/proof?fresh=<token>` on the page, makes that
run's analyses skip the cache. Revisited on 2026-11-05: only the operator's `FRESH_ANALYSIS_TOKEN`
does this, see [the demo is protected from one visitor](#the-demo-is-protected-from-one-visitor).

**Why:** a cached analysis appears at once. To show Claude working, from "Analyzing…" to the
result, the analysis has to run again.

**Consequence:** a fresh run of the naive store costs a new analysis of each of its failures, about
$0.27 at list prices.

## Database connections fail fast

**Decision:**
- The pool holds up to 15 connections and closes them after 30 seconds idle.
- TCP keepalive is on.
- Connecting times out after 10 seconds and a query after 20.
- An error on an idle connection is logged, not thrown.

The runner's wait for webhooks never polls past its deadline.

**Why:** on 2026-11-04 a connection died without a word during a local full proof. Without these
settings:
- a query on it hung until the operating system gave up minutes later;
- the webhook wait stretched to 415 seconds;
- the error on the idle connection reached the process as an uncaught exception.

Earlier the same day, five connections shared by six scenarios and their proxied calls made a store
time out on a call PayPal had answered in two seconds.

**Consequence:** a lost connection now costs a scenario at most a few seconds and ends in an error
the page shows, not a run stuck in RUNNING.

## A passing card shows the code that passed

**Decision:** a PASS card shows "How the hardened store handles it": the three to six lines of
`lib/store/hardened.ts` that decide the scenario, with the store's own comment as the caption, the
line numbers, and a link to the same lines on GitHub at the deployed commit. The naive store's one
pass, S1, shows its own lines the same way.

**How:** a comment that starts with a scenario id marks the code, for example
`// [S3] Fix: no answer is not a failure.` The snippet is the code after the comment, up to the next
blank line or the end of the block. `lib/store/snippets.ts` reads the store files at runtime, once
per process. A test fails when a scenario of the hardened store has no marker, two markers, fewer
than three or more than six lines, or lines without the identifiers that decide it, such as
`isEventProcessed` for S4.

**Why:**

- A pass needs as much evidence as a failure. Next to a failed card with Claude's analysis, an empty
  passing card says nothing about why the hardened store passed.
- Read from the file, the snippet cannot drift from the code that ran. A copy in the UI would.
- The markers sit where the "Fix:" comments already were, so the file reads as before.

**Consequence:** markers are part of the store code. A change to `hardened.ts` that moves the
deciding lines moves the marker with them; the test says which scenario lost its marker.

## A run states what its failures cost

**Decision:** under a store's score, a finished run lists what its failures cost: "This run: 1 cart
charged twice · 1 order shipped twice · 1 refund shown as paid · 1 forged refund accepted · 1 sale
lost". Each assertion returns a harm with its verdict and headline, from the same facts, and the run
counts them. A run where every scenario passed says "all 6 failures handled, nothing charged or
shipped twice". The score is red with any failure, green when every scenario passed and amber
otherwise; each scenario card has a thin stripe in its verdict's color.

**Why:** the line answers "so what?" for the whole run in one glance, and it can only claim what
happened. A failure that never reached the behaviour it tests, such as a replay missing from the
trace, records no harm, and INCONCLUSIVE records none.

**Consequence:** `run_scenarios.harm` holds the key of the harm, from `HARMS` in
`lib/proof/harms.ts`. Runs recorded before it existed show no line. The status colors pass WCAG AA
on the page background in both themes: at least 6.8:1 in the light theme and 10.4:1 in the dark one.

## The runner retries its own PayPal calls

**Decision:** the runner's own PayPal calls, the buyer's `confirm-payment-source`, the merchant's
refund and the runner's `GET /v2/checkout/orders/{id}`, get up to three attempts. A 5xx, a timeout,
a network error or a token that cannot be fetched is retried after 500 ms and then 1 s; a 2xx or a
4xx ends the call. Only when every attempt failed does the scenario end in ERROR, with the reason
"PayPal sandbox did not respond after 3 attempts", the call and its last answer. Every attempt is a
trace step whose note says which attempt it was.

**Why:**

- These calls are not under test. A slow or failing sandbox on one of them says nothing about the
  store, and a scenario that ends in ERROR for it hides a verdict the run could have reached.
- The store's calls through the proxy are not retried by the runner. How the store handles a failed
  call is what S1 to S3 measure.

**Retrying safely:**

- A refund keeps one `PayPal-Request-Id` across its attempts, and the runner accepts any 2xx: PayPal
  answers a repeated key with the original refund and 200, where a new key would get 422
  `CAPTURE_FULLY_REFUNDED`.
- `confirm-payment-source` gets no key, because the Orders schema lists none for it. A repeated
  confirm on an `APPROVED` order returns 200 `APPROVED` and captures nothing, so it is safe to
  repeat.
- A GET changes nothing and needs no key.

**Consequence:** a scenario can take up to three times a call's 30-second timeout longer when the
sandbox is down, and still ends in ERROR then.

**References:** [retries of the runner's own calls](sandbox-findings.md#retries-of-the-runners-own-calls-2026-11-04).

## Model-generated code never runs on the server

**Decision:** code written by the model never runs on the server. A patch is checked against the
store file as text on the server and shown; it is executed only by `scripts/verify-ai-fixes.ts`,
offline and in CI, and only from patches committed to `fixtures/ai-fixes/`. The server reads the
result of that check, `public/ai-fixes.json`, and nothing else.

**Why:** a patch is untrusted code. The model wrote it from a trace that includes PayPal responses
and a forged webhook, so text from outside could have shaped it. On the server it would run next to
the PayPal credentials, the Anthropic key and the database. Committed, it has been read in a pull
request before anything executes it.

**How the check contains it:**

- It runs in a child process whose environment holds no secret: placeholders for the PayPal
  credentials and webhook id, no database URL, no Anthropic key.
- Its `fetch` answers only the app's own routes and the in-memory PayPal model; any other host is
  refused and fails the check.
- A patch that imports anything a store does not already use, such as `node:fs` or
  `node:child_process`, is not run.
- In CI the step runs without a network interface.

## Claude's fixes are verified offline on a model of PayPal

**Decision:** `scripts/verify-ai-fixes.ts` applies each committed fix to a copy of
`lib/store/naive.ts`, type-checks it with `tsc --noEmit`, and runs all six scenarios against the
patched store on an offline bench. A fix is verified when its scenario goes from FAIL to PASS. The
result is `docs/ai-fixes-report.md` and `public/ai-fixes.json`; the analysis card shows "Fix verified
offline: FAIL → PASS" only for the exact patch that passed, compared by SHA-256, and "Fix not
verified" with the reason otherwise.

**The bench (`bench/`):**

- The real runner, routes, fault-injection proxy, stores and assertions run in one process. Only
  the network and the database server are replaced.
- The database is PGlite, an in-memory Postgres, migrated with the real migrations. The event-id
  dedupe rests on a primary key inside a transaction; a hand-written fake would have to imitate that,
  and could get it wrong.
- PayPal is `bench/paypal-model.ts`. Each behaviour names the section of
  [sandbox findings](sandbox-findings.md) it comes from. A request the findings do not cover gets a
  501 and is recorded, and a run with any such request is not counted.
- PayPal's webhooks reach the router while the runner waits for them, at its state reads, in the
  order PayPal created them. Live deliveries take 10 to 50 seconds, far longer than the runner's own
  calls, so this is the order a live run sees.
- The store timeout is 800 ms and the proxy holds S3's answer for 1,000 ms, the ratio of the
  deployed 8 s and 10 s. A full run takes about five seconds.

**Controls:** the naive store as committed must give the live verdicts and headlines, 1/6, and the
hardened store 6/6. A test checks both, and the script fails when either differs, because a bench
that disagrees with the sandbox cannot judge a fix.

**Which fixes are exported:** `scripts/export-ai-fixes.ts` takes a run's analyses only when they
were written for the store code in the checkout. The analysis cache key hashes the scenario, the
model, the store code and the trace; the script computes it again from the current files and the
run's trace and requires the stored key to match. The first export took the newest naive run, which
the deployed service had run before the `[S1]` marker was added to `naive.ts`, and its S2 patch did
not apply to the current file. That said nothing about the fix, only about the file it was written
for.

**Result on 2026-11-04,** run `fcc80878`, `claude-sonnet-5-5`: 4 of 5 verified. S2, S4, S5 and S6 go
from FAIL to PASS. S3 does not apply: its third hunk indents two context lines by two spaces where
the file has four. The server had already marked it "Patch needs review". The check applies patches
as written, with no whitespace fuzz, as the server does, and the patch is not repaired. The S4 and S5
fixes each also turn the other scenario into a PASS: both add the event-id dedupe, which is what
stops the replayed `COMPLETED` in S5.

**Limits:** the bench shows that a fix handles the behaviour PayPal showed in the sandbox, not that
it is the right fix in every respect. A fix that relies on behaviour nobody has observed, such as a
redelivery after a 5xx, is not counted.

**Revisit:** when a scenario or the store changes. The CI job fails when the committed report no
longer matches what the bench gives, and new fixes come from a new export.

## Claude proposes edits; code writes the diff

**Decision:** the analyst no longer writes a unified diff. Its fix is a list of edits, each
`{ file, find, replace }`, where `find` is whole lines quoted from the store file with their exact
indentation. Code (`lib/ai/edits.ts`) checks that every `find` occurs in the file exactly once and
that no two edits overlap, applies them all or none, and builds the unified diff that the page
shows, the export saves and the offline check applies.

**Self-check:** when a `find` does not occur, or occurs more than once, the model gets one round to
correct its edits. The message names the edit, the first line of `find` that is not a line of the
file, and the file's own closest lines with their line numbers. Leading spaces are shown as `·`, so
two spaces against four is visible. If the edits still do not match after that round, the analysis
is kept, its patch is "needs review" and shows the edits as written, and the verdict is untouched.
A schema retry and the self-check round are counted apart, so a call can need at most three model
calls.

**Why:** the first offline check verified four of five fixes. The fifth, S3, was a correct change
that did not apply, because its diff quoted two context lines with two spaces of indentation where
the file has four. A diff asks the model to reproduce context, counts and headers exactly; a quote
that code looks up asks only for the lines it changes, and a mismatch can be described precisely and
corrected.

**Consequence:**

- Every model call is a trace step: a rejected round reads "edits_rejected" with the reasons, and a
  note says whether the edits matched on the first check, after one self-check, or not at all. The
  analysis header on the page says the same: "self-corrected after 1 check".
- The analysis cache key includes a format version, `ANALYSIS_FORMAT = 2`, so no analysis written
  as a diff is reused, and `scripts/export-ai-fixes.ts` accepts only analyses of this format.
- The stored analysis keeps the edits, the server-built diff in `fix.patch`, and the self-check
  result. Analyses of the old format still display with their diff.

**Result on 2026-11-05,** run `42001f64`, `claude-sonnet-5-5`: 5 of 5 fixes verified offline, S3
included. Every edit matched the store file on the first check, so this run did not need the
self-check round; the tests cover the round with an ambiguous quote, with an indentation mismatch
that is corrected, and with one that is not.

## A person can pay through the reference stores

**Decision:** `/store/naive` and `/store/hardened` render a real PayPal Checkout with the JS SDK v6
(`@paypal/react-paypal-js`, `sdk-v6` entry, as in PayPal's Next.js guide): `PayPalProvider` with
`environment="sandbox"`, `PayPalOneTimePaymentButton`, and `PayPalGuestPaymentButton` for paying by
card without logging in. The buttons call the store's own routes, `POST /api/store/[mode]/orders`
and `.../capture`, so a person's payment runs the same `createOrder` and `captureOrder` as the proof
runner's headless buyer. After the capture the page reads `/api/store/[mode]/state` for the cart
until the `PAYMENT.CAPTURE.COMPLETED` webhook has been applied, for at most 150 seconds, and shows
the store's record as a short trace at a link of its own, `?cart=<cartId>`.

**Why:** the proof shows what a store does under failure; paying by hand shows that the same code
takes a real payment end to end, webhook included. A separate payment path would prove nothing
about the code under test.

**Consequence:** the sandbox buyer's email is configuration (`SANDBOX_BUYER_EMAIL`), shown on the
page; its password is never stored in the repository. The client id is read at request time on the
server, so a deploy needs no rebuild to change it. Webhooks reach only the deployed service, so a
purchase made against a local server sees its webhook through the shared database.

## The analyst's context is only what a fix can use

**Decision:** the configuration in the analyst's context is the variables of `.env.example` that
the store code reads: those whose names occur in a file of `lib/store` or `lib/paypal` that reads
`process.env`, which also covers a zod schema parsed over `process.env`. Each comes with its comment
from `.env.example` and no value. Today that is `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_API_BASE` and `PAYPAL_WEBHOOK_ID`.

**Why:** the context is part of the analysis cache key. When it held all of `.env.example`, adding
`SANDBOX_BUYER_EMAIL` for the checkout page changed every key. The next naive run would then have
written new analyses, with patches no committed fixture covers, and the page would have lost its
"Fix verified" badges for a change no fix can use.

**Consequence:** a variable read only by a page or a script leaves the context, and the cache, as
they are; a test adds one to a copy of the checkout and expects the same context. A variable the
store code starts to read changes the context, as it should.

## Changing the store or the analyst's context: export and verify again

**Decision:** `fixtures/ai-fixes/meta.json` records the code hash the fixes were written for: the
store file under test, the declarations and configuration in the analyst's context, and the analysis
format. The CI job `verify-ai-fixes` computes the same hash for the checkout, offline, and fails with
"analyst context changed: re-run export and verify" when they differ.

**Why:** the live page shows "Fix verified offline" only for a patch whose hash matches a verified
fixture. A change to the code hash makes the next live run write new analyses and new patches. If
nothing caught it, the badges would disappear after a deploy with no failing check.

**Procedure,** after any change to `lib/store/naive.ts`, to the exported declarations of `lib/store`
or `lib/paypal`, to a variable they read, or to the analysis format:

1. `npm run analyst:context` when the declarations or the configuration changed, and commit the
   result.
2. Run a naive proof on that code: locally with `npm run dev` and `/proof?fresh=1`, or on the
   deployed service after the merge.
3. `npx tsx scripts/export-ai-fixes.ts`. It takes the newest naive run whose analysis keys match the
   checkout, so analyses of other code are never exported.
4. `npx tsx scripts/verify-ai-fixes.ts`, which writes `docs/ai-fixes-report.md` and
   `public/ai-fixes.json`. Record what it finds, a fix that does not pass included.
5. Commit the fixtures, the report and the JSON with the change, so CI and the deployed page agree.

Running the proof locally before the merge keeps the badges on the deployed page: the deploy then
reuses the analyses already in the shared database, whose patches are the verified ones, as long as
its trace looks the same.

**Result on 2026-11-05,** run `e28c50a6`, with the context narrowed as above: 5 of 5 fixes verified
offline. S2's edits did not match the file on the first check and matched after the self-check
round, the first time that round was needed in a live run; the other four matched at once.

## A run holds a lease, and a run without a process ends INCONCLUSIVE

**Decision:** the runner renews a lease on its run every 5 seconds (`runs.last_heartbeat_at`). A run
whose lease has not been renewed for 45 seconds lost its process; a run still beating after 10
minutes is stuck. Either way it is ended: the run finishes with the reason, its unfinished scenarios
end INCONCLUSIVE with "Run interrupted: the server restarted while waiting for PayPal. Run again."
(or "Run stopped: it ran past its time limit. Run again."), and scenarios that had finished keep
their verdicts. Recovery runs when the server starts (`instrumentation.ts`), on every read of a run,
at most once every 5 seconds per process, and inside `createRun`. "One run at a time" is that lease:
a run without a live process never blocks a new one. On SIGTERM the process ends its own runs at once.

**Why:** on 2026-11-05 run `ae1a1618` started at 07:48:57 UTC, a minute after #21 was merged, on the
instance that served traffic while Render built the new one. Its last trace step is from 07:49:13,
while S3 to S6 waited for PayPal's webhooks. The instance was then replaced, the run lived only in
its memory, and the database kept it RUNNING. The page counted "1788 s of 150 s", and the old
ten-minute rule ended such a run only when someone started a new one, and then as an error.

**Consequence:**

- A process that comes back after its run was ended cannot undo it: scenario updates apply only
  while the run is RUNNING, and finishing a run applies only while it is active.
- The page's wait never counts past its limit; past it, the card says the result is being recorded
  until the final status arrives.
- During the first deploy with this change, the instance being replaced still runs the old code and
  renews no lease. A run it executes then reads as interrupted once the new instance starts, as it
  would have been when the old instance stopped.

## The demo is protected from one visitor

**Decision:**

- **Live analysis only with the operator's token.** `?fresh=<FRESH_ANALYSIS_TOKEN>` skips the
  analysis cache, compared in constant time. Any other value, or none, runs the proof from the cache
  with no error and no change to the page.
- **A daily ceiling on new Claude calls.** At most `ANALYSES_PER_DAY` (default 30) new analyses in
  any 24 hours; cached analyses do not count. Past it, an analysis reads "Analysis unavailable:
  today's limit of 30 new analyses is reached; Claude analyses again tomorrow. The verdict above
  stands." and is tried again on a later run.
- **Runs per visitor and overall.** A visitor may start `RUNS_PER_VISITOR_PER_HOUR` runs an hour
  (default 6), all visitors together `RUNS_PER_HOUR` (default 60), and one run is live at a time.
  The answer says which limit was reached and when the next run may start.

**Why:** the audit of 2026-11-05 found that anyone could start fresh runs, each a new analysis of
five failures at about $0.27, and that one visitor could use up the whole hourly limit of 20 and
block everyone else for an hour.

**The visitor is an address.** Render runs behind Cloudflare: responses carry `server: cloudflare`.
Cloudflare sets `CF-Connecting-IP` to "the client IP address connecting to Cloudflare", and it
appends to an existing `X-Forwarded-For` rather than replacing it, so entries on its left can be
written by the client ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)).
The limit therefore reads `CF-Connecting-IP`, and without it only the rightmost `X-Forwarded-For`
entry. Render's documentation does not describe its headers, so the source in use is logged once
per process, without the address, to be confirmed on the deployed service. Only a hash of the
address is stored, in `runs.visitor`.

**Consequence:** visitors behind one address, such as one office, share its six runs an hour. Live
analysis for a recording needs the token in the URL.
