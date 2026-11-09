# Integration Proof

One lost response, and the buyer pays twice. Integration Proof breaks a PayPal Checkout
integration on purpose in the sandbox, decides PASS or FAIL with code, and asks Claude for the root
cause and a fix that is verified before it is shown.

**[Live proof](https://integration-proof.onrender.com/proof) · [How it works](#how-it-works)**

[![CI](https://github.com/Jasekeee/integration-proof/actions/workflows/ci.yml/badge.svg)](https://github.com/Jasekeee/integration-proof/actions/workflows/ci.yml)
[![Verify AI fixes](https://github.com/Jasekeee/integration-proof/actions/workflows/verify-ai-fixes.yml/badge.svg)](https://github.com/Jasekeee/integration-proof/actions/workflows/verify-ai-fixes.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![One lost response, and the buyer pays twice: the buyer's card statement at the store that guessed shows $20, at the store that asked PayPal $10](docs/screenshots/hero.png)

## Who it is for

- **Teams with a custom PayPal Checkout** that call Orders v2 and handle webhooks themselves.
- **Plugin and platform authors**, whose one integration runs in thousands of stores.
- **Anyone before a launch or a sale day**, when timeouts and retries actually happen.

## Why it matters

PayPal documents what a correct integration does. Integration Proof checks that yours does.

- *"You can retry idempotent calls that fail with network timeouts or HTTP 5xx status codes…"*
  ([Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)) → S2, S3
- *"Any non-2xx status code will cause PayPal to reattempt delivery up to 25 times over the course
  of 3 days…"* ([Webhooks](https://developer.paypal.com/api/rest/webhooks/)) → S4, S5
- *"If you do not verify a message, you will not have a way to validate that its sender was in fact
  PayPal."* ([Webhooks](https://developer.paypal.com/api/rest/webhooks/)) → S6

## The problem

PayPal captured the payment, but its response reached the store after the store had stopped
waiting. The store read the timeout as a failed payment and told the buyer "Payment failed. Please
try again." The buyer checked out the same cart again, and PayPal captured the second order too. One
lost response, and the buyer paid twice.

Nothing in a happy-path test catches this. Integration Proof makes it happen on purpose, in the
sandbox, and shows what the store did.

## Scenarios

Two reference stores run side by side. The naive store keeps the common integration mistakes; the
hardened store is the same store with each one fixed. In the live sandbox the naive store passes 1
of the 6 failure scenarios, the hardened store 6 of 6. A *notice* is one of PayPal's webhook events.

| | Scenario | How it is produced | Naive store | Hardened store |
|---|---|---|---|---|
| S1 | The card is declined | The proxy adds `PayPal-Mock-Response: INSTRUMENT_DECLINED` to the capture | Shows a decline, charges nothing | Same |
| S2 | PayPal fails for a moment | The first capture gets a mocked `500 INTERNAL_SERVER_ERROR` | Marks the order failed: a sale lost from a buyer ready to pay | Retries with backoff and the same `PayPal-Request-Id`; charged once |
| S3 | PayPal's answer gets lost | PayPal captures; the proxy holds the answer past the store's timeout | Says "Payment failed"; the buyer checks out again and is charged twice for one cart | Asks `GET /v2/checkout/orders/{id}`, sees the capture, marks the order paid |
| S4 | A notice arrives twice | The same real `PAYMENT.CAPTURE.COMPLETED` webhook is delivered twice | Ships the order twice | Dedupes by event id; ships once |
| S5 | A notice arrives late | The merchant refunds; a stale `PAYMENT.CAPTURE.COMPLETED` arrives last | Shows the refunded order as paid | Reads the order from PayPal; stays refunded |
| S6 | Someone fakes a notice | A recorded webhook delivery with its body changed after PayPal signed it | Accepts the forged refund | Signature verification fails; answers 400 and changes nothing |

PayPal allows one capture per order, so no store here can charge the same order twice. The harms the
product shows are the ones that really happen: a lost sale (S2), a second charge on a second order
for the same cart (S3), a double shipment (S4), and order states that disagree with PayPal (S5, S6).

![The proof page: the naive store passes 1 of 6 failure scenarios, the hardened store 6 of 6; the lost-response scenario open in four plain sentences, with Claude's fix verified FAIL → PASS](docs/screenshots/proof-light.png)

## How it works

```mermaid
flowchart TB
  page["Proof page"] -->|"Run both"| runner
  subgraph app["Integration Proof · Next.js"]
    runner["Runner<br/>plays the buyer"] -->|"create order, capture"| stores["Reference stores<br/>naive · hardened"]
    stores -->|"Orders v2 calls"| proxy["Fault-injection proxy"]
    router["Webhook router"] -->|"by order mode"| stores
    runner -->|"facts from PayPal and the store"| assertions["Deterministic assertions<br/>PASS · FAIL · INCONCLUSIVE"]
    assertions -->|"FAIL or INCONCLUSIVE"| analyst["Claude analyst"]
  end
  proxy -->|"decline, 500, or answer held"| paypal[("PayPal sandbox")]
  runner -->|"confirm card, refund, GET order"| paypal
  paypal -->|"webhooks"| router
  analyst -->|"Messages API"| claude["Claude"]
  app --- db[("Postgres<br/>orders, deliveries, traces, analyses")]
  analyst -.->|"fixes, committed"| bench["Offline fix verification in CI<br/>PayPal model + in-memory Postgres"]
```

1. **Inject a failure.** The runner plays the buyer. The store under test sends its PayPal calls
   through a fault-injection proxy, which declines a capture, fails it with a 500, or lets PayPal
   capture and holds the answer past the store's timeout. The runner also replays and forges real
   webhook deliveries.
2. **Code decides the verdict.** Each scenario ends with a deterministic assertion that compares what the
   store believes with PayPal's own record of every order created for the buyer's cart. The model
   never decides a verdict.
3. **Explain and fix with Claude.** For each failure, Claude reads the trace and the store's code,
   names the root cause and what it costs, cites the trace steps that show it, and proposes a fix.
4. **Verify the fix offline.** The proposed fix is applied to the store and the scenario is run
   again on a deterministic model of PayPal, in CI.

More detail in [docs/architecture.md](docs/architecture.md).

## How PayPal is used

Every PayPal behaviour the product relies on was observed in the sandbox first and recorded, with
its `debug_id`, in [docs/sandbox-findings.md](docs/sandbox-findings.md).

- **[Orders v2](https://developer.paypal.com/api/orders/v2).** The store creates an order with no
  payment source. The headless buyer sends PayPal's published
  [sandbox test card](https://developer.paypal.com/tools/sandbox/card-testing/) to
  [`confirm-payment-source`](https://developer.paypal.com/api/orders/v2/orders-confirm), and the
  order becomes `APPROVED`. The store then captures in a separate request, which is the one the
  proxy faults. `GET /v2/checkout/orders/{id}` is the source of truth for every verdict.
- **[Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/).** The hardened
  store sends one `PayPal-Request-Id` per logical operation. A retried capture with the same key
  returns the original capture (200); a new key gets `422 ORDER_ALREADY_CAPTURED`.
- **[Negative testing](https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/).**
  The proxy injects `PayPal-Mock-Response` with `INSTRUMENT_DECLINED` (S1) or
  `INTERNAL_SERVER_ERROR` (S2). A mocked 500 is not stored against the key, so a retry captures.
- **[Refunds](https://developer.paypal.com/api/payments/v2).** S5 refunds the capture through
  Payments v2 as the merchant would, then replays the stale `COMPLETED` event.
- **[Webhooks](https://developer.paypal.com/api/rest/webhooks/).** One webhook is registered for
  `PAYMENT.CAPTURE.*` events. The hardened store verifies every delivery with
  [`verify-webhook-signature`](https://developer.paypal.com/api/webhooks/v1) and applies an event
  id once.

PayPal calls go through a small fetch client with an injectable base URL, so a run can route the
store through the proxy. The server SDK has no base URL option
([decision](docs/decisions.md#paypal-calls-use-our-fetch-client-not-the-server-sdk)).

## How Claude is used

![Claude's analysis of S3: the root cause, what it costs, evidence linked to trace steps, the fix and how to verify it](docs/screenshots/analysis-s3.png)

When a scenario fails, an analyst (`lib/ai/analyst.ts`) asks Claude (`claude-sonnet-5-5`, set by
`ANTHROPIC_MODEL`) why. It sends the scenario, the verdict, the redacted trace, the store file under
test in full, and the declarations of the modules the store can call.

- **Code decides the verdict.** Assertions are deterministic and run before the model is asked. The
  analysis explains a verdict; it never changes one.
- **Every answer is checked.** Claude answers in a zod-validated structure: root cause, business
  impact, evidence, fix, documentation links and confidence. Every evidence item must cite a step
  that exists in the trace, and on the page it scrolls to that row. Links must point to PayPal's
  documentation. An invalid answer gets one retry with the reasons; after that the analysis is
  marked unavailable and the verdict stands.
- **Edits, not diffs.** Claude writes the fix as edits that quote the store file. Code checks that
  each quote occurs exactly once, applies the edits and builds the diff itself. A quote that does not
  match gets one self-check round, in which Claude sees the file's own lines with their indentation
  made visible. If it still does not match, the patch is marked "needs review".
- **Prompt-injection guard.** The trace is data from PayPal, webhook deliveries and the store, and
  S6 sends a forged webhook on purpose. It goes into an `<untrusted_trace>` section in which nothing
  can close or open a tag. An operator message after it repeats that the trace is data, not
  instructions.
- **Caching.** An analysis is cached under a hash of the scenario, the model, the store code and the
  shape of the trace, so a store that fails the same way again costs no tokens. The store code sits
  behind a prompt-cache breakpoint shared by the analyses of one run.
- **Traced.** Every model call is a step of the scenario's trace, with tokens, duration and outcome.

## Verified fixes

Claude's fixes for S2 to S6 are committed to [`fixtures/ai-fixes/`](fixtures/ai-fixes) and checked
by [`scripts/verify-ai-fixes.ts`](scripts/verify-ai-fixes.ts) in CI. Each patch is applied to a
copy of the naive store and type-checked. All six scenarios then run against the patched store on
an offline bench.

| Scenario | Patch applies | Types | Before | After | Other scenarios |
|---|---|---|---|---|---|
| S2 · Sale lost on a transient error, edits self-corrected after 1 check | yes | yes | FAIL | **PASS** | unchanged |
| S3 · Buyer charged twice | yes | yes | FAIL | **PASS** | unchanged |
| S4 · Order shipped twice | yes | yes | FAIL | **PASS** | S5 FAIL → PASS |
| S5 · Refunded order shown as paid | yes | yes | FAIL | **PASS** | S4 FAIL → PASS |
| S6 · Forged refund accepted | yes | yes | FAIL | **PASS** | unchanged |

The bench runs the real runner, routes, proxy, stores and assertions against a deterministic model
of PayPal built from the behaviour recorded in the sandbox findings, and an in-memory Postgres. A
call the model does not cover is refused, and a run that made one does not count. Before it rules on
a fix, the bench must reproduce the live verdicts: naive 1/6, hardened 6/6. This is not a run
against the live sandbox; the full report is in [docs/ai-fixes-report.md](docs/ai-fixes-report.md).

## Security

- **Sandbox only.** A hard allowlist admits `api-m.sandbox.paypal.com` and the run's own proxy; any
  other PayPal base URL throws before a request leaves the process. The proxy forwards only the
  Orders v2 calls a store makes.
- **Secrets stay in the environment.** They live in `.env.local` and the hosting provider, are never
  logged, and never use a `NEXT_PUBLIC_` name. Traces are redacted before they are stored.
- **Model-generated code never runs on the server.** Patches run only in the offline check, from
  committed files, in a process with no secrets, and in CI with no network.
- **Per-scenario secret tokens.** Each scenario gets a random 256-bit key that routes the store
  through the proxy. Run ids are public; keys are never returned by the API.
- **Rate limits.** One live run at a time and sixty runs an hour for the whole demo. Only the
  operator's token makes Claude analyse a run anew, and new analyses are capped per day; cached ones
  are free. The deployed service cannot yet tell visitors apart, so it has no separate limit per
  visitor.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Honest limits

- **Sandbox only.** The product never touches live payments.
- **Your own store: checkout scenarios only.** The CLI proves a store that implements the
  [store contract](docs/store-contract.md) against S1–S3. The webhook scenarios S4–S6 run on the
  reference stores only.
- **Webhook delivery takes time.** In recorded full proofs a scenario's webhooks arrived 7 to 60
  seconds after its last call to PayPal, and once took 138 seconds for two deliveries. A scenario that needs a
  webhook waits up to 150 seconds. If PayPal has not delivered by then, the verdict is
  **INCONCLUSIVE**, not FAIL: the store was never tested.
- **The offline bench is a model.** It covers the PayPal behaviour observed in the sandbox and
  nothing more. A fix that relies on behaviour nobody has observed, such as a redelivery after a
  5xx, is not counted.
- **Not covered yet:** 3-D Secure and `PAYER_ACTION_REQUIRED`, partial refunds, pending captures.

## Try it in 60 seconds

1. Open [integration-proof.onrender.com/proof](https://integration-proof.onrender.com/proof). The page
   opens with the latest results of both stores.
2. Click **PayPal's answer gets lost** (S3) and read what happened in four sentences. Then open
   **Claude's full analysis**: the root cause, evidence steps that jump to the trace, and the fix with
   its offline verdict. Click a trace row for its redacted request and response.
3. Click **Run both live** to run the six scenarios again: the naive store, then the hardened one,
   one to two minutes each, about 2–3 minutes for both. The demo runs one proof at a time for
   everyone.

## Try the checkout yourself

[/store/hardened](https://integration-proof.onrender.com/store/hardened), linked from the landing page
and from /proof, sells one item through a real PayPal Checkout, rendered with the PayPal JS SDK v6;
[/store/naive](https://integration-proof.onrender.com/store/naive) does the same for the naive store.
The buttons call the store's own create and capture routes, the same code the proof runs. The page
shows three stages: the store's answer, PayPal's webhook with the store's signature check (`SUCCESS`
in the hardened store, `NOT_CHECKED` in the naive one), and the order once the webhook has been
applied (`PAID`, one fulfilment), then a short trace and a link to come back to. Once the order is
paid, a receipt with the capture id takes the buttons' place, also when the page is reloaded, and
"Start a new checkout" opens a new cart.

- **Pay with PayPal** as the sandbox buyer whose email the page shows. Reviewers get the sandbox buyer
  password with the testing instructions; it is not in this repository.
- **Pay by card**, with no login: PayPal's published
  [sandbox test card](https://developer.paypal.com/tools/sandbox/card-testing/), shown on the page.

A checkout abandoned before approval leaves a `CREATED` order behind. `npm run db:clean-manual`
lists the ones older than an hour, and `npm run db:clean-manual -- --yes` deletes them; proof runs
are never touched.

## Prove your own store

Your own PayPal Checkout integration can go through the same checkout scenarios, S1 to S3, from your
machine. Add three small endpoints to your store, described in the
[store contract](docs/store-contract.md): create an order, capture it, report the cart's state. Then
point its PayPal base URL at the proxy the CLI starts on `127.0.0.1:8787`, and run:

```bash
npm run cli -- run \
  --store http://localhost:4000/integration-proof \
  --env-file .env.cli \
  --explain --source examples/express-store \
  --write-patch claude-fix.patch
```

The last two lines are the opt-in Claude flags, which need `ANTHROPIC_API_KEY`; without them nothing is sent to Claude.

- **Same faults, same verdicts.** The CLI injects the same faults as the hosted proof, through a
  proxy on your machine, and decides with the same deterministic assertions. PayPal's record of the
  cart is the judge.
- **Your own credentials.** It uses your store's sandbox app; our service is not involved.
- **No PayPal account.** With `--paypal model`, an offline model of the sandbox answers instead,
  which suits CI.
- **Claude, if you ask.** With `--explain --source <dir>`, Claude explains each failure in your own
  code and proposes a fix, through the same analyst and checks as the hosted proof.
  - Before anything is sent, the CLI lists every file that will go. `.env` files, keys, lockfiles,
    dependencies and build output never go, and secret-looking values are redacted.
  - `--write-patch` writes the checked fix as a diff for you to apply. The CLI never applies or runs
    model-written code.
  - [A run on the example store](docs/store-contract-claude-run.md) takes S2 and S3 from FAIL to PASS.
- **Output.**
  - A verdict per scenario on the console.
  - `report.json` with the redacted trace.
  - A Markdown summary for a CI job page.
  - Exit code 0 when the verdicts are as expected (`--expect S1=PASS,S2=FAIL,S3=FAIL`).

[examples/express-store](examples/express-store) is a small Express store written from the contract,
with two common mistakes. The [Store contract workflow](.github/workflows/store-contract.yml) proves
it on every pull request with the offline model, expecting S1 to pass and S2 and S3 to fail. The
verdicts appear on the job's summary page.

The CLI runs from a clone of this repository; it is not published to npm. Contract version 1 covers
S1–S3. The webhook scenarios need a public URL for PayPal's deliveries and are not part of it.

## Quick start

You need Node.js 24, a PayPal sandbox REST app, a Postgres database (Neon works) and, for the
analyses, an Anthropic API key.

```bash
git clone https://github.com/Jasekeee/integration-proof.git
cd integration-proof
cp .env.example .env.local   # every variable is documented there
npm ci
npm run db:migrate
npm run dev                  # http://localhost:3000/proof
```

PayPal delivers webhooks only to a public HTTPS URL, registered on the sandbox app as
`https://<host>/api/store/webhooks-router`. Without one, S1 to S3 run as usual, and S4 to S6, which
need a delivery, end INCONCLUSIVE.

The offline bench needs no account at all:

```bash
npx vitest run bench                       # naive 1/6, hardened 6/6 on the PayPal model
npx tsx scripts/verify-ai-fixes.ts --check # Claude's committed fixes, verified offline
```

## Documentation

- [docs/architecture.md](docs/architecture.md): components, a run step by step, data model.
- [docs/decisions.md](docs/decisions.md): engineering decisions and their reasoning.
- [docs/sandbox-findings.md](docs/sandbox-findings.md): PayPal sandbox behaviour, as observed.
- [docs/ai-fixes-report.md](docs/ai-fixes-report.md): Claude's fixes, verified offline.
- [docs/store-contract.md](docs/store-contract.md): what a store implements to be proved by the CLI.
- [docs/store-contract-sandbox-run.md](docs/store-contract-sandbox-run.md): the example store proved against the real sandbox.
- [docs/store-contract-claude-run.md](docs/store-contract-claude-run.md): Claude explains the example store's failures, and its patch passes.

## Roadmap

- **Webhooks for your own store.** S4–S6 against a store that implements the contract, with
  PayPal's deliveries reaching it through a public URL or a tunnel.
- **More failures.** 3-D Secure and `PAYER_ACTION_REQUIRED`, partial refunds, pending captures, and
  webhook redelivery after a 5xx.
- **Proof in pull requests.** A GitHub Action that runs the proof against a preview deployment and
  comments the verdicts on the pull request.
- **Fixes as pull requests.** Open a verified fix from Claude as a pull request against the store.
- **Limits per visitor.** Find a source of the client address on the deployed service that tells
  visitors apart, and turn the per-visitor run limit back on.

## License

[MIT](LICENSE)
