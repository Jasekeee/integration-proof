// The app's own address as seen from inside its process. The runner calls the stores here, and the
// stores reach the fault-injection proxy here. It comes from server config, never from a request,
// so no caller can point the store's PayPal calls at another host.

/** `next start` and `next dev` listen on PORT (Render sets it), or on 3000 when it is unset. */
export function internalOrigin(): string {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid PORT: ${process.env.PORT}`);
  return `http://localhost:${port}`;
}
