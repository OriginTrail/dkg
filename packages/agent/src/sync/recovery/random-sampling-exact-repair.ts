import {
  createRandomSamplingRepairOperation,
  type RandomSamplingRepairMaterial,
  type RandomSamplingRepairOperation,
} from '@origintrail-official/dkg-random-sampling';
import { buildReconciledKnowledgeAssetUal } from '../../ka-identity.js';
import type { ExactAssetCommitment } from '../exact-assets.js';
import { runBoundedPreparedPeerTraversal } from '../prepared-peer-traversal.js';

export interface RandomSamplingExactRepairInput {
  readonly kaId: bigint;
  readonly cgId: bigint;
  readonly expectedRoot: Uint8Array;
  readonly expectedLeafCount: bigint;
}

export type RandomSamplingExactRepairResult =
  | {
      readonly kind: 'found';
      readonly material: RandomSamplingRepairMaterial;
    }
  | {
      readonly kind: 'miss';
      readonly disposition: 'clean-absent' | 'incomplete';
    };

export interface RandomSamplingExactRepairDependencies {
  readonly chainId: string;
  readonly maxPeers: number;
  readonly stopSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  resolveStorageAddress(signal: AbortSignal): Promise<string>;
  resolveLocalContextGraphId(
    onChainContextGraphId: bigint,
    signal: AbortSignal,
  ): string | undefined | Promise<string | undefined>;
  resolveCandidatePeerIds(
    localContextGraphId: string,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  selectPeerWindow(
    peerIds: string[],
    options: { readonly maxPeers: number; readonly peerRotationKey: string },
  ): string[];
  preparePeer(peerId: string, signal: AbortSignal): Promise<boolean>;
  fetchExactKnowledgeAsset(
    peerId: string,
    localContextGraphId: string,
    expectedCommitment: ExactAssetCommitment,
    signal: AbortSignal,
  ): Promise<RandomSamplingExactRepairResult>;
  logInfo(message: string): void;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Random Sampling exact repair aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function compactPeerError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  const detail = code ? `${code}:${message}` : message;
  return detail.replace(/\s+/g, ' ').slice(0, 72);
}

/**
 * Bounded proof-time recovery coordinator. The challenge commitment is applied
 * to the exact descriptor before the peer payload can become ephemeral proof input.
 */
async function executeRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
  signal: AbortSignal,
): Promise<RandomSamplingRepairMaterial> {
  throwIfAborted(signal);

  const localContextGraphId = await deps.resolveLocalContextGraphId(input.cgId, signal);
  if (!localContextGraphId) {
    throw new Error(`Random Sampling repair cannot resolve local CG ${input.cgId}`);
  }

  const storageAddress = await deps.resolveStorageAddress(signal);
  throwIfAborted(signal);
  const assetUal = buildReconciledKnowledgeAssetUal(
    deps.chainId,
    storageAddress,
    input.kaId,
  );
  const expectedCommitment: ExactAssetCommitment = {
    assetUal,
    merkleRootHex: hex(input.expectedRoot),
    merkleLeafCount: input.expectedLeafCount,
  };
  const candidatePeerIds = await deps.resolveCandidatePeerIds(localContextGraphId, signal);
  throwIfAborted(signal);
  if (candidatePeerIds.length === 0) {
    throw new Error(`Random Sampling repair found no providers for ${localContextGraphId}`);
  }
  const peerDiagnostics: string[] = [];
  const traversal = await runBoundedPreparedPeerTraversal<RandomSamplingExactRepairResult>({
    candidatePeerIds,
    // Keep each proof repair bounded while the keyed peer window advances
    // through the complete discovered roster across subsequent repairs.
    maxPeers: deps.maxPeers,
    operationLabel: `RS exact repair for ${assetUal} from`,
    assertCurrent: () => {
      if (signal.aborted) throw abortReason(signal);
    },
    selectPeerWindow: (peerIds, { maxPeers }) => deps.selectPeerWindow(peerIds, {
      maxPeers,
      peerRotationKey: `rs-proof:${localContextGraphId}`,
    }),
    preparePeer: async (peerId) => {
      const shortPeerId = peerId.slice(-8);
      try {
        const prepared = await deps.preparePeer(peerId, signal);
        if (!prepared) peerDiagnostics.push(`${shortPeerId}=unprepared`);
        return prepared;
      } catch (error) {
        peerDiagnostics.push(`${shortPeerId}=prepare:${compactPeerError(error)}`);
        throw error;
      }
    },
    attemptPeer: async (peerId) => {
      const shortPeerId = peerId.slice(-8);
      let result: RandomSamplingExactRepairResult;
      try {
        result = await deps.fetchExactKnowledgeAsset(
          peerId,
          localContextGraphId,
          expectedCommitment,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        peerDiagnostics.push(`${shortPeerId}=error:${compactPeerError(error)}`);
        return { kind: 'continue', error };
      }
      peerDiagnostics.push(
        `${shortPeerId}=${result.kind === 'found' ? 'found' : result.disposition}`,
      );
      deps.logInfo(
        `RS exact repair for ${assetUal} from ${peerId.slice(-8)}: `
          + (result.kind === 'found'
            ? 'outcome=found'
            : `outcome=miss disposition=${result.disposition}`),
      );
      return result.kind === 'found'
        ? { kind: 'done', result }
        : { kind: 'continue' };
    },
    log: deps.logInfo,
  });
  if (traversal.completion === 'done' && traversal.result?.kind === 'found') {
    return traversal.result.material;
  }

  throw new Error(
    `Random Sampling exact repair did not recover: ${peerDiagnostics.length > 0
      ? peerDiagnostics.slice(0, 8).join(',')
      : 'no prepared peer attempts'}; asset=${assetUal}`,
  );
}

/** Start one explicitly owned repair task for the prover lifecycle. */
export function startRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
): RandomSamplingRepairOperation {
  const timeoutSignal = (deps.createTimeoutSignal ?? AbortSignal.timeout)(
    deps.timeoutMs ?? 90_000,
  );
  const externalSignals = [deps.stopSignal, timeoutSignal]
    .filter((candidate): candidate is AbortSignal => candidate !== undefined);
  return createRandomSamplingRepairOperation(
    (signal) => executeRandomSamplingExactRepair(deps, input, signal),
    externalSignals,
  );
}

/** Convenience wrapper for callers that only consume the logical result. */
export function runRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
): Promise<RandomSamplingRepairMaterial> {
  return startRandomSamplingExactRepair(deps, input).result;
}
