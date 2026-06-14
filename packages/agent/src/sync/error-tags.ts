type SyncErrorTag = 'syncPeerResponded' | 'syncTransportFailure';

function markSyncError(error: unknown, tag: SyncErrorTag): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    Object.defineProperty(error, tag, {
      configurable: true,
      enumerable: false,
      value: true,
    });
  } catch {
    try {
      (error as Record<string, unknown>)[tag] = true;
    } catch {
      // Best-effort tagging only; never replace the original sync failure.
    }
  }
}

export function markSyncPeerResponded(error: unknown): void {
  markSyncError(error, 'syncPeerResponded');
}

export function markSyncTransportFailure(error: unknown): void {
  markSyncError(error, 'syncTransportFailure');
}

export function didSyncPeerRespond(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { syncPeerResponded?: boolean }).syncPeerResponded ||
    (error as { syncDenied?: boolean }).syncDenied
  ));
}

export function isSyncTransportFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { syncTransportFailure?: boolean }).syncTransportFailure);
}
