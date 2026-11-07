// Any address the app does not serve, and every notFound() without a closer boundary.
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "./_components/icon";
import { buttonPrimary, buttonSecondary, eyebrow } from "./_components/ui";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    // On a phone the message sits near the top; on a wide screen it takes the middle of the page.
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 pb-24 pt-16 sm:justify-center sm:px-6 sm:py-24">
      <p className={`${eyebrow} font-mono`}>404</p>
      <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">This page is not part of the proof.</h1>
      <div className="flex flex-wrap gap-3">
        <Link href="/proof" className={`group ${buttonPrimary}`}>
          See the live proof
          <Icon name="arrow-right" className="size-4 transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5" />
        </Link>
        <Link href="/" className={buttonSecondary}>
          Back to the start
        </Link>
      </div>
    </div>
  );
}
