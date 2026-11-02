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
