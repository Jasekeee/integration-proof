// What a failed scenario cost, decided by the assertion from the same facts as its verdict and
// headline. A run counts them for the line under its score:
// "This run: 1 cart charged twice · 1 order shipped twice · 1 sale lost".

/**
 * Each harm with its singular and plural wording, in the order the line lists them: the buyer's
 * money first, then the merchant's goods and records, then what the merchant never earned.
 */
export const HARMS = {
  cart_charged_twice: ["cart charged twice", "carts charged twice"],
  cart_charged_repeatedly: ["cart charged more than twice", "carts charged more than twice"],
  declined_card_charged: ["declined card charged", "declined cards charged"],
  order_shipped_twice: ["order shipped twice", "orders shipped twice"],
  order_shipped_repeatedly: ["order shipped more than twice", "orders shipped more than twice"],
  refund_shown_as_paid: ["refund shown as paid", "refunds shown as paid"],
  forged_refund_accepted: ["forged refund accepted", "forged refunds accepted"],
  forged_event_changed_order: ["order changed by a forged event", "orders changed by a forged event"],
  forged_event_accepted: ["forged event accepted", "forged events accepted"],
  declined_payment_marked_paid: ["declined payment marked paid", "declined payments marked paid"],
  paid_order_shown_as_failed: ["paid order shown as failed", "paid orders shown as failed"],
  paid_order_shown_as_unpaid: ["paid order shown as unpaid", "paid orders shown as unpaid"],
  paid_order_not_shipped: ["paid order never shipped", "paid orders never shipped"],
  order_out_of_sync: ["order out of sync with PayPal", "orders out of sync with PayPal"],
  decline_shown_as_error: ["decline shown as an error", "declines shown as an error"],
  decline_not_shown: ["decline not shown to the buyer", "declines not shown to the buyer"],
  sale_lost: ["sale lost", "sales lost"],
} as const satisfies Record<string, readonly [string, string]>;

export type Harm = keyof typeof HARMS;

const ORDER = Object.keys(HARMS) as Harm[];

function isHarm(value: unknown): value is Harm {
  return typeof value === "string" && Object.hasOwn(HARMS, value);
}

/**
 * The harms of a run, counted and worded: ["1 cart charged twice", "2 sales lost"]. Scenarios that
 * passed, could not be judged or failed without a harm add nothing. Unknown values are dropped,
 * because rows are data.
 */
export function consequences(scenarios: { harm: string | null }[]): string[] {
  const counts = new Map<Harm, number>();
  for (const { harm } of scenarios) {
    if (isHarm(harm)) counts.set(harm, (counts.get(harm) ?? 0) + 1);
  }
  return ORDER.filter((harm) => counts.has(harm)).map((harm) => {
    const count = counts.get(harm)!;
    return `${count} ${HARMS[harm][count === 1 ? 0 : 1]}`;
  });
}
