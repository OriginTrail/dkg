import type { Stream } from '@libp2p/interface';

export type InboundDuplexStage = 'pre-read' | 'read-request' | 'peer-admission' | 'handler' | 'close';

/** Only structured, sanitized data crosses this optional observation boundary. */
export interface InboundDuplexDiagnostics {
  onInboundOpen?: (peerIdSuffix: string) => void;
  onInboundFailure?: (failure: {
    peerIdSuffix: string;
    stage: InboundDuplexStage;
    errorName: string;
    errorCode: string | undefined;
    signalAborted: boolean;
  }) => void;
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
  try { options.onInboundOpen?.(peerId.slice(-8)); } catch { /* Observation cannot change admission. */ }
}

export function notifyInboundFailure(options: InboundDuplexDiagnostics, peerId: string,
  stage: InboundDuplexStage, error: unknown, signal: AbortSignal): void {
  const safeTag = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value : undefined;
  try {
    options.onInboundFailure?.({ peerIdSuffix: peerId.slice(-8), stage,
      errorName: safeTag(error instanceof Error ? error.name : undefined) ?? 'UnknownError',
      errorCode: safeTag(error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined),
      signalAborted: signal.aborted });
  } catch { /* Observation cannot change stream failure handling. */ }
}
