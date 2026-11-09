# Example: an Express store with two mistakes

A small store that sells one item through PayPal Checkout (Orders v2), in plain Express with the
orders in memory. It is written from the [store contract](../../docs/store-contract.md), not from the
reference stores in `lib/store`, and it is what a proof of your own store looks like.

The store works on a good day. On a bad one it makes two common mistakes, both marked `MISTAKE` in
[`server.js`](server.js):

| | Mistake | Scenario | What it costs |
|---|---|---|---|
| 1 | A 5xx from PayPal on capture is treated as final: one attempt, no `PayPal-Request-Id`. | S2 | A sale lost from a buyer who was ready to pay |
| 2 | A capture that times out is reported as a failed payment, without asking PayPal. | S3 | The buyer pays again: the cart is charged twice |

The contract endpoints live under `/integration-proof`. They call the same `createOrder` and
`captureOrder` the storefront routes (`/api/orders`) call.

## Prove it

From the root of this repository:

```bash
npm ci
(cd examples/express-store && npm ci)

# Terminal 1: the store, with its PayPal calls sent to the CLI's proxy
cd examples/express-store
PAYPAL_API_BASE=http://127.0.0.1:8787 PAYPAL_CLIENT_ID=model PAYPAL_CLIENT_SECRET=model \
  PAYPAL_TIMEOUT_MS=2000 npm start

# Terminal 2: the proof, against the offline model of the PayPal sandbox
npm run cli -- run --store http://127.0.0.1:4000/integration-proof \
  --paypal model --hold-ms 3000 --expect S1=PASS,S2=FAIL,S3=FAIL
```

```text
S1  PASS         Decline shown, nothing charged  (as expected)
S2  FAIL         Sale lost on a temporary error  (as expected)
S3  FAIL         Buyer charged twice  (as expected)
Result: every scenario as expected.
```

To use the real PayPal sandbox instead:
1. Start the store with your sandbox app's `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and the
   default `PAYPAL_TIMEOUT_MS` of 8 seconds.
2. Run the CLI with `--paypal sandbox`, the same two variables in its environment (or
   `--env-file`), and `--hold-ms 15000`.

The workflow [`.github/workflows/store-contract.yml`](../../.github/workflows/store-contract.yml)
runs this proof in model mode on every pull request. It needs no secret and puts the verdicts on the
job's summary page.

## Fix it

1. **Retry a 5xx with the same `PayPal-Request-Id`.** Generate one id per capture, send it on every
   attempt, and retry a 5xx with a short backoff. PayPal returns the first result for a repeated
   id, so a retry cannot charge twice.
2. **Ask PayPal before you answer the buyer.** When the capture times out, read
   `GET /v2/checkout/orders/{id}`. If it is `COMPLETED`, the payment went through: mark the order
   paid.

With both fixes the same command reports S1, S2 and S3 as PASS.
