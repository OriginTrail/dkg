import { buildReconciledKnowledgeAssetUal } from '../../ka-identity.js';
import type { ExactAssetCommitment } from '../requester/exact-durable-fetch.js';

export interface RandomSamplingExactRepairInput {
  readonly kaId: bigint;
  readonly cgId: bigint;
  readonly expectedRoot: Uint8Array;
  readonly expectedLeafCount: bigint;
}

export interface RandomSamplingExactRepairResult {
  readonly disposition: 'found' | 'clean-absent' | 'incomplete';
  readonly insertedTriples: number;
}

export interface RandomSamplingExactRepairDependencies {
  readonly chainId: string;
  readonly maxPeers: number;
  readonly stopSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  resolveStorageAddress(): Promise<string>;
  resolveLocalContextGraphId(onChainContextGraphId: bigint): string | undefined;
  observedCandidatePeerIds(localContextGraphId: string): string[];
  selectPeerWindow(
    peerIds: string[],
    options: { readonly maxPeers: number; readonly peerRotationKey: string },
  ): string[];
  ensurePeerAdmitted(peerId: string, signal: AbortSignal): Promise<boolean>;
  ensurePeerConnected(peerId: string, signal: AbortSignal): Promise<void>;
  waitForSyncProtocol(peerId: string, signal: AbortSignal): Promise<boolean>;
  fetchExactKnowledgeAsset(
    peerId: string,
    localContextGraphId: string,
    assetUal: string,
    expectedCommitment: ExactAssetCommitment,
    signal: AbortSignal,
  ): Promise<RandomSamplingExactRepairResult>;
  logInfo(message: string): void;
}

function hex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Random Sampling exact repair aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Bounded proof-time recovery coordinator. The challenge commitment is applied
 * to the exact descriptor before durable sync is allowed to materialize it.
 */
export async function runRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
): Promise<void> {
  const localContextGraphId = deps.resolveLocalContextGraphId(input.cgId);
  if (!localContextGraphId) {
    throw new Error(`Random Sampling repair cannot resolve local CG ${input.cgId}`);
  }

  const storageAddress = await deps.resolveStorageAddress();
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
  const observedPeerIds = deps.observedCandidatePeerIds(localContextGraphId);
  if (observedPeerIds.length === 0) {
    throw new Error(`Random Sampling repair found no providers for ${localContextGraphId}`);
  }
  const peerWindow = deps.selectPeerWindow(observedPeerIds, {
    maxPeers: deps.maxPeers,
    peerRotationKey: `rs-proof:${localContextGraphId}`,
  });
  const timeoutSignal = (deps.createTimeoutSignal ?? AbortSignal.timeout)(
    deps.timeoutMs ?? 90_000,
  );
  const signal = deps.stopSignal
    ? AbortSignal.any([deps.stopSignal, timeoutSignal])
    : timeoutSignal;
  const attempted: string[] = [];

  for (const peerId of peerWindow) {
    if (signal.aborted) throw abortReason(signal);
    attempted.push(peerId.slice(-8));
    try {
      if (!(await deps.ensurePeerAdmitted(peerId, signal))) continue;
      await deps.ensurePeerConnected(peerId, signal);
      if (!(await deps.waitForSyncProtocol(peerId, signal))) continue;
      const result = await deps.fetchExactKnowledgeAsset(
        peerId,
        localContextGraphId,
        assetUal,
        expectedCommitment,
        signal,
      );
      deps.logInfo(
        `RS exact repair for ${assetUal} from ${peerId.slice(-8)}: `
          + `disposition=${result.disposition} inserted=${result.insertedTriples}`,
      );
      if (result.disposition === 'found') return;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      deps.logInfo(
        `RS exact repair for ${assetUal} from ${peerId.slice(-8)} failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Random Sampling exact repair did not recover ${assetUal} from `
      + `${attempted.length > 0 ? attempted.join(',') : 'the bounded provider window'}`,
  );
}
