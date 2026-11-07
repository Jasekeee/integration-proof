# Security policy

## Reporting a vulnerability

Please report a vulnerability privately: open the repository's **Security** tab on GitHub and
choose **Report a vulnerability**. Do not open a public issue for it.

Include what is affected (a route, a file or a behaviour), the steps to reproduce it, and what an
attacker could do with it. We aim to acknowledge a report within five working days, and will keep
you informed until it is resolved.

## Scope

In scope are the code in this repository and the demo service at
[integration-proof.onrender.com](https://integration-proof.onrender.com). We are most interested in:

- any way to make the app send a PayPal call to a host other than `api-m.sandbox.paypal.com`;
- any way into a running scenario's fault-injection proxy without its run key;
- a webhook the hardened store accepts although PayPal did not sign it;
- secrets, card data or run keys in a trace, a log or an API response;
- trace content that changes what the analyst reports or gets past its validation;
- any path by which code written by the model could run on the server.

The naive reference store leaves common integration mistakes in on purpose: it verifies no webhook
signature and applies a repeated event again. Those mistakes are what the product demonstrates, not
vulnerabilities. A way to make the hardened store behave like the naive one is in scope.

## Testing guidelines

- The service works only with the PayPal sandbox; no real payment is ever made. Use only PayPal's
  published [sandbox test cards](https://developer.paypal.com/tools/sandbox/card-testing/).
- The demo runs one proof at a time for everyone, with an hourly limit shared by all visitors. Do
  not load-test it or try to keep it busy.
- Access only data you created yourself.

## Supported versions

The `main` branch and the deployed service. There are no released versions to patch separately.
