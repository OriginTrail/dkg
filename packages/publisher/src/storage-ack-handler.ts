import {
  GraphManager,
  loadSelectedSharedMemoryQuads,
  tryReplaceGraphAtomically,
  type SharedMemoryReadSelection,
  type TripleStore,
  type Quad,
  type QueryOptions,
  type StorePressureSnapshot,
} from '@origintrail-official/dkg-storage';
import type {
  EventBus,
  PublishIntentMsg,
  StorageACKDeclineCode,
  StorageACKMsg,
  SubscriptionSource,
  UpdateIntentMsg,
} from '@origintrail-official/dkg-core';
import {
  Logger,
  createOperationContext,
  decodePublishIntent,
  decodeUpdateIntent,
  encodeStorageACK,
  decodeStorageACK,
  isStorageACKDecline,
  withSpan,
  getMetrics,
  computePublishACKDigest,
  computeUpdateACKDigest,
  assertSafeIri,
  assertSafeRdfTerm,
  STORAGE_ACK_DECLINE_CODES,
  DEFAULT_SEND_TIMEOUT_MS,
  boundedDeclineCodeLabel,
  computeCatalogRoot,
  catalogCommittedLeaves,
  contextGraphCatalogUri,
  isSwmMerkleExcludedQuad,
  STORAGE_ACK_MAX_STAGING_BYTES,
  createGraphKnowledgeAssetScope,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';
import { replaceCatalogQuads } from './catalog-persistence.js';
import { generateKnowledgeAssetShareMetadata } from './metadata.js';
import { storeKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';
import { validateKnowledgeAssetPublishRequest } from './validation.js';
import { ethers } from 'ethers';

type PeerId = { toString(): string };

type GraphScopedPublishIntent = {
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
  subGraphName?: string;
};

function resolveGraphScopedPublishIntent(
  intent: PublishIntentMsg,
): GraphScopedPublishIntent | undefined {
  const privateMerkleRoot = intent.privateMerkleRoot?.length
    ? new Uint8Array(intent.privateMerkleRoot)
    : undefined;
  const hasGraphField =
    (intent.contentScopeVersion ?? 0) !== 0
    || Boolean(intent.kaUal)
    || Boolean(intent.assertionVersion)
    || (intent.publicTripleCount ?? 0) > 0
    || privateMerkleRoot !== undefined
    || (intent.privateTripleCount ?? 0) > 0;
  if (!hasGraphField) return undefined;
  if (intent.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(
      `StorageACK: graph-scoped publish requires contentScopeVersion=${GRAPH_KA_CONTENT_SCOPE_VERSION}`,
    );
  }
  if (!intent.kaUal || !intent.assertionVersion) {
    throw new Error('StorageACK: graph-scoped publish requires kaUal and assertionVersion');
  }
  if ((intent.rootEntities?.length ?? 0) !== 0 || (intent.privateMerkleRoots?.length ?? 0) !== 0) {
    throw new Error('StorageACK: graph-scoped publish must not carry legacy root commitments');
  }
  const publicTripleCount = intent.publicTripleCount ?? 0;
  const privateTripleCount = intent.privateTripleCount ?? 0;
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
    || (privateTripleCount > 0 && privateMerkleRoot?.length !== 32)
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) {
    throw new Error('StorageACK: graph-scoped publish has an invalid content envelope');
  }
  const scope = createGraphKnowledgeAssetScope(intent.kaUal, intent.assertionVersion);
  if (scope.ual !== intent.kaUal || scope.assertionVersion !== '1') {
    throw new Error('StorageACK: graph-scoped publish requires a canonical version-1 UAL');
  }
  const accessPolicy = intent.accessPolicy;
  const rawAllowedPeers = intent.allowedPeers ?? [];
  const allowedPeers = [...new Set(rawAllowedPeers.map((peer) => peer.trim()).filter(Boolean))];
  if (
    (accessPolicy !== 'public' && accessPolicy !== 'ownerOnly' && accessPolicy !== 'allowList')
    || allowedPeers.length !== rawAllowedPeers.length
    || (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new Error('StorageACK: graph-scoped publish has an invalid access envelope');
  }
  const subGraphName = intent.subGraphName || undefined;
  if (subGraphName) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) {
      throw new Error(`StorageACK: invalid graph-scoped subGraphName: ${validation.reason}`);
    }
  }
  return {
    scope,
    publicTripleCount,
    privateTripleCount,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    accessPolicy,
    allowedPeers,
    ...(subGraphName ? { subGraphName } : {}),
  };
}

type GraphScopedUpdateIntent = {
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  subGraphName?: string;
};

function updateIntentUint64(value: number | { low: number; high: number }): bigint {
  return typeof value === 'number'
    ? BigInt(value)
    : BigInt(value.low >>> 0) | (BigInt(value.high >>> 0) << 32n);
}

function resolveGraphScopedUpdateIntent(
  intent: UpdateIntentMsg,
): GraphScopedUpdateIntent | undefined {
  const privateMerkleRoot = intent.privateMerkleRoot?.length
    ? new Uint8Array(intent.privateMerkleRoot)
    : undefined;
  const hasGraphField =
    (intent.contentScopeVersion ?? 0) !== 0
    || Boolean(intent.kaUal)
    || Boolean(intent.assertionVersion)
    || (intent.publicTripleCount ?? 0) > 0
    || privateMerkleRoot !== undefined
    || (intent.privateTripleCount ?? 0) > 0;
  if (!hasGraphField) return undefined;
  if (intent.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(
      `UpdateStorageACK: graph-scoped update requires contentScopeVersion=${GRAPH_KA_CONTENT_SCOPE_VERSION}`,
    );
  }
  if (!intent.kaUal || !intent.assertionVersion) {
    throw new Error('UpdateStorageACK: graph-scoped update requires kaUal and assertionVersion');
  }
  const publicTripleCount = intent.publicTripleCount ?? 0;
  const privateTripleCount = intent.privateTripleCount ?? 0;
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
    || (privateTripleCount > 0 && privateMerkleRoot?.length !== 32)
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) {
    throw new Error('UpdateStorageACK: invalid graph-scoped content envelope');
  }
  const scope = createGraphKnowledgeAssetScope(intent.kaUal, intent.assertionVersion);
  if (scope.ual !== intent.kaUal) {
    throw new Error('UpdateStorageACK: graph-scoped kaUal is not canonical');
  }
  const kaId = BigInt(intent.kaId);
  const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (packedKaId !== kaId) {
    throw new Error(
      `UpdateStorageACK: UAL-derived kaId ${packedKaId} does not match intent kaId ${kaId}`,
    );
  }
  const expectedAssertionVersion = updateIntentUint64(intent.preUpdateMerkleRootCount) + 1n;
  if (BigInt(scope.assertionVersion) !== expectedAssertionVersion) {
    throw new Error(
      `UpdateStorageACK: assertionVersion ${scope.assertionVersion} must equal ` +
        `preUpdateMerkleRootCount + 1 (${expectedAssertionVersion})`,
    );
  }
  const subGraphName = intent.subGraphName || undefined;
  if (subGraphName) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) {
      throw new Error(
        `UpdateStorageACK: invalid graph-scoped subGraphName: ${validation.reason}`,
      );
    }
  }
  return {
    scope,
    publicTripleCount,
    privateTripleCount,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    ...(subGraphName ? { subGraphName } : {}),
  };
}

export interface StorageAckDecision {
  encoded: Uint8Array;
  ack: StorageACKMsg;
  intent?: PublishIntentMsg;
  peerId: string;
}

export type StorageAckDecisionObserver = (decision: StorageAckDecision) => void | Promise<void>;

/**
 * Validate that every term of a parsed quad is well-formed BEFORE it enters the
 * store-op wrapper. A malformed term is a bad request (the publisher committed
 * garbage into its merkle root), not a peer-local store outage — so it must
 * throw here (→ malformed-request stream reset) rather than surface from
 * `store.insert` and be mislabeled as a transient CORE_TEMPORARILY_UNAVAILABLE
 * decline that the publisher then retries against its transient budget.
 *
 * Mirrors `parseSimpleNQuads`' own literal-vs-IRI split: subject/predicate are
 * IRIs or blank nodes (angle brackets already stripped); the object is a full
 * SPARQL literal (kept with its quotes) OR a stripped IRI/blank node. `graph`
 * is set by the caller to an already-`assertSafeIri`'d URI. `assertSafeIri`
 * only rejects the SPARQL-breaking character set (`<>"{}|\^`, controls,
 * whitespace), which is a strict subset of what the store itself rejects — so
 * this never turns a store-acceptable term into a false malformed-request.
 */
function assertPersistQuadTermsSafe(quads: Quad[]): void {
  for (const q of quads) {
    assertSafeIri(q.subject);
    assertSafeIri(q.predicate);
    if (q.object.startsWith('"')) {
      assertSafeRdfTerm(q.object);
    } else {
      assertSafeIri(q.object);
    }
  }
}

const MAX_DECLINE_ENTITY_COUNT = 5;
const MAX_DECLINE_ENTITY_CHARS = 120;
const MAX_DECLINE_LOG_CG_ID_CHARS = 160;
const MAX_DECLINE_LOG_MESSAGE_CHARS = 240;
function compactDeclineText(value: string, maxChars: number): string {
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

/** Public publishes omit the catalog root; protobuf decodes that as `bytes` length 0, not absent. */
function catalogRootForAckDigest(root: Uint8Array | undefined): Uint8Array {
  if (!root || root.length === 0) {
    return new Uint8Array(32);
  }
  if (root.length !== 32) {
    throw new Error(`catalogRoot must be 32 bytes, got ${root.length}`);
  }
  return root;
}

function normalizePrivateMerkleRoots(
  roots: readonly Uint8Array[] | undefined,
): Uint8Array[] {
  if (!roots || roots.length === 0) return [];
  return roots.map((root, idx) => {
    const bytes = root instanceof Uint8Array ? root : new Uint8Array(root);
    if (bytes.length !== 32) {
      throw new Error(
        `StorageACK: privateMerkleRoots[${idx}] must be 32 bytes, got ${bytes.length}`,
      );
    }
    return bytes;
  });
}

function summarizeDeclineEntities(entities: readonly string[]): string {
  if (entities.length === 0) return '(none)';
  const visible = entities
    .slice(0, MAX_DECLINE_ENTITY_COUNT)
    .map((entity) => compactDeclineText(entity, MAX_DECLINE_ENTITY_CHARS));
  const remaining = entities.length - visible.length;
  return remaining > 0
    ? `${visible.join(', ')} (+${remaining} more)`
    : visible.join(', ');
}

/**
 * Module-private marker for "a triple-store operation failed mid-ACK".
 * `loadSWMQuads` raises this ONLY around the storage loader's store/index reads so the
 * handler's catch sites can tell a peer-local store outage (→ transient
 * `CORE_TEMPORARILY_UNAVAILABLE` decline) apart from the
 * `assertSafeIri` malformed-request throws inside the same function,
 * which MUST keep resetting the stream per the decline-vocabulary
 * contract in `packages/core/src/proto/storage-ack.ts` ("malformed-
 * request errors are NOT declines"). A blanket try/catch around the
 * whole `loadSWMQuads` call would demote an IRI-injection attempt into
 * a retryable decline and hand the publisher 6 pointless retries.
 */
class StoreUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StoreUnavailableError';
    this.cause = cause;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

class ACKHandlerDeadlineAbortError extends Error {
  constructor(deadlineMs: number, storePressure: string) {
    super(`ACK handler exceeded ${deadlineMs}ms (store slow / saturated; ${storePressure})`);
    this.name = 'ACKHandlerDeadlineAbortError';
  }
}

function isACKHandlerDeadlineAbort(err: unknown): boolean {
  if (err instanceof ACKHandlerDeadlineAbortError) return true;
  if (err instanceof StoreUnavailableError) return isACKHandlerDeadlineAbort(err.cause);
  return false;
}

function isACKHandlerDeadlineAbortSignal(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted && isACKHandlerDeadlineAbort(signal.reason));
}

async function runWithDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onDeadline: () => T,
): Promise<T> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let settled = false;
  const trackedWork = work.finally(() => {
    settled = true;
  });
  const deadline = new Promise<T>((resolve) => {
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      resolve(onDeadline());
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  });

  try {
    const result = await Promise.race([trackedWork, deadline]);
    if (timedOut) void work.catch(() => undefined);
    return result;
  } finally {
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function ackStoreOptions(source: string, signal?: AbortSignal): QueryOptions {
  return { priority: 'ack', source, ...(signal ? { signal } : {}) };
}

function formatStorePressureSnapshot(snapshot: StorePressureSnapshot | undefined): string {
  if (!snapshot) return 'storePressure=unavailable';
  return `ackInflight=${snapshot.ackInflight} ackQueued=${snapshot.ackQueued} ` +
    `normalQueued=${snapshot.normalQueued} backgroundQueued=${snapshot.backgroundQueued}`;
}

export interface StorageACKHandlerConfig {
  nodeRole: 'core' | 'edge';
  nodeIdentityId: bigint;
  signerWallet: ethers.Wallet;
  /**
   * Resolves the SWM graph URI for a given (sourceGraphId, subGraphName).
   * Accepts an optional `subGraphName` so the handler can locate data
   * stored under `.../<cgId>/<subGraphName>/_shared_memory` when the
   * publisher is writing into a sub-graph partition.
   */
  contextGraphSharedMemoryUri: (cgId: string, subGraphName?: string) => string;
  /**
   * Numeric EVM chain id (e.g. 31337n for hardhat). Part of the H5 prefix
   * on the V10 ACK digest — without this the signature will not match the
   * publisher's or the on-chain contract's expectation.
   */
  chainId: bigint;
  /**
   * Deployed address of `KnowledgeAssetsV10` on the handler's chain. Part
   * of the H5 prefix on the V10 ACK digest.
   */
  kav10Address: string;
  /**
   * Optional live confirmation hook. When provided, the handler calls it
   * immediately before signing so removed/unregistered operational keys stop
   * producing ACKs without needing a process restart.
   */
  isSignerRegistered?: () => Promise<boolean>;
  /**
   * Called when the live confirmation hook reports the signer is no longer
   * registered. Agents can use this to stop advertising StorageACK support.
   */
  onSignerUnregistered?: () => void | Promise<void>;
  /**
   * Called when the live confirmation hook itself fails. Lookup errors are
   * signing blockers because ACKs must only be produced by keys confirmed
   * registered on-chain at signing time.
   */
  onSignerRegistrationLookupFailed?: (err: unknown) => void | Promise<void>;
  /**
   * Called whenever the handler returns a typed StorageACK decline. The hook
   * receives bounded, log-safe text; the wire decline message is encoded
   * unchanged below so publisher-visible behavior stays stable.
   */
  onDecline?: (details: {
    code: StorageACKDeclineCode;
    contextGraphId: string;
    message: string;
  }) => void | Promise<void>;
  /** Optional observer for log/telemetry work after the protocol decision exists. */
  onStorageAckDecision?: StorageAckDecisionObserver;
  /**
   * Codex PR #608: independent curation oracle. The handler MUST verify a
   * publisher's `isEncryptedPayload=true` claim against the CG's real
   * access policy before signing — without this, a malicious publisher
   * could set the encrypted bit on a PUBLIC CG and have the core sign an
   * ACK over whatever `merkleRoot`/`merkleLeafCount` it claimed
   * (cores skip plaintext verification on the encrypted path because they
   * can't decrypt). Return `true` only when the CG is curated (private /
   * invite-only / allowlisted). Return `false` for public CGs and `null`
   * for "cannot determine locally" — the handler treats both as
   * "publisher must use the non-encrypted path".
   *
   * When omitted, the handler defaults to fail-closed: encrypted-payload
   * publishes are rejected wholesale (operators wiring a core without
   * curated-CG support shouldn't be tricked into signing for them).
   *
   * Inputs:
   *   - `cgId`: numeric on-chain id used in the V10 ACK digest
   *   - `swmGraphId`: cleartext CG id (may equal `cgId`); the publisher
   *     sends this for curated publishes so the core can resolve the
   *     local access-policy record without a chain RPC.
   */
  isCgCurated?: (cgId: string, swmGraphId?: string) => Promise<boolean | null>;
  /**
   * Codex PR #608 R1 #2 — publish-finalization callback. Called immediately
   * AFTER the handler has persisted the encrypted-payload staging graph
   * and signed an ACK, with the `(stagingGraphUri, cgId, merkleRoot)`
   * triple. The agent (which owns the chain-event subscriber) is expected
   * to register the staging-graph URI against the (cgId, merkleRoot) key
   * and drop it when the V10 publish finalizes (success or permanent
   * failure).
   *
   * The handler ALSO arms a long-window safety-net timer (default 60 min)
   * as a fallback for nodes without finalization hooks wired. The
   * safety net is configurable via `encryptedStagingSafetyNetMs`; agents
   * that wire a real finalization hook can set this to `Infinity` to
   * disable the timer entirely.
   *
   * Optional: handlers without this hook continue to rely on the
   * safety-net timer (current behaviour).
   */
  onEncryptedStagingPersisted?: (info: {
    stagingGraphUri: string;
    cgId: string;
    merkleRoot: Uint8Array;
  }) => void | Promise<void>;
  /**
   * Codex PR #608 R1 #2 — safety-net cleanup window for encrypted staging
   * graphs (default 60 * 60 * 1000 = 60 min). Set to `Infinity` to disable
   * timer-based cleanup entirely when a finalization hook is wired.
   */
  encryptedStagingSafetyNetMs?: number;
  /**
   * PR5 — ACK-provenance hook. When wired, called immediately before
   * signing a StorageACK to look up which of the four LU-6 Phase B
   * discovery paths (chain-event / beacon / reconciler / manual) or
   * member-mode caused this core to be hosting the CG. The returned
   * value is populated into `StorageACKMsg.subscriptionSource` so the
   * publisher can emit a per-publish ACK-provenance summary line and
   * surface the same data through `QuorumUnmetError.peerOutcomes`
   * when ACK collection fails.
   *
   * Returning `undefined` is honest and additive — the wire field
   * stays absent and consumers render "source unknown". Callers
   * SHOULD bind this to `DKGAgent.getSwmSubscriptionSource` (which
   * accepts multiple candidate ids and is path-shape aware) rather
   * than implementing it ad-hoc. Optional: handlers that don't wire
   * this just emit ACKs without the provenance field (legacy shape).
   *
   * The candidate ids are: numeric on-chain `cgId`, cleartext
   * `swmGraphId`, and the SWM gossip topic the publisher derived
   * for the ACK request. Resolvers should try each in turn.
   */
  getSubscriptionSourceForCg?: (
    cgId: string,
    swmGraphId?: string,
    gossipTopic?: string,
  ) => SubscriptionSource | undefined;
  /**
   * Codex review on PR #715: the per-CG named graph that backs the
   * LU-11 ciphertext chunk store MUST use a CANONICAL form of the CG
   * id so that publishers (writing `envelope.contextGraphId` from
   * their gossip envelope) and cores (looking up by `swmGraphId` from
   * the V2 ACK request) land on the same graph URI. Without
   * canonicalization, the cleartext-vs-wire-hash mismatch causes
   * lookups to miss and forces a `GRAPH ?g` wildcard scan, which in
   * turn exposes the multi-CG identical-KC collision the bot called
   * out on `ciphertext-chunk-store.ts`.
   *
   * The agent wires this to `DKGAgent.canonicalChunkStoreCgIdOrNull`
   * (which routes 0x-hex, cleartext, and decimal-numeric ids through
   * the local subscription map). Returning `null` is honest:
   * "I can't safely canonicalize this id — please degrade to the
   * legacy `GRAPH ?g` wildcard scan for this lookup." Codex review
   * (round 2) on PR #727: the previous shape forced a
   * `gossipWireIdFor(cgId)` even for decimal-numeric ids, which
   * keccak'd "42" as a literal string and missed every persisted
   * chunk — required for ACK V2 robustness when
   * `PublishIntent.swmGraphId` is absent.
   *
   * Optional: handlers without this hook continue to use the raw
   * `swmGraphId` as the graph key, which preserves the legacy
   * (pre-fix) behaviour for any caller that doesn't yet expose a
   * normalizer.
   */
  normalizeContextGraphIdForChunkStore?: (cgId: string) => string | null;
  /**
   * Test-only knob to shrink the V2 chunked-ACK local-wait retry
   * budget (default 20 retries × 500ms = 10s). The defaults exist so
   * the SWM ingest can finish persisting chunks before the ACK
   * lookup runs on freshly-subscribed cores; production callers
   * MUST NOT override this. Tests that exercise the deterministic
   * MISSING_CIPHERTEXT_CHUNKS decline path use it to keep CI fast
   * without changing the production behaviour pin.
   *
   * Codex review on PR #738: the prior MISSING_CHUNKS regression
   * burned the full ~10s retry budget on every run. The injection
   * point is intentionally narrow — only `maxRetries` and
   * `delayMs` are tunable; the loop structure is unchanged.
   */
  _v2ChunkLookupRetryPolicyForTests?: {
    maxRetries: number;
    delayMs: number;
  };
  /**
   * Wall-clock deadline for a single ACK-handler invocation. If the handler's
   * store work has not produced a reply within this budget, the handler
   * returns a `CORE_TEMPORARILY_UNAVAILABLE` decline instead of dead-airing
   * the stream. The publisher's per-send timeout is 20s
   * (`DEFAULT_SEND_TIMEOUT_MS`), so the default here is deliberately BELOW it
   * (15s) — a slow store (e.g. under a sync storm) then hands the publisher an
   * actionable transient decline that engages its retry-with-backoff ladder,
   * rather than a timeout the publisher can only read as a dead peer
   * (2026-07-07 Gnosis mainnet: cores whose Blazegraph was saturated dead-aired
   * past 20s and every round burned as TRANSPORT_ERROR / mislabeled
   * INVALID_SIGNATURE). Set to 0 to disable the deadline. Tests override it.
   */
  ackHandlerDeadlineMs?: number;
  /**
   * Optional store-pressure diagnostic provider for ACK deadline declines.
   * Agents may inject a store-owned or wrapper-owned snapshot here; otherwise
   * the handler asks the supplied TripleStore for its optional pressure
   * capability. The handler deliberately does not read any storage adapter's
   * process-global scheduler directly.
   */
  getStorePressure?: () => StorePressureSnapshot | undefined;
}

/**
 * Safety margin between the ACK-handler deadline and the publisher's per-send
 * timeout: the budget left for the decline to be encoded, written to the
 * stream, and read by the publisher before it gives up on the send. Without
 * it the deadline decline would race the publisher's own timeout and lose.
 */
export const ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS = 5_000;

/**
 * Default ACK-handler deadline — DERIVED from the publisher's per-send timeout
 * ({@link DEFAULT_SEND_TIMEOUT_MS}, 20s) minus
 * {@link ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS} (5s) = 15s, so the
 * "decline must reach the publisher before it gives up" invariant is
 * compile-time coupled to the send timeout instead of restated as a bare
 * literal that could silently drift.
 */
export const DEFAULT_ACK_HANDLER_DEADLINE_MS =
  DEFAULT_SEND_TIMEOUT_MS - ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS;

/**
 * StorageACKHandler implements the core node side of V10 spec §9.0 Phase 3.
 *
 * When a publisher broadcasts a PublishIntent:
 * 1. Verify this node is a core node
 * 2. Verify the data exists in SWM
 * 3. Recompute the merkle root from SWM triples
 * 4. Sign ACK = EIP-191(computePublishACKDigest(chainId, kav10Address, cgId,
 *    merkleRoot, kaCount, byteSize, epochs, tokenAmount, merkleLeafCount)) —
 *    the H5-prefixed digest. Matches `KnowledgeAssetsV10._executePublishCore`.
 * 5. Return StorageACK via the P2P stream response
 */
export class StorageACKHandler {
  private store: TripleStore;
  private readonly graphManager: GraphManager;
  private config: StorageACKHandlerConfig;
  private eventBus: EventBus;
  private readonly log = new Logger('StorageACKHandler');

  constructor(store: TripleStore, config: StorageACKHandlerConfig, eventBus: EventBus) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.config = config;
    this.eventBus = eventBus;
  }

  private getStorePressureSnapshot(): StorePressureSnapshot | undefined {
    try {
      return this.config.getStorePressure?.() ?? this.store.getPressureSnapshot?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Encode a structured decline response. Used in place of `throw` for
   * the subset of failures that represent "I as a core legitimately
   * cannot ACK this request right now" — currently SWM-side cases
   * that present as "data missing" or "data stale" to the publisher.
   *
   * The publisher's collector treats declines as **permanent for this
   * request** and surfaces the per-peer reason in the final error if
   * quorum fails. Throwing instead would close the libp2p stream as a
   * reset, which the publisher only sees as a generic IO error and
   * retries 3× against the same peer before giving up.
   *
   * Old senders never produce these fields and old receivers ignore
   * them, so adding declines is a strictly additive wire change — see
   * `packages/core/src/proto/storage-ack.ts` for the schema rationale.
   */
  private encodeDecline(
    cgId: string,
    code: StorageACKDeclineCode,
    message: string,
    // `hookMessage` (optional) feeds ONLY the local `onDecline` log hook
    // while `message` rides the wire. Used by the transient-unavailable
    // path so the operator's WARN line carries the real store/RPC error
    // but the remote publisher only sees a short sanitized reason —
    // internal error strings (paths, worker state) stay off the network.
    options: { hookMessage?: string } = {},
  ): Uint8Array {
    getMetrics().storageAckDeclinesTotal?.add(1, {
      reason: boundedDeclineCodeLabel(code),
    });
    if (this.config.onDecline) {
      const details = {
        code,
        contextGraphId: compactDeclineText(cgId, MAX_DECLINE_LOG_CG_ID_CHARS),
        message: compactDeclineText(options.hookMessage ?? message, MAX_DECLINE_LOG_MESSAGE_CHARS),
      };
      try {
        void Promise.resolve(this.config.onDecline(details)).catch(() => undefined);
      } catch {
        // Logging must never change ACK wire behavior.
      }
    }
    return encodeStorageACK({
      merkleRoot: new Uint8Array(0),
      coreNodeSignatureR: new Uint8Array(0),
      coreNodeSignatureVS: new Uint8Array(0),
      contextGraphId: cgId,
      nodeIdentityId: 0,
      declineCode: code,
      declineMessage: message,
    });
  }

  private buildStorageAckDecision(
    intent: PublishIntentMsg | undefined,
    encoded: Uint8Array,
    peerId: PeerId,
  ): StorageAckDecision {
    const ack = decodeStorageACK(encoded);
    return {
      encoded,
      ack,
      intent,
      peerId: peerId.toString(),
    };
  }

  private async observeStorageAckDecision(decision: StorageAckDecision): Promise<void> {
    if (!this.config.onStorageAckDecision) return;
    try {
      await this.config.onStorageAckDecision(decision);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('share'),
        `StorageACK decision observer failed: ${compactDeclineText(reason, MAX_DECLINE_LOG_MESSAGE_CHARS)}`,
      );
    }
  }

  /**
   * Transient peer-local failure → `CORE_TEMPORARILY_UNAVAILABLE`
   * decline (testnet dead-air fix). Before this, a thrown store op or
   * signer-lookup error escaped the handler and ProtocolRouter aborted
   * the inbound stream with NO reply — the publisher burned its 3
   * transport retries and recorded the peer as `no_response` (live
   * incident: 7 cores dialled, 21 attempts, ALL `no_response`,
   * 0 declines). An in-band transient decline instead (a) tells the
   * publisher WHY, and (b) keeps this core in the quorum pool on the
   * transient retry cadence — the store worker / RPC usually recovers
   * within seconds.
   *
   * `wireMessage` must be SHORT + generic (it goes to an untrusted
   * remote peer); the raw `cause` message only reaches the local
   * `onDecline` WARN hook.
   */
  private declineTemporarilyUnavailable(
    cgId: string,
    wireMessage: string,
    cause: unknown,
  ): Uint8Array {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    return this.encodeDecline(
      cgId,
      STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      wireMessage,
      { hookMessage: `${wireMessage}: ${causeMsg}` },
    );
  }

  /**
   * Centralized "run a store/signer op, or return the transient decline".
   *
   * Why this exists (otReviewAgent #1408, storage-ack-handler.ts:649): the
   * testnet dead-air fix scattered the SAME catch-and-decline pattern across
   * six store sites and three signer sites in this 1.5k-line handler. Every
   * copy has to (a) reply with `CORE_TEMPORARILY_UNAVAILABLE`, (b) keep the
   * raw error off the wire while feeding it to the local hook, and (c) NOT
   * swallow the `assertSafeIri` malformed-request throws (those must reset
   * the stream per the decline-vocabulary contract). One inconsistent copy on
   * a future ACK path silently reintroduces the dead-air bug OR demotes a
   * malformed-request into a retryable decline. The helpers below are the
   * ONLY place that pattern lives now; the publish + update handlers call
   * them and get a discriminated result they must narrow before proceeding.
   *
   * CONTRACT — what stays OUTSIDE these wrappers:
   *   - `assertSafeIri(...)` on graph/entity IRIs. An unsafe IRI is a
   *     malformed request (stream reset), NOT a store outage; callers run it
   *     before invoking the persist helpers so an IRI-injection attempt still
   *     throws and resets rather than being demoted to a transient decline.
   *   - `parseSimpleNQuads` / merkle / catalog verification. Only the actual
   *     `store.*` calls (and `loadSWMQuads`, whose internal `store.query`
   *     is tagged `StoreUnavailableError`) run inside the wrapper.
   *
   * On failure the result carries the pre-encoded `declineTemporarilyUnavailable`
   * bytes (wire msg 'store unavailable', raw cause only to `onDecline`) so the
   * wire decline code/message split is byte-identical to the inline try/catch
   * it replaced.
   */
  private async runStoreOpOrDecline<T>(
    cgId: string,
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: T } | { ok: false; decline: Uint8Array }> {
    try {
      return { ok: true, value: await op() };
    } catch (err) {
      if (isACKHandlerDeadlineAbort(err)) throw err;
      if (isACKHandlerDeadlineAbortSignal(signal)) throw signal!.reason;
      return { ok: false, decline: this.declineTemporarilyUnavailable(cgId, 'store unavailable', err) };
    }
  }

  /** Persist a verified public catalog under the shared store-error boundary. */
  private async persistCatalogOrDecline(
    cgId: string,
    catalogGraph: string,
    parsedCatalog: Quad[],
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; decline: Uint8Array }> {
    // Malformed terms are a bad request, not a store outage — validate BEFORE
    // the store wrapper so they reset the stream instead of being mislabeled
    // as a transient decline (see assertPersistQuadTermsSafe).
    assertPersistQuadTermsSafe(parsedCatalog);
    const result = await this.runStoreOpOrDecline(
      cgId,
      () => replaceCatalogQuads(this.store, catalogGraph, parsedCatalog, signal),
      signal,
    );
    return result.ok ? { ok: true } : result;
  }

  /**
   * Persist merkle-verified inline quads to a scoped staging graph before the
   * ACK is signed (crash-safety durability invariant: an on-chain KC implies
   * at least one core stored the data, so a failed persist MUST decline rather
   * than sign anyway). `dropGraph` (idempotent replace) then `insert`.
   */
  private async persistStagingOrDecline(
    cgId: string,
    stagingGraphUri: string,
    parsed: Quad[],
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; decline: Uint8Array }> {
    // Malformed terms are a bad request, not a store outage — validate BEFORE
    // the store wrapper so they reset the stream instead of being mislabeled
    // as a transient decline (see assertPersistQuadTermsSafe).
    assertPersistQuadTermsSafe(parsed);
    const result = await this.runStoreOpOrDecline(cgId, async () => {
      await this.store.dropGraph(
        stagingGraphUri,
        ackStoreOptions('storage-ack.persistStaging.dropGraph', signal),
      );
      const graphedQuads = parsed.map((q) => ({ ...q, graph: stagingGraphUri }));
      await this.store.insert(graphedQuads, ackStoreOptions('storage-ack.persistStaging.insert', signal));
      // Durability boundary: the ACK we are about to sign asserts this data is
      // stored, and a worker respawn can recover from a snapshot that predates
      // the debounced flush — so force it durable before signing. A flush
      // failure stays inside the wrapper → transient decline (never sign).
      await this.store.flush?.(ackStoreOptions('storage-ack.persistStaging.flush', signal));
    }, signal);
    return result.ok ? { ok: true } : result;
  }

  /**
   * Persist a verified rootless assertion as one exact SWM graph plus the
   * constant-size workspace head needed by finalization and chain reconcile.
   *
   * StorageACK durability is not satisfied by the data graph alone: without
   * the head, a core that does not subscribe to the CG's live publish topic
   * cannot bind those triples back to the UAL after the chain event lands.
   * The operation id binds asset identity, version, and content, so ACK retries
   * replace the same metadata rows without aliasing identical-content KAs.
   */
  private async persistGraphScopedWorkspaceOrDecline(
    cgId: string,
    swmGraphId: string,
    swmGraphUri: string,
    graphPublish: GraphScopedPublishIntent,
    parsed: Quad[],
    publisherPeerId: string,
    merkleRoot: Uint8Array,
    replaceGraph: boolean,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; decline: Uint8Array }> {
    assertPersistQuadTermsSafe(parsed);
    const normalized = parsed.map((quad) => ({ ...quad, graph: swmGraphUri }));
    const operationId = `storage-ack-${ethers.keccak256(ethers.toUtf8Bytes([
      graphPublish.scope.ual,
      graphPublish.scope.assertionVersion,
      ethers.hexlify(merkleRoot),
    ].join('\0'))).slice(2)}`;
    const metaGraph = this.graphManager.sharedMemoryMetaUri(
      swmGraphId,
      graphPublish.subGraphName,
    );
    const publicDigest = workspacePublicQuadsDigest(
      normalized.map((quad) => ({ ...quad, graph: '' })),
    );
    const metadata = generateKnowledgeAssetShareMetadata(
      {
        shareOperationId: operationId,
        contextGraphId: swmGraphId,
        kaUal: graphPublish.scope.ual,
        assertionVersion: graphPublish.scope.assertionVersion,
        publicTripleCount: normalized.length,
        ...(graphPublish.privateMerkleRoot
          ? { privateMerkleRoot: graphPublish.privateMerkleRoot }
          : {}),
        privateTripleCount: graphPublish.privateTripleCount,
        publisherPeerId: publisherPeerId.trim() || 'unknown',
        accessPolicy: graphPublish.accessPolicy,
        allowedPeers: graphPublish.allowedPeers,
        agentAddress: graphPublish.scope.agentAddress,
        subGraphName: graphPublish.subGraphName,
        timestamp: new Date(),
      },
      metaGraph,
    );
    const operationSubject = metadata[0]?.subject;
    if (!operationSubject) {
      throw new Error('StorageACK: graph-scoped workspace metadata is empty');
    }
    metadata.push({
      subject: operationSubject,
      predicate: 'http://dkg.io/ontology/publicQuadsDigest',
      object: `"${publicDigest}"`,
      graph: metaGraph,
    });

    const result = await this.runStoreOpOrDecline(cgId, async () => {
      if (replaceGraph) {
        const replaced = await tryReplaceGraphAtomically(
          this.store,
          swmGraphUri,
          normalized,
          ackStoreOptions('storage-ack.persistGraphScoped.replaceGraph', signal),
        );
        if (!replaced) {
          throw Object.assign(
            new Error('Graph-scoped StorageACK requires atomic TripleStore.replaceGraph support'),
            { code: 'SWM_ATOMIC_REPLACE_UNSUPPORTED' },
          );
        }
      }
      await this.store.deleteByPattern(
        { graph: metaGraph, subject: operationSubject },
        ackStoreOptions('storage-ack.persistGraphScoped.deleteOperationMeta', signal),
      );
      await this.store.insert(
        metadata,
        ackStoreOptions('storage-ack.persistGraphScoped.insertOperationMeta', signal),
      );
      await storeKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager: this.graphManager,
        contextGraphId: swmGraphId,
        kaUal: graphPublish.scope.ual,
        assertionVersion: graphPublish.scope.assertionVersion,
        shareOperationId: operationId,
        subGraphName: graphPublish.subGraphName,
      });
      await this.store.flush?.(
        ackStoreOptions('storage-ack.persistGraphScoped.flush', signal),
      );
    }, signal);
    return result.ok ? { ok: true } : result;
  }

  /**
   * Load SWM quads for the recompute, translating a store outage into the
   * transient decline. `loadSWMQuads` tags ONLY the storage loader's store/index
   * throws as `StoreUnavailableError`; its `assertSafeIri` guards throw
   * ordinary errors that this helper re-raises so a malformed-request still
   * resets the stream (never demoted to a retryable decline).
   */
  private async loadSWMOrDecline(
    cgId: string,
    graphUri: string,
    rootEntities: string[],
    signal?: AbortSignal,
  ): Promise<{ ok: true; quads: Quad[] } | { ok: false; decline: Uint8Array }> {
    try {
      return { ok: true, quads: await this.loadSWMQuads(graphUri, rootEntities, signal) };
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        if (isACKHandlerDeadlineAbort(err)) throw err;
        if (isACKHandlerDeadlineAbortSignal(signal)) throw signal!.reason;
        return { ok: false, decline: this.declineTemporarilyUnavailable(cgId, 'store unavailable', err) };
      }
      throw err;
    }
  }

  /**
   * Run the signer-registration gate, centralizing the three-way outcome the
   * publish + update handlers all need:
   *   - `{ ok: true }`            → signer confirmed (or no hook wired): SIGN.
   *   - `{ ok: false, decline }`  → a THROWN lookup (degraded RPC) is transient
   *     → `CORE_TEMPORARILY_UNAVAILABLE`; a `registered === false` verdict is
   *     permanent → `SIGNER_NOT_REGISTERED`. Both fail closed (never sign).
   *
   * The `verdictWireMessage` is the per-path `SIGNER_NOT_REGISTERED` wire text
   * (publish vs curated-publish vs update differ), passed through verbatim so
   * the existing wire bytes / test greps stay intact. The lookup-throw wire
   * message ('signer registration lookup unavailable') is identical across all
   * paths, so it lives here.
   */
  private async checkSignerRegistrationOrDecline(
    cgId: string,
    verdictWireMessage: string,
  ): Promise<{ ok: true } | { ok: false; decline: Uint8Array }> {
    if (!this.config.isSignerRegistered) return { ok: true };
    let signerRegistered: boolean;
    try {
      signerRegistered = await this.config.isSignerRegistered();
    } catch (err) {
      try {
        await this.config.onSignerRegistrationLookupFailed?.(err);
      } catch {
        // Keep ACK availability independent from logging/callback failures.
      }
      // Dead-air fix: `isSignerRegistered` is a LIVE chain read on every
      // inbound ACK — one degraded shared RPC used to make this throw on
      // EVERY request on EVERY core, and the resulting stream resets dead-
      // aired the whole network. A thrown LOOKUP is transient, so decline in
      // band; the definitive `registered === false` verdict below keeps its
      // SIGNER_NOT_REGISTERED decline. Either way we never sign without a
      // confirmed registration (fail-closed holds).
      return {
        ok: false,
        decline: this.declineTemporarilyUnavailable(cgId, 'signer registration lookup unavailable', err),
      };
    }
    if (signerRegistered === false) {
      try {
        await this.config.onSignerUnregistered?.();
      } catch {
        // Keep the signing refusal deterministic even if protocol cleanup fails.
      }
      // Decline rather than throw: the operator can rotate / re-register a key
      // without restarting publishers, and the publisher should deselect this
      // core for THIS request and move on rather than retry-and-time-out
      // against a known-rejecting signer.
      return {
        ok: false,
        decline: this.encodeDecline(cgId, STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED, verdictWireMessage),
      };
    }
    return { ok: true };
  }

  /**
   * Protocol stream handler for `/dkg/10.0.1/storage-ack`.
   * Receives PublishIntent, returns StorageACK.
   *
   * Wrapped in a fresh ROOT span (`publisher.storage_ack_handler`) — this
   * is an inbound libp2p callback with no cross-node trace context. Kept
   * MINIMAL (no per-step child spans) because it runs under libp2p stream
   * backpressure. Classifies the terminal outcome (ack / decline / reset)
   * for the `ackHandlerTotal` metric; a thrown error resets the stream and
   * is auto-recorded as a span ERROR by withSpan.
   */
  handler = async (data: Uint8Array, peerId: PeerId): Promise<Uint8Array> => {
    const chainIdLabel = this.config.chainId != null
      ? this.config.chainId.toString()
      : undefined;
    return withSpan('publisher.storage_ack_handler', async (span) => {
      let cgIdAttr: string | undefined;
      let intentPreview: PublishIntentMsg | undefined;
      try {
        // contextGraphId is cheap to read off the decoded intent for the span
        // attribute; the full classification rides the encoded response below.
        intentPreview = decodePublishIntent(data);
        cgIdAttr = intentPreview.contextGraphId;
        if (cgIdAttr) span.setAttribute('dkg.context_graph_id', cgIdAttr);
      } catch {
        // Malformed request — handlePublishIntent will throw + reset below.
      }
      try {
        const result = await this.runHandlerWithDeadline(
          (signal) => this.handlePublishIntent(data, peerId, signal),
          cgIdAttr,
        );
        const decision = this.buildStorageAckDecision(intentPreview, result, peerId);
        await this.observeStorageAckDecision(decision);
        if (isStorageACKDecline(decision.ack)) {
          const declineCode = decision.ack.declineCode || 'UNKNOWN';
          span.setAttribute('dkg.ack_outcome', 'decline');
          span.setAttribute('dkg.decline_code', declineCode);
          getMetrics().ackHandlerTotal.add(1, {
            outcome: 'decline',
            // Bound to the known enum so the metric label can't become
            // high-cardinality (defensive — only fixed enum values as labels).
            decline_code: boundedDeclineCodeLabel(declineCode),
            ...(chainIdLabel ? { chain_id: chainIdLabel } : {}),
          });
        } else {
          span.setAttribute('dkg.ack_outcome', 'ack');
          getMetrics().ackHandlerTotal.add(1, {
            outcome: 'ack',
            ...(chainIdLabel ? { chain_id: chainIdLabel } : {}),
          });
        }
        return decision.encoded;
      } catch (err) {
        // Throw resets the libp2p stream — withSpan records ERROR. Tag the
        // terminal outcome + metric, then re-throw to preserve control flow.
        span.setAttribute('dkg.ack_outcome', 'reset');
        getMetrics().ackHandlerTotal.add(1, {
          outcome: 'reset',
          ...(chainIdLabel ? { chain_id: chainIdLabel } : {}),
        });
        throw err;
      }
    });
  };

  /**
   * Run an in-flight ACK body ({@link handlePublishIntent} or
   * {@link handleUpdateIntent}) under a wall-clock deadline. If the store
   * work has not produced a reply within `ackHandlerDeadlineMs` (default 15s,
   * below the publisher's 20s per-send timeout), resolve with a
   * `CORE_TEMPORARILY_UNAVAILABLE` decline so the publisher gets an actionable
   * transient response instead of dead-air. The deadline aborts ACK store work
   * through the per-invocation signal; any staging it already persisted is
   * idempotent, and a late resolve/reject is swallowed so it cannot surface as
   * an unhandled rejection once the deadline reply has been sent.
   *
   * A THROWN handler error still propagates (the race rejects) → the outer
   * handler resets the stream exactly as before; the deadline only converts
   * the *slow* (non-throwing) case, which previously had no in-band signal.
   */
  private runHandlerWithDeadline = async (
    workFactory: (signal?: AbortSignal) => Promise<Uint8Array>,
    cgIdForDecline: string | undefined,
  ): Promise<Uint8Array> => {
    const deadlineMs = this.config.ackHandlerDeadlineMs ?? DEFAULT_ACK_HANDLER_DEADLINE_MS;
    if (deadlineMs <= 0) return workFactory();

    const abortController = new AbortController();
    const work = workFactory(abortController.signal);

    return runWithDeadline(work, deadlineMs, () => {
      const storePressure = formatStorePressureSnapshot(this.getStorePressureSnapshot());
      const deadlineError = new ACKHandlerDeadlineAbortError(deadlineMs, storePressure);
      const decline = this.declineTemporarilyUnavailable(
        cgIdForDecline ?? '',
        'ack handler deadline exceeded',
        deadlineError,
      );
      abortController.abort(deadlineError);
      return decline;
    });
  };

  /**
   * Original publish-intent handling body. Split out from {@link handler}
   * so the public entry point is a thin `withSpan` wrapper; the logic here
   * is byte-for-byte the pre-instrumentation behaviour.
   */
  private handlePublishIntent = async (
    data: Uint8Array,
    peerId: PeerId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (this.config.nodeRole !== 'core') {
      throw new Error('Only core nodes can issue StorageACKs');
    }

    const intent = decodePublishIntent(data);
    const graphPublish = resolveGraphScopedPublishIntent(intent);
    // `cgId` is the TARGET on-chain numeric id used by the ACK digest and
    // the publishDirect tx. `swmGraphId` (optional, from the remap flow)
    // is the SOURCE graph where data lives in SWM. When absent, fall back
    // to `cgId` so direct-publish flows keep working unchanged.
    const cgId = intent.contextGraphId;
    const swmGraphId = intent.swmGraphId && intent.swmGraphId.length > 0
      ? intent.swmGraphId
      : cgId;
    const subGraphName = graphPublish?.subGraphName ?? (
      intent.subGraphName && intent.subGraphName.length > 0
        ? intent.subGraphName
        : undefined
    );
    const merkleRoot = intent.merkleRoot instanceof Uint8Array
      ? intent.merkleRoot
      : new Uint8Array(intent.merkleRoot);
    const privateMerkleRoots = normalizePrivateMerkleRoots(intent.privateMerkleRoots);
    if (intent.isEncryptedPayload === true && privateMerkleRoots.length > 0) {
      throw new Error(
        'StorageACK: privateMerkleRoots are only valid for folded-private public-CG ACKs; ' +
        'curated/encrypted ACKs must use catalogCommitment without folded private roots',
      );
    }

    const contentPrivateRoots = graphPublish?.privateMerkleRoot
      ? [graphPublish.privateMerkleRoot]
      : privateMerkleRoots;
    const swmGraphUri = graphPublish
      ? knowledgeAssetLayerGraphUri(
          swmGraphId,
          MemoryLayer.SharedWorkingMemory,
          graphPublish.scope,
          subGraphName,
        )
      : this.config.contextGraphSharedMemoryUri(swmGraphId, subGraphName);

    let swmQuads: Quad[];

    // OT-RFC-49 / WS-D — CURATED catalog ACK. A curated publish ships the
    // PUBLIC `_catalog` N-quads inline (plaintext — the catalog is public by
    // design) and claims `(catalogRoot, catalogLeafCount)`. This core, which
    // cannot decrypt the PRIVATE data, instead independently REBUILDS the
    // catalog root over the inline catalog via the SAME definition the
    // producer and prover use (`computeCatalogRoot(catalogCommittedLeaves(...))`)
    // and DECLINEs `CATALOG_ROOT_MISMATCH` on disagreement. It then PERSISTS
    // the catalog to `<cg>/_catalog` so it can serve + later re-prove it, and
    // signs the V10 ACK digest (carrying the catalog commitment + the trusted
    // private `merkleRoot`). This REPLACED the stripped ciphertext-chunk /
    // encrypted-blob ACK paths.
    //
    // Curation is independently confirmed via `isCgCurated` (Codex PR #608
    // property): a publisher must NOT be able to claim curated semantics on a
    // PUBLIC CG — otherwise it could have this core sign over a `merkleRoot` it
    // cannot verify. Fail closed when no oracle is wired or curation is unknown.
    if (intent.isEncryptedPayload === true) {
      const swmGraphIdForCuration = intent.swmGraphId && intent.swmGraphId.length > 0
        ? intent.swmGraphId
        : undefined;
      if (!this.config.isCgCurated) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected: this core has no curation oracle wired, ` +
          `so it cannot verify the CG is curated. Cores must independently confirm the access policy ` +
          `before signing an ACK whose private merkleRoot they cannot recompute.`,
        );
      }
      const curationVerdict = await this.config.isCgCurated(cgId, swmGraphIdForCuration);
      if (curationVerdict !== true) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected for cg=${cgId}${swmGraphIdForCuration ? ` (swmGraph=${swmGraphIdForCuration})` : ''}: ` +
          `local curation oracle reports ${curationVerdict === false ? 'PUBLIC (not curated)' : 'UNKNOWN'}. ` +
          `The curated ACK path is restricted to verifiably-curated CGs.`,
        );
      }

      // The inline payload is the PUBLIC catalog N-quads. Bound the size and
      // require a non-empty payload — the curated commitment is verified
      // against it, so an empty payload is a malformed request.
      if (!intent.stagingQuads || intent.stagingQuads.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          'curated ACK requires the public catalog N-quads inline (empty stagingQuads)',
        );
      }
      if (intent.stagingQuads.length > STORAGE_ACK_MAX_STAGING_BYTES) {
        throw new Error(
          `curated catalog stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${STORAGE_ACK_MAX_STAGING_BYTES} byte limit — rejecting request`,
        );
      }
      const claimedByteSize = typeof intent.publicByteSize === 'number'
        ? intent.publicByteSize
        : Number(intent.publicByteSize);
      // byteSize parity: the curated CG prices off the catalog footprint, so
      // the inline catalog bytes MUST equal the claimed `publicByteSize`
      // (same honesty guard the plaintext path applies to its quads).
      if (intent.stagingQuads.length !== claimedByteSize) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK byteSize mismatch: inline catalog is ${intent.stagingQuads.length} bytes ` +
          `but publisher claims publicByteSize=${claimedByteSize}. For curated CGs byteSize MUST ` +
          `equal the catalog N-quads byte count.`,
        );
      }

      const claimedCatalogRoot = intent.catalogRoot;
      const claimedCatalogLeafCount = intent.catalogLeafCount ?? 0;
      if (!claimedCatalogRoot || claimedCatalogRoot.length !== 32 || claimedCatalogLeafCount <= 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK requires a 32-byte catalogRoot and a positive catalogLeafCount; ` +
          `got root=${claimedCatalogRoot ? claimedCatalogRoot.length : 'missing'} bytes, count=${claimedCatalogLeafCount}`,
        );
      }

      // Independently rebuild the catalog commitment over the inline catalog
      // via the SHARED definition (post-publish stamps stripped) so the core's
      // rebuilt root is byte-identical to the producer's committed root AND the
      // prover's later rebuild. DECLINE on any disagreement.
      const parsedCatalog = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      const committedLeaves = catalogCommittedLeaves(parsedCatalog);
      if (committedLeaves.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          'curated ACK: inline catalog parsed to zero committed leaves',
        );
      }
      const rebuilt = computeCatalogRoot(committedLeaves);
      if (rebuilt.leafCount !== claimedCatalogLeafCount) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK leaf-count mismatch: rebuilt ${rebuilt.leafCount} catalog leaves ` +
          `but publisher claims ${claimedCatalogLeafCount}`,
        );
      }
      if (!bytesEqual(rebuilt.root, claimedCatalogRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK root mismatch: rebuilt catalog root=${ethers.hexlify(rebuilt.root).slice(0, 18)}... ` +
          `does not match publisher claim=${ethers.hexlify(claimedCatalogRoot).slice(0, 18)}...`,
        );
      }

      // Root verified — persist the public catalog to `<cg>/_catalog` so this
      // core can serve it (the §7 facet open-serve) and the prover can later
      // rebuild the SAME root for curated proving. CLEAR/REPLACE the subjects.
      // `assertSafeIri` stays OUTSIDE the persist helper below: an unsafe graph
      // IRI is a malformed-request condition (stream reset), not a store outage.
      // A failing store (worker restarting, 'store is closed') instead returns
      // the transient decline so the publisher retries once the store recovers
      // rather than bucketing us as no_response after a stream reset.
      const catalogGraph = contextGraphCatalogUri(cgId);
      assertSafeIri(catalogGraph);
      const persistedCatalog = await this.persistCatalogOrDecline(cgId, catalogGraph, parsedCatalog, signal);
      if (!persistedCatalog.ok) return persistedCatalog.decline;

      // OT-RFC-43 / V10: every publish mints exactly ONE Knowledge Asset.
      if (intent.kaCount !== 1) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `curated PublishIntent.kaCount must be exactly 1 for V10 publishes; got ${intent.kaCount}`,
        );
      }
      const claimedLeafCount = intent.merkleLeafCount == null ? 0 : Number(intent.merkleLeafCount);
      // Curated KAs are sampled through the independently verified catalog
      // commitment above. Their private assertion may therefore contain zero
      // public leaves; requiring a positive count here forced an unnecessary
      // public placeholder that the lifecycle contract itself does not need.
      if (!Number.isInteger(claimedLeafCount) || claimedLeafCount < 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `curated PublishIntent.merkleLeafCount must be a non-negative integer; got ${claimedLeafCount}`,
        );
      }
      if (graphPublish && claimedLeafCount === 0 && graphPublish.publicTripleCount !== 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `curated graph-scoped PublishIntent claims zero Merkle leaves for ` +
            `${graphPublish.publicTripleCount} public triples`,
        );
      }

      const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
      const intentTokenAmount = intent.tokenAmountStr ? BigInt(intent.tokenAmountStr) : 0n;
      let contextGraphIdBigInt: bigint;
      try {
        contextGraphIdBigInt = BigInt(cgId);
      } catch {
        throw new Error(
          `curated StorageACK: V10 publish requires a numeric on-chain context graph id; got '${cgId}'.`,
        );
      }
      if (contextGraphIdBigInt <= 0n) {
        throw new Error(
          `curated StorageACK: V10 publish requires a positive on-chain context graph id; got ${contextGraphIdBigInt}.`,
        );
      }

      const digest = computePublishACKDigest(
        this.config.chainId,
        this.config.kav10Address,
        contextGraphIdBigInt,
        merkleRoot,
        BigInt(intent.kaCount),
        BigInt(claimedByteSize),
        BigInt(intentEpochs),
        intentTokenAmount,
        BigInt(claimedLeafCount),
        catalogRootForAckDigest(intent.catalogRoot),
        BigInt(intent.catalogLeafCount ?? 0),
        false,
      );

      const curatedSignerGate = await this.checkSignerRegistrationOrDecline(
        cgId,
        'curated StorageACK signer is not confirmed on-chain as an operational wallet',
      );
      if (!curatedSignerGate.ok) return curatedSignerGate.decline;

      const signature = ethers.Signature.from(
        await this.config.signerWallet.signMessage(digest),
      );
      const MAX_UINT64 = (1n << 64n) - 1n;
      if (this.config.nodeIdentityId > MAX_UINT64) {
        throw new Error(
          `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format`,
        );
      }
      const curatedSubscriptionSource = this.config.getSubscriptionSourceForCg?.(
        cgId,
        swmGraphId !== cgId ? swmGraphId : undefined,
      );
      return encodeStorageACK({
        merkleRoot,
        coreNodeSignatureR: ethers.getBytes(signature.r),
        coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
        contextGraphId: cgId,
        nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(this.config.nodeIdentityId)
          : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
        ...(curatedSubscriptionSource ? { subscriptionSource: curatedSubscriptionSource } : {}),
      });
    }


    if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      // Size limit: reject oversized inline payloads to prevent memory exhaustion.
      if (intent.stagingQuads.length > STORAGE_ACK_MAX_STAGING_BYTES) {
        throw new Error(
          `stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${STORAGE_ACK_MAX_STAGING_BYTES} byte limit — rejecting request`,
        );
      }

      // Verify merkle root IN-MEMORY before persisting anything to SWM.
      // This prevents untrusted peers from injecting arbitrary quads.
      const parsed = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      if (parsed.length === 0) {
        throw new Error('stagingQuads present but contained no parseable N-Quads');
      }

      // OT-RFC-44 / Design B: a publish is exactly ONE Knowledge Asset whose
      // member entities are the root subjects (any count). `kaCount` is the KA
      // count (must be 1) — NOT the entity count. The pre-Design-B check
      // `rootSubjects.size === intent.kaCount` conflated the two and made a
      // receiving node REFUSE to ACK any multi-entity KA (the silent cross-node
      // failure in OT-RFC-43 §2.7 / the §11.2 canary). Under Design B we assert
      // only the KA-count invariant here; data integrity (that these quads are
      // exactly what the publisher committed to) is guaranteed by the Merkle
      // check below, not by counting subjects.
      //
      // We deliberately do NOT require a count bijection between `rootEntities`
      // and the payload's root subjects. `rootEntities` is a *selection*, not a
      // complete enumeration: in the SWM-fallback branch it is the entity filter
      // passed to `loadSWMQuads`, so a caller may legitimately declare a subset
      // of the subjects present. The per-entity presence loop below still pins
      // the one direction that matters for a receiver — every entity the caller
      // names must actually be in the payload (declared ⊆ actual).
      const uniqueSubjects = new Set(parsed.map(q => q.subject));
      const rootSubjects = new Set(
        [...uniqueSubjects].filter(s => !s.includes('/.well-known/genid/')),
      );
      if (intent.kaCount !== 1) {
        throw new Error(
          `Design B: a publish must declare exactly one Knowledge Asset (kaCount=1); got ${intent.kaCount}`,
        );
      }

      // Validate that every declared rootEntity is actually present in the
      // payload (declared ⊆ actual). Skolemized blank-node children
      // (/.well-known/genid/) are excluded from `rootSubjects` above — they are
      // internal sub-nodes of a single entity, not separate root entities.
      if (intent.rootEntities && intent.rootEntities.length > 0) {
        for (const entity of intent.rootEntities) {
          if (!rootSubjects.has(entity)) {
            throw new Error(
              `rootEntity '${entity}' from intent not found in staging quads root subjects`,
            );
          }
        }
      }

      if (graphPublish && parsed.length !== graphPublish.publicTripleCount) {
        throw new Error(
          `StorageACK: graph-scoped public triple count mismatch ` +
            `(intent=${graphPublish.publicTripleCount}, inline=${parsed.length})`,
        );
      }
      const inMemoryRoot = computeFlatKCRoot(parsed, contentPrivateRoots);
      if (!bytesEqual(inMemoryRoot, merkleRoot)) {
        throw new Error(
          `Merkle root mismatch (inline quads): publisher=${ethers.hexlify(merkleRoot).slice(0, 18)}..., ` +
          `computed=${ethers.hexlify(inMemoryRoot).slice(0, 18)}... ` +
          `(${parsed.length} triples) — refusing to store`,
        );
      }

      // Root verified — persist to a scoped staging graph so the data is
      // durable before we sign the ACK (crash safety: on-chain KC implies
      // at least one core node stored the data). The staging graph is keyed
      // by merkle root prefix and cleaned up during finalization. A store
      // outage during the apply (closed / restarting worker) returns the
      // transient decline instead of resetting the stream — the durability
      // invariant is why we CANNOT sign anyway, so the publisher re-sends
      // once the store worker is back rather than bucketing us as no_response.
      const stagingGraphUri = graphPublish
        ? swmGraphUri
        : `${swmGraphUri}/staging/${ethers.hexlify(merkleRoot).slice(2, 18)}`;
      const persistedStaging = graphPublish
        ? await this.persistGraphScopedWorkspaceOrDecline(
            cgId,
            swmGraphId,
            swmGraphUri,
            graphPublish,
            parsed,
            peerId.toString(),
            merkleRoot,
            true,
            signal,
          )
        : await this.persistStagingOrDecline(cgId, stagingGraphUri, parsed, signal);
      if (!persistedStaging.ok) return persistedStaging.decline;
      swmQuads = parsed;

      // Schedule cleanup: remove staging graph after 10 minutes.
      // Finalization may promote data to LTM before this fires.
      if (!graphPublish) {
        setTimeout(async () => {
          try { await this.store.dropGraph(stagingGraphUri); } catch { /* ignore */ }
        }, 10 * 60 * 1000);
      }
    } else {
      // Fallback: data should already be in SWM (publishFromSharedMemory path).
      // Both the "no data" and "data but wrong merkle root" cases below are
      // reasons this specific core can't ACK this specific request — the
      // publisher should deselect this peer (no retry against it) and try
      // another core. Returning a typed decline instead of throwing keeps
      // the libp2p stream alive so the publisher sees the reason in band
      // rather than as an opaque stream reset (the #541 failure mode).
      //
      // Dead-air fix: the SWM CONSTRUCT itself failing (store worker down)
      // is the same #541 shape one level deeper — it used to throw out of
      // the handler and reset the stream. `loadSWMOrDecline` translates a
      // store-op failure (and ONLY that — assertSafeIri malformed-request
      // throws still propagate + reset) into the transient decline.
      if (graphPublish?.publicTripleCount === 0) {
        swmQuads = [];
      } else {
        const loadedSWM = await this.loadSWMOrDecline(
          cgId,
          swmGraphUri,
          graphPublish ? [] : intent.rootEntities,
          signal,
        );
        if (!loadedSWM.ok) return loadedSWM.decline;
        swmQuads = loadedSWM.quads;
      }

      if (swmQuads.length === 0 && !graphPublish) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
          `No data found in SWM graph ${swmGraphUri} for entities: ` +
          summarizeDeclineEntities(intent.rootEntities ?? []),
        );
      }

      if (graphPublish && swmQuads.length !== graphPublish.publicTripleCount) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `StorageACK: graph-scoped public triple count mismatch ` +
            `(intent=${graphPublish.publicTripleCount}, local=${swmQuads.length})`,
        );
      }
      const recomputedRoot = computeFlatKCRoot(swmQuads, contentPrivateRoots);
      if (!bytesEqual(recomputedRoot, merkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `Merkle root mismatch: publisher=${ethers.hexlify(merkleRoot).slice(0, 18)}..., ` +
          `local=${ethers.hexlify(recomputedRoot).slice(0, 18)}... ` +
          `(${swmQuads.length} triples in SWM)`,
        );
      }
      if (graphPublish) {
        const persistedWorkspace = await this.persistGraphScopedWorkspaceOrDecline(
          cgId,
          swmGraphId,
          swmGraphUri,
          graphPublish,
          swmQuads,
          peerId.toString(),
          merkleRoot,
          false,
          signal,
        );
        if (!persistedWorkspace.ok) return persistedWorkspace.decline;
      }
    }

    // OT-RFC-44 / Design B: a publish is exactly ONE Knowledge Asset whose
    // member entities are the root subjects (any count). The KA count signed
    // into the ACK digest is therefore ALWAYS 1 — it must match what the
    // publisher submits on chain (`knowledgeAssetsAmount`, which the contract
    // requires to be 1) and the digest the publisher/ACK-collector compute.
    // Pre-Design-B this recomputed kaCount = rootSubjects.size (the ENTITY
    // count); for a multi-entity KA that made the receiver sign a digest with
    // kaCount=N while the publisher and contract used kaCount=1, so no ACK
    // could ever validate — the silent cross-node failure in OT-RFC-43 §2.7.
    // The data integrity that recompute was protecting is already guaranteed
    // by the merkle-root check above (computeFlatKCRoot over the SWM quads).
    const verifiedKACount = 1;

    // byteSize pin: `publicByteSize` is signed into the ACK digest and prices the
    // publish on-chain (`ask · byteSize · epochs`); nothing on-chain can see the
    // content, so without this an under-claim (e.g. `byteSize = 1` for real
    // content) drives the cost toward zero regardless of the ask. The publisher
    // computes it as the UTF-8 byte length of the N-Quads serialization
    // (`TextEncoder().encode(nquads).length`), so the floor is in UTF-8 bytes:
    //   - INLINE path (`stagingQuads` present): the core received the EXACT
    //     serialized payload, so require the claim to cover its full byte length
    //     — anything less omits real serialized bytes (`<>`, separators, graph
    //     terms, escapes, newlines) the cores must store. This is the tight,
    //     exact floor (an honest direct publish sets `publicByteSize ==
    //     stagingQuads.length`; both derive from the same `nquadsStr`).
    //   - SWM-fallback path: the original serialization isn't reconstructable
    //     byte-exactly, so fall back to the serialization-INDEPENDENT lower bound
    //     Σ(UTF-8 byteLength(s,p,o)) (always ≤ the real serialization, so no
    //     false positives; JS string `.length` would under-count non-ASCII).
    // `publicByteSize` is a protobuf `uint64` (number | Long on the wire). Parse
    // it to `bigint` ONCE and keep the floor, the compare, AND the signed ACK
    // digest value in `bigint` across the full uint64 range — a `Number()` round
    // would corrupt a value above 2^53 before it is priced/signed.
    let byteSizeFloor: bigint;
    let floorBasis: string;
    if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      byteSizeFloor = BigInt(intent.stagingQuads.length);
      floorBasis = 'exact inline payload bytes';
    } else {
      byteSizeFloor = 0n;
      for (const q of swmQuads) {
        byteSizeFloor +=
          BigInt(Buffer.byteLength(q.subject, 'utf8')) +
          BigInt(Buffer.byteLength(q.predicate, 'utf8')) +
          BigInt(Buffer.byteLength(q.object, 'utf8'));
      }
      floorBasis = 'Σ UTF-8 term bytes (lower bound)';
    }
    let claimedPublicByteSize: bigint;
    try {
      claimedPublicByteSize = BigInt(
        typeof intent.publicByteSize === 'number'
          ? intent.publicByteSize
          : intent.publicByteSize.toString(),
      );
    } catch {
      claimedPublicByteSize = -1n; // non-integer / unparseable → fails the wire-validity gate
    }
    if (claimedPublicByteSize < 0n || claimedPublicByteSize < byteSizeFloor) {
      return this.encodeDecline(
        cgId,
        STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM,
        `public ACK byteSize under-claim: publisher claims publicByteSize=${claimedPublicByteSize} ` +
        `but the attested content requires at least ${byteSizeFloor} UTF-8 bytes ` +
        `(${floorBasis}). Refusing to sign an under-priced footprint.`,
      );
    }
    const verifiedByteSize = claimedPublicByteSize;

    // Derive numeric CG ID the same way the publisher does. Fail loud on
    // non-numeric or non-positive ids — the V10 contract rejects
    // `contextGraphId == 0` with `ZeroContextGraphId` at
    // `KnowledgeAssetsV10.sol:379`, so signing an ACK against CG 0 (or a
    // negative id from `BigInt("-1")`, which would die later in the
    // evm-adapter's uint256 encoder) would just produce a signature the
    // contract rejects downstream.
    //
    // Throw rather than decline: this is a malformed PublishIntent (the
    // publisher built a request the contract will never accept), not
    // peer-local state. A typed decline would make the publisher fan
    // out to every other core looking for a different answer and
    // report `storage_ack_insufficient` after the full retry budget,
    // masking the real caller error. The stream reset surfaces the
    // original message to the caller immediately.
    let contextGraphIdBigInt: bigint;
    try {
      contextGraphIdBigInt = BigInt(cgId);
    } catch {
      throw new Error(
        `StorageACK: V10 publish requires a numeric on-chain context graph id; ` +
        `got '${cgId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (contextGraphIdBigInt <= 0n) {
      throw new Error(
        `StorageACK: V10 publish requires a positive on-chain context graph id; ` +
        `got ${contextGraphIdBigInt}. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
    const intentTokenAmount = intent.tokenAmountStr
      ? BigInt(intent.tokenAmountStr)
      : 0n;

    const verifiedLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, contentPrivateRoots);
    if (verifiedLeafCount === 0 && !graphPublish?.privateMerkleRoot) {
      throw new Error(
        'StorageACK: empty Knowledge Asset payload (zero V10 Merkle leaves after sort+dedupe) — refusing ACK',
      );
    }
    const claimedLeafCount = intent.merkleLeafCount == null ? 0 : Number(intent.merkleLeafCount);
    if (claimedLeafCount !== verifiedLeafCount) {
      throw new Error(
        `StorageACK: merkleLeafCount mismatch (intent=${claimedLeafCount}, computed=${verifiedLeafCount}). ` +
        'Publishers must set PublishIntent.merkleLeafCount to the V10 flat-KC leaf count.',
      );
    }

    // H5-prefixed ACK digest matching `KnowledgeAssetsV10._executePublishCore`.
    // `chainId` and `kav10Address` are threaded in via StorageACKHandlerConfig.
    const digest = computePublishACKDigest(
      this.config.chainId,
      this.config.kav10Address,
      contextGraphIdBigInt,
      merkleRoot,
      BigInt(verifiedKACount),
      verifiedByteSize,
      BigInt(intentEpochs),
      intentTokenAmount,
      BigInt(verifiedLeafCount),
      // Public CGs carry no catalog commitment — absent fields decode as
      // 32 zero bytes + 0, matching the on-chain `bytes32(0)` / 0 defaults.
      catalogRootForAckDigest(intent.catalogRoot),
      BigInt(intent.catalogLeafCount ?? 0),
      false,
    );
    const signerGate = await this.checkSignerRegistrationOrDecline(
      cgId,
      'StorageACK signer is not confirmed on-chain as an operational wallet',
    );
    if (!signerGate.ok) return signerGate.decline;

    const signature = ethers.Signature.from(
      await this.config.signerWallet.signMessage(digest),
    );

    const MAX_UINT64 = (1n << 64n) - 1n;
    if (this.config.nodeIdentityId > MAX_UINT64) {
      throw new Error(
        `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format — ` +
        `protocol upgrade required before this identity can issue ACKs`,
      );
    }

    const subscriptionSource = this.config.getSubscriptionSourceForCg?.(
      cgId,
      swmGraphId !== cgId ? swmGraphId : undefined,
    );
    return encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(signature.r),
      coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
      contextGraphId: cgId,
      nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this.config.nodeIdentityId)
        : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
      ...(subscriptionSource ? { subscriptionSource } : {}),
    });
  };

  /**
   * Protocol stream handler for `/dkg/10.0.1/storage-update-ack`.
   *
   * Receives an `UpdateIntent`, recomputes the new flat-KC Merkle root
   * from the request's `stagingQuads` (the same way the plaintext/SWM
   * publish branch does via `computeFlatKCRoot`), verifies it equals the
   * request's `newMerkleRoot`, then signs the 13-field UPDATE ACK digest
   * (`computeUpdateACKDigest`) with the operational key (EIP-191) and
   * returns a `StorageACK` whose `merkleRoot` carries `newMerkleRoot`.
   *
   * `kaId` + `preUpdateMerkleRootCount` are taken from the request and
   * trusted (the publisher binds them; the on-chain update tx reverts if
   * they're wrong). Publish `kaCount` is not analogous anymore: V10 create
   * ACKs require exactly one KA before signing.
   *
   * Mirrors the publish `handler` above; only the digest, the request
   * fields, and the protocol id differ — including the ACK-handler
   * deadline: without it a hanging store op (SWM fallback `store.query`,
   * catalog persist) dead-airs update ACKs past the publisher's 20s
   * per-send timeout exactly as publish did, and the update collector
   * rides the same transient-decline retry ladder.
   */
  updateHandler = async (data: Uint8Array, peerId: PeerId): Promise<Uint8Array> => {
    let cgIdForDecline: string | undefined;
    try {
      // contextGraphId is cheap to read off the decoded intent for the
      // deadline decline; handleUpdateIntent re-decodes + validates below.
      cgIdForDecline = decodeUpdateIntent(data).contextGraphId;
    } catch {
      // Malformed request — handleUpdateIntent will throw + reset below.
    }
    return this.runHandlerWithDeadline(
      (signal) => this.handleUpdateIntent(data, peerId, signal),
      cgIdForDecline,
    );
  };

  /**
   * Original update-intent handling body. Split out from
   * {@link updateHandler} so the public entry point runs it under the
   * shared ACK deadline; the logic here is byte-for-byte the pre-deadline
   * behaviour.
   */
  private handleUpdateIntent = async (
    data: Uint8Array,
    _peerId: PeerId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (this.config.nodeRole !== 'core') {
      throw new Error('Only core nodes can issue StorageACKs');
    }

    const intent = decodeUpdateIntent(data);
    const graphUpdate = resolveGraphScopedUpdateIntent(intent);
    // `cgId` is the TARGET on-chain numeric id used by the UPDATE ACK
    // digest and the update tx. `swmGraphId` (optional) is the SOURCE
    // graph where the data lives in SWM. When absent, fall back to `cgId`.
    const cgId = intent.contextGraphId;
    const swmGraphId = intent.swmGraphId && intent.swmGraphId.length > 0
      ? intent.swmGraphId
      : cgId;
    const subGraphName = graphUpdate?.subGraphName ?? (
      intent.subGraphName && intent.subGraphName.length > 0
        ? intent.subGraphName
        : undefined
    );
    const newMerkleRoot = intent.newMerkleRoot instanceof Uint8Array
      ? intent.newMerkleRoot
      : new Uint8Array(intent.newMerkleRoot);
    if (newMerkleRoot.length !== 32) {
      throw new Error(
        `UpdateStorageACK: newMerkleRoot must be 32 bytes, got ${newMerkleRoot.length}`,
      );
    }

    const swmGraphUri = graphUpdate
      ? knowledgeAssetLayerGraphUri(
          swmGraphId,
          MemoryLayer.SharedWorkingMemory,
          graphUpdate.scope,
          subGraphName,
        )
      : this.config.contextGraphSharedMemoryUri(swmGraphId, subGraphName);
    const inlineVmGraphUri = graphUpdate
      ? knowledgeAssetLayerGraphUri(
          swmGraphId,
          MemoryLayer.VerifiableMemory,
          graphUpdate.scope,
          subGraphName,
        )
      : undefined;

    // Verify the new Merkle root the same way the publish path does:
    // recompute over the updated quads and compare to the publisher's
    // claim. For curated (encrypted) updates the core can't decrypt, so
    // it trusts the claimed root (member post-decrypt verification + the
    // on-chain revert are the integrity backstop) but still independently
    // confirms the CG is curated before signing an opaque ACK.
    //
    // #1283: byteSize floor for PUBLIC updates. The public inline / SWM branches
    // below set this to the attested updated-payload size; it is enforced
    // against the signed `newByteSize` after parsing. Curated/encrypted updates
    // keep their own catalog-parity check and the core can't see the private
    // payload, so they leave it null.
    let publicUpdateByteSizeFloor: bigint | null = null;
    let publicUpdateFloorBasis = '';
    if (intent.isEncryptedPayload === true) {
      const swmGraphIdForCuration = intent.swmGraphId && intent.swmGraphId.length > 0
        ? intent.swmGraphId
        : undefined;
      if (!this.config.isCgCurated) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          'UpdateIntent.isEncryptedPayload=true rejected: this core has no curation oracle wired and cannot verify the CG access policy',
        );
      }
      const curationVerdict = await this.config.isCgCurated(cgId, swmGraphIdForCuration);
      if (curationVerdict !== true) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          `UpdateIntent.isEncryptedPayload=true rejected for cg=${cgId}: local curation oracle reports ${curationVerdict === false ? 'PUBLIC (not curated)' : 'UNKNOWN'}; the encrypted-payload path is curated-only`,
        );
      }
      // OT-RFC-49 WS-D (update): if this curated update carries a public
      // `_catalog` commitment, INDEPENDENTLY rebuild + verify it and REPLACE-
      // persist `<cg>/_catalog` — the SAME guarantee the publish handler gives.
      // The PRIVATE newMerkleRoot stays trusted (the core can't decrypt it),
      // but the catalog is public and verifiable, so a curated update can no
      // longer obtain a signed ACK for a catalog root that doesn't match the
      // data, and cores re-host the rotated catalog so sampling can prove it.
      // A 32-zero-byte newCatalogRoot = no commitment (the on-chain gate
      // rejects a zero-root value-adding curated update), so we only ADD the
      // verification where a commitment is present — legacy/no-op flows intact.
      if (
        intent.newCatalogRoot &&
        intent.newCatalogRoot.length === 32 &&
        intent.newCatalogRoot.some((b) => b !== 0)
      ) {
        if (!intent.stagingQuads || intent.stagingQuads.length === 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            'curated UPDATE ACK requires the public catalog N-quads inline (empty stagingQuads)',
          );
        }
        if (intent.stagingQuads.length > STORAGE_ACK_MAX_STAGING_BYTES) {
          throw new Error(
            `curated UPDATE catalog stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
            `${STORAGE_ACK_MAX_STAGING_BYTES} byte limit — rejecting request`,
          );
        }
        // byteSize parity: a curated update prices off the catalog footprint, so
        // the inline catalog bytes MUST equal the claimed `newByteSize`. NOTE:
        // UpdateIntent has NO `publicByteSize` (unlike PublishIntent) — parity is
        // vs `newByteSize`, which the producer sets to the catalog byte count.
        const claimedNewByteSize = typeof intent.newByteSize === 'number'
          ? intent.newByteSize
          : Number(
              BigInt(intent.newByteSize.low >>> 0) |
                (BigInt(intent.newByteSize.high >>> 0) << 32n),
            );
        if (intent.stagingQuads.length !== claimedNewByteSize) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK byteSize mismatch: inline catalog is ${intent.stagingQuads.length} bytes ` +
            `but publisher claims newByteSize=${claimedNewByteSize}. For curated updates newByteSize MUST ` +
            `equal the catalog N-quads byte count.`,
          );
        }
        const claimedCatalogLeafCount = intent.newCatalogLeafCount ?? 0;
        if (claimedCatalogLeafCount <= 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK requires a positive newCatalogLeafCount; got ${claimedCatalogLeafCount}`,
          );
        }
        // Rebuild over the SHARED committed-leaf definition (post-publish stamps
        // stripped) so the rebuilt root is byte-identical to the producer's
        // committed root AND the prover's later rebuild. DECLINE on disagreement.
        const parsedCatalog = parseSimpleNQuads(
          new TextDecoder().decode(intent.stagingQuads),
        );
        const committedLeaves = catalogCommittedLeaves(parsedCatalog);
        if (committedLeaves.length === 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            'curated UPDATE ACK: inline catalog parsed to zero committed leaves',
          );
        }
        const rebuilt = computeCatalogRoot(committedLeaves);
        if (rebuilt.leafCount !== claimedCatalogLeafCount) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK leaf-count mismatch: rebuilt ${rebuilt.leafCount} catalog leaves ` +
            `but publisher claims ${claimedCatalogLeafCount}`,
          );
        }
        if (!bytesEqual(rebuilt.root, intent.newCatalogRoot)) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK root mismatch: rebuilt catalog root=${ethers.hexlify(rebuilt.root).slice(0, 18)}... ` +
            `does not match publisher claim=${ethers.hexlify(intent.newCatalogRoot).slice(0, 18)}...`,
          );
        }
        // Root verified — REPLACE-persist the updated public catalog to
        // `<cg>/_catalog` so this core serves + later proves the rotated root.
        // `assertSafeIri` stays OUTSIDE the persist helper: an unsafe IRI is
        // malformed-request territory (stream reset), not a store outage. A
        // store outage during the persist returns the same transient decline
        // as the publish handler's catalog persist (shared helper).
        const catalogGraph = contextGraphCatalogUri(cgId);
        assertSafeIri(catalogGraph);
        const persistedCatalog = await this.persistCatalogOrDecline(cgId, catalogGraph, parsedCatalog, signal);
        if (!persistedCatalog.ok) return persistedCatalog.decline;
      }
      // Encrypted updates trust the publisher's claimed newMerkleRoot —
      // no recompute. Fall through to the digest sign below.
    } else if (graphUpdate) {
      let publicQuads: Quad[];
      let inlineByteLength: number | undefined;
      if (intent.stagingQuads && intent.stagingQuads.length > 0) {
        if (intent.stagingQuads.length > STORAGE_ACK_MAX_STAGING_BYTES) {
          throw new Error(
            `UpdateStorageACK: stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
            `${STORAGE_ACK_MAX_STAGING_BYTES} byte limit — rejecting request`,
          );
        }
        publicQuads = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
        inlineByteLength = intent.stagingQuads.length;
      } else if (graphUpdate.publicTripleCount === 0) {
        publicQuads = [];
      } else {
        const loadedSWM = await this.loadSWMOrDecline(cgId, swmGraphUri, [], signal);
        if (!loadedSWM.ok) return loadedSWM.decline;
        publicQuads = loadedSWM.quads;
      }
      if (publicQuads.length !== graphUpdate.publicTripleCount) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: graph-scoped public triple count mismatch: ` +
            `intent=${graphUpdate.publicTripleCount}, local=${publicQuads.length}`,
        );
      }
      const validation = validateKnowledgeAssetPublishRequest(
        inlineByteLength === undefined
          ? publicQuads.map((quad) => ({ ...quad, graph: swmGraphUri }))
          : publicQuads,
        // Inline public graph updates are emitted by DKGPublisher from its
        // materialized per-KA VM graph. Only the no-inline fallback loads the
        // source per-KA SWM graph. Keeping these provenance-specific graph
        // expectations separate prevents every ordinary public update from
        // being declined while still rejecting a payload stamped for an
        // unrelated graph.
        inlineByteLength === undefined ? swmGraphUri : inlineVmGraphUri!,
        graphUpdate.publicTripleCount,
        // ACK verification operates on a canonical graph-scoped payload. The
        // exact c14n form is legitimate protocol output (for example Markdown
        // section nodes); the validator still rejects arbitrary/private uses
        // of the reserved namespace before signing an ACK.
        { allowCanonicalSkolemTerms: true },
      );
      if (!validation.valid) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: invalid graph-scoped RDF: ${validation.errors.join('; ')}`,
        );
      }
      const privateRoots = graphUpdate.privateMerkleRoot
        ? [graphUpdate.privateMerkleRoot]
        : [];
      const recomputedRoot = computeFlatKCRoot(publicQuads, privateRoots);
      if (!bytesEqual(recomputedRoot, newMerkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: graph-scoped newMerkleRoot mismatch: ` +
            `publisher=${ethers.hexlify(newMerkleRoot).slice(0, 18)}..., ` +
            `computed=${ethers.hexlify(recomputedRoot).slice(0, 18)}... ` +
            `(${publicQuads.length} public triples)`,
        );
      }
      const recomputedLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, privateRoots);
      const claimedLeafCount = intent.newMerkleLeafCount == null
        ? 0
        : Number(intent.newMerkleLeafCount);
      if (claimedLeafCount !== recomputedLeafCount) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: graph-scoped newMerkleLeafCount mismatch: ` +
            `intent=${claimedLeafCount}, computed=${recomputedLeafCount}`,
        );
      }
      if (inlineByteLength !== undefined) {
        publicUpdateByteSizeFloor = BigInt(inlineByteLength);
        publicUpdateFloorBasis = 'exact inline payload bytes';
      } else {
        publicUpdateByteSizeFloor = 0n;
        for (const quad of publicQuads) {
          publicUpdateByteSizeFloor +=
            BigInt(Buffer.byteLength(quad.subject, 'utf8'))
            + BigInt(Buffer.byteLength(quad.predicate, 'utf8'))
            + BigInt(Buffer.byteLength(quad.object, 'utf8'));
        }
        publicUpdateFloorBasis = 'Σ UTF-8 term bytes (lower bound)';
      }
    } else if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      if (intent.stagingQuads.length > STORAGE_ACK_MAX_STAGING_BYTES) {
        throw new Error(
          `UpdateStorageACK: stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${STORAGE_ACK_MAX_STAGING_BYTES} byte limit — rejecting request`,
        );
      }
      const parsed = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      if (parsed.length === 0) {
        throw new Error('UpdateStorageACK: stagingQuads present but contained no parseable N-Quads');
      }
      const recomputedRoot = computeFlatKCRoot(parsed, []);
      if (!bytesEqual(recomputedRoot, newMerkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: newMerkleRoot mismatch (inline quads): publisher=${ethers.hexlify(newMerkleRoot).slice(0, 18)}..., ` +
          `computed=${ethers.hexlify(recomputedRoot).slice(0, 18)}... (${parsed.length} triples) — refusing to ACK`,
        );
      }
      // #1283: public inline update — the core received the EXACT serialized
      // payload, so require the signed newByteSize to cover its full byte length
      // (mirrors the public-publish floor). Without this a publisher can ship a
      // correct new root while under-declaring newByteSize to underpay the
      // on-chain storage-growth charge.
      publicUpdateByteSizeFloor = BigInt(intent.stagingQuads.length);
      publicUpdateFloorBasis = 'exact inline payload bytes';
    } else {
      // Fallback: data should already be in SWM (publishFromSharedMemory
      // remap / SWM-resolution path). Reuse the publish branch's SWM
      // CONSTRUCT + recompute + typed-decline shape via the shared
      // `loadSWMOrDecline` helper — including the dead-air fix: a store-op
      // failure inside loadSWMQuads becomes a transient decline instead of a
      // stream reset (malformed-request assertSafeIri throws still propagate
      // + reset).
      const loadedSWM = await this.loadSWMOrDecline(cgId, swmGraphUri, [], signal);
      if (!loadedSWM.ok) return loadedSWM.decline;
      const swmQuads = loadedSWM.quads;
      if (swmQuads.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
          `UpdateStorageACK: no data found in SWM graph ${swmGraphUri}`,
        );
      }
      const recomputedRoot = computeFlatKCRoot(swmQuads, []);
      if (!bytesEqual(recomputedRoot, newMerkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: newMerkleRoot mismatch (SWM): publisher=${ethers.hexlify(newMerkleRoot).slice(0, 18)}..., ` +
          `local=${ethers.hexlify(recomputedRoot).slice(0, 18)}... (${swmQuads.length} triples in SWM)`,
        );
      }
      // #1283: public SWM-fallback update — the original serialization isn't
      // byte-reconstructable, so use the serialization-independent lower bound
      // Σ(UTF-8 byteLength(s,p,o)) (mirrors the public-publish SWM floor).
      publicUpdateByteSizeFloor = 0n;
      for (const q of swmQuads) {
        publicUpdateByteSizeFloor +=
          BigInt(Buffer.byteLength(q.subject, 'utf8')) +
          BigInt(Buffer.byteLength(q.predicate, 'utf8')) +
          BigInt(Buffer.byteLength(q.object, 'utf8'));
      }
      publicUpdateFloorBasis = 'Σ UTF-8 term bytes (lower bound)';
    }

    // Derive the bigint digest inputs. Fail loud on non-numeric / non-
    // positive on-chain ids — the contract rejects `contextGraphId == 0`,
    // so signing against it would just produce a signature it rejects.
    let contextGraphIdBigInt: bigint;
    try {
      contextGraphIdBigInt = BigInt(cgId);
    } catch {
      throw new Error(
        `UpdateStorageACK: V10 update requires a numeric on-chain context graph id; got '${cgId}'.`,
      );
    }
    if (contextGraphIdBigInt <= 0n) {
      throw new Error(
        `UpdateStorageACK: V10 update requires a positive on-chain context graph id; got ${contextGraphIdBigInt}.`,
      );
    }
    let kaIdBigInt: bigint;
    try {
      kaIdBigInt = BigInt(intent.kaId);
    } catch {
      throw new Error(`UpdateStorageACK: kaId must be a numeric decimal string; got '${intent.kaId}'.`);
    }
    const preUpdateMerkleRootCount = updateIntentUint64(intent.preUpdateMerkleRootCount);
    const newByteSize = typeof intent.newByteSize === 'number'
      ? BigInt(intent.newByteSize)
      : BigInt(intent.newByteSize.low >>> 0) | (BigInt(intent.newByteSize.high >>> 0) << 32n);

    // #1283: enforce the PUBLIC-update byteSize floor before signing. Mirrors
    // the public-publish BYTESIZE_UNDERCLAIM gate. Nothing on-chain can see the
    // content, and the contract only charges growth when newByteSize >
    // currentByteSize (KnowledgeAssetsLifecycle._executeUpdateCore), so an
    // under-declared newByteSize would let a publisher grow real public storage
    // for free. Curated updates already enforce catalog byteSize parity above.
    if (publicUpdateByteSizeFloor !== null && newByteSize < publicUpdateByteSizeFloor) {
      return this.encodeDecline(
        cgId,
        STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM,
        `public UPDATE ACK byteSize under-claim: publisher claims newByteSize=${newByteSize} ` +
        `but the attested updated content requires at least ${publicUpdateByteSizeFloor} UTF-8 bytes ` +
        `(${publicUpdateFloorBasis}). Refusing to sign an under-priced footprint.`,
      );
    }
    const newTokenAmount = intent.newTokenAmount && intent.newTokenAmount.length > 0
      ? BigInt(intent.newTokenAmount)
      : 0n;
    const mintAmount = intent.mintAmount == null
      ? 0n
      : (typeof intent.mintAmount === 'number'
          ? BigInt(intent.mintAmount)
          : BigInt(intent.mintAmount.low >>> 0) | (BigInt(intent.mintAmount.high >>> 0) << 32n));
    const burnTokenIds = (intent.burnTokenIds ?? []).map((id) => BigInt(id));
    const newMerkleLeafCount = intent.newMerkleLeafCount == null ? 0 : Number(intent.newMerkleLeafCount);
    // The encrypted branch above has already proven this is a curated CG and,
    // when supplied, independently verified its public catalog commitment.
    // Curated sampling uses that catalog count, so a fully private assertion
    // legitimately has zero public Merkle leaves. Public updates stay > 0.
    if (
      !Number.isInteger(newMerkleLeafCount)
      || newMerkleLeafCount < 0
      || (newMerkleLeafCount === 0 && intent.isEncryptedPayload !== true)
    ) {
      throw new Error(
        `UpdateStorageACK: newMerkleLeafCount must be positive for public KAs ` +
          `(zero is valid only for curated encrypted updates); got ${newMerkleLeafCount}`,
      );
    }

    // 13-field UPDATE ACK digest — byte-identical to
    // `KnowledgeAssetsLifecycle._executeUpdateCore`. The token amount is
    // floored INSIDE `computeUpdateACKDigest` (floorPublishTokenAmount),
    // matching the on-chain submission, so the publisher and this signer
    // bind the same `newTokenAmount` wire value.
    const digest = computeUpdateACKDigest(
      this.config.chainId,
      this.config.kav10Address,
      contextGraphIdBigInt,
      kaIdBigInt,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      BigInt(newMerkleLeafCount),
      catalogRootForAckDigest(intent.newCatalogRoot),
      BigInt(intent.newCatalogLeafCount ?? 0),
    );

    const updateSignerGate = await this.checkSignerRegistrationOrDecline(
      cgId,
      'UpdateStorageACK signer is not confirmed on-chain as an operational wallet',
    );
    if (!updateSignerGate.ok) return updateSignerGate.decline;

    const signature = ethers.Signature.from(
      await this.config.signerWallet.signMessage(digest),
    );
    const MAX_UINT64 = (1n << 64n) - 1n;
    if (this.config.nodeIdentityId > MAX_UINT64) {
      throw new Error(
        `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format`,
      );
    }
    const subscriptionSource = this.config.getSubscriptionSourceForCg?.(
      cgId,
      swmGraphId !== cgId ? swmGraphId : undefined,
    );
    return encodeStorageACK({
      merkleRoot: newMerkleRoot,
      coreNodeSignatureR: ethers.getBytes(signature.r),
      coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
      contextGraphId: cgId,
      nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this.config.nodeIdentityId)
        : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
      ...(subscriptionSource ? { subscriptionSource } : {}),
    });
  };

  private async loadSWMQuads(
    graphUri: string,
    rootEntities: string[],
    signal?: AbortSignal,
  ): Promise<Quad[]> {
    assertSafeIri(graphUri);
    for (const entity of rootEntities) {
      assertSafeIri(entity);
    }
    // The publisher computes the KC merkle root over its SWM read with the
    // trust-level / workspace-owner bookkeeping quads filtered OUT
    // (`isSwmMerkleExcludedQuad`). The core responder recomputes the same root
    // from its OWN SWM copy here, so it MUST apply the identical exclusion —
    // otherwise any trust-level/workspace-owner quad resident in the core's
    // store is hashed on one side but not the other and every folded-private
    // ACK declines MERKLE_MISMATCH_IN_SWM (2026-07-07 Gnosis mainnet). Shared
    // single-source filter so the two paths can never drift again.
    //
    // A3 (O(store) relief): go through the shared `loadSelectedSharedMemoryQuads`
    // helper, which binds the SWM graph set through the fast named-graph index
    // (`VALUES ?g`) instead of an unbounded `GRAPH ?g` + STRSTARTS scan — this
    // recompute runs on the ACK-deadline-critical responder that was starving
    // under load. Using the SAME helper as the publisher's merkle read keeps
    // graph selection AND the merkle-exclusion filter single-sourced, so the two
    // recomputes can never drift. The explicit `assertSafeIri(...)` guards above
    // stay ordinary malformed-request throws; a store/index failure inside the
    // read is re-tagged `StoreUnavailableError` (→ CORE_TEMPORARILY_UNAVAILABLE).
    const selection: SharedMemoryReadSelection =
      rootEntities.length === 0 ? 'all' : { rootEntities };
    try {
      return await loadSelectedSharedMemoryQuads(this.store, graphUri, selection, {
        queryOptions: ackStoreOptions(
          rootEntities.length === 0
            ? 'storage-ack.loadSWMQuads.constructAll'
            : 'storage-ack.loadSWMQuads.constructEntity',
          signal,
        ),
        quadFilter: (q) => !isSwmMerkleExcludedQuad(q),
      });
    } catch (err) {
      throw new StoreUnavailableError(err);
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
