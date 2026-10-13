import type { Stream } from '@libp2p/interface';

export type InboundDuplexStage = 'pre-read' | 'read-request' | 'peer-admission' | 'handler' | 'close';

/** Only structured, sanitized data crosses this optional observation boundary. */
export interface InboundDuplexDiagnostics {
  onInboundOpen?: (peerIdSuffix: string) => unknown;
  onInboundFailure?: (failure: {
    peerIdSuffix: string;
    stage: InboundDuplexStage;
    errorName: string;
    errorCode: string | undefined;
    signalAborted: boolean;
  }) => unknown;
}

function observeInbound(callback: () => unknown): void {
  try {
    const result = callback();
    if (result !== null && result !== undefined
      && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* Observation cannot change admission or stream cleanup. */ }
}

export function validateDuplexStreamOptions(options: {
  timeoutMs: number; maxReadBufferBytes: number;
}, maxReadBytes: number): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
    || !Number.isSafeInteger(options.maxReadBufferBytes) || options.maxReadBufferBytes <= 0
    || options.maxReadBufferBytes > maxReadBytes) throw new RangeError('Invalid duplex stream limits');
}

export function boundDuplexStreamBuffers(stream: Stream, limit: number): void {
  stream.maxReadBufferLength = Math.min(stream.maxReadBufferLength || limit, limit);
  stream.maxWriteBufferLength = Math.min(stream.maxWriteBufferLength || limit, limit);
}

export function notifyInboundOpen(options: InboundDuplexDiagnostics, peerId: string): void {
  observeInbound(() => options.onInboundOpen?.(peerId.slice(-8)));
}

export function notifyInboundFailure(options: InboundDuplexDiagnostics, peerId: string,
  stage: InboundDuplexStage, error: unknown, signal: AbortSignal): void {
  const safeTag = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value : undefined;
  observeInbound(() =>
    options.onInboundFailure?.({ peerIdSuffix: peerId.slice(-8), stage,
      errorName: safeTag(error instanceof Error ? error.name : undefined) ?? 'UnknownError',
      errorCode: safeTag(error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined),
      signalAborted: signal.aborted }));
}
