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

export function isSyncBackoffWorthyError(error: unknown): boolean {
  if (isSyncTransportFailure(error)) return true;

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();

  return (
    message.includes('too many active durable data sync session snapshots') ||
    (message.includes('sync responder') && (
      message.includes('queue full') ||
      message.includes('queue wait exceeded') ||
      message.includes('snapshot limit exceeded') ||
      message.includes('busy')
    )) ||
    message.includes('stream reset') ||
    message.includes('connection reset') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('send timeout') ||
    message.includes('operation timed out') ||
    message.includes('operation was aborted due to timeout')
  );
}
