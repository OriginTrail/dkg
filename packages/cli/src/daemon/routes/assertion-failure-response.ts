/** Existing HTTP classification, before route-specific partial-success metadata. */
export interface AssertionFailureResponse {
  status: number;
  body: Record<string, unknown>;
  /** Store unavailability must interrupt a partially completed one-shot request. */
  partialDisposition?: 'unavailable';
  headers?: Record<string, string>;
}
