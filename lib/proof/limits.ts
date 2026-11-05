// What keeps one visitor from spending the demo for everyone: runs per visitor and per hour, a daily
// ceiling on new Claude calls, and live analysis only for whoever holds the operator's token.
import { createHash, timingSafeEqual } from "node:crypto";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Runs any one visitor may start in an hour. */
export function runsPerVisitorPerHour(): number {
  return positiveInt(process.env.RUNS_PER_VISITOR_PER_HOUR, 6);
}

/** Runs everyone together may start in an hour: high enough that one visitor cannot use it up. */
export function runsPerHour(): number {
  return positiveInt(process.env.RUNS_PER_HOUR, 60);
}

/** New Claude analyses in any 24 hours. Analyses served from the cache do not count. */
export function analysesPerDay(): number {
  return positiveInt(process.env.ANALYSES_PER_DAY, 30);
}

const loggedSources = new Set<string>();

/**
 * The visitor's address. Cloudflare, in front of Render, sets CF-Connecting-IP to the address that
 * connected to it, so a visitor cannot choose it. Without that header, the rightmost
 * X-Forwarded-For entry is the one the last proxy appended; entries to its left came from the
 * client and are never trusted. The source used is logged once per process, without the address.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return logSource("cf-connecting-ip", forwarded.length, cloudflare);
  if (forwarded.length > 0) return logSource("x-forwarded-for, rightmost entry", forwarded.length, forwarded[forwarded.length - 1]);
  return logSource("none", 0, "unknown");
}

/**
 * Logs, once per process and source, where the address came from and how many proxies
 * X-Forwarded-For lists, never the address. /api/health calls it too, so the line appears soon
 * after every deploy without a proof run.
 */
function logSource(source: string, forwardedEntries: number, address: string): string {
  if (!loggedSources.has(source)) {
    loggedSources.add(source);
    console.log(`Rate limits read the visitor's address from: ${source} (x-forwarded-for entries: ${forwardedEntries})`);
  }
  return address;
}

/** What the database stores for a visitor: a hash of the address, never the address itself. */
export function visitorKey(address: string): string {
  return createHash("sha256").update(`integration-proof visitor ${address}`).digest("hex").slice(0, 32);
}

/**
 * Whether a run may skip the analysis cache: only with the operator's token, compared in constant
 * time. Without the token configured, never.
 */
export function freshAllowed(given: string | null): boolean {
  const expected = process.env.FRESH_ANALYSIS_TOKEN;
  if (!expected || !given) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** "4 minutes", "1 minute", "less than a minute". */
export function waitFor(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (seconds < 60) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
