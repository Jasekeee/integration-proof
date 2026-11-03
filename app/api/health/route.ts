// Liveness check for the hosting provider. Answers without touching the database or PayPal, so a
// cold database or a slow sandbox cannot get a healthy instance restarted.

export function GET() {
  return Response.json(
    { status: "ok", commit: process.env.RENDER_GIT_COMMIT ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
