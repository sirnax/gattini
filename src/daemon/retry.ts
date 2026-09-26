/** Only failures known to occur before a runtime launch can enter this policy. */
const TRANSIENT_CODES = new Set(["EAGAIN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH"]);

export function isTransientPreflightFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && TRANSIENT_CODES.has(error.code);
}

export const MAX_PREFLIGHT_ATTEMPTS = 2;
