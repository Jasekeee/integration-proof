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

## S2 is judged on the request trace, not the capture count

**Decision:** the S2 assertion checks that both capture attempts carry the same `PayPal-Request-Id`.
"Exactly one capture at PayPal" stays a sanity check and never separates the two stores.

**Why:**

- PayPal allows one capture per `intent: CAPTURE` order. A second attempt with a new key or no key
  returns 422 `ORDER_ALREADY_CAPTURED`, so a blind retry cannot charge the same order twice. The
  capture count is 1 for both stores.
- The mocked 500 never reaches a real capture, so the retry captures once whatever key it sends.
- The harm of a missing key shows up after a real capture whose response was lost. With the same key
  the retry gets 200 and the original capture id. Without it the retry gets a 422, which a store can
  misread as a failed payment after the buyer has paid.

**Consequence:** S3 is the scenario that shows the customer-facing failure. Product copy must not
claim that a retry double-charges an order; the verified risk is a paid order recorded as failed.

**References:** [sandbox findings](sandbox-findings.md#capture-replay-and-repeated-capture).

## Timeouts wait for a measurement from the hosting region

**Decision:** the store timeout and the full-proof time budget are set from latency measured on the
deployed service, not from local runs. Until then the capability check allows 30 seconds per call. A
call with no response is reported as an outcome of that call, not as a crash.

**Why:** local calls took 5.1 s at the median and up to 11.4 s, but an unauthenticated 401 took
about as long and a reference host was also slow, so most of that time belongs to the local network
path. One local request also lost its connection before PayPal captured anything.

**Consequence:** the runner and proxy treat a missing response as a normal trace entry.

**References:** [sandbox findings](sandbox-findings.md#latency-and-connection-failures).
