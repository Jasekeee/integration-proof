// The store contract, version 1 (docs/store-contract.md): the three requests the CLI sends to a
// store under test and the answers it accepts. Every answer is validated here before it is used.
import { z } from "zod";
import { ORDER_STATUSES } from "../lib/db/schema";

export const CONTRACT_VERSION = 1;

/** The scenarios contract v1 covers. S4–S6 need PayPal's webhooks, which need a public URL. */
export const CONTRACT_SCENARIOS = ["S1", "S2", "S3"] as const;
export type ContractScenarioId = (typeof CONTRACT_SCENARIOS)[number];

/** A cart id the CLI makes up for each checkout: short, URL-safe, unique per scenario. */
export const CartIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** POST {store}/orders, answered 201. */
export const CreatedSchema = z.object({ orderId: z.string().regex(/^[A-Z0-9]{1,36}$/) });

/** POST {store}/orders/{orderId}/capture: what the store tells the buyer. */
export const CaptureAnswerSchema = z.object({ status: z.enum(ORDER_STATUSES), message: z.string() });

/** GET {store}/state?cartId=: what the store believes about every order of the cart. */
export const StateSchema = z.object({
  contract: z.literal(CONTRACT_VERSION),
  orders: z.array(
    z.object({
      paypalOrderId: z.string().min(1),
      status: z.enum(ORDER_STATUSES),
      fulfilments: z.number().int().min(0),
    }),
  ),
});
export type StoreState = z.infer<typeof StateSchema>;

/** The paths of the contract under the store's base URL, which carries the store's own prefix. */
export const contractPaths = {
  orders: "/orders",
  capture: (orderId: string) => `/orders/${encodeURIComponent(orderId)}/capture`,
  state: (cartId: string) => `/state?cartId=${encodeURIComponent(cartId)}`,
};
