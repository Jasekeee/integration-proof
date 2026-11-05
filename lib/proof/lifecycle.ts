// What the server does about runs when it starts and when it is told to stop. A run executes in the
// memory of the process that started it, so a restart, as in a deploy, would leave it running
// forever in the database. Recovery at start and on reads is the guarantee; ending this process's
// runs on SIGTERM is the courtesy that usually gets there first.
import { interruptRuns, recoverInterruptedRuns } from "./repository";
import { activeRuns } from "./runner";

/** Startup must not wait long on a slow database; the lazy recovery on reads covers the rest. */
const STARTUP_RECOVERY_TIMEOUT_MS = 10_000;
const SHUTDOWN_GLOBAL = "integrationProofShutdownHandler";

/** Ends the runs a previous process left behind. Never throws and never blocks startup for long. */
export async function recoverOnStart(): Promise<void> {
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STARTUP_RECOVERY_TIMEOUT_MS).unref());
  const result = await Promise.race([recoverInterruptedRuns(), timeout]).catch((error: unknown) => error);
  if (result === "timeout") console.warn("Recovery of interrupted runs is still running after startup.");
  else if (result instanceof Error) console.error("Could not recover interrupted runs at startup", result);
  else if (Array.isArray(result) && result.length > 0) console.log(`Ended ${result.length} interrupted run(s): ${result.join(", ")}`);
}

/**
 * Ends the runs this process is executing. Called on SIGTERM, which Render sends before it stops an
 * instance; Next.js exits on the same signal, so the database write starts at once and may not
 * finish, in which case recovery ends the runs once their lease lapses.
 */
export async function interruptActiveRuns(): Promise<string[]> {
  const ids = [...activeRuns()];
  if (ids.length === 0) return [];
  try {
    const ended = await interruptRuns(ids);
    for (const id of ended) activeRuns().delete(id);
    return ended;
  } catch (error) {
    console.error("Could not mark the running proofs as interrupted on shutdown", error);
    return [];
  }
}

/** Installs the SIGTERM handler once per process. */
export function handleShutdown(): void {
  const store = globalThis as typeof globalThis & { [SHUTDOWN_GLOBAL]?: boolean };
  if (store[SHUTDOWN_GLOBAL]) return;
  store[SHUTDOWN_GLOBAL] = true;
  process.on("SIGTERM", () => {
    void interruptActiveRuns();
  });
}
