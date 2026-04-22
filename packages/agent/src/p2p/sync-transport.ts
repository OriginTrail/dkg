import { withRetry } from '@origintrail-official/dkg-core';

interface SyncSendParams {
  remotePeerId: string;
  timeoutMs: number;
  retryAttempts: number;
  contextGraphId: string;
  offset: number;
  requestFactory: () => Promise<Uint8Array>;
  send: (peerId: string, protocolId: string, data: Uint8Array, timeoutMs: number) => Promise<Uint8Array>;
  protocolId: string;
  onRetry: (attempt: number, delay: number, err: unknown) => void;
}

export async function sendSyncRequest(params: SyncSendParams): Promise<Uint8Array> {
  return withRetry(
    async () => {
      const requestBytes = await params.requestFactory();
      return params.send(params.remotePeerId, params.protocolId, requestBytes, params.timeoutMs);
    },
    {
      maxAttempts: params.retryAttempts,
      baseDelayMs: 1000,
      onRetry: params.onRetry,
    },
  );
}
