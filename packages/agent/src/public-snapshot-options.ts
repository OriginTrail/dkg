import { isPublicGraphSnapshotScope } from '@origintrail-official/dkg-chain';
import { isPublicSnapshotMode, type PublicSnapshotMode } from './public-snapshot-mode.js';

export interface PublicSnapshotSyncOptions {
  contextGraphId: string;
  onChainId: string;
  /** Operator-configured peer identities, never populated from advertised roles. */
  trustedCorePeerIds: readonly string[];
  mode?: PublicSnapshotMode;
  signal?: AbortSignal;
}

/** The agent and HTTP boundary share domain validation; HTTP owns wire-size/field limits. */
export function normalizePublicSnapshotSyncOptions(input: unknown): PublicSnapshotSyncOptions & { mode: PublicSnapshotMode } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid snapshot job');
  const value = input as Record<string, unknown>;
  const mode = value.mode ?? 'core-cache';
  if (!isPublicGraphSnapshotScope(value)
    || !isPublicSnapshotMode(mode)
    || !Array.isArray(value.trustedCorePeerIds)
    || value.trustedCorePeerIds.some(peer => typeof peer !== 'string' || !peer.length || peer.length > 256)
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) throw new Error('Invalid snapshot job');
  const peers = [...new Set(value.trustedCorePeerIds as string[])];
  if (!peers.length || peers.length > 4) throw new Error('Configure one to four trusted core peer identities');
  return { contextGraphId: value.contextGraphId, onChainId: value.onChainId,
    trustedCorePeerIds: peers, mode, ...(value.signal ? { signal: value.signal as AbortSignal } : {}) };
}
