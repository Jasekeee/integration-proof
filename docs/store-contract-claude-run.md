# Claude explains the example store's failures

One run of the CLI with `--explain` against [examples/express-store](../examples/express-store), with
the real Claude API, kept as evidence of the whole loop:

1. The proof finds the two mistakes.
2. Claude explains them in the store's own code and proposes a fix.
3. The CLI checks the fix against the file and writes a patch.
4. The patched store passes.

The CLI never applied or ran the fix. It was applied by hand, with `git apply`, to a temporary copy
of the example that is not part of the repository.

Both runs used the offline model of the sandbox (`--paypal model`) for PayPal, so the only external
service involved is the Claude API. The analysis below is the model's text as the CLI printed it. Only
file paths on the machine that ran it were changed.

## 1. Prove the store and ask Claude

```bash
# The example, unchanged, with its PayPal calls on the CLI's proxy (in examples/express-store)
PAYPAL_API_BASE=http://127.0.0.1:8787 PAYPAL_CLIENT_ID=model PAYPAL_CLIENT_SECRET=model \
  PAYPAL_TIMEOUT_MS=2000 npm start

npm run cli -- run --store http://127.0.0.1:4000/integration-proof --paypal model --hold-ms 3000 \
  --expect S1=PASS,S2=FAIL,S3=FAIL \
  --explain --source examples/express-store --write-patch claude-fix.patch --env-file .env.local
```

`.env.local` supplies `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. The verdicts, decided by code:

| Scenario | Verdict | What happened |
|---|---|---|
| S1 · Capture declined | **PASS** | Decline shown, nothing charged |
| S2 · Transient 5xx on capture | **FAIL** | Sale lost on a transient error |
| S3 · Lost response after successful capture | **FAIL** | Buyer charged twice |

Before anything was sent, the CLI printed exactly what Claude would receive:

```text
Claude (claude-sonnet-5-5) will now receive, for each of S2, S3:
  examples/express-store/server.js  6596 bytes  (target: the only file a fix may change)
  6596 bytes of source in all, with 0 secret-looking values redacted;
  plus the scenario, its verdict and its redacted trace. Nothing else.
  not sent: examples/express-store/node_modules/ (dependencies or build output)
  not sent: examples/express-store/README.md (not source code)
  not sent: examples/express-store/package-lock.json (lockfile)
  not sent: examples/express-store/package.json (not source code)
```

## Claude's analysis

By claude-sonnet-5-5. The verdicts above are decided by code, not by the model. The CLI never applied or ran the code below: review the patch before you apply it.

### S2 · Transient 5xx on capture

**Root cause.** captureOrder in server.js makes a single capture call with no PayPal-Request-Id and maps any answer that is not 200/201 and not INSTRUMENT_DECLINED to FAILED. A temporary 500 from PayPal is therefore treated as a final failed payment (MISTAKE 1 in the file).

**What it costs.** The buyer had an approved order and was ready to pay, but was told "Payment failed. Please try again." PayPal charged nothing, so the merchant loses a sale that one more attempt would probably have completed. The store also records the order as FAILED with no fulfilment, so nothing in its own records shows the sale was recoverable.

**Evidence in the trace.**

- Step 5: The store's only capture request to PayPal got HTTP 500 INTERNAL_SERVER_ERROR (injected fault) and carries no PayPal-Request-Id. No retry follows it.
- Step 4: The store answered the buyer's capture call with status FAILED and "Payment failed. Please try again." right after that single 500.
- Step 6: PayPal still shows the order as APPROVED, so nothing was captured and a retry would have been safe and could have succeeded.
- Step 7: The store's state lists the order as FAILED with 0 fulfilments, so the sale was lost.

**Fix.** Send the capture with a stable PayPal-Request-Id and retry up to three times with backoff when PayPal answers 5xx. A retry with the same id returns the original capture instead of capturing twice.

```diff
--- a/examples/express-store/server.js
+++ b/examples/express-store/server.js
@@ -47,10 +47,10 @@
 }
 
 /** One PayPal call. A call that takes longer than PAYPAL_TIMEOUT_MS throws. */
-async function paypal(method, path, body) {
+async function paypal(method, path, body, extraHeaders = {}) {
   const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
     method,
-    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
+    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...extraHeaders },
     body: body === undefined ? undefined : JSON.stringify(body),
     signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
   });
@@ -76,7 +76,13 @@
     // MISTAKE 1: one attempt and no PayPal-Request-Id. A 5xx from PayPal is temporary and captured
     // nothing; a correct store retries with backoff and the same PayPal-Request-Id, which makes the
     // retry safe. Here the buyer is told the payment failed and the sale is lost (S2).
-    const captured = await paypal("POST", `/v2/checkout/orders/${orderId}/capture`, {});
+    const requestId = `capture-${orderId}`;
+    let captured;
+    for (let attempt = 1; ; attempt++) {
+      captured = await paypal("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { "PayPal-Request-Id": requestId });
+      if (captured.status < 500 || attempt === 3) break;
+      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
+    }
     if (captured.status === 201 || captured.status === 200) status = "PAID";
     else if (captured.body?.details?.[0]?.issue === "INSTRUMENT_DECLINED") status = "DECLINED";
     else status = "FAILED";
```

**Verify by.** Re-run S2. The trace should show a first capture request with a PayPal-Request-Id that gets 500, then a second request with the same PayPal-Request-Id that succeeds. The store should answer PAID, and its state should show the order PAID with one fulfilment and one charge for the cart.

### S3 · Lost response after successful capture

**Root cause.** In captureOrder in examples/express-store/server.js, the catch block treats any error on the capture call, including a timeout, as FAILED without asking PayPal. The capture had actually succeeded, but the answer arrived after the store stopped waiting.

**What it costs.** The buyer was told the payment failed even though PayPal had captured it, so the buyer checked out again and the same cart was charged twice. The merchant has a duplicate charge to refund and a first order recorded as FAILED with no fulfilment, even though the money was taken. Handling this costs support time and risks a dispute.

**Evidence in the trace.**

- Step 5: PayPal captured the first order (COMPLETED), but the proxy held the answer for 3000 ms, so the store did not get it in time.
- Step 4: The store told the buyer FAILED with "Payment failed. Please try again." for the order PayPal had captured.
- Step 11: PayPal, the source of truth, shows the first order as COMPLETED with a completed capture.
- Step 6: The buyer started a second checkout for the same cart, creating a second order, which was then captured (steps 9 and 10).
- Step 13: The store's state lists the first order as FAILED with 0 fulfilments and the second as PAID, while PayPal charged both.

**Fix.** When the capture call throws, ask PayPal for the order with GET /v2/checkout/orders/{id} before answering. If it is COMPLETED, mark the order PAID. Otherwise keep FAILED.

```diff
--- a/examples/express-store/server.js
+++ b/examples/express-store/server.js
@@ -83,8 +83,14 @@
   } catch {
     // MISTAKE 2: a timeout read as a failed payment. PayPal may have captured before its answer got
     // lost; a correct store asks PayPal (GET /v2/checkout/orders/{id}) before it answers the buyer.
-    // Here the buyer is told the payment failed, pays again, and the cart is charged twice (S3).
+    // Ask PayPal what happened before telling the buyer anything.
     status = "FAILED";
+    try {
+      const lookup = await paypal("GET", `/v2/checkout/orders/${orderId}`);
+      if (lookup.body?.status === "COMPLETED") status = "PAID";
+    } catch {
+      // PayPal could not be reached to confirm; keep FAILED.
+    }
   }
   order.status = status;
   if (status === "PAID") order.fulfilments += 1;
```

**Verify by.** Re-run S3. The capture answer should be PAID even though the response is held, PayPal should show one charge for the cart, and the store state should list one order PAID with one fulfilment and no second checkout.

### Model calls

- S2: 1 call, 6,865 input tokens, 1,778 output, 14.0 s; edits matched on the first check.
- S3: 1 call, 7,912 input tokens, 1,570 output, 13.1 s; edits matched on the first check.

## 2. The patch the CLI wrote

Both fixes were checked against the real `server.js`:
- every `find` occurs in it exactly once;
- the diff is written by code from the edits, not by the model;
- the two fixes do not overlap, so the CLI combined them into one patch (`--write-patch`).

```diff
--- a/examples/express-store/server.js
+++ b/examples/express-store/server.js
@@ -47,10 +47,10 @@
 }
 
 /** One PayPal call. A call that takes longer than PAYPAL_TIMEOUT_MS throws. */
-async function paypal(method, path, body) {
+async function paypal(method, path, body, extraHeaders = {}) {
   const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
     method,
-    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
+    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...extraHeaders },
     body: body === undefined ? undefined : JSON.stringify(body),
     signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
   });
@@ -76,15 +76,27 @@
     // MISTAKE 1: one attempt and no PayPal-Request-Id. A 5xx from PayPal is temporary and captured
     // nothing; a correct store retries with backoff and the same PayPal-Request-Id, which makes the
     // retry safe. Here the buyer is told the payment failed and the sale is lost (S2).
-    const captured = await paypal("POST", `/v2/checkout/orders/${orderId}/capture`, {});
+    const requestId = `capture-${orderId}`;
+    let captured;
+    for (let attempt = 1; ; attempt++) {
+      captured = await paypal("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { "PayPal-Request-Id": requestId });
+      if (captured.status < 500 || attempt === 3) break;
+      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
+    }
     if (captured.status === 201 || captured.status === 200) status = "PAID";
     else if (captured.body?.details?.[0]?.issue === "INSTRUMENT_DECLINED") status = "DECLINED";
     else status = "FAILED";
   } catch {
     // MISTAKE 2: a timeout read as a failed payment. PayPal may have captured before its answer got
     // lost; a correct store asks PayPal (GET /v2/checkout/orders/{id}) before it answers the buyer.
-    // Here the buyer is told the payment failed, pays again, and the cart is charged twice (S3).
+    // Ask PayPal what happened before telling the buyer anything.
     status = "FAILED";
+    try {
+      const lookup = await paypal("GET", `/v2/checkout/orders/${orderId}`);
+      if (lookup.body?.status === "COMPLETED") status = "PAID";
+    } catch {
+      // PayPal could not be reached to confirm; keep FAILED.
+    }
   }
   order.status = status;
   if (status === "PAID") order.fulfilments += 1;
```

## 3. Apply it to a copy and prove the store again

```bash
mkdir -p /tmp/proof-copy/examples && cp -r examples/express-store /tmp/proof-copy/examples/
cd /tmp/proof-copy && git apply claude-fix.patch   # by hand: the CLI never applies a patch

# The patched copy on its own ports (in /tmp/proof-copy/examples/express-store)
PORT=4002 PAYPAL_API_BASE=http://127.0.0.1:8789 PAYPAL_CLIENT_ID=model PAYPAL_CLIENT_SECRET=model \
  PAYPAL_TIMEOUT_MS=2000 npm start

npm run cli -- run --store http://127.0.0.1:4002/integration-proof --paypal model --proxy-port 8789 \
  --hold-ms 3000 --expect S1=PASS,S2=PASS,S3=PASS
```

| Scenario | Verdict | What happened |
|---|---|---|
| S1 · Capture declined | **PASS** | Decline shown, nothing charged |
| S2 · Transient 5xx on capture | **PASS** | Retried and charged once |
| S3 · Lost response after successful capture | **PASS** | Charged once, no second checkout |

Exit code 0. S2 and S3 went from FAIL to PASS:
- **S2.** The patched store retried the mocked 500 with the same `PayPal-Request-Id`: two capture
  requests, one charge.
- **S3.** After the held answer it asked PayPal and marked the order paid, so the buyer checked out once.

The example in this repository still has both mistakes, and the CI job keeps proving that.
