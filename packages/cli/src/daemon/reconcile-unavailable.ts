/**
 * Classify a transient KA-number-floor reconcile without emitting a response.
 * Typed or explicitly retryable legacy errors map to 503; deterministic errors
 * fall through. Shared by the ordinary responder and partial-success routes.
 */
export function classifyReconcileUnavailable(e: any): Record<string, unknown> | undefined {
  const msg = e?.message ?? String(e);
  const isTyped = e?.code === "KA_FLOOR_RECONCILE_UNAVAILABLE";
  // Message-text fallback (for errors re-wrapped on the way up) is accepted only
  // when the error explicitly carries a retryable marker — never for a bare
  // message, which might be hiding a deterministic revert.
  const isMarkedLegacyTransient =
    e?.retryable === true && /failed to reconcile KA-number floor/i.test(msg);
  if ((!isTyped && !isMarkedLegacyTransient) || e?.retryable === false) {
    return undefined;
  }
  return {
    error: msg,
    code: "KA_FLOOR_RECONCILE_UNAVAILABLE",
    retryable: true,
  };
}
