// Runs once when a Next.js server instance starts. Ends proof runs that a previous process left
// running, and ends this process's runs when it is told to stop (lib/proof/lifecycle.ts).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { handleShutdown, recoverOnStart } = await import("./lib/proof/lifecycle");
  handleShutdown();
  await recoverOnStart();
}
