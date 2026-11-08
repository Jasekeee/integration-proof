# A sandbox run of the example store

One run of the Integration Proof CLI against [examples/express-store](../examples/express-store), with
the real PayPal sandbox, kept as evidence that the contract and the CLI work end to end outside the
offline model. The output below is the CLI’s own `report.json`, reduced to the verdicts and the steps.
Request and response bodies are left out; in the report they are redacted (card number, expiry and
security code), and the OAuth exchange is never recorded.

## How it was run

- **Store:** `examples/express-store`, unchanged, with its two mistakes, its default PayPal timeout
  of 8 s, a sandbox REST app’s credentials, and `PAYPAL_API_BASE=http://127.0.0.1:8787`.
- **CLI:**

  ```bash
  npm run cli -- run --store http://127.0.0.1:4000/integration-proof \
    --paypal sandbox --env-file .env.local --hold-ms 15000 \
    --expect S1=PASS,S2=FAIL,S3=FAIL
  ```

- **When:** 2026-11-08 18:53:44 UTC, 28.9 s in all. Exit code 0.

## Verdicts

| Scenario | Verdict | What happened | Why |
|---|---|---|---|
| S1 · Capture declined | **PASS** | Decline shown, nothing charged | The order stayed unpaid, the buyer was told the card was declined, and PayPal shows no charge for the cart. |
| S2 · Transient 5xx on capture | **FAIL** | Sale lost on a transient error | PayPal shows 0 charges for the cart, not 1; the store marked order 26L99513M3577013P FAILED. The store sent 1 capture request to PayPal: HTTP 500. |
| S3 · Lost response after successful capture | **FAIL** | Buyer charged twice | PayPal shows 2 charges for the cart, not 1; the store told the buyer "Payment failed. Please try again." for order 8AC22864YM279735Y, which PayPal had captured; the store marked order 8AC22864YM279735Y FAILED. The buyer checked out 2 times. |

Every scenario was as expected: S1 passes, and the two mistakes fail S2 and S3.

## The steps

Each step is one request: the buyer’s and the CLI’s to the store or to PayPal, and the store’s to
PayPal as the proxy saw it. `debug_id` is PayPal’s own id for the call.

### S1 · Capture declined · PASS

| # | From → to | Request | HTTP | Time | debug_id | Fault |
|---|---|---|---|---|---|---|
| 1 | buyer (CLI) → store | `POST /integration-proof/orders` | 201 | 2.7 s |  |  |
| 2 | store → PayPal | `POST /v2/checkout/orders` | 201 | 1.2 s | `ca576c84b2830` |  |
| 3 | buyer (CLI) → PayPal | `POST /v2/checkout/orders/9P361467TT422215T/confirm-payment-source` | 200 | 1.5 s | `ca576c854ebb2` |  |
| 4 | buyer (CLI) → store | `POST /integration-proof/orders/9P361467TT422215T/capture` | 200 | 407 ms |  |  |
| 5 | store → PayPal | `POST /v2/checkout/orders/9P361467TT422215T/capture` | 422 | 399 ms | `ca576c85c2bac` | PayPal-Mock-Response INSTRUMENT_DECLINED |
| 6 | CLI → PayPal | `GET /v2/checkout/orders/9P361467TT422215T` | 200 | 600 ms | `ca576c85ebea2` |  |
| 7 | CLI → store | `GET /integration-proof/state?cartId=…` | 200 | 3 ms |  |  |

### S2 · Transient 5xx on capture · FAIL

| # | From → to | Request | HTTP | Time | debug_id | Fault |
|---|---|---|---|---|---|---|
| 1 | buyer (CLI) → store | `POST /integration-proof/orders` | 201 | 638 ms |  |  |
| 2 | store → PayPal | `POST /v2/checkout/orders` | 201 | 627 ms | `ca576c8627a95` |  |
| 3 | buyer (CLI) → PayPal | `POST /v2/checkout/orders/26L99513M3577013P/confirm-payment-source` | 200 | 1.1 s | `ca576c8667fba` |  |
| 4 | buyer (CLI) → store | `POST /integration-proof/orders/26L99513M3577013P/capture` | 200 | 332 ms |  |  |
| 5 | store → PayPal | `POST /v2/checkout/orders/26L99513M3577013P/capture` | 500 | 324 ms | `ca576c86d2f85` | PayPal-Mock-Response INTERNAL_SERVER_ERROR |
| 6 | CLI → PayPal | `GET /v2/checkout/orders/26L99513M3577013P` | 200 | 509 ms | `ca576c86f39a1` |  |
| 7 | CLI → store | `GET /integration-proof/state?cartId=…` | 200 | 3 ms |  |  |

### S3 · Lost response after successful capture · FAIL

| # | From → to | Request | HTTP | Time | debug_id | Fault |
|---|---|---|---|---|---|---|
| 1 | buyer (CLI) → store | `POST /integration-proof/orders` | 201 | 543 ms |  |  |
| 2 | store → PayPal | `POST /v2/checkout/orders` | 201 | 536 ms | `ca576c8728d06` |  |
| 3 | buyer (CLI) → PayPal | `POST /v2/checkout/orders/8AC22864YM279735Y/confirm-payment-source` | 200 | 1.1 s | `ca576c875d89e` |  |
| 4 | buyer (CLI) → store | `POST /integration-proof/orders/8AC22864YM279735Y/capture` | 200 | 8.0 s |  |  |
| 5 | store → PayPal | `POST /v2/checkout/orders/8AC22864YM279735Y/capture` | 201 | 2.6 s | `ca576c87cc935` | Response held 15000 ms |
| 6 | buyer (CLI) → store | `POST /integration-proof/orders` | 201 | 867 ms |  |  |
| 7 | store → PayPal | `POST /v2/checkout/orders` | 201 | 859 ms | `ca576c8b07b3a` |  |
| 8 | buyer (CLI) → PayPal | `POST /v2/checkout/orders/77W38920J1683332S/confirm-payment-source` | 200 | 1.2 s | `ca576c8b47b1a` |  |
| 9 | buyer (CLI) → store | `POST /integration-proof/orders/77W38920J1683332S/capture` | 200 | 2.6 s |  |  |
| 10 | store → PayPal | `POST /v2/checkout/orders/77W38920J1683332S/capture` | 201 | 2.6 s | `ca576c8bc1b8a` |  |
| 11 | CLI → PayPal | `GET /v2/checkout/orders/8AC22864YM279735Y` | 200 | 1.0 s | `ca576c8ec5a92` |  |
| 12 | CLI → PayPal | `GET /v2/checkout/orders/77W38920J1683332S` | 200 | 798 ms | `ca576c8f17d74` |  |
| 13 | CLI → store | `GET /integration-proof/state?cartId=…` | 200 | 3 ms |  |  |

## What the steps show

- **S1.** The mocked `INSTRUMENT_DECLINED` came back as `422`; the store told the buyer the card was
  declined, and PayPal shows no charge.
- **S2.** PayPal answered the store’s only capture with the mocked `500`. The store sent no second
  attempt and told the buyer the payment failed, and PayPal shows no charge: a sale lost.
- **S3.** PayPal captured the first order (`201`), and the proxy held that answer for 15 s. The store
  gave up after its 8 s timeout and told the buyer “Payment failed” without asking PayPal. The buyer
  checked out again, the second order was captured too, and PayPal shows two charges for one cart.
