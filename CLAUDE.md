# CLAUDE.md

Engineering guide for AI coding agents and contributors working on **Integration Proof**.
If `.private/BRIEF.md` exists locally, read it first — it contains maintainer context that is
intentionally not committed.

## Product

**Integration Proof** — prove your PayPal integration survives a bad day, before your customers find out.

Integration Proof runs controlled failure scenarios against a PayPal Checkout integration in the
PayPal sandbox, records every request, response and webhook in a trace, returns a deterministic
PASS/FAIL per scenario, and uses Claude to explain the root cause and propose a concrete fix.

## Architecture — one Next.js app, one service, one database

```
app/
  layout.tsx, globals.css                              root layout, global styles
  (marketing)/page.tsx                                 landing
  proof/page.tsx                                       naive and hardened side by side; Run both
  proof/[runId]/page.tsx                               shareable results of one run
  _components/                                         result views: verdict matrix, scenario cards, Claude analysis, AG Grid trace
  icon.svg, opengraph-image.png                        favicon and link preview (the README hero layout)
  not-found.tsx                                        the 404 page
  proof/loading.tsx, proof/[runId]/loading.tsx         skeletons of the results while they load
  proof/[runId]/[scenarioId]/page.tsx                  redirects to that scenario's section of the run page
  store/[mode]/page.tsx                                reference store, mode = "naive" | "hardened" (both live)
  api/store/[mode]/orders/route.ts                     create order (Orders v2)
  api/store/[mode]/orders/[orderId]/capture/route.ts   capture order (Orders v2)
  api/store/[mode]/state/route.ts                      read-only state contract used by the runner
  api/store/webhooks-router/route.ts                   single registered webhook; dispatches by order.mode
  api/proxy/[runId]/[runKey]/[...path]/route.ts        fault-injection proxy -> api-m.sandbox.paypal.com
  api/runs/route.ts                                    start run
  api/runs/[runId]/route.ts                            poll status
  api/runs/[runId]/report/route.ts                     fetch report
  api/health/route.ts                                  liveness check and deployed commit, no DB call
instrumentation.ts                                     on server start: end interrupted runs, handle SIGTERM
lib/
  origin.ts                                            the app's own address inside its process (PORT)
  paypal/token.ts                                      OAuth token cache
  paypal/client.ts                                     fetch client (injectable base URL)
  paypal/orders.ts                                     Orders v2 calls and the order slice the stores read
  paypal/webhooks.ts                                   webhook parsing and verification
  paypal/test-cards.ts                                 the published sandbox test card the runner uses
  paypal/payments.ts                                   Payments v2 refund the runner makes as the merchant (S5)
  store/naive.ts, store/hardened.ts                    two implementations of the same store logic
  store/shared.ts, store/repository.ts                 pure decisions shared by both stores; their DB access
  store/snippets.ts                                    the marked lines of each store a passing card shows
  proof/scenarios/index.ts                             scenario definitions (S1..S6)
  proof/assertions/index.ts                            pure functions: (trace, state) -> { verdict, reason }
  proof/harms.ts                                       what a failure cost, counted for a run's "This run:" line
  proof/runner.ts                                      runs a run's scenarios in parallel and writes the trace
  proof/retry.ts                                       retries of the runner's own PayPal calls, never the store's
  proof/lease.ts, proof/lifecycle.ts                   the runner's lease; ending runs on startup, on reads and on SIGTERM
  proof/proxy.ts, proof/context.ts                     what the proxy forwards; which base URL a store uses
  proof/repository.ts, proof/views.ts                  runs, scenarios and trace steps in the DB; API JSON
  proof/redact.ts, proof/types.ts                      redaction before a body is traced; shared shapes
  proof/report.ts                                      a run's full report for the API and the result pages
  ai/analyst.ts                                        Claude call + zod output schema
  ai/patch.ts, ai/signature.ts, ai/sources.ts          patch check, analysis cache key, the store code it reads
  ai/edits.ts                                          applies Claude's find/replace edits and builds the diff
  ai/jobs.ts, ai/repository.ts                         analysis after a verdict, traced; the analyses cache
  ai/declarations.ts, ai/context.generated.json        the analyst's read-only context (npm run analyst:context)
  ai/fix-check.ts                                      whether a shown patch is one the offline check verified
  db/schema.ts, db/client.ts                           Drizzle schema, database client
  db/migrations/                                       Drizzle migrations
bench/                                                 offline bench: in-memory PayPal model, PGlite, real runner
fixtures/ai-fixes/                                     Claude's committed fixes for S2..S6 (scripts/export-ai-fixes.ts)
public/ai-fixes.json, docs/ai-fixes-report.md          offline verification of those fixes (scripts/verify-ai-fixes.ts)
scripts/                                               one-off tooling (e.g. sandbox capability checks)
docs/architecture.md                                   components, a run step by step, data model
docs/decisions.md                                      engineering decisions and their reasoning
docs/sandbox-findings.md                               observed PayPal sandbox behavior
```

Design rules:
- **Mode lives in the URL, never in an env var.** Both reference stores run side by side. Every order
  row stores its `mode`; the webhook router dispatches to the matching implementation.
- **Injectable base URL.** The store's PayPal client receives `baseUrl` per call. Normal checkout uses
  `https://api-m.sandbox.paypal.com`; during a run the runner routes the store through
  `/api/proxy/{runId}/{runKey}`. The override is honoured only in sandbox and only from the runner:
  each scenario has a secret run key that only the runner and the store see.
- **Two buyer paths.** Human: PayPal button via JS SDK v6 (`@paypal/react-paypal-js`, sdk-v6 entry).
  Headless runner: the store creates the order with no payment source, the runner sends one of
  PayPal's published sandbox test cards to `confirm-payment-source` (order becomes `APPROVED`), and
  the store captures in a separate request, which is the request the proxy faults. A card on create
  order completes in one call and leaves no capture to fault, so it is not used. The vaulted wallet
  fallback is not built. See `docs/decisions.md`.

## Scenarios

PayPal allows one capture per `intent: CAPTURE` order: a second capture returns 422
`ORDER_ALREADY_CAPTURED` with a new `PayPal-Request-Id` or with none
(`docs/sandbox-findings.md`). No store can charge the same order twice, so harm is counted per buyer
cart. `chargesPerCart` is the number of completed captures across every order created for one cart,
read back from PayPal with `GET /v2/checkout/orders/{id}`, never from the store's own rows. Every
order row stores its `cartId`. All scenarios use the headless buyer above.

| ID | Scenario | Produced by | PASS when |
|---|---|---|---|
| S1 | Capture declined | Proxy adds `PayPal-Mock-Response` `INSTRUMENT_DECLINED` to capture | Order not marked PAID; buyer sees a decline, not a crash; `chargesPerCart == 0` |
| S2 | Transient 5xx on capture | Proxy adds `PayPal-Mock-Response` `INTERNAL_SERVER_ERROR` to the first capture attempt only | Order PAID with exactly one charge |
| S3 | Lost response after successful capture | Proxy forwards the capture to PayPal, then holds the response past the store timeout | `chargesPerCart == 1` and order PAID |
| S4 | Duplicate webhook | After PayPal's real `PAYMENT.CAPTURE.COMPLETED` is applied, the runner replays the recorded delivery byte for byte with its transmission headers | Fulfilled once |
| S5 | Out-of-order webhooks | The runner refunds the capture as the merchant right after it; once PayPal's deliveries are applied, it replays the earlier `PAYMENT.CAPTURE.COMPLETED`, which arrives after the refund | Final state equals PayPal source of truth |
| S6 | Forged webhook | The runner resends the recorded `PAYMENT.CAPTURE.COMPLETED` with its original transmission headers and a body changed after signing: `event_type` `PAYMENT.CAPTURE.REFUNDED`, `resource.status` `REFUNDED` | Rejected with 4xx, state unchanged |

The PASS column is `passWhen` in `lib/proof/scenarios/index.ts`, which the analyst reads; keep the
two identical. S5 compares the store's status with the one PayPal's latest capture implies
(`REFUNDED` after the refund). S4 to S6 need PayPal's real deliveries: when one has not reached the
store within 150 seconds, the verdict is INCONCLUSIVE, not FAIL. Neither replay nor forgery uses the
Webhooks Simulator (`docs/decisions.md`, "S4 and S5 replay real deliveries").

**S2.** The naive store treats the 500 as final and marks the order FAILED: a lost sale from a buyer
who was ready to pay. The hardened store retries with backoff and the same `PayPal-Request-Id`. The
mocked 500 captured nothing and is not stored against the key, so the retry captures.

**S3, the flagship scenario.** PayPal captures, but the store's request times out before the response
arrives. The naive store marks the order FAILED and tells the buyer the payment failed. The runner,
acting as the buyer, checks out the same cart again: a new order, a second capture,
`chargesPerCart == 2`. The hardened store answers the timeout with `GET /v2/checkout/orders/{id}`,
sees `COMPLETED`, marks the order PAID, and the buyer has no reason to check out again.

The naive store deliberately contains common mistakes: a transient 5xx treated as a final failure, a
timeout treated as a failed payment without asking PayPal, no `PayPal-Request-Id`, no event-id
dedupe, events applied in arrival order, no signature verification. The hardened store fixes each
one. Keep the diff between them small and readable.

**Product copy claims only what PayPal allows.** README, UI text, scenario descriptions and analyst
explanations never say that a retried capture charges the same order twice: PayPal refuses it. The
harms the product shows are a lost sale (S2) and a second charge on a new order for the same cart
(S3).

## Stack

Next.js 16 (App Router), TypeScript strict, Tailwind CSS · PayPal Orders v2, Webhooks,
JS SDK v6 · Neon Postgres + Drizzle · Anthropic TypeScript SDK (`ANTHROPIC_MODEL` env) ·
AG Grid Community · Vitest · GitHub Actions · Render. Validate all external input and all model
output with zod.

## Engineering rules

1. Secrets only in `.env.local` (git-ignored) and the hosting provider. `.env.example` lists every
   variable with a comment. Never log secrets or card numbers. Server secrets never use `NEXT_PUBLIC_`.
2. Sandbox only: hard allowlist `api-m.sandbox.paypal.com`; any other upstream host throws.
   Only PayPal's published sandbox test card numbers may appear in code.
3. Hardened webhooks are verified via `POST /v1/notifications/verify-webhook-signature`.
   Webhooks Simulator events cannot be verified by postback; use real sandbox transactions.
4. Hardened store sends a stable `PayPal-Request-Id` per logical operation and dedupes webhook
   events by id (unique index).
5. The model never decides PASS/FAIL. Assertions are deterministic code. Model output is validated;
   every evidence item must reference an existing trace step id. Invalid output -> one retry ->
   explanation marked unavailable; the verdict is still shown. A fix is edits whose `find` must
   occur in the file exactly once; code applies them and builds the diff. Edits that do not match
   get one self-check round, then "patch needs review".
6. Trace every PayPal and model call: step id, timestamp, duration, method, path, status, PayPal
   `debug_id`, redacted bodies.
7. Rate-limit runs (one concurrent run, bounded runs per hour).
8. Every assertion has unit tests with passing and failing fixtures.
9. Never invent PayPal endpoints, headers, error codes or SDK options. When unsure, run a sandbox
   experiment and record the real response in `docs/sandbox-findings.md` with the doc URL.
10. Model-generated code never runs on the server. Patches run only in `scripts/verify-ai-fixes.ts`,
    offline and in CI, from committed files. The bench's PayPal model covers only behaviour recorded
    in `docs/sandbox-findings.md`.

## Repository conventions

- English everywhere: code, comments, docs, commit messages, UI copy.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`), small and focused.
- Public files must read as a product repository: no personal notes, no event names, no deadlines,
  no TODO dumps. Anything private goes to `.private/` (git-ignored).
- Before finishing a task: lint, typecheck and tests pass; explain what changed and how to verify it.
