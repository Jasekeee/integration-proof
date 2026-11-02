// Landing page.
export default function LandingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center font-sans">
      <h1 className="text-4xl font-semibold tracking-tight">
        Integration Proof
      </h1>
      <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
        Prove your PayPal integration survives a bad day, before your customers
        find out.
      </p>
    </main>
  );
}
