// OAuth access token cache. Tokens always come straight from the sandbox, never through the proxy.
import { z } from "zod";
import { SANDBOX_API_BASE } from "./client";

const TOKEN_TIMEOUT_MS = 30_000;
/** Refresh this long before PayPal's expiry so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const CredentialsSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_API_BASE: z.literal(SANDBOX_API_BASE),
});

const TokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

let cached: { token: string; refreshAt: number } | null = null;
let inFlight: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.refreshAt) return cached.token;
  inFlight ??= fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchToken(): Promise<string> {
  const env = CredentialsSchema.safeParse(process.env);
  if (!env.success) {
    const names = [...new Set(env.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`PayPal credentials are invalid or missing: ${names.join(", ")}`);
  }

  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = env.data;
  const response = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    cache: "no-store",
  });

  const parsed = TokenSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    const debugId = response.headers.get("paypal-debug-id") ?? "none";
    throw new Error(`PayPal OAuth failed: HTTP ${response.status}, debug_id ${debugId}`);
  }

  const lifetimeMs = parsed.data.expires_in * 1000;
  cached = {
    token: parsed.data.access_token,
    refreshAt: Date.now() + Math.max(lifetimeMs - REFRESH_MARGIN_MS, lifetimeMs / 2),
  };
  return cached.token;
}
