// Proof runs: start a run and follow it.
import { RunConsole } from "./run-console";

export default function ProofPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Proof runs</h1>
        <p className="text-sm">
          A full proof runs all six scenarios against the PayPal sandbox at once, each with its own cart:
          failed and lost captures, duplicate, late and forged webhooks.
        </p>
      </header>
      <RunConsole />
    </main>
  );
}
