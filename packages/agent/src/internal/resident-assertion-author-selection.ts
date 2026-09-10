/** A snapshotted selector; malformed public input still reports resident candidates. */
export type ResidentAssertionAuthorSelection =
  | { readonly kind: 'address'; readonly agentAddress: string }
  | { readonly kind: 'malformed'; readonly displayValue: string };

/** Snapshot untyped API input without forwarding arbitrary values into lookup. */
export function readResidentAuthorSelection(value: unknown): ResidentAssertionAuthorSelection | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? Object.freeze({ kind: 'address', agentAddress: value })
    : Object.freeze({ kind: 'malformed', displayValue: String(value) });
}
