// Reference store with a real PayPal Checkout, for a person to pay through by hand. mode is "naive"
// or "hardened"; both run side by side. Payment goes through the same store routes, and so the same
// store code, as the proof runner's headless buyer.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MODE_LABELS } from "../../_components/report";
import { eyebrow, linkProse } from "../../_components/ui";
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
  const other = mode.data === "naive" ? "hardened" : "naive";

  return (
    // The site's grid: the left edge lines up with the header; the store keeps a narrower measure.
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex max-w-5xl flex-col gap-3">
        <p className={eyebrow}>PayPal sandbox · {mode.data} store</p>
        <h1 className="text-3xl font-semibold tracking-tight">Try the checkout yourself</h1>
        <p className="measure leading-relaxed text-pretty text-muted">
          Pay for one item through a real PayPal Checkout. The {label.name.toLowerCase()} creates and captures the order with
          the same code the proof runs, and the page follows the order until PayPal&apos;s webhook arrives. Sandbox only: no
          real money moves.{" "}
          <Link href={`/store/${other}`} className={linkProse}>
            Try the {other} store
          </Link>
        </p>
      </header>
      <div className="max-w-5xl">
      <Checkout
        mode={mode.data}
        clientId={clientId}
        buyerEmail={process.env.SANDBOX_BUYER_EMAIL || null}
        product={PRODUCT}
        testCard={{ number: SANDBOX_TEST_CARD.number, expiry: SANDBOX_TEST_CARD.expiry, securityCode: SANDBOX_TEST_CARD.security_code }}
        initialCart={cart.success ? cart.data : null}
      />
      </div>
    </div>
  );
}
