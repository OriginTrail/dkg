import { DKG_CORE_CHAIN_CACHE } from './core-chain-cache-config.js';
import { isPublicGraphSnapshotScope } from '@origintrail-official/dkg-chain';
import { isPublicSnapshotMode, type PublicSnapshotMode } from './public-snapshot-mode.js';
import { BASE_MAINNET_SOURCE_POLICY } from './public-snapshot-source-proof.js';

interface PublicSnapshotSyncBase {
  contextGraphId: string;
  onChainId: string;
  mode?: PublicSnapshotMode;
  transport?: "exact" | "bulk";
  signal?: AbortSignal;
}

export type PublicSnapshotSyncOptions = PublicSnapshotSyncBase & (
  | {
      /** Operator-configured identities, never advertised roles. */
      trustedCorePeerIds: readonly string[];
      sourcePolicy?: never;
    }
  | {
      /** Independently authenticated registered cores; no explicit peers. */
      trustedCorePeerIds: readonly [];
      sourcePolicy: typeof BASE_MAINNET_SOURCE_POLICY | typeof DKG_CORE_CHAIN_CACHE;
    }
);

/** The agent and HTTP boundary share domain validation; HTTP owns wire-size/field limits. */
export function normalizePublicSnapshotSyncOptions(input: unknown): PublicSnapshotSyncOptions & { mode: PublicSnapshotMode; transport: "exact" | "bulk" } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid snapshot job');
  const value = input as Record<string, unknown>;
  const mode = value.mode ?? 'core-cache';
  const transport = value.transport ?? (process.env.DKG_PUBLIC_SNAPSHOT_BULK === '1' ? 'bulk' : 'exact');
  if (!isPublicGraphSnapshotScope(value)
    || !isPublicSnapshotMode(mode)
    || (transport !== 'exact' && transport !== 'bulk')
    || (value.sourcePolicy !== undefined && value.sourcePolicy !== BASE_MAINNET_SOURCE_POLICY && value.sourcePolicy !== DKG_CORE_CHAIN_CACHE)
    || !Array.isArray(value.trustedCorePeerIds)
    || value.trustedCorePeerIds.some(peer => typeof peer !== 'string' || !peer.length || peer.length > 256)
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) throw new Error('Invalid snapshot job');
  const peers = [...new Set(value.trustedCorePeerIds as string[])];
  if (value.sourcePolicy ? peers.length !== 0 : (!peers.length || peers.length > 4))
    throw new Error('Configure one to four trusted cores or the registered-core policy, never both');
  const common: PublicSnapshotSyncBase & { mode: PublicSnapshotMode; transport: "exact" | "bulk" } = {
    contextGraphId: value.contextGraphId, onChainId: value.onChainId, mode, transport,
    ...(value.signal ? { signal: value.signal as AbortSignal } : {}),
  };
  return value.sourcePolicy
    ? { ...common, trustedCorePeerIds: [], sourcePolicy: value.sourcePolicy as typeof BASE_MAINNET_SOURCE_POLICY | typeof DKG_CORE_CHAIN_CACHE }
    : { ...common, trustedCorePeerIds: peers };
}
