import { validateContextGraphId } from '@origintrail-official/dkg-core';
import type { PublicSnapshotMode } from './public-snapshot-evidence.js';

export interface PublicSnapshotSyncOptions {
  contextGraphId: string;
  onChainId: string;
  /** Operator-configured peer identities, never populated from advertised roles. */
  trustedCorePeerIds: readonly string[];
  mode?: PublicSnapshotMode;
  transport?: "exact" | "bulk";
  signal?: AbortSignal;
}

/** The agent and HTTP boundary share domain validation; HTTP owns wire-size/field limits. */
export function normalizePublicSnapshotSyncOptions(input: unknown): PublicSnapshotSyncOptions & { mode: PublicSnapshotMode; transport: "exact" | "bulk" } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid snapshot job');
  const value = input as Record<string, unknown>;
  const mode = value.mode ?? 'core-cache';
  const transport = value.transport ?? (process.env.DKG_PUBLIC_SNAPSHOT_BULK === '1' ? 'bulk' : 'exact');
  if (typeof value.contextGraphId !== 'string' || !validateContextGraphId(value.contextGraphId).valid
    || typeof value.onChainId !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value.onChainId)
    || (mode !== 'core-cache' && mode !== 'rpc-only')
    || (transport !== 'exact' && transport !== 'bulk')
    || !Array.isArray(value.trustedCorePeerIds)
    || value.trustedCorePeerIds.some(peer => typeof peer !== 'string' || !peer.length || peer.length > 256)
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) throw new Error('Invalid snapshot job');
  const peers = [...new Set(value.trustedCorePeerIds as string[])];
  if (!peers.length || peers.length > 4) throw new Error('Configure one to four trusted core peer identities');
  return { contextGraphId: value.contextGraphId, onChainId: value.onChainId,
    trustedCorePeerIds: peers, mode, transport, ...(value.signal ? { signal: value.signal as AbortSignal } : {}) };
}
