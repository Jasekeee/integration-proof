// JSON error responses shared by the route handlers.
import type { z } from "zod";
import { StoreError } from "./store/shared";

export function jsonError(status: number, error: string, message: string, extra?: object): Response {
  return Response.json({ error, message, ...extra }, { status });
}

export function invalidRequest(issues: z.core.$ZodIssue[]): Response {
  return jsonError(400, "invalid_request", "The request is invalid.", {
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/** Maps a thrown error to a response without leaking internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof StoreError) {
    return jsonError(error.httpStatus, "store_error", error.message, { debugId: error.debugId });
  }
  console.error(error);
  return jsonError(500, "internal_error", "Something went wrong on our side.");
}
