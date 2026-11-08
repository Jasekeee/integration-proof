// --paypal model: the PayPal sandbox answered in process by the offline bench's model
// (bench/paypal-model.ts), which only covers behaviour recorded in docs/sandbox-findings.md. Every
// request this process sends to the sandbox host, the proxy's and the CLI's own, goes to the model;
// nothing reaches PayPal and no credentials are needed.
import { SANDBOX_HOST } from "../lib/paypal/client";
import { PayPalModel } from "../bench/paypal-model";

/** Placeholders the PayPal client reads; the model accepts any client credentials. */
const MODEL_ENV = { PAYPAL_CLIENT_ID: "model-client", PAYPAL_CLIENT_SECRET: "model-secret" };

export function installModel(): { model: PayPalModel; restore: () => void } {
  const model = new PayPalModel("WH-MODEL");
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, MODEL_ENV);
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host === SANDBOX_HOST) return model.handle(request);
    return original(input, init);
  };
  return {
    model,
    restore() {
      globalThis.fetch = saved.fetch;
      for (const name of Object.keys(MODEL_ENV)) {
        if (saved.env[name] === undefined) delete process.env[name];
        else process.env[name] = saved.env[name];
      }
    },
  };
}
