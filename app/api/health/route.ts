// Liveness check for the hosting provider. Answers without touching the database or PayPal, so a
// cold database or a slow sandbox cannot get a healthy instance restarted.
import { clientAddress } from "@/lib/proof/limits";

export function GET(request: Request) {
  // Logs once per process where the rate limits read a visitor's address (never the address), so
  // the monitor's pings show it in the logs soon after each deploy.
  clientAddress(request.headers);
  return Response.json(
    { status: "ok", commit: process.env.RENDER_GIT_COMMIT ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
