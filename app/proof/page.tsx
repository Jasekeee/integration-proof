// Proof runs: start a run and follow it.
import { RunConsole } from "./run-console";

export default function ProofPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Proof runs</h1>
        <p className="text-sm">
          Each run checks out one cart per scenario against the PayPal sandbox, with the scenario&apos;s fault
          injected into the store&apos;s capture. Scenarios run side by side.
        </p>
      </header>
      <RunConsole />
    </main>
  );
}
