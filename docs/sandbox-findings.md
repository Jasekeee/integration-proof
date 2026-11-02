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
