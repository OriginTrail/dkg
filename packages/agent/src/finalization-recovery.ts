import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  decodeFinalizationMessage,
  validateContextGraphId,
  validateSubGraphName,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import {
  FinalizationRecoveryJournal,
  finalizationRecoveryEntryKey,
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryTrust,
} from './finalization-recovery-journal.js';

export type GraphScopedAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

export interface ParsedGraphScopedFinalization {
  msg: FinalizationMessageMsg;
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  assertionVersion: string;
  kaId: bigint;
  blockNumber: number;
  startKAId: bigint;
  endKAId: bigint;
  batchId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  wireAccessPolicy?: GraphScopedAccessPolicy;
  allowedPeers: string[];
}

export type GraphScopedFinalizationRejectionReason =
  | 'decode-failed'
  | 'unsupported-content-scope'
  | 'missing-ual'
  | 'invalid-transaction-hash'
  | 'invalid-merkle-root'
  | 'invalid-publisher-address'
  | 'legacy-root-entities'
  | 'context-graph-mismatch'
  | 'invalid-context-graph'
  | 'invalid-subgraph'
  | 'missing-assertion-version'
  | 'invalid-identity'
  | 'non-canonical-ual'
  | 'invalid-triple-count'
  | 'invalid-private-commitment'
  | 'invalid-access-policy'
  | 'invalid-allowed-peers'
  | 'invalid-block-number'
  | 'invalid-target-context-graph'
  | 'invalid-ka-identifiers';

export type GraphScopedFinalizationAdmission =
  | { ok: true; value: ParsedGraphScopedFinalization }
  | { ok: false; reason: GraphScopedFinalizationRejectionReason };

function reject(reason: GraphScopedFinalizationRejectionReason): GraphScopedFinalizationAdmission {
  return { ok: false, reason };
}

function protoToNumber(value: number | bigint | { low: number; high: number; unsigned: boolean }): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return ((value.high >>> 0) * 0x100000000) + (value.low >>> 0);
}

function protoToBigInt(
  value: string | number | bigint | { low: number; high: number; unsigned: boolean },
): bigint {
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
}

/** Single typed admission boundary shared by live processing and durable replay. */
export function parseGraphScopedFinalization(
  msg: FinalizationMessageMsg,
  topicContextGraphId: string,
): GraphScopedFinalizationAdmission {
  if (msg.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    return reject('unsupported-content-scope');
  }
  if (!msg.ual) return reject('missing-ual');
  if (!/^0x[0-9a-fA-F]{64}$/.test(msg.txHash)) return reject('invalid-transaction-hash');
  if (msg.kcMerkleRoot.length !== 32) return reject('invalid-merkle-root');
  if (!ethers.isAddress(msg.publisherAddress)) return reject('invalid-publisher-address');
  if (msg.rootEntities.length !== 0) return reject('legacy-root-entities');
  if (msg.contextGraphId && msg.contextGraphId !== topicContextGraphId) {
    return reject('context-graph-mismatch');
  }
  if (msg.contextGraphId && !validateContextGraphId(msg.contextGraphId).valid) {
    return reject('invalid-context-graph');
  }
  if (msg.subGraphName && !validateSubGraphName(msg.subGraphName).valid) {
    return reject('invalid-subgraph');
  }

  const assertionVersion = String(msg.assertionVersion ?? '').trim();
  if (!assertionVersion) return reject('missing-assertion-version');
  let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  try {
    scope = createGraphKnowledgeAssetScope(msg.ual, assertionVersion);
  } catch {
    return reject('invalid-identity');
  }
  if (scope.ual !== msg.ual) return reject('non-canonical-ual');

  const publicTripleCount = Number(msg.publicTripleCount ?? 0);
  const privateTripleCount = Number(msg.privateTripleCount ?? 0);
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
  ) return reject('invalid-triple-count');

  const privateMerkleRoot = msg.privateMerkleRoot?.length
    ? new Uint8Array(msg.privateMerkleRoot)
    : undefined;
  if (
    (privateTripleCount > 0 && privateMerkleRoot?.length !== 32)
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) return reject('invalid-private-commitment');

  const accessPolicy = msg.accessPolicy || undefined;
  if (
    accessPolicy !== undefined
    && accessPolicy !== 'public'
    && accessPolicy !== 'ownerOnly'
    && accessPolicy !== 'allowList'
  ) return reject('invalid-access-policy');
  const rawAllowedPeers = msg.allowedPeers ?? [];
  const allowedPeers = [...new Set(rawAllowedPeers.map((peer) => peer.trim()).filter(Boolean))];
  if (
    allowedPeers.length !== rawAllowedPeers.length
    || (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) return reject('invalid-allowed-peers');

  try {
    const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    const blockNumber = protoToNumber(msg.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      return reject('invalid-block-number');
    }
    if (
      msg.targetContextGraphId !== undefined
      && (!/^\d+$/.test(msg.targetContextGraphId) || BigInt(msg.targetContextGraphId) <= 0n)
    ) return reject('invalid-target-context-graph');
    const startKAId = protoToBigInt(msg.startKAId);
    const endKAId = protoToBigInt(msg.endKAId);
    const batchId = protoToBigInt(msg.batchId);
    if (startKAId !== kaId || endKAId !== kaId || batchId !== kaId) {
      return reject('invalid-ka-identifiers');
    }
    return {
      ok: true,
      value: {
        msg,
        scope,
        assertionVersion,
        kaId,
        blockNumber,
        startKAId,
        endKAId,
        batchId,
        publicTripleCount,
        privateTripleCount,
        ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
        ...(accessPolicy ? { wireAccessPolicy: accessPolicy } : {}),
        allowedPeers,
      },
    };
  } catch {
    return reject('invalid-ka-identifiers');
  }
}

export function decodeGraphScopedFinalization(
  data: Uint8Array,
  topicContextGraphId: string,
): GraphScopedFinalizationAdmission {
  try {
    return parseGraphScopedFinalization(decodeFinalizationMessage(data), topicContextGraphId);
  } catch {
    return reject('decode-failed');
  }
}

interface FinalizationRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface FinalizationRecoveryReplayInput {
  chainId: string;
  contextGraphId: string;
  onChainCgId: string;
  ual: string;
  merkleRoot: string;
  kaId: string;
}

export class FinalizationRecovery {
  private readonly replaySingleFlights = new Map<string, Promise<void>>();

  constructor(
    private readonly journal: FinalizationRecoveryJournal | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly apply: (
      rawMessage: Uint8Array,
      contextGraphId: string,
      sourcePeerId?: string,
    ) => Promise<void>,
    private readonly log: FinalizationRecoveryLog,
  ) {}

  recordRawOnBusy(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<boolean> {
    return this.record({ ...input, state: 'raw' });
  }

  recordVerified(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<boolean> {
    return this.record({ ...input, state: 'verified' });
  }

  async clear(msg: FinalizationMessageMsg, contextGraphId: string): Promise<void> {
    if (!this.journal) return;
    try {
      await this.journal.remove(finalizationRecoveryEntryKey({
        chainId: this.chain?.chainId ?? 'none',
        contextGraphId,
        ual: msg.ual,
        txHash: msg.txHash,
      }));
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal cleanup failed for ${msg.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async replayMatching(input: FinalizationRecoveryReplayInput): Promise<boolean> {
    if (!this.journal) return false;
    if (
      !this.chain?.getLatestMerkleRoot
      || !this.chain.getMerkleRootCount
      || !this.chain.getKAContextGraphId
    ) return false;

    let entries: FinalizationRecoveryEntry[];
    try {
      entries = await this.journal.forKnowledgeAsset(input);
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    let recoveredCurrentAssertion = false;
    for (const entry of entries) {
      if (
        entry.targetContextGraphId !== undefined
        && entry.targetContextGraphId !== input.onChainCgId
      ) continue;
      try {
        const assertionVersion = BigInt(entry.assertionVersion);
        const [latestRoot, rootCount, boundContextGraphId] = await Promise.all([
          this.chain.getLatestMerkleRoot(BigInt(entry.kaId)),
          this.chain.getMerkleRootCount(BigInt(entry.kaId)),
          this.chain.getKAContextGraphId(BigInt(entry.kaId)),
        ]);
        if (rootCount > assertionVersion) {
          await this.journal.remove(entry.key);
          this.log.info(
            `Finalization recovery discarded superseded assertion ${entry.assertionVersion} for ${entry.ual}`,
          );
          continue;
        }
        if (
          !equalBytes(latestRoot, ethers.getBytes(entry.merkleRoot))
          || !equalBytes(latestRoot, ethers.getBytes(input.merkleRoot))
          || rootCount !== assertionVersion
          || boundContextGraphId === null
          || boundContextGraphId === undefined
          || BigInt(boundContextGraphId).toString() !== input.onChainCgId
        ) continue;
      } catch (error) {
        this.log.info(
          `Finalization recovery chain state is not settled for ${entry.ual}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const existing = this.replaySingleFlights.get(entry.key);
      if (existing) {
        await existing;
      } else {
        const replay = this.apply(
          Buffer.from(entry.rawMessageBase64, 'base64'),
          entry.contextGraphId,
          entry.sourcePeerId,
        ).catch((error: unknown) => {
          if (!(error instanceof StoreSchedulerBusyError)) throw error;
          this.log.info(
            `Finalization recovery store remains busy for ${entry.ual}; keeping journal entry`,
          );
        }).finally(() => {
          if (this.replaySingleFlights.get(entry.key) === replay) {
            this.replaySingleFlights.delete(entry.key);
          }
        });
        this.replaySingleFlights.set(entry.key, replay);
        await replay;
      }
      const remaining = await this.journal.forKnowledgeAsset(input);
      if (!remaining.some((candidate) => candidate.key === entry.key)) {
        recoveredCurrentAssertion = true;
      }
    }
    return recoveredCurrentAssertion;
  }

  private async record(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
    state: FinalizationRecoveryTrust;
  }): Promise<boolean> {
    if (!this.journal) return false;
    const { candidate } = input;
    try {
      const persisted = await this.journal.upsert({
        state: input.state,
        chainId: this.chain?.chainId ?? 'none',
        contextGraphId: input.contextGraphId,
        ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
        ual: candidate.scope.ual,
        txHash: candidate.msg.txHash,
        assertionVersion: candidate.assertionVersion,
        merkleRoot: ethers.hexlify(candidate.msg.kcMerkleRoot),
        kaId: candidate.kaId.toString(),
        ...(candidate.msg.targetContextGraphId
          ? { targetContextGraphId: candidate.msg.targetContextGraphId }
          : {}),
        rawMessage: input.rawMessage,
      });
      if (!persisted) {
        this.log.warn(
          `Finalization recovery journal rejected ${candidate.scope.ual}; `
            + 'capacity, envelope limit, or conflicting identity-bound bytes',
        );
      }
      return persisted;
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal write failed for ${candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
