import type { RandomSamplingRepairMaterial } from '@origintrail-official/dkg-random-sampling';
import { buildReconciledKnowledgeAssetUal } from '../../ka-identity.js';
import type { ExactAssetCommitment } from '../exact-assets.js';
import { runBoundedPreparedPeerTraversal } from '../prepared-peer-traversal.js';

export interface RandomSamplingExactRepairInput {
  readonly kaId: bigint;
  readonly cgId: bigint;
  readonly expectedRoot: Uint8Array;
  readonly expectedLeafCount: bigint;
  /** Lifetime of the owning prover handle. */
  readonly signal?: AbortSignal;
  /** Physical dependency work that prover close must drain after logical abort. */
  readonly registerPhysicalOperation?: (operation: Promise<unknown>) => void;
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
  resolveLocalContextGraphId(onChainContextGraphId: bigint): string | undefined;
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

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  registerPhysicalOperation?: (operation: Promise<unknown>) => void,
): Promise<T> {
  registerPhysicalOperation?.(operation);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Bounded proof-time recovery coordinator. The challenge commitment is applied
 * to the exact descriptor before the peer payload can become ephemeral proof input.
 */
export async function runRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
): Promise<RandomSamplingRepairMaterial> {
  const timeoutSignal = (deps.createTimeoutSignal ?? AbortSignal.timeout)(
    deps.timeoutMs ?? 90_000,
  );
  const activeSignals = [
    input.signal,
    deps.stopSignal,
    timeoutSignal,
  ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
  const signal = activeSignals.length === 1
    ? activeSignals[0]!
    : AbortSignal.any(activeSignals);
  if (signal.aborted) throw abortReason(signal);

  const localContextGraphId = deps.resolveLocalContextGraphId(input.cgId);
  if (!localContextGraphId) {
    throw new Error(`Random Sampling repair cannot resolve local CG ${input.cgId}`);
  }

  const storageAddress = await raceWithAbort(
    deps.resolveStorageAddress(signal),
    signal,
    input.registerPhysicalOperation,
  );
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
  const candidatePeerIds = await raceWithAbort(
    deps.resolveCandidatePeerIds(localContextGraphId, signal),
    signal,
    input.registerPhysicalOperation,
  );
  if (candidatePeerIds.length === 0) {
    throw new Error(`Random Sampling repair found no providers for ${localContextGraphId}`);
  }
  const traversal = await runBoundedPreparedPeerTraversal<RandomSamplingExactRepairResult>({
    candidatePeerIds,
    maxPeers: deps.maxPeers,
    operationLabel: `RS exact repair for ${assetUal} from`,
    assertCurrent: () => {
      if (signal.aborted) throw abortReason(signal);
    },
    selectPeerWindow: (peerIds, { maxPeers }) => deps.selectPeerWindow(peerIds, {
      maxPeers,
      peerRotationKey: `rs-proof:${localContextGraphId}`,
    }),
    preparePeer: (peerId) => raceWithAbort(
      deps.preparePeer(peerId, signal),
      signal,
      input.registerPhysicalOperation,
    ),
    attemptPeer: async (peerId) => {
      let result: RandomSamplingExactRepairResult;
      try {
        result = await raceWithAbort(deps.fetchExactKnowledgeAsset(
          peerId,
          localContextGraphId,
          expectedCommitment,
          signal,
        ), signal, input.registerPhysicalOperation);
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        return { kind: 'continue', error };
      }
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
    `Random Sampling exact repair did not recover ${assetUal} from `
      + `${traversal.attemptedPeerIds.length > 0
        ? traversal.attemptedPeerIds.map((peerId) => peerId.slice(-8)).join(',')
        : 'the bounded provider window'}`,
  );
}
