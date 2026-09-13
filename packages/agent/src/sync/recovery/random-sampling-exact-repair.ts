import {
  createRandomSamplingRepairOperation,
  type RandomSamplingRepairMaterial,
  type RandomSamplingRepairOperation,
} from '@origintrail-official/dkg-random-sampling';
import { buildReconciledKnowledgeAssetUal } from '../../ka-identity.js';
import type { ExactAssetCommitment } from '../exact-assets.js';
import {
  runBoundedPreparedPeerTraversal,
  type PreparedPeerAttemptRecord,
} from '../prepared-peer-traversal.js';

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

export type RandomSamplingPeerPreparation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface RandomSamplingExactRepairDependencies {
  readonly chainId: string;
  readonly maxPeers: number | 'all';
  readonly stopSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  readonly createPeerTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  readonly now?: () => number;
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
  preparePeer(peerId: string, signal: AbortSignal): Promise<RandomSamplingPeerPreparation>;
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

function compactError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  const detail = code ? `${code}:${message}` : message;
  return detail.replace(/\s+/g, ' ').slice(0, 72);
}

/** Compact `peer=outcome` rendering of one traversal record for the aggregate failure. */
function describeAttempt(record: PreparedPeerAttemptRecord): string {
  const peer = record.peerId.slice(-8);
  switch (record.kind) {
    case 'skipped':
      return `${peer}=skipped:${record.reason}`;
    case 'prepare-failed':
      return `${peer}=prepare:${compactError(record.error)}`;
    case 'failed':
      return `${peer}=error:${compactError(record.error)}`;
    case 'missed':
      return `${peer}=missed:${record.reason}`;
    case 'done':
      return `${peer}=done`;
  }
}

/**
 * Bounded proof-time recovery coordinator. The challenge commitment is applied
 * to the exact descriptor before the peer payload can become ephemeral proof input.
 */
async function executeRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
  signal: AbortSignal,
  deadlineMs: number,
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
  const maxPeers = deps.maxPeers === 'all' ? candidatePeerIds.length : deps.maxPeers;
  const now = deps.now ?? Date.now;
  const createPeerTimeoutSignal = deps.createPeerTimeoutSignal ?? AbortSignal.timeout;
  const traversal = await runBoundedPreparedPeerTraversal<RandomSamplingExactRepairResult>({
    candidatePeerIds,
    // The caller bounds this to the complete registry roster. Unlike ordinary
    // reconciliation, one proof-time repair must reach every eligible Core
    // before its deadline; deferring a later Core to another challenge loses
    // the current proof.
    maxPeers,
    operationLabel: `RS exact repair for ${assetUal} from`,
    selectPeerWindow: (peerIds, { maxPeers: boundedMaxPeers }) => deps.selectPeerWindow(
      peerIds,
      {
        maxPeers: boundedMaxPeers,
        peerRotationKey: `rs-proof:${localContextGraphId}`,
      },
    ),
    onWindowSelected: (selectedWindow) => {
      deps.logInfo(`[rs.tick.kc-repair-window] ${JSON.stringify({
        assetUal,
        localContextGraphId,
        expectedRoot: `0x${expectedCommitment.merkleRootHex}`,
        expectedLeafCount: expectedCommitment.merkleLeafCount.toString(),
        candidatePeerIds: selectedWindow.candidatePeerIds,
        selectedPeerIds: selectedWindow.selectedPeerIds,
        maxPeers: selectedWindow.maxPeers,
      })}`);
    },
    assertCurrent: () => {
      if (signal.aborted) throw abortReason(signal);
    },
    attemptPeer: async (peerId, { remainingPeers }) => {
      // Reserve a fair share for every later Core. One stalled dial/fetch may
      // consume its share, but cannot monopolize the proof's global deadline.
      const peerBudgetMs = Math.max(
        1,
        Math.floor(Math.max(1, deadlineMs - now()) / remainingPeers),
      );
      const peerSignal = AbortSignal.any([
        signal,
        createPeerTimeoutSignal(peerBudgetMs),
      ]);
      let preparation: RandomSamplingPeerPreparation;
      try {
        preparation = await deps.preparePeer(peerId, peerSignal);
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        return { kind: 'prepare-failed', error };
      }
      throwIfAborted(signal);
      if (preparation.kind === 'skipped') return preparation;

      let result: RandomSamplingExactRepairResult;
      try {
        result = await deps.fetchExactKnowledgeAsset(
          peerId,
          localContextGraphId,
          expectedCommitment,
          peerSignal,
        );
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        return { kind: 'failed', error };
      }
      deps.logInfo(
        `RS exact repair for ${assetUal} from ${peerId.slice(-8)}: `
          + (result.kind === 'found'
            ? 'outcome=found'
            : `outcome=miss disposition=${result.disposition}`),
      );
      return result.kind === 'found'
        ? { kind: 'done', result }
        : { kind: 'missed', reason: result.disposition };
    },
    log: deps.logInfo,
  });
  if (traversal.completion === 'done' && traversal.result?.kind === 'found') {
    return traversal.result.material;
  }

  // The traversal records every peer outcome; render the leading ones compactly.
  throw new Error(
    `Random Sampling exact repair did not recover: ${traversal.attempts.length > 0
      ? traversal.attempts.slice(0, 8).map(describeAttempt).join(',')
      : 'no peer attempts'}; asset=${assetUal}`,
  );
}

/** Start one explicitly owned repair task for the prover lifecycle. */
export function startRandomSamplingExactRepair(
  deps: RandomSamplingExactRepairDependencies,
  input: RandomSamplingExactRepairInput,
): RandomSamplingRepairOperation {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const deadlineMs = (deps.now ?? Date.now)() + timeoutMs;
  const timeoutSignal = (deps.createTimeoutSignal ?? AbortSignal.timeout)(timeoutMs);
  const externalSignals = [deps.stopSignal, timeoutSignal]
    .filter((candidate): candidate is AbortSignal => candidate !== undefined);
  return createRandomSamplingRepairOperation(
    (signal) => executeRandomSamplingExactRepair(deps, input, signal, deadlineMs),
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
