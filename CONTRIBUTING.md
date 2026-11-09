# Contributing

Thanks for looking into Integration Proof. Issues and pull requests are welcome; for anything larger
than a fix, open an issue first so the approach can be agreed before you write it.

## Set up

You need Node.js 24. The tests, the offline bench and the CLI's model mode need no account:

```bash
npm ci
npm test
npx vitest run bench
npx tsx scripts/verify-ai-fixes.ts --check
```

Running the app and the live proof needs a PayPal sandbox app, Postgres and an Anthropic key; see
[Quick start](README.md#quick-start) and `.env.example`, which documents every variable. Never commit
real values: `.env.local` is git-ignored.

## Before you open a pull request

- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass. CI runs them, the offline
  verification of Claude's fixes, and the store-contract proof of `examples/express-store` on every
  pull request.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `docs:`, `test:`, `refactor:`, `chore:`, `ci:`), small and focused.
- Docs change with the code they describe: the README, `docs/architecture.md` and
  `docs/decisions.md` for design, `docs/store-contract.md` for the CLI.

## Rules that keep the proof honest

- **Verdicts are code.** A scenario's PASS or FAIL comes from a deterministic assertion in
  `lib/proof/assertions`; every assertion has tests with a passing and a failing fixture. The model
  never decides a verdict.
- **Only observed PayPal behaviour.** Do not rely on an endpoint, header or error code that has not
  been seen in the sandbox. Run the experiment, and record the real response with its `debug_id` in
  `docs/sandbox-findings.md`. The offline bench's model of PayPal covers only what is recorded there.
- **Sandbox only.** `api-m.sandbox.paypal.com` is the only upstream host, and only PayPal's published
  sandbox test cards appear in code.
- **Changing the naive store or the analyst's context** means exporting and verifying Claude's fixes
  again; the procedure is in
  [docs/decisions.md](docs/decisions.md#changing-the-store-or-the-analysts-context-export-and-verify-again).

## Security

Please do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).
