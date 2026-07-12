/** Canonical due-page policy shared by every ProtocolOutboxStore implementation. */
export function normalizeProtocolOutboxDueLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.floor(limit));
}
