import { money } from "../_components/story";

/**
 * Scenario S3 as the buyer's card statement, at both stores: one lost answer, and the store that
 * guessed charges the cart a second time. The amounts are the reference item's price, once and
 * twice, as PayPal records them in a run (chargesPerCart 2 against 1).
 *
 * The server renders the final state. One short animation in CSS enhances it (globals.css): the
 * second payment arrives and the totals settle within 1.1 s, once. Every line holds its place from
 * the first paint, so nothing below moves; with reduced motion or without JavaScript nothing plays.
 */
export function Statements({ price, currency }: { price: number; currency: string }) {
  const line = money(price, currency).replace(/^\$(\d+)$/, "$$$1.00");
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5" aria-label="The same cart at two stores">
      <Statement who="Store that guessed" lines={[line, line]} total={money(price * 2, currency)} first={money(price, currency)} />
      <Statement who="Store that asked PayPal" lines={[line]} total={money(price, currency)} />
    </div>
  );
}

function Statement({
  who,
  lines,
  total,
  first,
}: {
  who: string;
  lines: string[];
  total: string;
  /** The total before the second payment, when there is one. */
  first?: string;
}) {
  return (
    <figure className="m-0 flex min-w-0 flex-col">
      <figcaption className="mb-2.5 ml-1 text-small text-muted sm:text-sm">{who}</figcaption>
      <div className="flex flex-1 flex-col rounded-[1.25rem] border border-border bg-background px-4 pb-4 pt-3.5 shadow-raised sm:px-5 sm:pb-5 sm:pt-4">
        <p className="flex justify-between border-b border-border pb-2.5 text-small text-muted">
          <span>Buyer’s card</span>
          <span>PayPal</span>
        </p>
        <ul className="flex flex-col">
          {[0, 1].map((index) => {
            const amount = lines[index];
            const again = index === 1;
            return (
              <li
                key={index}
                aria-hidden={amount ? undefined : true}
                className={`flex min-h-11 items-center justify-between gap-2 text-sm tabular-nums sm:text-base ${again ? "border-t border-dashed border-border" : ""} ${again && amount ? "stmt-line text-fail" : ""}`}
              >
                {amount && (
                  <>
                    <span className="flex items-center gap-2">
                      Payment
                      {again && <span className="rounded-full bg-fail-bg px-2 text-small max-xl:hidden">again</span>}
                    </span>
                    <span>{amount}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-auto flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-small text-muted">Charged</span>
          <b className="grid text-[2rem] font-semibold leading-none tracking-tight tabular-nums sm:text-[2.75rem]">
            {first && (
              <span aria-hidden="true" className="stmt-before col-start-1 row-start-1 justify-self-end">
                {first}
              </span>
            )}
            <span className={`col-start-1 row-start-1 justify-self-end ${first ? "stmt-after text-fail" : "stmt-settle text-pass"}`}>{total}</span>
          </b>
        </p>
      </div>
    </figure>
  );
}
