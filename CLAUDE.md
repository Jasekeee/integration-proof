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
  proof/page.tsx                                       start a run, browse previous runs
  proof/[runId]/page.tsx                               results grid for one run
  proof/[runId]/[scenarioId]/page.tsx                  report for one scenario
  store/[mode]/page.tsx                                reference store, mode = "naive" | "hardened" (both live)
  api/store/[mode]/orders/route.ts                     create order (Orders v2)
  api/store/[mode]/orders/[orderId]/capture/route.ts   capture order (Orders v2)
  api/store/[mode]/state/route.ts                      read-only state contract used by the runner
  api/store/webhooks-router/route.ts                   single registered webhook; dispatches by order.mode
  api/proxy/[runId]/[...path]/route.ts                 fault-injection proxy -> api-m.sandbox.paypal.com
  api/runs/route.ts                                    start run
  api/runs/[runId]/route.ts                            poll status
  api/runs/[runId]/report/route.ts                     fetch report
lib/
  paypal/token.ts                                      OAuth token cache
  paypal/client.ts                                     fetch client (injectable base URL)
  paypal/webhooks.ts                                   webhook verification
  store/naive.ts, store/hardened.ts                    two implementations of the same store logic
  proof/scenarios/index.ts                             scenario definitions (S1..S6)
  proof/assertions/index.ts                            pure functions: (trace, state) -> { verdict, reason }
  proof/runner.ts                                      executes a scenario step by step and writes the trace
  ai/analyst.ts                                        Claude call + zod output schema
  db/schema.ts, db/client.ts                           Drizzle schema, database client
  db/migrations/                                       Drizzle migrations
scripts/                                               one-off tooling (e.g. sandbox capability checks)
docs/decisions.md                                      engineering decisions and their reasoning
docs/sandbox-findings.md                               observed PayPal sandbox behavior
```

Design rules:
- **Mode lives in the URL, never in an env var.** Both reference stores run side by side. Every order
  row stores its `mode`; the webhook router dispatches to the matching implementation.
- **Injectable base URL.** The store's PayPal client receives `baseUrl` per call. Normal checkout uses
  `https://api-m.sandbox.paypal.com`; during a run the runner routes the store through
  `/api/proxy/{runId}`. The override is honoured only in sandbox and only from the runner.
- **Two buyer paths.** Human: PayPal button via JS SDK v6 (`@paypal/react-paypal-js`, sdk-v6 entry).
  Headless runner: Orders v2 with `payment_source.card` using PayPal's published sandbox test cards,
  multi-step (create -> confirm payment source if required -> capture) so the capture step can be
  faulted. Fallback: vaulted PayPal wallet (`payment_source.paypal.vault_id`). The chosen path is
  recorded in `docs/decisions.md` after validation in `docs/sandbox-findings.md`.

## Scenarios

| ID | Scenario | Produced by | PASS when |
|---|---|---|---|
| S1 | Capture declined | Proxy adds `PayPal-Mock-Response` `INSTRUMENT_DECLINED` to capture | Order not marked paid; buyer sees a decline, not a crash |
| S2 | 5xx on capture, then retry | Proxy adds `INTERNAL_SERVER_ERROR` once | Retry reuses the same `PayPal-Request-Id`; exactly one capture at PayPal |
| S3 | Timeout after successful capture | Proxy forwards, then holds the response past the store timeout | Store reconciles via GET order or webhook; final PAID, one capture |
| S4 | Duplicate webhook | Same real `PAYMENT.CAPTURE.COMPLETED` delivered twice | Fulfilled once |
| S5 | Out-of-order webhooks | Later-state event delivered first | Final state equals PayPal source of truth |
| S6 | Forged webhook | Tampered body / invalid signature | Rejected with 4xx, state unchanged |

The naive store deliberately contains common mistakes: no `PayPal-Request-Id`, blind retries, timeout
treated as failure, no event-id dedupe, events applied in arrival order, no signature verification.
The hardened store fixes each one. Keep the diff between them small and readable.

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
   explanation marked unavailable; the verdict is still shown.
6. Trace every PayPal and model call: step id, timestamp, duration, method, path, status, PayPal
   `debug_id`, redacted bodies.
7. Rate-limit runs (one concurrent run, bounded runs per hour).
8. Every assertion has unit tests with passing and failing fixtures.
9. Never invent PayPal endpoints, headers, error codes or SDK options. When unsure, run a sandbox
   experiment and record the real response in `docs/sandbox-findings.md` with the doc URL.

## Repository conventions

- English everywhere: code, comments, docs, commit messages, UI copy.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`), small and focused.
- Public files must read as a product repository: no personal notes, no event names, no deadlines,
  no TODO dumps. Anything private goes to `.private/` (git-ignored).
- Before finishing a task: lint, typecheck and tests pass; explain what changed and how to verify it.
