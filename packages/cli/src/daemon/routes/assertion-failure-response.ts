/** Existing HTTP classification, before route-specific partial-success metadata. */
export interface AssertionFailureResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}
