/**
 * PayPal sandbox capability check.
 *
 * Runs the calls Integration Proof depends on against the live sandbox and prints what PayPal
 * returned. The output is the evidence behind docs/sandbox-findings.md.
 *
 *   npx tsx scripts/sandbox-capabilities.ts
 *
 * Credentials come from .env.local. Responses pass through schemas that keep only the listed
 * fields, so tokens and card data cannot reach the report. Exits 1 when a capability is missing.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const ORDERS_PATH = "/v2/checkout/orders";
const SERVER_SDK_PACKAGE = "@paypal/paypal-server-sdk";
const REQUEST_TIMEOUT_MS = 30_000;

/** Visa number published at https://developer.paypal.com/tools/sandbox/card-testing/ */
const TEST_CARD = {
  number: "4012888888881881",
  expiry: `${new Date().getUTCFullYear() + 3}-12`,
  security_code: "123",
  name: "Integration Proof",
  billing_address: {
    address_line_1: "2211 North First Street",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

const PURCHASE_UNITS = [{ amount: { currency_code: "USD", value: "1.00" } }];

const CARDS_NOT_ENABLED_ISSUES = [
  "NOT_ENABLED_FOR_CARD_PROCESSING",
  "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING",
];

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_API_BASE: z.literal(SANDBOX_BASE_URL),
});

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
});

const OrderSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({
            captures: z.array(z.object({ id: z.string(), status: z.string() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const ErrorSchema = z.object({
  name: z.string().optional(),
  error: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
});

type Order = z.infer<typeof OrderSchema>;
type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";

interface Check {
  id: string;
  title: string;
  verdict: Verdict;
  summary: string;
}

interface CallResult {
  httpStatus: number;
  order: Order;
  /** PayPal `details[].issue` codes, or the error name when the response has no details. */
  issues: string[];
}

interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

function captureIds(order: Order): string[] {
  return (order.purchase_units ?? []).flatMap((unit) =>
    (unit.payments?.captures ?? []).map((capture) => capture.id),
  );
}

function capturePath(orderId: string): string {
  return `${ORDERS_PATH}/${orderId}/capture`;
}

function mockResponse(code: string): Record<string, string> {
  return { "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: code }) };
}

function requestId(id: string = randomUUID()): Record<string, string> {
  return { "PayPal-Request-Id": id };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = "code" in cause ? String(cause.code) : cause.name;
    return `${code}: ${cause.message}`;
  }
  return `${error.name}: ${error.message}`;
}

function logCall(
  label: string,
  method: string,
  path: string,
  outcome: string[],
  debugId: string | null | undefined,
  startedAt: number,
): void {
  const duration = Math.round(performance.now() - startedAt);
  console.log(`  ${label}`);
  console.log(`    ${method} ${path}`);
  console.log(`    -> ${outcome.join(" ")} debug_id=${debugId ?? "none"} ${duration}ms`);
}

async function api(
  token: string,
  label: string,
  method: "GET" | "POST",
  path: string,
  { body, headers }: CallOptions = {},
): Promise<CallResult> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${SANDBOX_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const issue = `NO_RESPONSE(${describeNetworkError(error)})`;
    logCall(label, method, path, [issue], null, startedAt);
    return { httpStatus: 0, order: {}, issues: [issue] };
  }

  const json = parseJson(await response.text());
  const order = OrderSchema.safeParse(json).data ?? {};
  const error = ErrorSchema.safeParse(json).data ?? {};
  const details = (error.details ?? []).flatMap((detail) => detail.issue ?? []);
  const issues = response.ok ? [] : details.length > 0 ? details : [error.name ?? "UNKNOWN_ERROR"];

  const outcome = [String(response.status)];
  if (order.status) outcome.push(order.status);
  if (captureIds(order).length > 0) outcome.push(`captures=${captureIds(order).join(",")}`);
  if (issues.length > 0) outcome.push(`issue=${issues.join(",")}`);
  const debugId = response.headers.get("paypal-debug-id") ?? error.debug_id;
  logCall(label, method, path, outcome, debugId, startedAt);

  return { httpStatus: response.status, order, issues };
}

/** Creates a bare order and confirms the card on it, which leaves the capture as its own call. */
async function createApprovedOrder(token: string): Promise<CallResult & { orderId?: string }> {
  const created = await api(token, "create order, no payment source", "POST", ORDERS_PATH, {
    body: { intent: "CAPTURE", purchase_units: PURCHASE_UNITS },
  });
  if (!created.order.id) return created;

  const confirmed = await api(
    token,
    "confirm-payment-source with the test card",
    "POST",
    `${ORDERS_PATH}/${created.order.id}/confirm-payment-source`,
    { body: { payment_source: { card: TEST_CARD } } },
  );
  return confirmed.order.status === "APPROVED"
    ? { ...confirmed, orderId: created.order.id }
    : confirmed;
}

async function checkOauth(): Promise<{ check: Check; token?: string }> {
  const title = "OAuth token";
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const names = [...new Set(env.error.issues.map((issue) => issue.path.join(".")))];
    const summary = `invalid or empty in .env.local: ${names.join(", ")}`;
    return { check: { id: "1", title, verdict: "FAIL", summary } };
  }

  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = env.data;
  const path = "/v1/oauth2/token";
  const startedAt = performance.now();
  const response = await fetch(`${SANDBOX_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const json = parseJson(await response.text());
  const token = TokenSchema.safeParse(json).data;
  const failure = ErrorSchema.safeParse(json).data?.error;
  const debugId = response.headers.get("paypal-debug-id");
  const outcome = [String(response.status), ...(failure ? [`error=${failure}`] : [])];
  logCall("client credentials grant", "POST", path, outcome, debugId, startedAt);

  if (!response.ok || !token) {
    const summary = `no token: HTTP ${response.status}${failure ? ` ${failure}` : ""}`;
    return { check: { id: "1", title, verdict: "FAIL", summary } };
  }
  const summary = `${token.token_type} token issued, expires in ${token.expires_in}s`;
  return { check: { id: "1", title, verdict: "PASS", summary }, token: token.access_token };
}

/** The path the guide starts from: card on create, then confirm and capture if PayPal needs them. */
async function runCardOnCreate(token: string): Promise<string> {
  console.log("  Path A: payment_source.card on create order");
  const created = await api(token, "create order with the test card", "POST", ORDERS_PATH, {
    body: { intent: "CAPTURE", purchase_units: PURCHASE_UNITS, payment_source: { card: TEST_CARD } },
    headers: requestId(),
  });

  const { id: orderId, status } = created.order;
  if (!orderId) return `create failed: HTTP ${created.httpStatus} ${created.issues.join(",")}`;
  if (status === "COMPLETED") return "COMPLETED on create, no separate capture on this path";
  if (status === "PAYER_ACTION_REQUIRED") return "PAYER_ACTION_REQUIRED, needs a buyer in a browser";

  if (status === "CREATED") {
    const confirmed = await api(
      token,
      "confirm-payment-source with the test card",
      "POST",
      `${ORDERS_PATH}/${orderId}/confirm-payment-source`,
      { body: { payment_source: { card: TEST_CARD } } },
    );
    if (confirmed.order.status !== "APPROVED") {
      return `confirm returned ${confirmed.order.status ?? confirmed.issues.join(",")}`;
    }
  }

  const captured = await api(token, "capture", "POST", capturePath(orderId), {
    headers: requestId(),
  });
  return `${status} on create, capture returned ${captured.order.status ?? captured.issues.join(",")}`;
}

/** The path the fault-injection proxy needs: the capture is a separate request it can intercept. */
async function runSeparateCapture(token: string): Promise<{ captured: boolean; summary: string }> {
  console.log("  Path B: bare create, confirm-payment-source, separate capture");
  const approved = await createApprovedOrder(token);
  if (!approved.orderId) {
    const reason = approved.issues.join(",") || approved.order.status || "no order id";
    const hint = approved.issues.some((issue) => CARDS_NOT_ENABLED_ISSUES.includes(issue))
      ? " (card processing is not enabled for this app)"
      : "";
    return { captured: false, summary: `no approved order: ${reason}${hint}` };
  }

  const captured = await api(token, "capture", "POST", capturePath(approved.orderId), {
    headers: requestId(),
  });
  const done = captured.order.status === "COMPLETED" && captureIds(captured.order).length === 1;
  return {
    captured: done,
    summary: done
      ? "CREATED -> APPROVED -> COMPLETED, one capture"
      : `capture returned ${captured.order.status ?? captured.issues.join(",")}`,
  };
}

async function checkHeadlessCard(token: string): Promise<Check> {
  const pathA = await runCardOnCreate(token);
  const pathB = await runSeparateCapture(token);
  return {
    id: "2",
    title: "Headless card purchase with a separate capture",
    verdict: pathB.captured ? "PASS" : "FAIL",
    summary: `path A: ${pathA}; path B: ${pathB.summary}`,
  };
}

async function checkMockedDecline(token: string): Promise<Check> {
  const title = "PayPal-Mock-Response INSTRUMENT_DECLINED on capture";
  const { orderId } = await createApprovedOrder(token);
  if (!orderId) return { id: "3", title, verdict: "FAIL", summary: "no approved order" };

  const declined = await api(token, "capture with the mock header", "POST", capturePath(orderId), {
    headers: { ...requestId(), ...mockResponse("INSTRUMENT_DECLINED") },
  });
  const after = await api(token, "read order", "GET", `${ORDERS_PATH}/${orderId}`);

  const isDeclined = declined.issues.includes("INSTRUMENT_DECLINED");
  const noCapture = captureIds(after.order).length === 0;
  return {
    id: "3",
    title,
    verdict: isDeclined && noCapture ? "PASS" : "FAIL",
    summary:
      `capture returned HTTP ${declined.httpStatus} ${declined.issues.join(",") || "no error"}; ` +
      `order stays ${after.order.status}, ${captureIds(after.order).length} capture(s)`,
  };
}

async function checkIdempotentCapture(token: string): Promise<Check> {
  const title = "Capture replay with the same PayPal-Request-Id";
  const { orderId } = await createApprovedOrder(token);
  if (!orderId) return { id: "4", title, verdict: "FAIL", summary: "no approved order" };

  const key = requestId();
  const path = capturePath(orderId);
  const first = await api(token, "capture", "POST", path, { headers: key });
  const replay = await api(token, "replay with the same PayPal-Request-Id", "POST", path, {
    headers: key,
  });
  const newKey = await api(token, "control: new PayPal-Request-Id", "POST", path, {
    headers: requestId(),
  });
  const noKey = await api(token, "control: no PayPal-Request-Id", "POST", path);
  const final = await api(token, "read order", "GET", `${ORDERS_PATH}/${orderId}`);

  const [firstId] = captureIds(first.order);
  const [replayId] = captureIds(replay.order);
  const finalIds = captureIds(final.order);
  const sameCapture = Boolean(firstId) && firstId === replayId;
  return {
    id: "4",
    title,
    verdict: sameCapture && finalIds.length === 1 && finalIds[0] === firstId ? "PASS" : "FAIL",
    summary:
      `first ${firstId ?? "none"}, replay ${replayId ?? "none"}, ` +
      `${finalIds.length} capture(s) on the order; ` +
      `new key returned HTTP ${newKey.httpStatus} ${newKey.issues.join(",") || "no error"}, ` +
      `no key returned HTTP ${noKey.httpStatus} ${noKey.issues.join(",") || "no error"}`,
  };
}

/** Scenario S2 retries a mocked 5xx with the same key, so that key must not replay the mock. */
async function checkRetryAfterMockedFailure(token: string): Promise<Check> {
  const title = "Retry after mocked INTERNAL_SERVER_ERROR, same PayPal-Request-Id";
  const { orderId } = await createApprovedOrder(token);
  if (!orderId) return { id: "+", title, verdict: "FAIL", summary: "no approved order" };

  const key = requestId();
  const path = capturePath(orderId);
  const failed = await api(token, "capture with the mock header", "POST", path, {
    headers: { ...key, ...mockResponse("INTERNAL_SERVER_ERROR") },
  });
  const retried = await api(token, "retry with the same key, no mock", "POST", path, {
    headers: key,
  });
  const final = await api(token, "read order", "GET", `${ORDERS_PATH}/${orderId}`);

  const captures = captureIds(final.order).length;
  return {
    id: "+",
    title,
    verdict: failed.httpStatus >= 500 && captures === 1 ? "PASS" : "FAIL",
    summary:
      `mock returned HTTP ${failed.httpStatus}, retry returned HTTP ${retried.httpStatus} ` +
      `${retried.order.status ?? retried.issues.join(",")}; ${captures} capture(s) on the order`,
  };
}

/** Reads the published package as text. Nothing from it is executed. */
function checkServerSdk(): Check {
  const title = `Custom base URL in ${SERVER_SDK_PACKAGE}`;
  const directory = mkdtempSync(join(tmpdir(), "paypal-server-sdk-"));
  try {
    const tarball = execFileSync(
      "npm",
      ["pack", SERVER_SDK_PACKAGE, "--ignore-scripts", "--silent", "--pack-destination", directory],
      { encoding: "utf8" },
    ).trim();
    execFileSync("tar", ["-xzf", join(directory, tarball), "-C", directory]);
    const read = (file: string) => readFileSync(join(directory, "package", file), "utf8");

    const { version } = z.object({ version: z.string() }).parse(JSON.parse(read("package.json")));
    const types = read("dist/esm/types/configuration.d.ts");
    const configuration = types.match(/export interface Configuration \{[\s\S]*?\n\}/)?.[0] ?? "";
    const urlOptions = configuration.match(/\b\w*(url|uri|host|server)\w*\??:/gi) ?? [];
    const environments = [...types.matchAll(/^\s+(\w+) = "\w+",?$/gm)].map((match) => match[1]);
    const baseUrls = [...read("src/client.ts").matchAll(/return '(https:\/\/[^']+)'/g)];
    const readmeMentions = /base.?ur[il]|custom.?url/i.test(read("README.md"));

    console.log(`  version ${version}`);
    console.log(`  Configuration options matching url/uri/host/server: ${urlOptions.length}`);
    console.log(`  Environment enum: ${environments.join(", ")}`);
    console.log(`  hard-coded in getBaseUri: ${baseUrls.map((match) => match[1]).join(", ")}`);
    console.log(`  README mentions a base URL: ${readmeMentions}`);

    const supported = urlOptions.length > 0 || readmeMentions;
    return {
      id: "5",
      title,
      verdict: "INFO",
      summary: supported
        ? `possible option in ${version}, review the package: ${urlOptions.join(" ")}`
        : `no option in ${version}: the host comes from the Environment enum only`,
    };
  } catch (error) {
    const summary = `could not inspect the package: ${error instanceof Error ? error.message : error}`;
    return { id: "5", title, verdict: "FAIL", summary };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  process.loadEnvFile(".env.local");
  console.log(`PayPal sandbox capability check against ${new URL(SANDBOX_BASE_URL).hostname}`);

  const checks: Check[] = [];
  const run = async (heading: string, execute: () => Check | Promise<Check>) => {
    console.log(`\n${heading}`);
    const check = await execute();
    console.log(`  ${check.verdict}: ${check.summary}`);
    checks.push(check);
    return check;
  };

  console.log("\n1. OAuth token");
  const { check: oauth, token } = await checkOauth();
  console.log(`  ${oauth.verdict}: ${oauth.summary}`);
  checks.push(oauth);

  const skipped = (id: string, title: string, reason: string): void => {
    checks.push({ id, title, verdict: "SKIP", summary: reason });
  };

  if (token) {
    const card = await run("2. Headless card purchase", () => checkHeadlessCard(token));
    if (card.verdict === "PASS") {
      await run("3. Mocked decline on capture", () => checkMockedDecline(token));
      await run("4. Capture idempotency", () => checkIdempotentCapture(token));
      await run("+. Retry after a mocked 5xx (scenario S2)", () =>
        checkRetryAfterMockedFailure(token),
      );
    } else {
      skipped("3", "Mocked decline on capture", "needs an approved order from check 2");
      skipped("4", "Capture idempotency", "needs an approved order from check 2");
    }
  } else {
    skipped("2", "Headless card purchase", "needs a token from check 1");
    skipped("3", "Mocked decline on capture", "needs a token from check 1");
    skipped("4", "Capture idempotency", "needs a token from check 1");
  }

  await run("5. Custom base URL in the server SDK", checkServerSdk);

  console.log("\nSummary");
  for (const check of checks) {
    console.log(`  ${check.verdict}  ${check.id}  ${check.title}`);
    console.log(`        ${check.summary}`);
  }
  if (checks.some((check) => check.verdict === "FAIL" || check.verdict === "SKIP")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
