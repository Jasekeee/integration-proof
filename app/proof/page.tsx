// Both stores side by side, with their latest runs, and a button that runs both.
import type { Metadata } from "next";
import { ProofComparison } from "../_components/proof-comparison";
import type { RunReport } from "../_components/report";
import { freshAllowed } from "@/lib/proof/limits";
import { latestRunIds, readReport } from "@/lib/proof/report";
import { readStoreCode } from "@/lib/store/snippets";

export const metadata: Metadata = {
  title: "Proof runs",
  description: "Six PayPal failure scenarios against a naive and a hardened store, side by side.",
};

/** Plain JSON, as the report API returns it, so the first paint and later polls match. */
async function loadReport(runId: string | null): Promise<RunReport | null> {
  if (!runId) return null;
  const report = await readReport(runId);
  return report ? (JSON.parse(JSON.stringify(report)) as RunReport) : null;
}

export default async function ProofPage({ searchParams }: PageProps<"/proof">) {
  // Only the operator's token turns live analysis on; any other value leaves the page as it is.
  const given = (await searchParams).fresh;
  const freshToken = typeof given === "string" && freshAllowed(given) ? given : null;
  const code = await readStoreCode();
  let initial: Record<"naive" | "hardened", RunReport | null> = { naive: null, hardened: null };
  let loadError = false;
  try {
    const ids = await latestRunIds();
    const [naive, hardened] = await Promise.all([loadReport(ids.naive), loadReport(ids.hardened)]);
    initial = { naive, hardened };
  } catch (error) {
    console.error("Could not load the latest runs", error);
    loadError = true;
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Naive and hardened, side by side</h1>
        <p className="max-w-3xl text-muted">
          The same six failures against two stores in the PayPal sandbox. Code decides every verdict; Claude explains each
          failure and proposes the fix.
        </p>
      </header>
      {loadError && (
        <p role="alert" className="rounded-lg border border-warn/40 bg-warn-bg p-4 text-sm text-warn">
          The latest results could not be loaded. Running the proof still works; reload the page to try again.
        </p>
      )}
      <ProofComparison initial={initial} freshToken={freshToken} code={code} />
    </div>
  );
}
