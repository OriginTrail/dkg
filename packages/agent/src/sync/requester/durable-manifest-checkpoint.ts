// SPDX-License-Identifier: Apache-2.0
import { graphScopedDurableManifestPrefixAtOffset, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { DurableSyncContext } from './durable-sync.js';

/** One validated manifest boundary for both fetched pages and held completion. */
export function persistDurableManifestBoundary(input: {
  checkpointKey: string;
  manifest: GraphScopedDurableManifestPlan;
  offset: number;
  terminal: boolean;
  session: { kind: 'discard' } | { kind: 'fetched'; rawOffset: number | undefined };
  deleteCheckpoint: DurableSyncContext['deleteCheckpoint'];
  setCheckpoint: DurableSyncContext['setCheckpoint'];
}): void {
  const { checkpointKey, manifest, offset, terminal, session, deleteCheckpoint, setCheckpoint } = input;
  if (terminal && offset !== manifest.manifestRowCount) {
    deleteCheckpoint(checkpointKey);
    throw new Error(`Refusing to persist terminal durable DATA offset ${offset}: manifest requires ${manifest.manifestRowCount}`);
  }
  const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, offset);
  if (!prefix) {
    deleteCheckpoint(checkpointKey);
    throw new Error(`Refusing to ${terminal ? 'persist terminal' : 'checkpoint'} durable DATA offset ${offset}: `
      + 'the completed META manifest has no matching graph boundary');
  }
  // Held completion has no responder coordinate; discard the previous session.
  if (session.kind === 'discard') deleteCheckpoint(checkpointKey);
  setCheckpoint(checkpointKey, {
    offset,
    ...(session.kind === 'fetched' ? { responderSessionOffset: session.rawOffset } : {}),
    binding: { manifestDigest: manifest.manifestDigest, manifestPrefixDigest: prefix.prefixDigest, terminal },
  });
}
