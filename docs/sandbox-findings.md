# Sandbox findings

Observed PayPal sandbox behavior: what was tested, the real response, and the documentation it was checked against.

## Capability check, 2026-11-02

Reproduce with `npx tsx scripts/sandbox-capabilities.ts`. Credentials come from `.env.local`.

The check ran three times against `api-m.sandbox.paypal.com` on a US Business sandbox account. Every
order is `intent: CAPTURE` for 1.00 USD, paid with a Visa number from PayPal's
[published test cards](https://developer.paypal.com/tools/sandbox/card-testing/). The tables below
come from the third run, which also added the no-key control call. Runs two and three returned the
same statuses and error codes for every shared call; run one stopped at a connection failure,
covered under [Latency and connection failures](#latency-and-connection-failures).

| Capability | Result |
|---|---|
| OAuth token | Works |
| Headless card purchase with a separate capture | Works, but only with the card on `confirm-payment-source` |
| `PayPal-Mock-Response` `INSTRUMENT_DECLINED` on capture | Works: 422, nothing captured |
| Capture replay with the same `PayPal-Request-Id` | Works: same capture id, one capture |
| Retry with the same key after a mocked 500 | Works: the retry captures, the mock is not replayed |
| Custom base URL in `@paypal/paypal-server-sdk` 2.5.0 | Not available |

### OAuth token

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v1/oauth2/token` | 200, `Bearer` | `f718375ce022f` |

`expires_in` was 32400 on the first run, then 32265 and 32084 on later runs, which suggests PayPal
returns an existing token with its remaining lifetime. Token values were not compared.

### Headless card purchase

**Card on create order.** The order completes in one call, so no capture request exists to fault.

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/checkout/orders` with `payment_source.card` | 201 `COMPLETED`, capture `1CJ19552RD355114P` | `f5119200204b0` |

**Card on confirm-payment-source.** The capture is a separate request. Order `6C744114JY8028214`:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/checkout/orders`, no payment source | 201 `CREATED` | `f570519544b7f` |
| `POST /v2/checkout/orders/{id}/confirm-payment-source` with `payment_source.card` | 200 `APPROVED` | `f153856f00562` |
| `POST /v2/checkout/orders/{id}/capture` | 201 `COMPLETED`, capture `0J071953NB340423E` | `f97573510b7d3` |

Neither path needed a buyer, a browser or a payer action, and no card-enablement error appeared, so
the vaulted wallet fallback was not exercised.

Documentation:
[Expanded Checkout Orders API use cases](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced),
[confirm payment source](https://developer.paypal.com/api/orders/v2/orders-confirm),
[capture payment](https://developer.paypal.com/api/orders/v2/orders-capture). The Orders schema lists
`PayPal-Request-Id` on create and capture but not on `confirm-payment-source`, so the check does not
send it there.

### Mocked decline on capture

The capture request carries `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}`.
Order `27276312US010910S`, confirmed as above:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/checkout/orders/{id}/capture` with the mock header | 422, issue `INSTRUMENT_DECLINED` | `f680320934cc1` |
| `GET /v2/checkout/orders/{id}` | 200 `APPROVED`, 0 captures | `f318002142bb3` |

The order stays `APPROVED`, so the decline leaves it capturable.

Documentation: [negative testing request headers](https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/),
[Orders v2 errors](https://developer.paypal.com/api/rest/reference/orders/v2/errors/). The negative
testing page shows only `DUPLICATE_INVOICE_ID` as an example value, so this result and the mocked 500
below are confirmed by the sandbox response rather than by that page.

### Capture replay and repeated capture

Order `52R21644TR079134A`, confirmed as above:

| Call | Status | `debug_id` |
|---|---|---|
| Capture with key A | 201 `COMPLETED`, capture `02K82574PE3994029` | `f7051531808aa` |
| Capture with key A again | 200 `COMPLETED`, capture `02K82574PE3994029` | `f847320b64aca` |
| Capture with a new key | 422, issue `ORDER_ALREADY_CAPTURED` | `f4445567dd972` |
| Capture with no `PayPal-Request-Id` | 422, issue `ORDER_ALREADY_CAPTURED` | `f211985836a5e` |
| `GET /v2/checkout/orders/{id}` | 200 `COMPLETED`, 1 capture, `02K82574PE3994029` | `f83942757e9a7` |

A replay is recognisable: the original returns 201, the replay returns 200 with the same capture id.
The two control calls show that PayPal refuses a second capture on this order with or without a key.
The errors page states the rule: "If 'intent=CAPTURE' only one capture per order is allowed."

### Retry after a mocked 500

The first attempt carries the mock header and key B; the retry carries key B and no mock. Order
`58N76999K9080650L`, confirmed as above:

| Call | Status | `debug_id` |
|---|---|---|
| Capture with key B and `INTERNAL_SERVER_ERROR` mock | 500, issue `INTERNAL_SERVER_ERROR` | `f7551967a7979` |
| Capture with key B, no mock | 201 `COMPLETED`, capture `21L21918PP069432H` | `f6348977aea85` |
| `GET /v2/checkout/orders/{id}` | 200 `COMPLETED`, 1 capture | `f643419fe8f3e` |

The mocked failure is not stored against the key, so a retry with that key performs the real capture.

### Custom base URL in the server SDK

Inspected from the published package, version 2.5.0, without executing it:

- `Configuration` in `dist/esm/types/configuration.d.ts` has no URL, URI, host or server option.
- `Environment` is an enum of `Production` and `Sandbox`.
- `getBaseUri` in `src/client.ts` returns a hard-coded `https://api-m.paypal.com` or
  `https://api-m.sandbox.paypal.com` and throws for anything else.
- The README lists the same two environments and describes no base URL setting.

`httpClientOptions.proxySettings` configures an outbound HTTP proxy, which keeps the PayPal host as
the target. `unstable_httpClientOptions` is typed `any`, passed through to the HTTP client, and
documented only as "Unstable configurable http client options". Neither is a base URL setting.

Documentation: [package README](https://www.npmjs.com/package/@paypal/paypal-server-sdk).

### Latency and connection failures

Across 52 calls the median was 5.1 s, with a minimum of 2.2 s and a maximum of 11.4 s. These numbers
describe the path from a development workstation and should not be read as sandbox latency:

- An unauthenticated `GET` that returns 401 took 4.3 to 5.7 s, with TLS alone finishing at 1.7 to 2.3 s.
- A reference request to `api.github.com` from the same machine took 3.2 s, and a second attempt
  failed with an HTTP/2 framing error after 13.1 s.

On run one, the capture of order `0XN39052JU372324L` failed in the client with `fetch failed` and no
HTTP status. The underlying cause was not recorded; the script now reports it. A later read returned
200 `APPROVED` with 0 captures (`f428385c84fcf`), so that request did not capture.

### Not covered

- 3D Secure and `PAYER_ACTION_REQUIRED`.
- The vaulted wallet fallback, which was not needed.
- A response lost after a successful capture. The replay above is the mechanism that scenario relies
  on, but the scenario itself needs the fault-injection proxy.
- Latency from the hosting region.

## Webhooks, 2026-11-03

### Verification of a forged signature

`POST /v1/notifications/verify-webhook-signature` with well-formed transmission fields, a signature
PayPal did not produce, and a webhook id that is not registered on the app:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v1/notifications/verify-webhook-signature` | 200, `verification_status` `FAILURE` | `ca54a3b743e56` |

A rejected signature is a 200 answer, so the hardened store decides on `verification_status`, not on
the HTTP status. Because two inputs were wrong in this call, it does not tell a bad signature apart
from an unknown webhook id.

Documentation: [Webhooks API](https://developer.paypal.com/docs/api/webhooks/v1/), request and
response schema in [schema.json](https://developer.paypal.com/api/webhooks/v1/schema.json).

### A real delivery on the deployed service

One hardened checkout on `https://integration-proof.onrender.com` through the headless buyer path.
Reproduce with `npx tsx scripts/checkout.ts --store https://integration-proof.onrender.com --mode hardened`.
PayPal order `9RX69635KJ645230G`, capture `0MM28060KS143004L`:

| Step | Result |
|---|---|
| Store creates the order | `CREATED` |
| Buyer sends the test card to `confirm-payment-source` | `APPROVED` |
| Store captures | `COMPLETED`, order `PAID` |
| `PAYMENT.CAPTURE.COMPLETED` reaches the webhook router | `verification_status` `SUCCESS`, outcome `applied`, HTTP 200 |
| Store state afterwards | order `PAID`, 1 fulfilment |

The event has `resource_type` `capture` and `resource_version` `2.0`. The capture carries the store's
order id in `custom_id` and the PayPal order id in `supplementary_data.related_ids.order_id`, and both
point at the same order row.

### Replay of a recorded delivery

The recorded delivery sent to the router again with its original body and transmission headers.
Reproduce with `npx tsx scripts/webhook-replay.ts --post https://integration-proof.onrender.com`.

| Delivery | Recorded (UTC) | `verification_status` | Router outcome |
|---|---|---|---|
| Original, from PayPal | 11:09:23.212 | `SUCCESS` | `applied`, 200 |
| Replay: same body, same transmission id and signature | 11:09:31.063 | `SUCCESS` | `duplicate`, 200 |

`verify-webhook-signature` accepts the replay just as it accepted the original. A valid signature
shows that PayPal produced these bytes, not that they arrive for the first time, so only the
event-id dedupe kept the hardened store from shipping the order twice. The replay was sent 48 seconds
after the original transmission time, so this does not show whether PayPal rejects an older
transmission.

### Delivery latency

| Time (UTC) | What | Source |
|---|---|---|
| 11:08:30.414 | Store created the order | `orders.created_at` |
| 11:08:34 | Capture created | capture `create_time` |
| 11:08:39.183 | Event created | event `create_time` |
| 11:08:43 | Delivery transmitted | `paypal-transmission-time` header |
| 11:09:23.212 | Delivery recorded | `webhook_deliveries.received_at` |

40 seconds from transmission to the recorded delivery, 49 seconds from the capture. The router writes
the row after the verification postback and the hardened store's `GET` order, so the network delivery
itself took somewhat less than 40 seconds. This is one delivery, not a distribution.

Documentation: [Webhooks API](https://developer.paypal.com/docs/api/webhooks/v1/),
[webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/).

### A body changed after signing

S6 sends a recorded `PAYMENT.CAPTURE.COMPLETED` with its original transmission headers after
changing `event_type` to `PAYMENT.CAPTURE.REFUNDED` and `resource.status` to `REFUNDED`. The hardened
store posts it to `verify-webhook-signature` with the changed body. Three full proofs on the deployed
service, 2026-11-04:

| Run | Forged delivery sent (UTC) | `verification_status` | Router answer |
|---|---|---|---|
| `87fbf7d5` | 14:58:43 | `FAILURE` | 400, `rejected` |
| `e99b3da9` | 15:09:28 | `FAILURE` | 400, `rejected` |
| `5c2d9e1b` | 16:24:33 | `FAILURE` | 400, `rejected` |

Unlike the forged-signature call above, everything but the body is genuine here: a real transmission
id, signature and certificate URL, and the registered webhook id. The changed body alone makes
verification fail.

### Documented, not yet observed on a real delivery

- The event names page lists `PAYMENT.CAPTURE.DECLINED` for Payments v2, not
  `PAYMENT.CAPTURE.DENIED`. Source: [event names](https://developer.paypal.com/api/rest/webhooks/event-names/).

## Refunds, 2026-11-03

### Full refund of a capture

One hardened checkout on the deployed service, then a refund through the Payments API with an
empty body. PayPal order `2E69545469028204E`, capture `16B6712761564310P`:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/payments/captures/{id}/refund`, empty body, new `PayPal-Request-Id` | 201, refund `018790663G7408425` `COMPLETED` | `f57746175dccc` |
| `GET /v2/checkout/orders/{id}` | 200, order `COMPLETED`, capture `REFUNDED`, 1 refund `COMPLETED` | `f322420b0a023` |

- An empty body refunds the full amount.
- The refund carries the capture's `custom_id`, although the request set none. The
  `PAYMENT.CAPTURE.REFUNDED` resource is the refund: it has `custom_id` but no
  `supplementary_data`, and its `up` link points to the capture. The webhook router finds the order
  by `custom_id`.
- After the refund the order's own status stays `COMPLETED`; only the capture changes to `REFUNDED`.
  A store that reads the order status alone does not see the refund.
- The refund's `create_time` is written with a `-08:00` offset, the capture's with `Z`.

### Deliveries around the refund

| Time (UTC) | What | Source |
|---|---|---|
| 12:28:44 | Capture created | capture `create_time` |
| 12:28:47 | Refund created | refund `create_time` |
| 12:28:49.919 | `PAYMENT.CAPTURE.COMPLETED` created | event `create_time` |
| 12:28:51.765 | `PAYMENT.CAPTURE.REFUNDED` created | event `create_time` |
| 12:28:55 / 12:28:59.320 | `COMPLETED` transmitted / recorded, `SUCCESS`, applied | headers, `webhook_deliveries` |
| 12:29:04 / 12:29:08.448 | `REFUNDED` transmitted / recorded, `SUCCESS`, applied | headers, `webhook_deliveries` |

PayPal created the `COMPLETED` event three seconds after the refund, and it reached the store
twelve seconds after the refund. The hardened store read the order on that event, found the capture
`REFUNDED`, recorded the order as `REFUNDED` and shipped nothing. The webhook is subscribed to
`PAYMENT.CAPTURE.COMPLETED`, `DECLINED`, `PENDING`, `REFUNDED` and `REVERSED`
(`GET /v1/notifications/webhooks/{id}`, `f5618034aba41`).

Documentation: [refund captured payment](https://developer.paypal.com/docs/api/payments/v2/#captures_refund),
[webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/).

### Webhook waits in full proofs

Runner wait from its `GET` order after the last action until the store had acknowledged every
expected delivery. Local runs of all six scenarios, deliveries to the deployed router:

| Run | S2 | S3 | S4 | S5 (`COMPLETED` and `REFUNDED`) | S6 |
|---|---|---|---|---|---|
| naive | none expected | 46.6 s, 2 deliveries | 7.4 s | 60.3 s | 11.2 s |
| hardened | 11.2 s | 7.5 s | 11.3 s | 18.3 s | 14.6 s |

The longest wait, 60.3 s, is within the 90-second deadline. Delivery time varies far more than the
calls do.

## Retries of the runner's own calls, 2026-11-04

Reproduce with `npx tsx scripts/repeated-runner-calls.ts`. The runner retries its own calls after a
5xx, a timeout or a network error (see [decisions](decisions.md#the-runner-retries-its-own-paypal-calls)).
A retry after a lost response repeats a request PayPal may already have carried out, so each call
was sent twice on purpose. Orders are `intent: CAPTURE` for 1.00 USD, paid with the published test
card.

### Header support in the API schemas

Checked in the published schemas,
[Orders v2](https://developer.paypal.com/api/orders/v2/schema.json) and
[Payments v2](https://developer.paypal.com/api/payments/v2/schema.json):

| Call | `PayPal-Request-Id` |
|---|---|
| `POST /v2/checkout/orders` | Listed |
| `POST /v2/checkout/orders/{id}/confirm-payment-source` | Not listed |
| `POST /v2/checkout/orders/{id}/capture` | Listed |
| `GET /v2/checkout/orders/{id}` | Not listed |
| `POST /v2/payments/captures/{id}/refund` | Listed |

### confirm-payment-source repeated

No `PayPal-Request-Id`, because the schema lists none for this call. Order `11244302XF289323K`:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/checkout/orders/{id}/confirm-payment-source` | 200 `APPROVED` | `f2314270e5726` |
| The same request again | 200 `APPROVED` | `f3652166965c4` |
| `GET /v2/checkout/orders/{id}` | 200 `APPROVED`, 0 captures | `f61568321259d` |
| `POST /v2/checkout/orders/{id}/capture` | 201 `COMPLETED` | `f59804003dcad` |
| `confirm-payment-source` after the capture | 422, issue `ORDER_ALREADY_CAPTURED` | `f4127311ced61` |

A second run on order `6D664770UE0597442` returned the same statuses. Confirming an `APPROVED`
order again approves it again and captures nothing, so the runner can repeat a confirm whose answer
was lost. The runner confirms before the store captures, so the 422 after a capture does not occur
in a run.

### Refund repeated with the same key

Order `4H274297V1152530X`, captured once:

| Call | Status | `debug_id` |
|---|---|---|
| `POST /v2/payments/captures/{id}/refund`, key R | 201, refund `4AC48240EN136032W` `COMPLETED` | `f738105668f02` |
| The same refund with key R again | 200, refund `4AC48240EN136032W` `COMPLETED` | `f548291b37495` |
| The same refund with a new key | 422, issue `CAPTURE_FULLY_REFUNDED` | `f198367d94ccf` |
| `GET /v2/checkout/orders/{id}` | 200, capture `REFUNDED` | `f5257917c2e7d` |

A retry with the same key gets the original refund back with 200 instead of 201, as a capture replay
does. A new key would read as a failed refund. The runner therefore keeps one key per refund across
its attempts and accepts any 2xx.

Documentation: [confirm payment source](https://developer.paypal.com/api/orders/v2/orders-confirm),
[refund captured payment](https://developer.paypal.com/docs/api/payments/v2/#captures_refund).
