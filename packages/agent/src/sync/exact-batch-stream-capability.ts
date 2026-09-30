/** Connection-bound transport hint only: never membership or absence evidence. */
const unsupportedByOwner = new WeakMap<object, Map<string, {
  readonly connectionKey: string;
  readonly expiresAt: number;
}>>();

export const EXACT_BATCH_UNSUPPORTED_TTL_MS = 60_000;
export const EXACT_BATCH_UNSUPPORTED_MAX_PEERS = 128;

export function exactBatchStreamUnsupported(
  owner: object,
  peerId: string,
  connectionKey: string | null,
  now: number,
): boolean {
  const entries = unsupportedByOwner.get(owner);
  const entry = entries?.get(peerId);
  if (!entry) return false;
  if (connectionKey === null || entry.connectionKey !== connectionKey || entry.expiresAt <= now) {
    entries!.delete(peerId);
    return false;
  }
  entries!.delete(peerId);
  entries!.set(peerId, entry);
  return true;
}

/** Call only for Core's typed unsupported-before-START negotiation failure. */
export function rememberExactBatchStreamUnsupported(
  owner: object,
  peerId: string,
  admittedConnectionKey: string | null,
  currentConnectionKey: string | null,
  now: number,
): void {
  if (!peerId || admittedConnectionKey === null || admittedConnectionKey !== currentConnectionKey
    || !Number.isFinite(now)) return;
  let entries = unsupportedByOwner.get(owner);
  if (!entries) { entries = new Map(); unsupportedByOwner.set(owner, entries); }
  entries.delete(peerId);
  entries.set(peerId, { connectionKey: admittedConnectionKey, expiresAt: now + EXACT_BATCH_UNSUPPORTED_TTL_MS });
  while (entries.size > EXACT_BATCH_UNSUPPORTED_MAX_PEERS) entries.delete(entries.keys().next().value!);
}
