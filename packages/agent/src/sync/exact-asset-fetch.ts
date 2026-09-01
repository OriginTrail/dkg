// SPDX-License-Identifier: Apache-2.0

import { parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core';

import { packKnowledgeAssetIdFromIdentity } from '../ka-identity.js';
import { MAX_EXACT_SYNC_ASSETS } from './exact-assets.js';
import { runBoundedPreparedPeerTraversal } from './prepared-peer-traversal.js';

export const MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS = 5;

/**
 * Sync-admission priority of an exact asset fetch an OPERATOR asked for.
 *
 * Named rather than repeated as a literal because a second, automatic caller
 * now exists and the whole point of ADR-W2R-9 is that it sits BELOW this one:
 * two bare `1_000`s in different files would make that ordering invisible.
 */
export const EXACT_ASSET_FETCH_ADMISSION_PRIORITY = 1_000;

export type ContextGraphAssetFetchItemStatus =
  | 'already-present'
  | 'materialized'
  | 'fetched'
  | 'unresolved';

export interface ContextGraphAssetFetchItemResult {
  ual: string;
  kaId: string;
  status: ContextGraphAssetFetchItemStatus;
  /**
   * Block at which the on-chain version this item was judged against was read.
   *
   * The evidence has always carried it (`ExactAssetFetchEvidence.versionBlock`);
   * it was simply not reported. A caller acting on a chain EVENT needs it: the
   * pinned chain view resolves through a failover sequence that can land on an
   * endpoint lagging behind the event, and `already-present` from such a view
   * means "current as of a block before your event" — not "current". Without
   * this field that distinction is unobservable to the caller.
   */
  versionBlock: number;
}

export interface ContextGraphAssetFetchResult {
  contextGraphId: string;
  onChainId: string;
  status: 'current' | 'complete' | 'partial';
  requestedAssets: number;
  alreadyPresentAssets: number;
  materializedAssets: number;
  fetchedAssets: number;
  unresolvedAssets: number;
  networkAttempted: boolean;
  peerAttempts: number;
  items: ContextGraphAssetFetchItemResult[];
}

export class ContextGraphAssetFetchValidationError extends Error {
  readonly code = 'ContextGraphAssetFetchValidation';

  constructor(message: string) {
    super(message);
    this.name = 'ContextGraphAssetFetchValidationError';
  }
}

/**
 * Why an exact fetch refused to act, as a stable machine-readable value.
 *
 * An automatic caller has to tell "one endpoint was behind" (try again shortly)
 * apart from "the chain says this UAL is not that asset" (stop and be loud).
 * Both arrive as the same exception class with only a human-readable message,
 * so classifying by message text would be the only alternative — and would
 * break the first time a message is reworded.
 */
export type ContextGraphAssetFetchConflictCode =
  /** The UAL belongs to a different network than this node's chain. */
  | 'wrong-network'
  /** The KA is not registered to any on-chain Context Graph. */
  | 'not-registered'
  /** Not every configured endpoint answered the pinned version view. */
  | 'snapshot-unavailable'
  /** Registered, but with no committed Merkle root (`rootCount <= 0`). */
  | 'no-committed-version'
  /** The chain answered with a root/block/address this code cannot use. */
  | 'invalid-evidence'
  /** The assets' on-chain CG does not match the CG the caller named. */
  | 'binding-mismatch';

export class ContextGraphAssetFetchConflictError extends Error {
  /**
   * The classification, NOT the class name — `name` already carries that, and
   * a second copy of it was information-free. Nothing read the previous value.
   */
  readonly code: ContextGraphAssetFetchConflictCode;

  constructor(code: ContextGraphAssetFetchConflictCode, message: string) {
    super(message);
    this.name = 'ContextGraphAssetFetchConflictError';
    this.code = code;
  }
}

export class ExactAssetFetchLifecycleClosedError extends Error {
  constructor() {
    super('Exact asset fetch lifecycle is closed');
    this.name = 'ExactAssetFetchLifecycleClosedError';
  }
}

export interface ExactAssetChainSnapshot {
  latestRoot: string;
  rootCount: bigint;
  latestAuthor: string;
  latestPublisher: string;
  blockNumber: number;
}

export interface ExactAssetFetchEvidence {
  ual: string;
  kaId: bigint;
  batchId: bigint;
  onChainCgId: string;
  /** Coherent chain rootCount; this is the exact current assertion version. */
  assertionVersion: bigint;
  merkleRoot: Uint8Array;
  authorAddress: string;
  publisherAddress: string;
  versionBlock: number;
}

export type ExactAssetLocalState = 'present' | 'materialized' | 'missing';

export interface ExactAssetFetchDependencies {
  chainId: string;
  signal?: AbortSignal;
  isCurrent(): boolean;
  getKAContextGraphId(kaId: bigint, signal?: AbortSignal): Promise<bigint>;
  readKnowledgeAssetVersionSnapshot(
    kaId: bigint,
    signal?: AbortSignal,
  ): Promise<ExactAssetChainSnapshot | null>;
  verifyLocalContextGraph(onChainCgId: string): Promise<boolean>;
  inspectLocal(evidence: ExactAssetFetchEvidence): Promise<ExactAssetLocalState>;
  resolvePeerIds(): Promise<readonly string[]>;
  preparePeer(peerId: string): Promise<boolean>;
  fetchFromPeer(peerId: string, uals: readonly string[]): Promise<void>;
  flush(): Promise<void>;
  log(message: string): void;
}

interface ExactAssetRequest {
  ual: string;
  kaId: bigint;
}

function requireCurrent(deps: ExactAssetFetchDependencies): void {
  if (!deps.isCurrent()) {
    throw new ExactAssetFetchLifecycleClosedError();
  }
}

function bytes32FromHex(value: string, ual: string): Uint8Array {
  const hex = value.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ContextGraphAssetFetchConflictError(
      'invalid-evidence',
      `Knowledge Asset ${ual} has an invalid latest Merkle root`,
    );
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function normalizeRequestedPeerIds(peerIds: readonly string[] | undefined): string[] | undefined {
  if (peerIds === undefined) return undefined;
  if (!Array.isArray(peerIds) || peerIds.length === 0) {
    throw new ContextGraphAssetFetchValidationError(
      'peerIds must contain at least one peer when provided',
    );
  }
  if (peerIds.length > MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS) {
    throw new ContextGraphAssetFetchValidationError(
      `Exact asset fetch accepts at most ${MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS} peerIds`,
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawPeerId of peerIds) {
    if (typeof rawPeerId !== 'string' || rawPeerId.trim().length === 0) {
      throw new ContextGraphAssetFetchValidationError(
        'Every peerIds entry must be a non-empty string',
      );
    }
    const peerId = rawPeerId.trim();
    if (!seen.has(peerId)) {
      seen.add(peerId);
      normalized.push(peerId);
    }
  }
  return normalized;
}

function requireOrderedAssetRequests(
  value: unknown,
  chainId: string,
): ExactAssetRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXACT_SYNC_ASSETS) {
    throw new ContextGraphAssetFetchValidationError(
      `Exact VM sync requires 1-${MAX_EXACT_SYNC_ASSETS} valid KA UALs`,
    );
  }
  const requests: ExactAssetRequest[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      throw new ContextGraphAssetFetchValidationError(
        `Exact VM sync requires 1-${MAX_EXACT_SYNC_ASSETS} valid KA UALs`,
      );
    }
    let identity: ReturnType<typeof parseDeterministicKnowledgeAssetUal>;
    try {
      identity = parseDeterministicKnowledgeAssetUal(candidate);
    } catch {
      throw new ContextGraphAssetFetchValidationError(
        `Exact VM sync requires 1-${MAX_EXACT_SYNC_ASSETS} valid KA UALs`,
      );
    }
    if (identity.chainId !== chainId) {
      throw new ContextGraphAssetFetchConflictError(
        'wrong-network',
        `Knowledge Asset ${identity.ual} belongs to network ${identity.chainId}, not ${chainId}`,
      );
    }
    if (seen.has(identity.ual)) continue;
    seen.add(identity.ual);
    requests.push({
      ual: identity.ual,
      kaId: packKnowledgeAssetIdFromIdentity({
        agentAddress: identity.agentAddress,
        kaNumber: identity.kaNumber,
      }),
    });
  }
  return requests;
}

async function resolveEvidence(
  request: ExactAssetRequest,
  deps: ExactAssetFetchDependencies,
): Promise<ExactAssetFetchEvidence> {
  requireCurrent(deps);
  const { ual, kaId } = request;
  // These two reads are independent. Run them together for every requested KA.
  // The version fields themselves must come from the one coherent snapshot.
  const [rawOnChainCgId, snapshot] = await Promise.all([
    deps.getKAContextGraphId(kaId, deps.signal),
    deps.readKnowledgeAssetVersionSnapshot(kaId, deps.signal),
  ]);
  requireCurrent(deps);
  const onChainCgId = rawOnChainCgId.toString();
  if (onChainCgId === '0') {
    throw new ContextGraphAssetFetchConflictError(
      'not-registered',
      `Knowledge Asset ${ual} is not registered to a Context Graph`,
    );
  }
  if (!snapshot) {
    throw new ContextGraphAssetFetchConflictError(
      'snapshot-unavailable',
      `Knowledge Asset ${ual} has no coherent on-chain version snapshot`,
    );
  }
  if (snapshot.rootCount <= 0n) {
    throw new ContextGraphAssetFetchConflictError(
      'no-committed-version',
      `Knowledge Asset ${ual} has no committed on-chain version`,
    );
  }
  if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0) {
    throw new ContextGraphAssetFetchConflictError(
      'invalid-evidence',
      `Knowledge Asset ${ual} has an invalid version block`,
    );
  }
  if (typeof snapshot.latestPublisher !== 'string' || snapshot.latestPublisher.length === 0) {
    throw new ContextGraphAssetFetchConflictError(
      'invalid-evidence',
      `Knowledge Asset ${ual} has no latest publisher on-chain`,
    );
  }
  if (typeof snapshot.latestAuthor !== 'string' || snapshot.latestAuthor.length === 0) {
    throw new ContextGraphAssetFetchConflictError(
      'invalid-evidence',
      `Knowledge Asset ${ual} has no latest author on-chain`,
    );
  }
  return {
    ual,
    kaId,
    // The V10 exact-fetch chain inventory uses one packed KA per batch.
    // Keep this identity explicit so reconciliation never invents it later.
    batchId: kaId,
    onChainCgId,
    assertionVersion: snapshot.rootCount,
    merkleRoot: bytes32FromHex(snapshot.latestRoot, ual),
    authorAddress: snapshot.latestAuthor,
    publisherAddress: snapshot.latestPublisher,
    versionBlock: snapshot.blockNumber,
  };
}

/**
 * Fetch and materialize a small exact-UAL set without changing a graph watermark.
 * The host supplies lifecycle, chain, local-state, and peer operations through a
 * narrow boundary. This function owns ordering, evidence, and fallback policy.
 */
export async function runExactAssetFetch(
  input: {
    contextGraphId: string;
    requestedUals: readonly string[];
    peerIds?: readonly string[];
    expectedOnChainId?: string;
  },
  deps: ExactAssetFetchDependencies,
): Promise<ContextGraphAssetFetchResult> {
  const requests = requireOrderedAssetRequests(input.requestedUals, deps.chainId);
  const uals = requests.map((request) => request.ual);
  const requestedPeerIds = normalizeRequestedPeerIds(input.peerIds);
  requireCurrent(deps);

  // Promise.all preserves request order while allowing all bounded evidence
  // reads to overlap. The request limit is ten assets.
  const evidence = await Promise.all(requests.map((request) => resolveEvidence(request, deps)));
  requireCurrent(deps);
  const onChainId = evidence[0]!.onChainCgId;
  if (evidence.some((item) => item.onChainCgId !== onChainId)) {
    throw new ContextGraphAssetFetchConflictError(
      'binding-mismatch',
      'All requested Knowledge Assets must belong to the same on-chain Context Graph',
    );
  }
  if (input.expectedOnChainId && input.expectedOnChainId !== onChainId) {
    throw new ContextGraphAssetFetchConflictError(
      'binding-mismatch',
      `Requested assets belong to on-chain Context Graph ${onChainId}, `
        + `not the node's bound Context Graph ${input.expectedOnChainId}`,
    );
  }
  // All items share one chain CG, so prove the local binding once.
  if (!(await deps.verifyLocalContextGraph(onChainId))) {
    throw new ContextGraphAssetFetchConflictError(
      'binding-mismatch',
      `Local Context Graph "${input.contextGraphId}" does not match on-chain Context Graph ${onChainId}`,
    );
  }
  requireCurrent(deps);

  const itemResults = new Map<string, ContextGraphAssetFetchItemResult>();
  let remaining = new Map<string, ExactAssetFetchEvidence>();
  for (const item of evidence) {
    requireCurrent(deps);
    const state = await deps.inspectLocal(item);
    if (state === 'present') {
      itemResults.set(item.ual, {
        ual: item.ual,
        kaId: item.kaId.toString(),
        status: 'already-present',
        versionBlock: item.versionBlock,
      });
    } else if (state === 'materialized') {
      itemResults.set(item.ual, {
        ual: item.ual,
        kaId: item.kaId.toString(),
        status: 'materialized',
        versionBlock: item.versionBlock,
      });
    } else {
      remaining.set(item.ual, item);
    }
  }

  const candidates = requestedPeerIds ?? (
    remaining.size === 0 ? [] : await deps.resolvePeerIds()
  );
  requireCurrent(deps);
  const traversal = await runBoundedPreparedPeerTraversal({
    candidatePeerIds: candidates,
    maxPeers: MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS,
    operationLabel: 'Exact asset fetch from',
    assertCurrent: () => requireCurrent(deps),
    preparePeer: deps.preparePeer,
    attemptPeer: async (peerId) => {
      let failure: unknown;
      try {
        await deps.fetchFromPeer(peerId, [...remaining.keys()]);
      } catch (error) {
        failure = error;
      }
      requireCurrent(deps);

      // A peer fetch is not transactional. It can persist a strict prefix before
      // it rejects, so inspect durable local state after every started attempt.
      // Retain the rejection only as a diagnostic and continue failover with the
      // exact unresolved suffix.
      const nextRemaining = new Map<string, ExactAssetFetchEvidence>();
      for (const item of remaining.values()) {
        requireCurrent(deps);
        const state = await deps.inspectLocal(item);
        if (state === 'present' || state === 'materialized') {
          itemResults.set(item.ual, {
            ual: item.ual,
            kaId: item.kaId.toString(),
            status: 'fetched',
            versionBlock: item.versionBlock,
          });
        } else {
          nextRemaining.set(item.ual, item);
        }
      }
      remaining = nextRemaining;
      if (remaining.size === 0) {
        return failure === undefined
          ? { kind: 'done' as const }
          : { kind: 'done' as const, diagnostic: failure };
      }
      return failure === undefined
        ? { kind: 'continue' as const }
        : { kind: 'continue' as const, error: failure };
    },
    log: deps.log,
  });
  const peerAttempts = traversal.peerAttempts;

  for (const item of remaining.values()) {
    itemResults.set(item.ual, {
      ual: item.ual,
      kaId: item.kaId.toString(),
      status: 'unresolved',
      versionBlock: item.versionBlock,
    });
  }
  const items = uals.map((ual) => itemResults.get(ual)!);
  const alreadyPresentAssets = items.filter((item) => item.status === 'already-present').length;
  const materializedAssets = items.filter((item) => item.status === 'materialized').length;
  const fetchedAssets = items.filter((item) => item.status === 'fetched').length;
  const unresolvedAssets = items.filter((item) => item.status === 'unresolved').length;
  if (materializedAssets + fetchedAssets > 0) {
    requireCurrent(deps);
    await deps.flush();
    requireCurrent(deps);
  }
  return {
    contextGraphId: input.contextGraphId,
    onChainId,
    status: unresolvedAssets > 0
      ? 'partial'
      : materializedAssets + fetchedAssets > 0
        ? 'complete'
        : 'current',
    requestedAssets: items.length,
    alreadyPresentAssets,
    materializedAssets,
    fetchedAssets,
    unresolvedAssets,
    networkAttempted: peerAttempts > 0,
    peerAttempts,
    items,
  };
}
