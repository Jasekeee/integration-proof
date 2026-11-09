// Reference store with a real PayPal Checkout, for a person to pay through by hand. mode is "naive"
// or "hardened"; both run side by side. Payment goes through the same store routes, and so the same
// store code, as the proof runner's headless buyer.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MODE_LABELS } from "../../_components/report";
import { linkProse } from "../../_components/ui";
import { Checkout } from "./checkout";
import { SANDBOX_TEST_CARD } from "@/lib/paypal/test-cards";
import { StoreModeSchema } from "@/lib/store";
import { PRODUCT } from "@/lib/store/shared";

const CartSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export async function generateMetadata({ params }: PageProps<"/store/[mode]">): Promise<Metadata> {
  const mode = StoreModeSchema.safeParse((await params).mode);
  return mode.success
    ? { title: `${MODE_LABELS[mode.data].name}: try the checkout`, description: "Pay through a real PayPal Checkout in the sandbox." }
    : { title: "Store not found" };
}

export default async function StorePage({ params, searchParams }: PageProps<"/store/[mode]">) {
  const mode = StoreModeSchema.safeParse((await params).mode);
  if (!mode.success) notFound();
  const cart = CartSchema.safeParse((await searchParams).cart);

  // The client id is public by design; it is read at request time so a deploy needs no rebuild.
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || null;
  const label = MODE_LABELS[mode.data];

  return (
    // The proof page's layout: a centered header, then panels on a surface, as in a scenario's scene.
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 pb-24 sm:px-6">
      <header className="flex flex-col items-center pb-10 pt-12 text-center sm:pb-12 sm:pt-16">
        <p className="text-small text-muted">PayPal sandbox · {label.name}</p>
        <h1 className="mt-3 text-[clamp(2.5rem,6vw,4.75rem)] font-semibold leading-[1.04] tracking-display text-balance">
          A real PayPal Checkout.
        </h1>
        <p className="measure mt-4 text-lg text-pretty text-muted sm:text-xl">
          Pay in PayPal&apos;s real sandbox as the sandbox buyer or with the test card, then watch the page wait for
          PayPal&apos;s webhook and show{" "}
          {mode.data === "hardened" ? "that the store verified its signature" : "that this store never checks its signature"}.
        </p>
        {/* The naive store's page is reachable by its URL only; from there, the hardened one is a click away. */}
        {mode.data === "naive" && (
          <p className="mt-4 text-sm text-muted">
            <Link href="/store/hardened" className={linkProse}>
              Try the hardened store
            </Link>
          </p>
        )}
      </header>
      <Checkout
        mode={mode.data}
        storeName={label.name}
        clientId={clientId}
        buyerEmail={process.env.SANDBOX_BUYER_EMAIL || null}
        product={PRODUCT}
        testCard={{ number: SANDBOX_TEST_CARD.number, expiry: SANDBOX_TEST_CARD.expiry, securityCode: SANDBOX_TEST_CARD.security_code }}
        initialCart={cart.success ? cart.data : null}
      />
    </div>
  );
}
