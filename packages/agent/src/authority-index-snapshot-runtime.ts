// SPDX-License-Identifier: Apache-2.0

import { withRpcRequestContext, type ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  createAuthorityIndexSnapshotHandler,
  PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
} from './authority-index-snapshot-service.js';

export const AUTHORITY_INDEX_SNAPSHOT_REFRESH_INTERVAL_MS = 30_000;

/** Core-owned indexing. Requests only read the cached checkpoint. */
export function startAuthorityIndexSnapshotRuntime(input: {
  nodeRole: 'core' | 'edge';
  snapshots: ChainAdapter['contextGraphAuthorityIndexSnapshots'];
  register: (
    protocol: string,
    handler: (data: Uint8Array) => Promise<Uint8Array>,
    options: { maxReadBytes: number },
  ) => void;
  warn: (message: string) => void;
}): { close(): Promise<void> } | undefined {
  const snapshots = input.snapshots;
  if (input.nodeRole !== 'core' || snapshots === undefined) return undefined;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  input.register(
    PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
    createAuthorityIndexSnapshotHandler({
      exportSnapshot: (request) => abort.signal.aborted
        ? Promise.resolve(null)
        : snapshots.exportSnapshot(request),
    }),
    { maxReadBytes: 2_048 },
  );
  const run = (): void => {
    if (abort.signal.aborted) return;
    active = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return withRpcRequestContext({ requestClass: 'background', signal: abort.signal }, () => (
        snapshots.refresh({ signal: abort.signal })
      ));
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) {
        input.warn(`Authority index snapshot refresh will retry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).finally(() => {
      if (abort.signal.aborted) return;
      timer = setTimeout(run, AUTHORITY_INDEX_SNAPSHOT_REFRESH_INTERVAL_MS);
      timer.unref?.();
    });
  };
  run();
  return {
    async close() {
      abort.abort(new DOMException('Authority index snapshot runtime stopped', 'AbortError'));
      if (timer !== undefined) clearTimeout(timer);
      await active;
    },
  };
}
