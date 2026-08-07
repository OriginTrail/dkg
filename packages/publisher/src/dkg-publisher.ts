import type { Quad, SharedMemoryGraphScope, TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter, OnChainPublishResult, AddBatchToContextGraphParams } from '@origintrail-official/dkg-chain';
import { enrichEvmError } from '@origintrail-official/dkg-chain';
import type { EventBus, GraphKnowledgeAssetScope, OperationContext } from '@origintrail-official/dkg-core';
import type { AssertionSeal } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, sha256, encodeWorkspacePublishRequest, encodeEncryptedWorkspacePayload, encryptWorkspacePayload, contextGraphDataUri, contextGraphDataGraphUri, contextGraphMetaUri, contextGraphPrivateUri, contextGraphAssertionUri, contextGraphLayerUri, MemoryLayer, assertionLifecycleUri, contextGraphSubGraphUri, contextGraphSubGraphMetaUri, contextGraphSubGraphPrivateUri, SYSTEM_CONTEXT_GRAPHS, validateSubGraphName, isSafeIri, assertSafeIri, assertSafeRdfTerm, assertQuadLiteralsMutf8Safe, DKG_GOSSIP_MAX_MESSAGE_BYTES, SwmGossipPayloadTooLargeError, STORAGE_ACK_MAX_STAGING_BYTES, type Ed25519Keypair, buildAuthorAttestationTypedData, buildUpdateAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, TrustLevel, TRUST_LEVEL_PREDICATE, assertNoUserAuthoredTrustLevelQuads, buildTrustLevelQuads, isTrustLevelQuad, isSwmMerkleExcludedQuad, WORKSPACE_OWNER_PREDICATE, DKG_ENTITY, DKG_ROOT_ENTITY_LEGACY, ENTITY_PRED_ALT, parseAssertionSealQuads, ASSERTION_SEAL_PREDICATES, DKG_ONTOLOGY, GRAPH_KA_CONTENT_SCOPE_VERSION, LegacyKnowledgeAssetReadOnlyError, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { GraphManager, invalidateSwmMaterializationWitness, PrivateContentStore, loadSharedMemoryQuadsForScope, loadSelectedSharedMemoryQuads, resolveSharedMemoryScopeGraphs, tryReplaceGraphAtomically } from '@origintrail-official/dkg-storage';
import { DEFAULT_PUBLISH_EPOCHS, MAX_PUBLISH_EPOCHS, type Publisher, type PublishOptions, type PublishResult, type KAManifestEntry, type PhaseCallback, type V10CoreNodeACK, type V10ACKProviderParams, type V10ACKProviderObject, type LegacyV10ACKProvider } from './publisher.js';
import { assertNoUserAuthoredKnowledgeAssetSkolemTerms, skolemizeByEntity, skolemizeKnowledgeAsset, skolemizeKnowledgeAssetParts } from './auto-partition.js';
import { assertNoKnowledgeAssetPayloadNamedGraphs } from './knowledge-asset-graph-policy.js';
import { withKeyedLocks } from './keyed-lock.js';
import { tagPromoteStep } from './promote-step-tag.js';
import { canonicalPublishPayload } from './canonical-publish-payload.js';
import {
  assertTrustedCatalogTriplesAreGeneratedFloor,
  catalogTripleKey,
  generatedPrivateCatalogFloorQuads,
  splitTrustedGeneratedCatalogRootMap,
  trustedCatalogTripleKeySet,
} from './catalog-trust.js';
import { partitionCatalogQuads, catalogCommittedLeaves, computeCatalogRoot, contextGraphCatalogUri, isAgentRegistryContextGraph } from '@origintrail-official/dkg-core';
import { RESERVED_SUBJECT_PREFIXES, findReservedSubjectPrefix, isReservedSubject } from './reserved-subjects.js';
import { skolemize } from './skolemize.js';
import {
  computeTripleHashV10 as computeTripleHash,
  computePrivateRootV10 as computePrivateRoot,
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from './merkle.js';
import {
  validateCanonicalGraphScopedKnowledgeAssetPayload,
  validatePublishRequest,
} from './validation.js';
import { isFailClosedInlineEncrypt } from './async-lift-publish-options.js';
import {
  assertionOriginalGraph,
  assertionScopedGraphUri,
  listAssertionScopedGraphUris,
  listGraphsByPrefix,
} from './assertion-scoped-graphs.js';
import {
  generateConfirmedFullMetadata,
  generateGraphKnowledgeAssetMetadata,
  replaceLocallyTrustedKnowledgeAssetControls,
  buildDeterministicTokenRows,
  compareRootIris,
  generateOwnershipQuads,
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateAssertionDiscardedMetadata,
  generateTentativeMetadata,
  WM_CURRENT_ASSERTION_PRED,
  SWM_CURRENT_ASSERTION_PRED,
  VM_CURRENT_ASSERTION_PRED,
  SHARE_OPERATION_ID_PRED,
  PROMOTE_OPERATION_INTENT_PRED,
  stripOptionalLiteral,
  toHex,
  buildScopedMinimalMeta,
  resolveUalByBatchId,
  promoteUpdatedKaToPerCgId,
  restateLabelGraphForUpdate,
  shouldApplyMaterialization,
  withMaterializationLock,
  writeMaterializedVersion,
  type MaterializedVersion,
  type KAMetadata,
  type OnChainProvenance,
} from './metadata.js';
import {
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  storeWorkspaceOperationPublicQuads,
} from './workspace-resolution.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';
import { ethers } from 'ethers';
import type { WorkspaceAgentRecipientResolver } from './workspace-agent-recipients.js';
import {
  PublisherWalletRequiredError,
  StaleWriteError,
  ReservedNamespaceError,
  AssertionNotPersistedError,
  MultiRootPublishNotAtomicError,
  CuratorUnconfirmedError,
  CuratorRejectedError,
  type CASCondition,
} from './errors.js';
import { isQuorumUnmetError } from './ack-errors.js';
import {
  runLegacyWorkingMemoryMigration,
  type LegacyWmMigrationHost,
  type LegacyWmMigrationResult,
} from './legacy-wm-migration.js';
import { PublishLifecycleLogger } from './publish-lifecycle-logger.js';
import {
  PublisherPlanner,
  coercePublisherAddress,
  type PublisherAddressResolution,
  type PublisherSigner,
} from './publisher-planning.js';

export { RESERVED_SUBJECT_PREFIXES, findReservedSubjectPrefix, isReservedSubject } from './reserved-subjects.js';
// Typed errors + the CAS condition payload live in ./errors.js now; re-export
// them here so `./dkg-publisher.js` (and the package index, which re-exports
// from this module) stays the stable import path for every consumer.
export {
  PublisherWalletRequiredError,
  StaleWriteError,
  ReservedNamespaceError,
  AssertionNotPersistedError,
  MultiRootPublishNotAtomicError,
  CuratorUnconfirmedError,
  CuratorRejectedError,
  type CASCondition,
};

// #1116 (review A1) — marker predicate stamped on the lifecycle URN when a KA
// has been FULLY shared to SWM (entities:"all", all roots landed). It gates
// finalize(layer:"swm") so a subset share — which also stamps dkg:rootEntity
// member rows — cannot be sealed-in-SWM and published as a partial asset.
const SWM_SHARE_COMPLETE_PRED = 'http://dkg.io/ontology/swmShareComplete';

type PromoteOperationIntent = {
  version: 1;
  operationId: string;
  timestampMs: number;
  publisherPeerId?: string;
  confirmationRequired: boolean;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
};

type AssertionPromoteOptions = {
  entities?: string[] | 'all';
  subGraphName?: string;
  publisherPeerId?: string;
  senderAgentAddress?: string;
  /** Do not encrypt or emit a network-ready payload for a local capture. */
  localOnly?: boolean;
  /** Immutable access envelope persisted with the graph-scoped share. */
  accessPolicy?: PublishOptions['accessPolicy'];
  allowedPeers?: readonly string[];
  trustedNonManifestCatalogTriples?: PublishOptions['trustedNonManifestCatalogTriples'];
  onChainContextGraphId?: string | bigint;
  /**
   * Strict curator-ack gate (OT-RFC-49 curator-leader), same contract as
   * `ShareOptions.confirmBeforeCommit`: called after the gossip message is
   * built and BEFORE the WM→SWM mutation. `applied: false` aborts the promote
   * (CuratorUnconfirmedError / CuratorRejectedError) leaving WM intact.
   */
  confirmBeforeCommit?: (message: Uint8Array) => Promise<{ applied: boolean; rejected?: boolean }>;
};

type AssertionPromoteResult = {
  promotedCount: number;
  gossipMessage?: Uint8Array;
  promotedAllRoots: boolean;
  shareOperationId?: string;
};

/**
 * Resolve the public catalog proof material independently from a V2 KA's
 * canonical RDF payload.
 *
 * Legacy root-scoped publishes retain the combined-model partition: catalog
 * rows already present in the payload stay committed by the KC root. A
 * graph-scoped KA is different: every submitted triple is atomic asset data,
 * including a user-authored triple whose subject happens to be the CG DID.
 * Its protocol-owned private-CG floor is therefore generated into a detached
 * catalog commitment and must never be removed from, or appended to, the KA.
 */
function resolveCatalogProofMaterial(
  quads: readonly Quad[],
  contextGraphId: string,
  graphScoped: boolean,
  trustedKeys: PublishOptions['trustedNonManifestCatalogTriples'],
  memberDataGraph: string,
): { catalogQuads: Quad[]; otherQuads: Quad[] } {
  if (!graphScoped) {
    return partitionCatalogQuads(quads, contextGraphDataUri(contextGraphId));
  }
  return {
    catalogQuads: trustedCatalogTripleKeySet(trustedKeys).size > 0
      ? generatedPrivateCatalogFloorQuads(contextGraphId)
      : [],
    // Graph-scoped canonicalization deliberately hashes graph-less triples,
    // but the same payload is later serialized as N-Quads for member-side
    // encryption. Stamp the exact per-KA VM graph here so that serialization
    // cannot emit the invalid empty graph IRI `<>`.
    otherQuads: quads.map((quad) => ({ ...quad, graph: memberDataGraph })),
  };
}

/**
 * Verify the off-band owner authorization before any update payload is staged.
 *
 * Both the agent's direct-update boundary and the publisher's final chain
 * submission call this helper. Keeping the verification here prevents the two
 * layers from drifting while allowing callers to reject an unauthorized update
 * before replacing local SWM or private state.
 */
export async function assertValidPrecomputedUpdateAttestation(
  chain: ChainAdapter,
  kaId: bigint,
  merkleRoot: Uint8Array,
  updateSeal: NonNullable<PublishOptions['precomputedUpdateAttestation']>,
): Promise<void> {
  const expected = updateSeal.expectedNewMerkleRoot;
  if (
    expected.length !== merkleRoot.length
    || !expected.every((byte, index) => byte === merkleRoot[index])
  ) {
    throw new Error(
      `precomputedUpdateAttestation.expectedNewMerkleRoot mismatch: seal expects ${ethers.hexlify(expected)} `
      + `but update-time recompute yielded ${ethers.hexlify(merkleRoot)}.`,
    );
  }

  const v10ChainId = await chain.getEvmChainId?.();
  const v10KavAddress = await chain.getKnowledgeAssetsLifecycleAddress?.();
  if (v10ChainId === undefined || !v10KavAddress) {
    throw new Error(
      'V10 update requires getEvmChainId() and getKnowledgeAssetsLifecycleAddress() on the chain adapter.',
    );
  }

  const updateAuthorTyped = buildUpdateAuthorAttestationTypedData({
    chainId: v10ChainId,
    kav10Address: v10KavAddress,
    kaId,
    newMerkleRoot: merkleRoot,
    authorAddress: updateSeal.authorAddress,
    schemeVersion: updateSeal.schemeVersion,
  });
  const signature = ethers.Signature.from({
    r: ethers.hexlify(updateSeal.signature.r),
    yParityAndS: ethers.hexlify(updateSeal.signature.vs),
  });
  const digest = ethers.TypedDataEncoder.hash(
    updateAuthorTyped.domain,
    updateAuthorTyped.types,
    updateAuthorTyped.message,
  );
  const isContractAuthor = typeof chain.hasContractCode === 'function'
    ? await chain.hasContractCode(updateSeal.authorAddress)
    : false;
  if (isContractAuthor) {
    if (typeof chain.verifyContractSignature !== 'function') {
      throw new Error(
        'V10 contract-author update authorization requires verifyContractSignature() on the chain adapter.',
      );
    }
    const valid = await chain.verifyContractSignature(
      updateSeal.authorAddress,
      digest,
      signature.serialized,
    );
    if (!valid) {
      throw new Error(
        `precomputedUpdateAttestation contract signature is invalid for ${updateSeal.authorAddress}.`,
      );
    }
  } else {
    const recovered = ethers.recoverAddress(digest, signature);
    if (recovered.toLowerCase() !== updateSeal.authorAddress.toLowerCase()) {
      throw new Error(
        `precomputedUpdateAttestation signer mismatch: recovers ${recovered} `
        + `but claims ${updateSeal.authorAddress}.`,
      );
    }
  }

  if (typeof chain.getKnowledgeAssetOwner !== 'function') {
    throw new Error(
      'V10 update authorization requires getKnowledgeAssetOwner() on the chain adapter.',
    );
  }
  const currentOwner = ethers.getAddress(await chain.getKnowledgeAssetOwner(kaId));
  const claimedAuthor = ethers.getAddress(updateSeal.authorAddress);
  if (currentOwner !== claimedAuthor) {
    throw Object.assign(
      new Error(
        `precomputedUpdateAttestation author ${claimedAuthor} is not the current owner `
        + `${currentOwner} of Knowledge Asset ${kaId.toString()}.`,
      ),
      {
        code: 'KA_UPDATE_AUTHOR_NOT_OWNER',
        kaId: kaId.toString(),
        currentOwner,
        authorAddress: claimedAuthor,
      },
    );
  }
}

/**
 * Decode a chain rejection to its contract error name for update() failure
 * classification. Prefers the adapter's `enrichEvmError` decode, falling back
 * to an ethers-predecoded `revert.name`. Shared by update()'s pre-staging owner
 * check and its chain-submit path so both classify rejections identically.
 */
function extractV10UpdateRejectionName(err: unknown): string | undefined {
  return enrichEvmError(err) ?? (err as { revert?: { name?: string } })?.revert?.name;
}

/**
 * Reverts the pre-staging owner check (`getKnowledgeAssetOwner` -> `ownerOf`)
 * can surface that mean "there is no updatable KA on chain" — update() returns
 * a failed result instead of throwing. Deliberately a strict subset of
 * {@link V10_DEFINITIVE_UPDATE_ERRORS}: an authorization failure (wrong owner,
 * bad signature) must still THROW before staging. Expiry/immutability are NOT
 * here — those are submit-time reverts from `KnowledgeAssetsLifecycle`, never
 * from the storage contract's `ownerOf`, so they cannot reach this check.
 */
const PRE_STAGING_NO_UPDATABLE_KA_ERRORS = ['ERC721NonexistentToken'];

/**
 * Definitive chain rejections at update submit — convert to a failed result
 * rather than throw (by submit time the KA/authorship are already validated).
 */
const V10_DEFINITIVE_UPDATE_ERRORS = [
  'NotKnowledgeAssetOwner',
  'InvalidAuthorSignature',
  'InvalidAuthorSignature1271',
  'AuthorRequired',
  'KnowledgeAssetExpired',
  'CannotUpdateImmutableKnowledgeAsset',
  'ExceededKnowledgeAssetBatchSize',
];

async function validateGraphScopedPayloadAgainstSeal(
  seal: AssertionSeal,
  publicQuads: readonly Quad[],
  privateQuads: readonly Quad[],
  sourceLabel: string,
): Promise<{
  normalizedPublicQuads: Quad[];
  normalizedPrivateQuads: Quad[];
  privateMerkleRoot: Uint8Array | undefined;
}> {
  assertNoKnowledgeAssetPayloadNamedGraphs(publicQuads, privateQuads);
  const normalizedParts = await skolemizeKnowledgeAssetParts(
    [...publicQuads],
    [...privateQuads],
    { allowCanonicalSkolemTerms: true },
  );
  const normalizedPublicQuads = normalizedParts.publicQuads;
  const normalizedPrivateQuads = normalizedParts.privateQuads;
  if (normalizedPublicQuads.length !== seal.publicTripleCount) {
    throw new Error(
      `Graph-scoped assertion triple-count mismatch: seal=${seal.publicTripleCount}, `
      + `${sourceLabel}=${normalizedPublicQuads.length}`,
    );
  }
  if (normalizedPrivateQuads.length !== seal.privateTripleCount) {
    throw new Error(
      `Graph-scoped assertion private triple-count mismatch: seal=${seal.privateTripleCount}, `
      + `private-store=${normalizedPrivateQuads.length}`,
    );
  }
  const privateMerkleRoot = computePrivateRoot(normalizedPrivateQuads);
  const privateRootMatches = seal.privateMerkleRoot === undefined
    ? privateMerkleRoot === undefined
    : privateMerkleRoot !== undefined
      && seal.privateMerkleRoot.length === privateMerkleRoot.length
      && seal.privateMerkleRoot.every((byte, index) => byte === privateMerkleRoot[index]);
  if (!privateRootMatches) {
    throw new Error(
      `Graph-scoped assertion private Merkle mismatch: seal=${seal.privateMerkleRoot
        ? ethers.hexlify(seal.privateMerkleRoot)
        : '(none)'}, private-store=${privateMerkleRoot
        ? ethers.hexlify(privateMerkleRoot)
        : '(none)'}`,
    );
  }
  const merkleRoot = computeFlatKCRoot(
    normalizedPublicQuads,
    privateMerkleRoot ? [privateMerkleRoot] : [],
  );
  if (
    merkleRoot.length !== seal.merkleRoot.length
    || !merkleRoot.every((byte, index) => byte === seal.merkleRoot[index])
  ) {
    throw new Error(
      `Graph-scoped assertion Merkle mismatch: seal=${ethers.hexlify(seal.merkleRoot)}, `
      + `${sourceLabel}=${ethers.hexlify(merkleRoot)}`,
    );
  }
  return { normalizedPublicQuads, normalizedPrivateQuads, privateMerkleRoot };
}

async function listGraphFamily(store: TripleStore, rootGraph: string): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`);
  if (await store.hasGraph(rootGraph)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

type PublishedSwmCleanupPlan =
  | { kind: 'complete-family'; dataGraphs: string[] }
  | { kind: 'named-lifecycle'; dataGraphs: string[] };

/**
 * Minimal structural view of the OT-RFC-43 Option-1 KA-number allocator the
 * publisher needs to mint deterministic packed ids. The concrete
 * `KaNumberAllocator` (packages/agent) satisfies this; typing it structurally
 * here avoids an agent→publisher dependency cycle.
 */
export interface KaIdAllocator {
  /** Allocate the next packed kaId = (uint160(author)<<96)|number for `author`. */
  allocate(author: string): { kaId: bigint; number: bigint };
  /** Raise the per-author floor to `observedNumber + 1` (never lower) so the next allocate skips minted numbers.
   *  `observedNumber` is a `bigint` end-to-end (OT-RFC-43 Option-1, PR #976 F6) — the per-author number can
   *  exceed 2^53, so `Number` would silently lose precision and let the allocator re-issue a minted id. */
  reconcile(author: string, observedNumber: bigint): void;
  /** Satisfy the allocator's cold-start guard once reconciliation has run. */
  markReconciled(): void;
}

export interface DKGPublisherConfig {
  store: TripleStore;
  chain: ChainAdapter;
  eventBus: EventBus;
  keypair: Ed25519Keypair;
  publisherNodeIdentityId?: bigint;
  publisherAddress?: string;
  /** Retryable publisher address resolver for adapter-backed signing. */
  publisherAddressResolver?: (contextGraphId?: bigint) => Promise<string | undefined>;
  /** EVM private key for signing publish requests (hex string with 0x prefix) */
  publisherPrivateKey?: string;
  /**
   * Additional EVM private keys whose identities can act as receiver
   * signers for the `contextGraphSignatures` path of `publishSharedMemory`
   * (the post-confirmation context-graph verify step). NOT used for V10
   * StorageACK collection — ACKs are always gathered from real connected
   * core peers via `ack-collector.ts`.
   */
  additionalSignerKeys?: string[];
  /** Shared map of SWM-owned rootEntities per context graph: entity → creatorPeerId. Pass from agent so handler and publisher stay in sync. */
  sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
  /** Shared batch→context graph binding map. Pass to UpdateHandler so it uses trusted local bindings. */
  knownBatchContextGraphs?: Map<string, string>;
  /** Shared write lock map. Pass to SharedMemoryHandler so gossip writes serialize against CAS writes. */
  writeLocks?: Map<string, Promise<void>>;
  /** Resolves DKG-agent public encryption keys for private/agent-gated remote SWM gossip. */
  workspaceAgentRecipientResolver?: WorkspaceAgentRecipientResolver;
  /** Encrypts private/agent-gated SWM gossip with the node's Sender Key epoch state. */
  workspaceSenderKeyEncryptor?: WorkspaceSenderKeyEncryptor;
  /** Optional out-of-Oxigraph store for immutable public SWM operation snapshots. */
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * OT-RFC-43 Option 1 — when present, the publisher allocates a deterministic
   * packed reservedKaId for each V10 mint (and reconciles the per-author floor
   * against the chain on first use). Omit for mock/no-chain or pre-Option-1
   * flows; the real EVM adapter then throws on the missing reservedKaId.
   */
  kaAllocator?: KaIdAllocator;
  /**
   * RFC ka-metadata-trim Phase 3 (P3.3) — `metadata.provenanceEvents` config.
   * Default `true`. When `false` ("lite mode"), the lifecycle writers skip the
   * per-transition PROV event nodes (`dkg:AssertionCreated` /
   * `dkg:AssertionPromoted` activities) but keep every state/identity row on
   * the lifecycle subject; the history API returns `events: []` gracefully.
   */
  provenanceEvents?: boolean;
}

/**
 * Publisher instances that target the same in-process store must serialize
 * lifecycle mutations together. A per-instance default lets a writer race a
 * promote in another publisher and disappear when promote drops the stale WM
 * snapshot. Explicitly supplied locks still win so the agent can share its
 * wider handler lock domain with the publisher.
 */
const STORE_WRITE_LOCKS = new WeakMap<TripleStore, Map<string, Promise<void>>>();

function writeLocksForStore(
  store: TripleStore,
  suppliedLocks?: Map<string, Promise<void>>,
): Map<string, Promise<void>> {
  const existingLocks = STORE_WRITE_LOCKS.get(store);
  if (existingLocks) {
    if (suppliedLocks && suppliedLocks !== existingLocks) {
      throw new Error(
        'DKGPublisher instances sharing one TripleStore must share the same writeLocks map',
      );
    }
    return existingLocks;
  }
  const locks = suppliedLocks ?? new Map();
  STORE_WRITE_LOCKS.set(store, locks);
  return locks;
}

export interface WorkspaceSenderKeyEncryptInput {
  contextGraphId: string;
  plaintext: Uint8Array;
  senderAgentAddress: string;
  operationId: string;
  shareOperationId: string;
  timestampMs: number;
  subGraphName?: string;
  publisherPeerId: string;
}

export type WorkspaceSenderKeyEncryptor = (
  input: WorkspaceSenderKeyEncryptInput,
) => Promise<Uint8Array>;

interface PublisherAddressResolutionOptions {
  includeReservingPublisherProbe?: boolean;
  includeGenericSignMessageProbe?: boolean;
}

function normalizePublisherAddress(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid publisherAddress: "${address}" is not a valid EVM address`);
  }
  const normalized = ethers.getAddress(address);
  if (normalized === ethers.ZeroAddress) {
    throw new Error('Invalid publisherAddress: zero address is not a valid publisher');
  }
  return normalized;
}

function resolvePublishEpochsOverride(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PUBLISH_EPOCHS) {
    throw new Error(`publishEpochs must be a positive uint32 integer, got ${String(value)}`);
  }
  return value;
}

function isLegacyV10ACKProvider(
  provider: NonNullable<PublishOptions['v10ACKProvider']>,
): provider is LegacyV10ACKProvider {
  return provider.length > 1;
}

async function invokeV10ACKProvider(
  provider: NonNullable<PublishOptions['v10ACKProvider']>,
  params: V10ACKProviderParams,
): Promise<V10CoreNodeACK[]> {
  if (!isLegacyV10ACKProvider(provider)) {
    return (provider as V10ACKProviderObject)(params);
  }

  if (params.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(
      'Graph-scoped V10 ACK collection requires object-form v10ACKProvider ' +
      'so the complete content and access envelopes reach ACK replicas.',
    );
  }

  if (params.ackMode.kind === 'folded-private') {
    throw new Error(
      'Folded-private V10 ACK collection requires object-form v10ACKProvider ' +
      'so privateMerkleRoots reach the ACK collector.',
    );
  }

  const catalogCommitment = params.ackMode.kind === 'curated-catalog'
    ? params.ackMode.catalogCommitment
    : undefined;
  return provider(
    params.merkleRoot,
    params.contextGraphId,
    params.kaCount,
    params.rootEntities,
    params.publicByteSize,
    params.stagingQuads,
    params.epochs,
    params.tokenAmount,
    params.swmGraphId,
    params.subGraphName,
    params.merkleLeafCount,
    params.ackMode.kind === 'curated-catalog' ? true : undefined,
    catalogCommitment,
  );
}

function publisherAddressFromUal(ual: string | undefined): string | undefined {
  const prefix = 'did:dkg:';
  if (!ual?.startsWith(prefix)) return undefined;
  const segments = ual.slice(prefix.length).split('/');
  return coercePublisherAddress(segments[1]);
}

function formatBytesAsKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatGossipLimit(bytes: number): string {
  const mb = 1024 * 1024;
  if (bytes % mb === 0) return `${bytes / mb} MB`;
  return formatBytesAsKb(bytes);
}

function recoverCompactMessageSigner(
  message: Uint8Array,
  signature: { r: Uint8Array; vs: Uint8Array },
): string {
  const serialized = ethers.Signature.from({
    r: ethers.hexlify(signature.r),
    yParityAndS: ethers.hexlify(signature.vs),
  }).serialized;
  return ethers.verifyMessage(message, serialized);
}

export interface ShareOptions {
  publisherPeerId: string;
  operationCtx?: OperationContext;
  subGraphName?: string;
  localOnly?: boolean;
  senderAgentAddress?: string;
  /**
   * Strict curator-ack gate (OT-RFC-49 curator-leader). When provided, the
   * share path calls this AFTER building the signed wire message but BEFORE any
   * destructive store mutation, passing the exact message that would be
   * published. If it resolves `applied: false`, the write is ABORTED with NO
   * local persistence — `CuratorRejectedError` when `rejected: true`, otherwise
   * `CuratorUnconfirmedError`. The agent injects this to require the curator (the
   * authoritative replica) to have applied the write before the member commits
   * it locally, so a write the curator never received is never silently accepted.
   * Omitted (the default) preserves the legacy best-effort, commit-then-fan-out
   * behaviour for public CGs, `localOnly` writes, and non-gated callers.
   */
  confirmBeforeCommit?: (message: Uint8Array) => Promise<{ applied: boolean; rejected?: boolean }>;
}

/** @deprecated Use ShareOptions */
export type WriteToWorkspaceOptions = ShareOptions;

export interface ShareResult {
  shareOperationId: string;
  message: Uint8Array;
}

/** @deprecated Use ShareResult */
export type WriteToWorkspaceResult = ShareResult;

export interface ConditionalShareOptions extends ShareOptions {
  conditions: CASCondition[];
}

/** @deprecated Use ConditionalShareOptions */
export type ShareConditionalOptions = ConditionalShareOptions;

/** @deprecated Use ConditionalShareOptions */
export type WriteConditionalToWorkspaceOptions = ConditionalShareOptions;

// Round 9 Bug 25: protocol-reserved URN namespaces that MUST NOT appear
// as subjects in user-authored quads. These prefixes are owned by the
// daemon's import-file handler for file descriptors and extraction
// provenance per `19_MARKDOWN_CONTENT_TYPE.md §10.2`. Allowing user
// writes here would (a) collide with daemon bookkeeping across assertions
// and (b) get silently stripped by `assertionPromote`'s safety filter,
// which would be data loss from the user's perspective. Reject at the
// write boundary with a clear error that names the reserved prefix.
//
// The daemon's own import-file handler bypasses `assertion.write` via a
// direct `store.insert` (documented in `daemon.ts`), so the guard here
// only fires on user-facing entry points and never on the daemon's
// internal bookkeeping writes.
//
// Prefix form matches the `assertionPromote` defense-in-depth filter:
// bare `urn:dkg:file:` (not `urn:dkg:file:keccak256:`) so any future
// hash-algorithm variant (e.g., `urn:dkg:file:blake3:...`) is also
// covered without a guard update.
// Round 12 Bug 34: module-private token proving an internal caller
// (specifically `publishFromSharedMemory`) is the origin of a
// `publish()` call so the reserved-namespace guard can be bypassed
// for legitimate internal promote→publish flows WITHOUT exposing a
// public flag that external callers could set to bypass the guard.
//
// Round 9 Bug 25 used `options.fromSharedMemory` as the discriminator,
// but `fromSharedMemory` is a public `PublishOptions` field with its
// own user-facing semantic (signals to the V10 ACK path that data is
// already in peers' SWM). Any external caller could set it `true` and
// trivially bypass the guard, making `urn:dkg:file:*` writes possible
// via the public API — the exact class of bypass Round 9 was supposed
// to prevent. Codex Bug 34 caught this.
//
// The token is a module-scoped `Symbol` with no external references.
// Only code in this file can mint it. Public callers cannot forge it.
// Bypassing the guard therefore requires either being in this file
// (and thus code-reviewed for correctness) or not calling the guarded
// public entry points at all (the daemon's direct `store.insert`
// bypass, which is the other legitimate non-guard path).
const INTERNAL_ORIGIN_TOKEN = Symbol('dkg-publisher:internal-origin');
const TRUSTED_CATALOG_ORIGIN_TOKEN = Symbol('dkg-publisher:trusted-catalog-origin');
const PUBLIC_ACK_STAGING_MODE_TOKEN = Symbol('dkg-publisher:public-ack-staging-mode');
type PublicACKStagingMode = 'inline' | 'strict-swm' | 'inline-small-swm';
type InternalPublishOptions = PublishOptions & {
  [INTERNAL_ORIGIN_TOKEN]?: true;
  [TRUSTED_CATALOG_ORIGIN_TOKEN]?: true;
  [PUBLIC_ACK_STAGING_MODE_TOKEN]?: PublicACKStagingMode;
};

interface GraphScopedPublishDescriptor {
  scope: GraphKnowledgeAssetScope;
  /** Packed V10 kaId derived once from the immutable UAL author/number pair. */
  expectedPackedKaId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  expectedPrivateMerkleRoot?: Uint8Array;
}

/**
 * Return the numeric EIP-155 suffix carried by a DKG chain label.
 *
 * UALs in persisted jobs use both bare numeric labels (`31337`) and
 * namespaced labels (`evm:31337`, `base:8453`).  The adapter exposes the
 * authoritative numeric network through `getEvmChainId()`, so representation
 * aliases must compare by that value rather than by their raw strings.
 */
function numericEvmChainId(chainId: string): bigint | undefined {
  const match = /(?:^|:)([0-9]+)$/.exec(chainId.trim());
  if (!match) return undefined;
  try {
    return BigInt(match[1]);
  } catch {
    return undefined;
  }
}

function graphScopeTargetsChain(
  scopeChainId: string,
  adapterChainId: string,
  evmChainId?: bigint,
): boolean {
  // DKG chain labels are protocol namespaces, not necessarily EIP-155 aliases.
  // For example, `otp:20430` identifies the NeuroWeb test network while the
  // backing EVM currently reports chain id 31337.  An exact adapter-label match
  // is therefore authoritative and must win before numeric alias comparison.
  if (scopeChainId === adapterChainId) return true;
  const scopeNumericId = numericEvmChainId(scopeChainId);
  // If the raw labels differ, accept representation aliases only when their
  // numeric EIP-155 ids agree (for example `31337` and `evm:31337`).
  if (scopeNumericId !== undefined && evmChainId !== undefined) {
    return scopeNumericId === evmChainId;
  }
  const adapterNumericId = evmChainId ?? numericEvmChainId(adapterChainId);
  return scopeNumericId !== undefined
    && adapterNumericId !== undefined
    && scopeNumericId === adapterNumericId;
}

/**
 * Resolve the all-or-nothing V2 content envelope carried by a publish/update.
 * A partially populated envelope is a protocol error, while an explicit
 * legacy version is a stable read-only error rather than a fallback to roots.
 */
function resolveGraphScopedPublishDescriptor(
  options: PublishOptions,
): GraphScopedPublishDescriptor | undefined {
  const hasGraphScopeField =
    options.contentScopeVersion !== undefined
    || options.kaUal !== undefined
    || options.assertionVersion !== undefined
    || options.publicTripleCount !== undefined
    || options.privateMerkleRoot !== undefined
    || options.privateTripleCount !== undefined;
  if (!hasGraphScopeField) return undefined;
  if (options.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    if (options.contentScopeVersion === 0 || options.contentScopeVersion === 1) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    throw new Error(
      `Graph-scoped publish requires contentScopeVersion=${GRAPH_KA_CONTENT_SCOPE_VERSION}`,
    );
  }
  if (options.kaUal === undefined || options.assertionVersion === undefined) {
    throw new Error('Graph-scoped publish requires kaUal and assertionVersion');
  }
  if (!Number.isSafeInteger(options.publicTripleCount) || options.publicTripleCount! < 0) {
    throw new Error(
      `Graph-scoped publish requires a non-negative safe publicTripleCount, got ${String(options.publicTripleCount)}`,
    );
  }
  const privateTripleCount = options.privateTripleCount ?? 0;
  if (!Number.isSafeInteger(privateTripleCount) || privateTripleCount < 0) {
    throw new Error(
      `Graph-scoped publish requires a non-negative safe privateTripleCount, got ${String(privateTripleCount)}`,
    );
  }
  if (privateTripleCount === 0 && options.privateMerkleRoot !== undefined) {
    throw new Error('Graph-scoped privateMerkleRoot requires a positive privateTripleCount');
  }
  if (privateTripleCount > 0 && options.privateMerkleRoot?.length !== 32) {
    throw new Error('Graph-scoped private content requires one 32-byte privateMerkleRoot');
  }
  if (options.publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('Graph-scoped Knowledge Asset cannot be empty');
  }
  if ((options.manifest?.length ?? 0) > 0) {
    throw new Error('Graph-scoped publish must not carry a root-entity manifest');
  }
  const scope = createGraphKnowledgeAssetScope(options.kaUal, options.assertionVersion);
  const expectedPackedKaId =
    (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  // Reject conflicting caller-supplied identity before planner, chain, or
  // storage work. Discovering it only after mint would strand an on-chain KA
  // that can never materialize under the requested UAL.
  const suppliedReservedKaId =
    options.reservedKaId ?? options.precomputedAttestation?.reservedKaId;
  if (suppliedReservedKaId !== undefined) {
    if (suppliedReservedKaId !== expectedPackedKaId) {
      throw new Error(
        `Graph-scoped publish carries reserved kaId ${suppliedReservedKaId}, but UAL ` +
          `${scope.ual} derives packed kaId ${expectedPackedKaId}`,
      );
    }
  }
  const attestationAuthor =
    options.precomputedAttestation?.authorAddress
    ?? options.precomputedUpdateAttestation?.authorAddress;
  if (
    attestationAuthor !== undefined
    && attestationAuthor.toLowerCase() !== scope.agentAddress
  ) {
    throw new Error(
      `Graph-scoped publish attestation author ${attestationAuthor} does not match ` +
        `the UAL author ${scope.agentAddress}`,
    );
  }
  return {
    scope,
    expectedPackedKaId,
    publicTripleCount: options.publicTripleCount!,
    privateTripleCount,
    ...(options.privateMerkleRoot
      ? { expectedPrivateMerkleRoot: options.privateMerkleRoot }
      : {}),
  };
}

function isInternalOrigin(options: PublishOptions): boolean {
  return (options as InternalPublishOptions)[INTERNAL_ORIGIN_TOKEN] === true;
}

function isTrustedCatalogInternalOrigin(options: PublishOptions): boolean {
  return (options as InternalPublishOptions)[TRUSTED_CATALOG_ORIGIN_TOKEN] === true;
}

function resolvePublicACKStagingMode(options: PublishOptions): PublicACKStagingMode {
  return (options as InternalPublishOptions)[PUBLIC_ACK_STAGING_MODE_TOKEN]
    ?? (options.fromSharedMemory ? 'strict-swm' : 'inline');
}

function selectPublicStagingQuads(
  mode: PublicACKStagingMode,
  publicNquadsBytes: Uint8Array,
): Uint8Array | undefined {
  if (mode === 'strict-swm') return undefined;
  if (mode === 'inline-small-swm' && publicNquadsBytes.length > STORAGE_ACK_MAX_STAGING_BYTES) {
    return undefined;
  }
  return publicNquadsBytes;
}

function parsePromoteOperationIntent(
  rawValue: string,
  expectedOperationId: string,
): PromoteOperationIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = undefined;
  }
  const candidate = parsed as Partial<PromoteOperationIntent> | undefined;
  const publisherPeerId = candidate?.publisherPeerId;
  const allowedPeers = candidate?.allowedPeers;
  const canonicalAllowedPeers = Array.isArray(allowedPeers)
    ? [...new Set(allowedPeers.map((peer) => typeof peer === 'string' ? peer.trim() : ''))]
        .filter(Boolean)
        .sort()
    : [];
  const accessPolicy = candidate?.accessPolicy;
  const valid = candidate?.version === 1
    && candidate.operationId === expectedOperationId
    && Number.isSafeInteger(candidate.timestampMs)
    && Number(candidate.timestampMs) > 0
    && (publisherPeerId === undefined
      || (typeof publisherPeerId === 'string'
        && publisherPeerId.length > 0
        && publisherPeerId === publisherPeerId.trim()))
    && typeof candidate.confirmationRequired === 'boolean'
    && (accessPolicy === 'public' || accessPolicy === 'ownerOnly' || accessPolicy === 'allowList')
    && Array.isArray(allowedPeers)
    && allowedPeers.every((peer) => typeof peer === 'string')
    && JSON.stringify(allowedPeers) === JSON.stringify(canonicalAllowedPeers)
    && ((accessPolicy === 'allowList') === (canonicalAllowedPeers.length > 0));
  if (!valid) {
    throw Object.assign(
      new Error(`Durable promote intent for operation ${expectedOperationId} is missing or corrupt`),
      { code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' },
    );
  }
  return {
    version: 1,
    operationId: expectedOperationId,
    timestampMs: candidate.timestampMs!,
    ...(publisherPeerId ? { publisherPeerId } : {}),
    confirmationRequired: candidate.confirmationRequired!,
    accessPolicy,
    allowedPeers: canonicalAllowedPeers,
  };
}

function sameBigIntLiteral(left: string | bigint | undefined, right: string | bigint | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

// Round 14 Bug 41: case-insensitive check against `RESERVED_SUBJECT_PREFIXES`.
// Per RFC 8141 §3.1, the URN scheme (`urn:`) and NID (`dkg`) are
// case-insensitive for equivalence purposes — `URN:dkg:file:abc`,
// `urn:DKG:file:abc`, and `urn:dkg:file:abc` are all the same resource.
// The NSS portion is case-sensitive by default but our reserved
// prefixes (`urn:dkg:file:`, `urn:dkg:extraction:`) are entirely
// within the scheme+NID range, so lowercase-then-startsWith on the
// full subject string is the correct comparison: it accepts all
// case variants of the scheme/NID without over-matching into
// NSS-level content.
//
// Earlier rounds used a byte-level `subject.startsWith(prefix)` check
// at both the Bucket A write-boundary guard (Round 9 Bug 25) AND the
// Round 4 promote-time filter (Round 12 Bug 35 SSOT). Both were
// case-sensitive, so a malicious or accidentally-mixed-case subject
// like `URN:dkg:file:keccak256:<hex>` bypassed both defenses. Codex
// Bug 41 flagged this. The fix replaces both byte-level comparisons
// with the shared case-insensitive helper from `reserved-subjects.ts`,
// preserving the SSOT property established in Round 12.
function rejectReservedSubjectPrefixes(quads: Quad[]): void {
  for (const q of quads) {
    if (isReservedSubject(q.subject)) {
      // Find the specific prefix that matched (for the error message)
      // — re-scan with the lowercased subject since the constants are
      // lowercase. Byte-level comparison here is fine because by this
      // point we've already confirmed a match exists.
      throw new ReservedNamespaceError(q.subject, findReservedSubjectPrefix(q.subject)!);
    }
  }
}

function rejectUserAuthoredProtocolMetadata(quads: Quad[]): void {
  rejectReservedSubjectPrefixes(quads);
  assertNoUserAuthoredKnowledgeAssetSkolemTerms(quads);
  assertNoUserAuthoredTrustLevelQuads(quads);
}

function normalizeAssertionInputGraph(
  contextGraphId: string,
  subGraphName: string | undefined,
  wmGraphUri: string,
  graph: string,
): string {
  if (graph === '') return '';
  // RDF parsers and older scripts often carry the DKG physical storage graph in
  // the quad graph term. That is placement metadata, not user-authored RDF
  // named-graph identity, so keep it in the KA default graph. Only normalize
  // exact physical graph URIs; other DKG context-graph DIDs remain named graphs.
  const physicalGraphs = new Set([
    wmGraphUri,
    contextGraphDataUri(contextGraphId),
    ...(subGraphName ? [contextGraphDataUri(contextGraphId, subGraphName)] : []),
  ]);
  if (physicalGraphs.has(graph)) return '';
  return graph;
}

function rejectOversizedRdfLiterals(quads: Quad[], label: string): void {
  assertQuadLiteralsMutf8Safe(quads, { label });
}

async function stampTrustLevel(
  store: TripleStore,
  graph: string,
  subjects: Iterable<string>,
  level: TrustLevel,
): Promise<void> {
  const quads = buildTrustLevelQuads(subjects, level, graph) as Quad[];
  for (const quad of quads) {
    await store.deleteByPattern({
      graph: quad.graph,
      subject: quad.subject,
      predicate: TRUST_LEVEL_PREDICATE,
    });
  }
  if (quads.length > 0) {
    await store.insert(quads);
  }
}

function collectTrustSubjectsForRoots(
  quads: Iterable<Pick<Quad, 'subject'>>,
  roots: Iterable<string>,
): string[] {
  const rootSet = new Set([...roots].filter(Boolean));
  const subjects = new Set(rootSet);
  for (const quad of quads) {
    for (const root of rootSet) {
      if (quad.subject === root || quad.subject.startsWith(`${root}/.well-known/genid/`)) {
        subjects.add(quad.subject);
        break;
      }
    }
  }
  return [...subjects];
}

function isNoDataInSwmFailure(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if (`${current.name} ${current.message}`.includes('NO_DATA_IN_SWM')) return true;
      stack.push((current as Error & { cause?: unknown }).cause);
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of ['reason', 'code', 'message', 'legacyMessage', 'declineCode', 'declineMessage']) {
        const value = record[key];
        if (typeof value === 'string' && value.includes('NO_DATA_IN_SWM')) return true;
      }
      const peerOutcomes = record.peerOutcomes;
      if (Array.isArray(peerOutcomes)) stack.push(...peerOutcomes);
      if ('cause' in record) stack.push(record.cause);
    } else if (String(current).includes('NO_DATA_IN_SWM')) {
      return true;
    }
  }
  return false;
}

export class DKGPublisher implements Publisher {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly keypair: Ed25519Keypair;
  private readonly graphManager: GraphManager;
  private readonly privateStore: PrivateContentStore;
  private readonly ownedEntities = new Map<string, Set<string>>();
  private readonly sharedMemoryOwnedEntities: Map<string, Map<string, string>>;
  readonly knownBatchContextGraphs: Map<string, string>;
  private publisherNodeIdentityId: bigint;
  private readonly publisherAddress?: string;
  private readonly publisherAddressResolver?: (contextGraphId?: bigint) => Promise<string | undefined>;
  private readonly publisherWallet?: ethers.Wallet;
  private readonly publisherPlanner: PublisherPlanner;
  private adapterSignMessagePublisherAddress?: string;
  private readonly adapterSignMessageProbeCache = new Map<string, boolean>();
  private workspaceAgentRecipientResolver?: WorkspaceAgentRecipientResolver;
  private workspaceSenderKeyEncryptor?: WorkspaceSenderKeyEncryptor;
  /** Additional wallets that can provide receiver signatures. */
  private readonly additionalSignerWallets: ethers.Wallet[] = [];
  private readonly log = new Logger('DKGPublisher');
  private readonly sessionId = Date.now().toString(36);
  private tentativeCounter = 0;
  readonly writeLocks: Map<string, Promise<void>>;
  private readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /** OT-RFC-43 Option 1 — deterministic KA-id allocator (optional; see DKGPublisherConfig). */
  private readonly kaAllocator?: KaIdAllocator;
  /** Authors whose allocator floor has been reconciled against the chain this process. */
  private readonly reconciledKaAuthors = new Set<string>();
  /** RFC ka-metadata-trim P3.3 — gate for the lifecycle PROV event rows (default true). */
  private readonly provenanceEvents: boolean;

  constructor(config: DKGPublisherConfig) {
    this.store = config.store;
    this.chain = config.chain;
    this.kaAllocator = config.kaAllocator;
    this.provenanceEvents = config.provenanceEvents !== false;
    this.eventBus = config.eventBus;
    this.keypair = config.keypair;
    this.publisherNodeIdentityId = config.publisherNodeIdentityId ?? 0n;
    this.publisherAddressResolver = config.publisherAddressResolver;

    const configuredPublisherAddress = normalizePublisherAddress(config.publisherAddress);
    if (config.publisherPrivateKey) {
      this.publisherWallet = new ethers.Wallet(config.publisherPrivateKey);
      this.publisherAddress = this.publisherWallet.address;
      if (
        configuredPublisherAddress &&
        configuredPublisherAddress.toLowerCase() !== this.publisherAddress.toLowerCase()
      ) {
        throw new Error(
          `publisherAddress (${configuredPublisherAddress}) does not match publisherPrivateKey signer ` +
          `(${this.publisherAddress})`,
        );
      }
    } else {
      // No private key supplied means no in-process publisher signing
      // capability. Keep an optional, validated address only for callers
      // that route signing through their ChainAdapter (e.g. adapter-backed
      // or hardware-signer deployments). Chain-backed publish still fails
      // unless that address is backed by ChainAdapter.signMessageAs() or
      // signMessage(); update can let the adapter select its signer from the
      // configured signer pool.
      //
      // The previous behaviour generated an ephemeral `Wallet.createRandom()`
      // here whenever chain was enabled, which produced unverifiable
      // signatures attributed to a throw-away address. We also must not use
      // `0x000...000` as a sentinel: it looks like an on-chain publisher and
      // can leak into UALs/metadata. See PR #371 for
      // the testnet-blocking incident chain (`ensureProfile` had the same
      // anti-pattern, fixed in PR #366).
      this.publisherAddress = configuredPublisherAddress;
    }

    for (const key of config.additionalSignerKeys ?? []) {
      this.additionalSignerWallets.push(new ethers.Wallet(key));
    }

    this.graphManager = new GraphManager(config.store);
    this.privateStore = new PrivateContentStore(config.store, this.graphManager);
    this.sharedMemoryOwnedEntities = config.sharedMemoryOwnedEntities ?? new Map();
    this.knownBatchContextGraphs = config.knownBatchContextGraphs ?? new Map();
    this.writeLocks = writeLocksForStore(this.store, config.writeLocks);
    this.workspaceAgentRecipientResolver = config.workspaceAgentRecipientResolver;
    this.workspaceSenderKeyEncryptor = config.workspaceSenderKeyEncryptor;
    this.publicSnapshotStore = config.publicSnapshotStore;
    this.publisherPlanner = new PublisherPlanner({
      chain: this.chain,
      resolvePublisherAddressSelection: (contextGraphId, options) =>
        this.resolvePublisherAddressSelection(contextGraphId, options),
      resolvePublisherSigner: (address) => this.getPublisherSigner(address),
      localTentativePublisherAddress: () => this.localTentativePublisherAddress(),
      log: {
        info: (ctx, message) => this.log.info(ctx, message),
        warn: (ctx, message) => this.log.warn(ctx, message),
      },
    });
  }

  setWorkspaceAgentRecipientResolver(resolver: WorkspaceAgentRecipientResolver | undefined): void {
    this.workspaceAgentRecipientResolver = resolver;
  }

  setWorkspaceSenderKeyEncryptor(encryptor: WorkspaceSenderKeyEncryptor | undefined): void {
    this.workspaceSenderKeyEncryptor = encryptor;
  }

  private async storedOnChainContextGraphId(contextGraphId: string): Promise<string | undefined> {
    const ontologyGraph = contextGraphDataUri('ontology');
    const contextGraphUri = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <https://dkg.network/ontology#ContextGraphOnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return stripOptionalLiteral(result.bindings[0]?.['id'])?.trim();
  }

  private async onChainContextGraphMatchesLocalId(
    contextGraphId: string,
    onChainContextGraphId: bigint | string | undefined,
  ): Promise<boolean> {
    if (onChainContextGraphId === undefined || onChainContextGraphId === null) return false;
    const normalizedOnChainId = String(onChainContextGraphId).trim();
    const normalizedContextGraphId = contextGraphId.trim();

    if (/^\d+$/.test(normalizedContextGraphId) && normalizedContextGraphId === normalizedOnChainId) return true;

    const liveNameHashMatches = async (): Promise<boolean> => {
      if (typeof this.chain?.getContextGraphNameHash !== 'function') return false;
      try {
        const nameHash = await this.chain.getContextGraphNameHash(BigInt(normalizedOnChainId));
        return typeof nameHash === 'string' &&
          nameHash.toLowerCase() === ethers.keccak256(ethers.toUtf8Bytes(normalizedContextGraphId)).toLowerCase();
      } catch {
        return false;
      }
    };

    const storedOnChainId = await this.storedOnChainContextGraphId(contextGraphId);
    if (sameBigIntLiteral(storedOnChainId, normalizedOnChainId)) {
      return typeof this.chain?.getContextGraphNameHash === 'function'
        ? liveNameHashMatches()
        : true;
    }

    return liveNameHashMatches();
  }

  private async onChainContextGraphIsPrivate(
    contextGraphId: string,
    onChainContextGraphId: bigint | string | undefined,
  ): Promise<boolean> {
    if (onChainContextGraphId === undefined || onChainContextGraphId === null) return false;
    if (!this.chain || this.chain.chainId === 'none') return false;
    if (typeof this.chain.getContextGraphAccessPolicy !== 'function') return false;
    if (!await this.onChainContextGraphMatchesLocalId(contextGraphId, onChainContextGraphId)) return false;
    try {
      return Number(await this.chain.getContextGraphAccessPolicy(BigInt(onChainContextGraphId))) === 1;
    } catch {
      return false;
    }
  }

  private async localContextGraphHasPrivateAccessSignal(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return false;

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?policy ?gate WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?gate
          }
        } UNION {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?gate
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?gate
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?gate
          }
        }
      }`,
    );
    if (result.type !== 'bindings') return false;
    let hasPrivatePolicy = false;
    let hasGate = false;
    for (const row of result.bindings) {
      const policy = stripOptionalLiteral(row['policy'])?.trim().toLowerCase();
      if (policy === 'public') return false;
      if (policy === 'private') hasPrivatePolicy = true;
      if (stripOptionalLiteral(row['gate'])?.trim()) hasGate = true;
    }
    return hasPrivatePolicy || hasGate;
  }

  private async assertTrustedCatalogTriplesAllowed(params: {
    contextGraphId: string;
    trustedNonManifestCatalogTriples: PublishOptions['trustedNonManifestCatalogTriples'];
    onChainContextGraphId?: bigint | string;
    internalCatalogOrigin?: boolean;
    allowLocalPrivateContextGraph?: boolean;
  }): Promise<void> {
    const {
      contextGraphId,
      trustedNonManifestCatalogTriples,
      onChainContextGraphId,
      internalCatalogOrigin = false,
      allowLocalPrivateContextGraph = false,
    } = params;
    assertTrustedCatalogTriplesAreGeneratedFloor(
      contextGraphId,
      trustedNonManifestCatalogTriples,
    );

    if (trustedCatalogTripleKeySet(trustedNonManifestCatalogTriples).size === 0) return;
    if (internalCatalogOrigin) return;
    const storedOnChainContextGraphId = await this.storedOnChainContextGraphId(contextGraphId);
    const effectiveOnChainContextGraphId = onChainContextGraphId ?? storedOnChainContextGraphId;
    if (
      allowLocalPrivateContextGraph &&
      effectiveOnChainContextGraphId === undefined &&
      await this.localContextGraphHasPrivateAccessSignal(contextGraphId)
    ) return;
    if (await this.onChainContextGraphIsPrivate(contextGraphId, effectiveOnChainContextGraphId)) return;

    throw new Error(
      'trustedNonManifestCatalogTriples is only allowed for internal private context graph catalog floor handling',
    );
  }

  private async resolvePublisherAddress(
    contextGraphId?: bigint,
    options: PublisherAddressResolutionOptions = {},
  ): Promise<string | undefined> {
    return (await this.resolvePublisherAddressSelection(contextGraphId, options)).address;
  }

  private async resolvePublisherAddressSelection(
    contextGraphId?: bigint,
    options: PublisherAddressResolutionOptions = {},
  ): Promise<PublisherAddressResolution> {
    if (this.publisherAddress) {
      return {
        address: this.publisherAddress,
        planningPin: this.publisherAddress,
        planningPinLabel: this.publisherWallet
          ? 'publisherPrivateKey'
          : 'configured publisherAddress',
      };
    }
    if (this.publisherAddressResolver) {
      const resolved = normalizePublisherAddress(await this.publisherAddressResolver(contextGraphId));
      if (resolved) {
        return {
          address: resolved,
          planningPin: resolved,
          planningPinLabel: 'publisherAddressResolver',
        };
      }
    }
    return { address: await this.inferAdapterPublisherAddress(contextGraphId, options) };
  }

  /** RFC-001 §9 fallback author when no agent override is supplied. Returns undefined if no signer configured. */
  async publisherFallbackAuthorAddress(): Promise<string | undefined> {
    return this.resolvePublisherAddress();
  }

  /** Sign EIP-712 typed data with the publisher's own wallet. Returns KAv10's compact (r, vs). */
  async signAuthorAttestationAsPublisher(typedData: {
    domain: { name: string; version: string; chainId: bigint; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  }): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const address = await this.resolvePublisherAddress();
    if (!address) {
      throw new Error(
        'signAuthorAttestationAsPublisher: no publisher signer is configured. ' +
          'Configure publisherPrivateKey or use a chain adapter that exposes signTypedData.',
      );
    }
    const signer = await this.getPublisherSigner(address);
    if (!signer) {
      throw new Error(
        `signAuthorAttestationAsPublisher: failed to resolve a signer for ${address}.`,
      );
    }
    const sigHex = await signer.signTypedData(
      typedData.domain,
      typedData.types as { [k: string]: Array<{ name: string; type: string }> },
      typedData.message,
    );
    const sig = ethers.Signature.from(sigHex);
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  private async inferAdapterPublisherAddress(
    contextGraphId?: bigint,
    options: PublisherAddressResolutionOptions = {},
  ): Promise<string | undefined> {
    if (
      options.includeReservingPublisherProbe !== false &&
      contextGraphId !== undefined &&
      typeof this.chain.getAuthorizedPublisherAddress === 'function'
    ) {
      try {
        const address = coercePublisherAddress(await this.chain.getAuthorizedPublisherAddress(contextGraphId));
        if (address) return address;
      } catch {
        // Best-effort inference; the publish path will fail clearly if no signer resolves.
      }
    }

    const signerAddressGetter = (this.chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
    if (typeof signerAddressGetter === 'function') {
      try {
        const address = coercePublisherAddress(
          await Promise.resolve(signerAddressGetter.call(this.chain)),
        );
        if (address) return address;
      } catch {
        // Fall through to other common adapter surfaces.
      }
    }

    const signerAddressesGetter = (this.chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
    if (typeof signerAddressesGetter === 'function') {
      try {
        const advertised = await Promise.resolve(signerAddressesGetter.call(this.chain));
        if (Array.isArray(advertised)) {
          for (const value of advertised) {
            const address = coercePublisherAddress(value);
            if (address) return address;
          }
        }
      } catch {
        // Fall through to legacy adapter surfaces.
      }
    }

    const signerAddress = coercePublisherAddress(
      (this.chain as unknown as { signerAddress?: unknown }).signerAddress,
    );
    if (signerAddress) return signerAddress;

    const operationalWallet = this.getAdapterOperationalWallet();
    if (operationalWallet) return operationalWallet.address;

    if (this.adapterSignMessagePublisherAddress) return this.adapterSignMessagePublisherAddress;
    if (options.includeGenericSignMessageProbe === false) return undefined;
    if (this.chain.chainId === 'none' || typeof this.chain.signMessage !== 'function') return undefined;

    try {
      const challenge = ethers.getBytes(ethers.id('dkg-publisher:publisher-address-probe'));
      const compact = await this.chain.signMessage(challenge);
      const address = coercePublisherAddress(recoverCompactMessageSigner(challenge, compact));
      if (address) {
        this.adapterSignMessagePublisherAddress = address;
        this.adapterSignMessageProbeCache.set(address.toLowerCase(), true);
      }
      return address;
    } catch {
      return undefined;
    }
  }

  private getAdapterOperationalWallet(): ethers.Wallet | undefined {
    const operationalKeyGetter = (this.chain as unknown as { getOperationalPrivateKey?: () => unknown })
      .getOperationalPrivateKey;
    if (typeof operationalKeyGetter !== 'function') return undefined;

    try {
      const privateKey = operationalKeyGetter.call(this.chain);
      return typeof privateKey === 'string' && privateKey.length > 0
        ? new ethers.Wallet(privateKey)
        : undefined;
    } catch {
      return undefined;
    }
  }

  // Local-only tentative publishes need a stable, non-zero UAL component even
  // when no EVM publisher key exists. This is not used for signatures.
  private localTentativePublisherAddress(): string {
    const digest = ethers.keccak256(this.keypair.publicKey);
    const address = ethers.getAddress(ethers.dataSlice(digest, 12));
    return address === ethers.ZeroAddress ? '0x0000000000000000000000000000000000000001' : address;
  }

  private async resolveKnownBatchPublisherAddress(
    contextGraphId: string,
    kaId: bigint,
    metaGraphUri = this.graphManager.metaGraphUri(contextGraphId),
  ): Promise<string | undefined> {
    try {
      const ual = await resolveUalByBatchId(
        this.store,
        metaGraphUri,
        kaId,
      );
      return publisherAddressFromUal(ual);
    } catch {
      return undefined;
    }
  }

  private async adapterSignMessageMatchesAddress(expectedAddress: string): Promise<boolean> {
    if (typeof this.chain.signMessage !== 'function') return false;

    const cacheKey = expectedAddress.toLowerCase();
    const cached = this.adapterSignMessageProbeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const challenge = ethers.getBytes(ethers.id(`dkg-publisher:chain-signer-probe:${cacheKey}`));
    try {
      const compact = await this.chain.signMessage(challenge);
      const recovered = recoverCompactMessageSigner(challenge, compact);
      const matches = recovered.toLowerCase() === cacheKey;
      this.adapterSignMessageProbeCache.set(cacheKey, matches);
      if (matches) this.adapterSignMessagePublisherAddress = expectedAddress;
      return matches;
    } catch {
      return false;
    }
  }

  private async getPublisherSigner(address = this.publisherAddress): Promise<PublisherSigner | undefined> {
    if (this.publisherWallet && this.publisherAddress) {
      if (address && address.toLowerCase() !== this.publisherAddress.toLowerCase()) return undefined;
      const wallet = this.publisherWallet;
      return {
        address: this.publisherAddress,
        source: 'publisherPrivateKey',
        signMessage: (message: Uint8Array) => wallet.signMessage(message),
        signTypedData: (domain, types, value) =>
          wallet.signTypedData(domain, types, value),
      };
    }

    if (address && typeof this.chain.signMessageAs === 'function') {
      const expectedAddress = address;
      return {
        address: expectedAddress,
        source: 'chainAdapter',
        signMessage: async (message: Uint8Array) => {
          const compact = await this.chain.signMessageAs!(expectedAddress, message);
          const signature = ethers.Signature.from({
            r: ethers.hexlify(compact.r),
            yParityAndS: ethers.hexlify(compact.vs),
          }).serialized;
          const recovered = ethers.verifyMessage(message, signature);
          if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
            throw new Error(
              `publisherAddress (${expectedAddress}) does not match ChainAdapter.signMessage signer ` +
              `(${recovered})`,
            );
          }
          return signature;
        },
        signTypedData: async (domain, types, value) => {
          if (typeof this.chain.signTypedDataAs === 'function') {
            return this.chain.signTypedDataAs(expectedAddress, domain, types, value);
          }
          if (typeof this.chain.signTypedData === 'function') {
            return this.chain.signTypedData(domain, types, value);
          }
          throw new Error(
            'EIP-712 typed-data signing (RFC-001 author attestation) is not supported ' +
            'by this chain adapter. Configure publisherPrivateKey or upgrade the adapter ' +
            'to implement signTypedData / signTypedDataAs.',
          );
        },
      };
    }

    if (address && typeof this.chain.signMessage === 'function') {
      const expectedAddress = address;
      if (!(await this.adapterSignMessageMatchesAddress(expectedAddress))) return undefined;
      return {
        address: expectedAddress,
        source: 'chainAdapter',
        signMessage: async (message: Uint8Array) => {
          const compact = await this.chain.signMessage!(message);
          const signature = ethers.Signature.from({
            r: ethers.hexlify(compact.r),
            yParityAndS: ethers.hexlify(compact.vs),
          }).serialized;
          const recovered = ethers.verifyMessage(message, signature);
          if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
            this.adapterSignMessageProbeCache.set(expectedAddress.toLowerCase(), false);
            throw new Error(
              `publisherAddress (${expectedAddress}) does not match ChainAdapter.signMessage signer ` +
              `(${recovered})`,
            );
          }
          return signature;
        },
        signTypedData: async (domain, types, value) => {
          if (typeof this.chain.signTypedData === 'function') {
            return this.chain.signTypedData(domain, types, value);
          }
          if (typeof this.chain.signTypedDataAs === 'function') {
            return this.chain.signTypedDataAs(expectedAddress, domain, types, value);
          }
          throw new Error(
            'EIP-712 typed-data signing (RFC-001 author attestation) is not supported ' +
            'by this chain adapter. Configure publisherPrivateKey or upgrade the adapter ' +
            'to implement signTypedData / signTypedDataAs.',
          );
        },
      };
    }

    const operationalWallet = this.getAdapterOperationalWallet();
    if (
      address &&
      operationalWallet &&
      operationalWallet.address.toLowerCase() === address.toLowerCase()
    ) {
      return {
        address: operationalWallet.address,
        source: 'chainAdapter',
        signMessage: (message: Uint8Array) => operationalWallet.signMessage(message),
        signTypedData: (domain, types, value) =>
          operationalWallet.signTypedData(domain, types, value),
      };
    }

    return undefined;
  }

  private withWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return withKeyedLocks(this.writeLocks, keys, fn);
  }

  private assertionLifecycleWriteLockKey(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): string {
    const normalizedAgentAddress = /^0x[0-9a-fA-F]{40}$/.test(agentAddress)
      ? agentAddress.toLowerCase()
      : agentAddress;
    return `assertion-lifecycle:${JSON.stringify([
      contextGraphId,
      subGraphName ?? '',
      normalizedAgentAddress,
      name,
    ])}`;
  }

  private withAssertionLifecycleWriteLock<T>(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.withWriteLocks([
      this.assertionLifecycleWriteLockKey(contextGraphId, name, agentAddress, subGraphName),
    ], fn);
  }

  /**
   * Write quads to the context graph's shared memory (no chain, no TRAC).
   * Validates, stores locally in SWM + SWM meta, returns encoded message for the agent to broadcast on the SWM topic.
   * Acquires per-entity write locks to serialize against concurrent CAS writes.
   */
  async share(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions,
  ): Promise<ShareResult> {
    // Round 9 Bug 25: reject user-authored quads with reserved URN
    // prefixes at the TOP of the Bucket A entry point, before any
    // other processing (lock acquisition, partitioning, etc.) per
    // spec `19_MARKDOWN_CONTENT_TYPE.md §10.2`. Short-circuit so a
    // reserved-namespace violation cannot be masked by a lock timeout
    // or subject-level validation error downstream.
    rejectUserAuthoredProtocolMetadata(quads);
    rejectOversizedRdfLiterals(quads, 'share.quads');
    const subjects = [...new Set(quads.map(q => q.subject))];
    const lockPrefix = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const lockKeys = subjects.map(s => `${lockPrefix}\0${s}`);
    return this.withWriteLocks(lockKeys, () => this._shareImpl(contextGraphId, quads, options));
  }

  /** @deprecated Use share() */
  async writeToWorkspace(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions,
  ): Promise<ShareResult> {
    return this.share(contextGraphId, quads, options);
  }

  private async _shareImpl(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions & { conditions?: CASCondition[] },
  ): Promise<ShareResult> {
    if (options.subGraphName !== undefined) {
      const v = validateSubGraphName(options.subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name for share: ${v.reason}`);
    }
    await this.ensureSubGraphRegistered(contextGraphId, options.subGraphName);
    // Round 9 Bug 25: reserved-namespace guard lives at the public
    // entry points (`share`, `conditionalShare`), not here — this
    // method is Bucket B (internal plumbing) and its callers have
    // already validated the quad set.
    const ctx = options.operationCtx ?? createOperationContext('share');
    this.log.info(ctx, `Writing ${quads.length} quads to shared memory for context graph ${contextGraphId}`);

    await this.graphManager.ensureContextGraph(contextGraphId);

    const kaMap = skolemizeByEntity(quads);
    const manifestEntries: { rootEntity: string; privateMerkleRoot?: Uint8Array; privateTripleCount: number }[] = [];
    for (const [rootEntity, publicQuads] of kaMap) {
      const privRoot = undefined;
      manifestEntries.push({
        rootEntity,
        privateMerkleRoot: privRoot,
        privateTripleCount: 0,
      });
    }

    const manifestForValidation: KAManifestEntry[] = manifestEntries.map((m) => ({
      tokenId: 0n,
      rootEntity: m.rootEntity,
      privateMerkleRoot: m.privateMerkleRoot,
      privateTripleCount: m.privateTripleCount,
    }));

    const ownershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const dataOwned = this.ownedEntities.get(ownershipKey) ?? new Set();
    const swmOwned = this.sharedMemoryOwnedEntities.get(ownershipKey) ?? new Map<string, string>();
    const existing = new Set<string>([...dataOwned, ...swmOwned.keys()]);

    const upsertable = new Set<string>();
    for (const [entity, creator] of swmOwned) {
      if (creator === options.publisherPeerId) {
        upsertable.add(entity);
      }
    }

    const validation = validatePublishRequest(
      [...kaMap.values()].flat(),
      manifestForValidation,
      contextGraphId,
      existing,
      { allowUpsert: true, upsertableEntities: upsertable },
    );
    if (!validation.valid) {
      throw new Error(`SWM validation failed: ${validation.errors.join('; ')}`);
    }

    const shareOperationId = `swm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Generic share (dkg_shared_memory_publish) is raw shared data, NOT a lifecycle KA:
    // it has no created/promoted identity to key a per-KA graph, and minting one here
    // collides with the publish-from-SWM kaId reservation (0-KA publishes). It stays in
    // the bucket; the per-KA …/_shared_memory/{addr}/{number} layout is produced by
    // promote (a real KA lifecycle). read-both reads cover both shapes.
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options.subGraphName);
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, options.subGraphName);

    // Pre-encode gossip message and enforce size limit BEFORE any
    // destructive SWM mutations to avoid leaving orphaned state.
    const dataGraphUri = this.graphManager.dataGraphUri(contextGraphId);
    const gossipQuads = [...kaMap.values()].flat().map((q) => ({ ...q, graph: dataGraphUri }));
    const nquadsStr = gossipQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
      )
      .join('\n');

    const casConditions = options.conditions?.map(c => ({
      subject: c.subject,
      predicate: c.predicate,
      expectedValue: c.expectedValue ?? '',
      expectAbsent: c.expectedValue === null,
    }));

    const timestampMs = Date.now();
    const workspaceRequestMessage = encodeWorkspacePublishRequest({
      contextGraphId,
      nquads: new TextEncoder().encode(nquadsStr),
      manifest: manifestEntries.map((m) => ({
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount,
      })),
      publisherPeerId: options.publisherPeerId,
      shareOperationId,
      timestampMs,
      operationId: ctx.operationId,
      casConditions,
      subGraphName: options.subGraphName,
    });
    const message = await this.encodeWorkspaceGossipPayload(
      contextGraphId,
      workspaceRequestMessage,
      {
        localOnly: options.localOnly === true,
        senderAgentAddress: options.senderAgentAddress,
        operationId: ctx.operationId,
        shareOperationId,
        timestampMs,
        subGraphName: options.subGraphName,
        publisherPeerId: options.publisherPeerId,
      },
    );

    if (message.length > DKG_GOSSIP_MAX_MESSAGE_BYTES) {
      const hint = `Split large writes into multiple share() calls partitioned by root entity.`;
      throw new SwmGossipPayloadTooLargeError({
        actualBytes: message.length,
        maxBytes: DKG_GOSSIP_MAX_MESSAGE_BYTES,
        operation: 'share',
        message:
          `SWM message too large (${formatBytesAsKb(message.length)}, limit ${formatGossipLimit(DKG_GOSSIP_MAX_MESSAGE_BYTES)}). ` +
          hint,
        hint,
      });
    }

    // Strict curator-ack gate (OT-RFC-49 curator-leader). Runs AFTER the wire
    // message is fully built + size-checked (above) and BEFORE the first
    // destructive mutation (below) — the build/commit seam the message was
    // deliberately pre-encoded for ("BEFORE any destructive SWM mutations").
    // The agent injects a confirmer that reliably delivers `message` to the
    // curator and waits for an applied-ack; a non-confirmation aborts here with
    // ZERO orphaned state, so the member never holds a value the curator lacks.
    if (options.confirmBeforeCommit) {
      const confirmation = await options.confirmBeforeCommit(message);
      if (!confirmation.applied) {
        if (confirmation.rejected) throw new CuratorRejectedError(contextGraphId);
        throw new CuratorUnconfirmedError(contextGraphId);
      }
    }

    // Delete-then-insert for upserted entities (replace old triples).
    for (const m of manifestEntries) {
      if (swmOwned.has(m.rootEntity)) {
        await this.store.deleteByPattern({ graph: swmGraph, subject: m.rootEntity });
        await this.store.deleteBySubjectPrefix(swmGraph, m.rootEntity + '/.well-known/genid/');
        await this.deleteMetaForRoot(swmMetaGraph, m.rootEntity);
      }
    }

    const normalized = [...kaMap.values()].flat().map((q) => ({ ...q, graph: swmGraph }));
    await this.store.insert(normalized);

    const rootEntities = manifestEntries.map((m) => m.rootEntity);
    const operationTimestamp = new Date();
    await storeWorkspaceOperationPublicQuads({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId,
      shareOperationId,
      rootEntities,
      quads: normalized,
      publisherPeerId: options.publisherPeerId,
      agentAddress: options.senderAgentAddress,
      subGraphName: options.subGraphName,
      timestamp: operationTimestamp,
      publicSnapshotStore: this.publicSnapshotStore,
    });

    if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
      this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
    }
    const newOwnershipEntries: { rootEntity: string; creatorPeerId: string }[] = [];
    const liveOwned = this.sharedMemoryOwnedEntities.get(ownershipKey)!;
    for (const r of rootEntities) {
      if (!liveOwned.has(r)) {
        newOwnershipEntries.push({ rootEntity: r, creatorPeerId: options.publisherPeerId });
      }
    }
    if (newOwnershipEntries.length > 0) {
      for (const entry of newOwnershipEntries) {
        await this.store.deleteByPattern({
          graph: swmMetaGraph,
          subject: entry.rootEntity,
          predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
      }
      await this.store.insert(generateOwnershipQuads(newOwnershipEntries, swmMetaGraph));
      for (const entry of newOwnershipEntries) {
        liveOwned.set(entry.rootEntity, entry.creatorPeerId);
      }
    }

    this.log.info(ctx, `Shared memory write complete: ${shareOperationId}`);
    return { shareOperationId, message };
  }

  private async encodeWorkspaceGossipPayload(
    contextGraphId: string,
    plaintext: Uint8Array,
    options: {
      localOnly: boolean;
      senderAgentAddress?: string;
      operationId: string;
      shareOperationId: string;
      timestampMs: number;
      subGraphName?: string;
      publisherPeerId: string;
    },
  ): Promise<Uint8Array> {
    if (options.localOnly || !this.workspaceAgentRecipientResolver) {
      return plaintext;
    }

    const resolution = await this.workspaceAgentRecipientResolver({ contextGraphId });
    if (!resolution.requiresEncryption) {
      return plaintext;
    }
    if (resolution.recipients.length === 0) {
      throw new Error(`Context graph "${contextGraphId}" requires encrypted SWM gossip but has no valid DKG agent recipients`);
    }
    if (!options.senderAgentAddress) {
      throw new Error(`Context graph "${contextGraphId}" requires a DKG agent sender identity for encrypted SWM gossip`);
    }

    if (this.workspaceSenderKeyEncryptor) {
      return this.workspaceSenderKeyEncryptor({
        contextGraphId,
        plaintext,
        senderAgentAddress: options.senderAgentAddress,
        operationId: options.operationId,
        shareOperationId: options.shareOperationId,
        timestampMs: options.timestampMs,
        subGraphName: options.subGraphName,
        publisherPeerId: options.publisherPeerId,
      });
    }

    const senderIdentity = `did:dkg:agent:${ethers.getAddress(options.senderAgentAddress)}`;
    return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
      contextGraphId,
      senderIdentity,
      operationId: options.operationId,
      shareOperationId: options.shareOperationId,
      timestampMs: options.timestampMs,
      subGraphName: options.subGraphName,
      plaintext,
      recipients: resolution.recipients,
    }));
  }

  /**
   * Compare-and-swap shared memory write. Checks each condition against the
   * current SWM graph state before applying the write atomically.
   * Serializes against both CAS and plain writes via per-entity write
   * locks so check-then-write cannot interleave with any concurrent
   * store mutations on the same subjects.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    // Round 9 Bug 25: reject user-authored quads with reserved URN
    // prefixes at the TOP of the Bucket A entry point, before the
    // CAS condition check (which could otherwise mask the namespace
    // violation with a StaleWriteError). Short-circuit per
    // `19_MARKDOWN_CONTENT_TYPE.md §10.2`.
    rejectUserAuthoredProtocolMetadata(quads);
    rejectOversizedRdfLiterals(quads, 'conditionalShare.quads');
    for (const cond of options.conditions) {
      assertSafeIri(cond.subject);
      assertSafeIri(cond.predicate);
      if (cond.expectedValue !== null) {
        assertSafeRdfTerm(cond.expectedValue);
      }
    }

    const conditionSubjects = options.conditions.map(c => c.subject);
    const quadSubjects = [...new Set(quads.map(q => q.subject))];
    const lockPrefix = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const lockKeys = [...new Set([...conditionSubjects, ...quadSubjects])].map(s => `${lockPrefix}\0${s}`);

    return this.withWriteLocks(lockKeys, () => this._executeConditionalWrite(contextGraphId, quads, options));
  }

  /** @deprecated Use conditionalShare() */
  async writeConditionalToWorkspace(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    return this.conditionalShare(contextGraphId, quads, options);
  }

  private async _executeConditionalWrite(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    const ctx = options.operationCtx ?? createOperationContext('share');

    await this.graphManager.ensureContextGraph(contextGraphId);
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options.subGraphName);

    for (const cond of options.conditions) {
      const ask = cond.expectedValue === null
        ? `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } }`
        : `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ${cond.expectedValue} } }`;
      const result = await this.store.query(ask);

      if (result.type !== 'boolean') {
        throw new Error(`CAS condition query returned unexpected type "${result.type}" for <${cond.subject}> <${cond.predicate}>`);
      }

      const shouldExist = cond.expectedValue !== null;
      if (result.value !== shouldExist) {
        const sel = `SELECT ?o WHERE { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } } LIMIT 1`;
        const cur = await this.store.query(sel);
        const actual = cur.type === 'bindings' && cur.bindings.length > 0 ? cur.bindings[0].o ?? null : null;
        throw new StaleWriteError(cond, actual);
      }
    }

    this.log.info(ctx, `CAS conditions passed (${options.conditions.length}), proceeding with write`);
    return this._shareImpl(contextGraphId, quads, {
      ...options,
      conditions: options.conditions,
    });
  }

  /**
   * Read quads from the context graph's shared memory and publish them with full finality (data graph + chain).
   * Selection: 'all' or { rootEntities: string[] } to publish only those root entities from shared memory.
   *
   * @throws Error if `options.subGraphName` is combined with `options.publishContextGraphId`.
   *   The remap-on-publish flow targets `/context/{id}` URIs, which are incompatible with
   *   sub-graph URIs of shape `/{contextGraphId}/{subGraphName}`. To publish from a sub-graph,
   *   omit `publishContextGraphId` (publish remains in the source CG's sub-graph).
   */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      operationCtx?: OperationContext;
      clearSharedMemoryAfter?: boolean;
      onPhase?: PhaseCallback;
      /** Triggers remap: moves data from the default data graph to `/context/{id}`. */
      publishContextGraphId?: string;
      /** On-chain CG ID for the V10 chain tx (ACK digest + publishDirect). Does NOT trigger remap. */
      onChainContextGraphId?: string;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      v10ACKProvider?: PublishOptions['v10ACKProvider'];
      trustedNonManifestCatalogTriples?: PublishOptions['trustedNonManifestCatalogTriples'];
      subGraphName?: string;
      publisherPeerId?: string;
      /**
       * Per-call override for the on-chain attribution target — see
       * `PublishOptions.publisherNodeIdentityIdOverride` for full semantics.
       * Threaded into the inner `publish()` call below.
       */
      publisherNodeIdentityIdOverride?: bigint;
      /**
       * RFC-001 §9.x — pre-computed attestation captured at
       * `agent.assertion.finalize()` time. See
       * `PublishOptions.precomputedAttestation`. Required for
       * on-chain publishes.
       */
      precomputedAttestation?: PublishOptions['precomputedAttestation'];
      /**
       * OT-RFC-38 / LU-5. When set, the inline ACK payload is AEAD-
       * encrypted before being shipped to cores so curated-CG bytes
       * are opaque on the wire. See `PublishOptions.encryptInlinePayload`
       * for the full semantics.
       */
      encryptInlinePayload?: PublishOptions['encryptInlinePayload'];
      /**
       * OT-RFC-38 LU-11. Sibling of `encryptInlinePayload` — when set,
       * the publisher routes through the chunked path that fans
       * per-chunk ciphertexts via SWM gossip and ships only the
       * commitment to cores via V2 ACK. See
       * `PublishOptions.encryptInlineChunked` for the full
       * semantics.
       */
      encryptInlineChunked?: PublishOptions['encryptInlineChunked'];
      /** Per-publish on-chain lifetime override in epochs. */
      publishEpochs?: number;
      /**
       * OT-RFC-43 A2 (decision 1) — precomputed packed kaId stamped at
       * finalize. When set, `ensureReservedKaId` REUSES it instead of
       * allocating again (single-source allocate-at-finalize). Undefined keeps
       * the existing allocate-at-publish behavior.
       */
      reservedKaId?: bigint;
      /** Explicit graph-family boundary; named lifecycles exclude bucket and siblings. */
      sharedMemoryScope?: SharedMemoryGraphScope;
      contentScopeVersion?: PublishOptions['contentScopeVersion'];
      kaUal?: PublishOptions['kaUal'];
      assertionVersion?: PublishOptions['assertionVersion'];
      publicTripleCount?: PublishOptions['publicTripleCount'];
      privateMerkleRoot?: PublishOptions['privateMerkleRoot'];
      privateTripleCount?: PublishOptions['privateTripleCount'];
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const sharedMemoryScope: SharedMemoryGraphScope = options?.sharedMemoryScope
      ?? { kind: 'complete-family' };
    const graphPublish = resolveGraphScopedPublishDescriptor({
      contextGraphId,
      quads: [],
      contentScopeVersion: options?.contentScopeVersion,
      kaUal: options?.kaUal,
      assertionVersion: options?.assertionVersion,
      publicTripleCount: options?.publicTripleCount,
      privateMerkleRoot: options?.privateMerkleRoot,
      privateTripleCount: options?.privateTripleCount,
    });
    if (graphPublish && (selection !== 'all' || sharedMemoryScope.kind !== 'named-lifecycle')) {
      throw new Error(
        'Graph-scoped KA publish requires selection "all" within one exact named-lifecycle SWM scope',
      );
    }
    if (sharedMemoryScope.kind === 'named-lifecycle' && options?.clearSharedMemoryAfter === true) {
      throw new Error(
        'clearSharedMemoryAfter cannot be combined with a named-lifecycle shared-memory scope; ' +
        'use complete-family scope for an explicit family-wide clear',
      );
    }

    // Guard: VM publishing requires an on-chain registered context graph.
    // Skip for mock/none chains (unit tests) — only enforce on real chains.
    // Also skip when publishContextGraphId is set (remap flow) — the source
    // CG may be unregistered while the target CG is already on-chain.
    if (this.chain.chainId !== 'none' && !this.chain.chainId.startsWith('mock') && !options?.publishContextGraphId) {
      const cgMetaUri = contextGraphMetaUri(contextGraphId);
      const cgDataUri = contextGraphDataUri(contextGraphId);

      // Check _meta for explicit registration status
      const regResult = await this.store.query(
        `SELECT ?status WHERE { GRAPH <${cgMetaUri}> { <${cgDataUri}> <https://dkg.network/ontology#registrationStatus> ?status } } LIMIT 1`,
      );
      const regStatus = regResult.type === 'bindings' ? regResult.bindings[0]?.['status']?.replace(/^"|"$/g, '') : undefined;

      if (regStatus !== 'registered') {
        // Fall back to checking for an OnChainId triple in ontology — chain-discovered
        // CGs have this but may not have _meta.registrationStatus synced yet.
        const ontologyGraph = contextGraphDataUri('ontology');
        const onChainResult = await this.store.query(
          `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${cgDataUri}> <https://dkg.network/ontology#ContextGraphOnChainId> ?id } } LIMIT 1`,
        );
        const hasOnChainId = onChainResult.type === 'bindings' && onChainResult.bindings.length > 0;

        if (!hasOnChainId) {
          // #1116 (review B): carry a stable `code` so route matchers no longer
          // have to key on the message text. The MESSAGE stays verbatim — the
          // e2e test (rejects.toThrow(/not registered on-chain/i)) and back-compat
          // route fallbacks still rely on it.
          throw Object.assign(
            new Error(
              `Context graph "${contextGraphId}" is not registered on-chain. ` +
              `Run 'dkg context-graph register ${contextGraphId}' first to enable Verifiable Memory publishing.`,
            ),
            { code: 'CG_NOT_REGISTERED' },
          );
        }
      }
    }

    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options?.subGraphName);

    const loadOptions = {
      quadFilter: (q: Quad) => !isSwmMerkleExcludedQuad(q),
      rootEntitiesErrorMessage: ({ inputCount, hadInput }: { inputCount: number; hadInput: boolean }) => (
        hadInput
          ? `No valid rootEntities provided (all ${inputCount} entries failed IRI validation)`
          : `No rootEntities provided for context graph ${contextGraphId}`
      ),
    };
    const quads = await loadSharedMemoryQuadsForScope(
      this.store,
      swmGraph,
      selection,
      sharedMemoryScope,
      loadOptions,
    );
    const privateQuads = graphPublish
      ? await this.privateStore.getKnowledgeAssetPrivateTriples(
          contextGraphId,
          graphPublish.scope,
          options?.subGraphName,
        )
      : [];

    if (quads.length === 0 && privateQuads.length === 0) {
      throw new Error(
        `No public or private quads for context graph ${contextGraphId} matching the selected Knowledge Asset`,
      );
    }
    // OT-RFC-44 / Design B: once the caller has selected one lifecycle/file,
    // that payload may contain N root entities and still publish as ONE KA in a
    // single transaction. Higher-level selection endpoints keep their
    // unrelated-root guard until they can identify that one lifecycle boundary.
    const rootEntities = graphPublish ? [] : [...skolemizeByEntity(quads).keys()];

    const ctxGraphId = options?.publishContextGraphId;
    const chainCgId = options?.onChainContextGraphId ?? ctxGraphId;

    const idToValidate = chainCgId ?? ctxGraphId;
    if (idToValidate !== undefined && idToValidate !== null) {
      let parsed: bigint;
      try {
        parsed = BigInt(idToValidate);
      } catch {
        throw new Error(`Invalid context graph id: ${String(idToValidate)} (must be a numeric value)`);
      }
      if (parsed <= 0n) {
        throw new Error(
          `Invalid context graph id: ${String(idToValidate)} ` +
          `(must be a positive integer; V10 contract rejects cgId <= 0 at ` +
          `KnowledgeAssetsV10.sol:379 with ZeroContextGraphId)`,
        );
      }
    }

    if (options?.subGraphName && ctxGraphId) {
      throw new Error(
        'subGraphName and publishContextGraphId cannot be used together — ' +
        'the remap flow targets /context/{id} which is incompatible with sub-graph URIs',
      );
    }

    const hasTrustedCatalogTriples = trustedCatalogTripleKeySet(
      options?.trustedNonManifestCatalogTriples,
    ).size > 0;
    await this.assertTrustedCatalogTriplesAllowed({
      contextGraphId,
      trustedNonManifestCatalogTriples: options?.trustedNonManifestCatalogTriples,
      onChainContextGraphId: chainCgId,
    });

    this.log.info(ctx, `Publishing ${quads.length} public and ${privateQuads.length} private quads from shared memory to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'data graph'}${chainCgId && !ctxGraphId ? ` (on-chain CG ${chainCgId})` : ''}${options?.subGraphName ? ` (sub-graph: ${options.subGraphName})` : ''}`);
    const internalPublishOptions: InternalPublishOptions = {
      contextGraphId,
      quads: quads.map((q) => ({ ...q, graph: '' })),
      ...(graphPublish ? { privateQuads } : {}),
      operationCtx: ctx,
      onPhase: options?.onPhase,
      publisherPeerId: options?.publisherPeerId,
      v10ACKProvider: options?.v10ACKProvider,
      trustedNonManifestCatalogTriples: options?.trustedNonManifestCatalogTriples,
      publishContextGraphId: chainCgId ?? undefined,
      fromSharedMemory: true,
      subGraphName: options?.subGraphName,
      publisherNodeIdentityIdOverride: options?.publisherNodeIdentityIdOverride,
      precomputedAttestation: options?.precomputedAttestation,
      encryptInlinePayload: options?.encryptInlinePayload,
      encryptInlineChunked: options?.encryptInlineChunked,
      publishEpochs: options?.publishEpochs,
      // OT-RFC-43 A2 — reuse the finalize-stamped kaId (no re-allocate).
      reservedKaId: options?.reservedKaId,
      contentScopeVersion: options?.contentScopeVersion,
      kaUal: options?.kaUal,
      assertionVersion: options?.assertionVersion,
      publicTripleCount: options?.publicTripleCount,
      privateMerkleRoot: options?.privateMerkleRoot,
      privateTripleCount: options?.privateTripleCount,
      [INTERNAL_ORIGIN_TOKEN]: true,
      [PUBLIC_ACK_STAGING_MODE_TOKEN]: 'inline-small-swm',
      ...(hasTrustedCatalogTriples ? { [TRUSTED_CATALOG_ORIGIN_TOKEN]: true } : {}),
    };
    let publishResult: PublishResult;
    try {
      publishResult = await this.publish(internalPublishOptions);
    } catch (err) {
      if (!isNoDataInSwmFailure(err)) throw err;
      this.log.warn(
        ctx,
        'publishFromSWM core-node verification failed with NO_DATA_IN_SWM; retrying via direct publish with inline quads',
      );
      const directRetryOptions: InternalPublishOptions = {
        ...internalPublishOptions,
        fromSharedMemory: false,
        [PUBLIC_ACK_STAGING_MODE_TOKEN]: 'inline',
      };
      publishResult = await this.publish(directRetryOptions);
    }

    // Per-cgId data promotion: copy quads + KA meta from the default
    // `<NAME>/data` + `<NAME>/_meta` graphs into `<NAME>/context/<cgId>/data`
    // + `<NAME>/context/<cgId>/_meta`. The RS prover's `extractV10KCFromStore`
    // queries the per-cgId meta graph (ka-extractor.ts:154) to resolve a
    // KC's UAL from `dkg:batchId`, so without this promotion every published
    // KC stays invisible to random sampling and the prover loops on
    // `kc-not-synced` indefinitely.
    //
    // Pre-Phase B-3 the gate was `if (ctxGraphId && ...)` which fired only on
    // remap-flow publishes (`subContextGraphId` set). Same-graph publishes
    // through the selection-bridge (`publishContextGraphId === undefined`,
    // `onChainContextGraphId === '<resolved>'`) were silently skipped, breaking
    // RS for all V10 publishes that don't remap. The gate now also fires
    // when only `chainCgId` is set — the target cgId is always
    // `ctxGraphId ?? chainCgId`.
    const targetCgId = ctxGraphId ?? chainCgId;
    // V2/rootless KAs remain in their exact per-KA VM graph. Random sampling
    // resolves that graph from constant-size label metadata, so copying their
    // triples into the legacy shared per-cgId partition would only duplicate
    // storage and would make rootless updates impossible to replace safely.
    if (
      !graphPublish
      && targetCgId
      && publishResult.status === 'confirmed'
      && publishResult.onChainResult
    ) {
      // V10 publishDirect already registered the KC to the context graph
      // inside publishDirect, via a Hub-authorized internal call to
      // ContextGraphs.registerKnowledgeAsset (EOAs cannot call it directly),
      // which emits KnowledgeAssetRegisteredToContextGraph. The legacy V9
      // explicit chain.verify() fallback that used to run here always reverted
      // on V10 ("Only Contracts in Hub" / CALL_EXCEPTION) — i.e. a doomed
      // on-chain call plus an estimateGas round-trip, and serializer occupancy,
      // on EVERY confirmed publish (#1575). Registration is already done, so
      // skip the verify attempt entirely and proceed to the data promotion.
      this.log.debug(ctx, `V10 auto-registered KC to context graph ${targetCgId}; explicit verify skipped`);

        const ctxDataGraph = contextGraphDataUri(contextGraphId, targetCgId);
        const ctxMetaGraph = contextGraphMetaUri(contextGraphId, targetCgId);
        const defaultDataGraph = this.graphManager.dataGraphUri(contextGraphId);
        const defaultMetaGraph = `${defaultDataGraph.replace(/\/data$/, '')}/_meta`;

        // GH#842 last-writer-wins guard: if this KA has already been updated
        // (a newer materialisation exists in the per-cgId meta), this
        // publish-promotion is stale and MUST NOT re-materialise the original
        // KA on top of it — that is exactly the race that made updated KAs
        // unprovable. Skip the whole promotion when stale.
        // `txIndex` is the chain-truth tiebreaker — without it a same-block
        // publish + update would tie and the stale promotion could still
        // overwrite the update.
        const publishVersion: MaterializedVersion = {
          blockNumber: publishResult.onChainResult.blockNumber ?? 0,
          txIndex: publishResult.onChainResult.txIndex ?? 0,
        };
        // PR #845 review: serialise the check + the entire promotion +
        // the final version-stamp under the per-KA materialization lock,
        // otherwise a concurrent update path's `restate*` (or another
        // finalization) can stamp a newer version between our check and
        // our write, and we'd resume mid-sequence and overwrite it.
        await withMaterializationLock(ctxMetaGraph, publishResult.ual, async () => {
        const applyPromotion = await shouldApplyMaterialization(
          this.store, ctxMetaGraph, publishResult.ual, publishVersion,
        );
        if (!applyPromotion) {
          this.log.info(ctx, `Skipped publish→per-cgId promotion for ${publishResult.ual}: a newer update is already materialised`);
        } else {
        // Data promotion: always COPY public quads to the per-cgId data
        // graph (`<NAME>/context/<cgId>/data`) — RS prover's
        // `extractV10KCFromStore` reads triples from there
        // (`ka-extractor.ts` line ~225). On REMAP-flow publishes
        // (`publishContextGraphId` set), also delete the original copy
        // from the default data graph; on same-graph publishes, leave
        // the default copy in place so `agent.query(label)` (which
        // resolves to `did:dkg:context-graph:<label>` without a
        // `/context/<id>` suffix) still finds the just-published
        // triples. Mirrors the `_meta` pattern below.
        if (
          publishResult.publicQuads &&
          publishResult.publicQuads.length > 0
        ) {
          // Uniform layout: the confirmed publish wrote the public quads to the per-KA
          // verifiable-memory graph (…/_verifiable_memory/{author}/{number}); copy from there to the
          // per-cgId graph, and (REMAP flow) delete from there so the data ends up ONLY in per-cgId.
          const remapKaId = publishResult.onChainResult!.kaId ?? publishResult.onChainResult!.batchId;
          const remapVmGraph = contextGraphLayerUri(contextGraphId, MemoryLayer.VerifiableMemory, '0x' + (remapKaId >> 96n).toString(16).padStart(40, '0'), remapKaId & ((1n << 96n) - 1n));
          const storedQuads = publishResult.publicQuads.map(q => ({ ...q, graph: remapVmGraph }));
          await this.store.insert(storedQuads.map(q => ({ ...q, graph: ctxDataGraph })));
          const trustSubjects = collectTrustSubjectsForRoots(
            storedQuads,
            publishResult.kaManifest.map((ka) => ka.rootEntity),
          );
          await stampTrustLevel(
            this.store,
            ctxDataGraph,
            trustSubjects,
            TrustLevel.SelfAttested,
          );
          if (ctxGraphId) {
            await this.store.delete(storedQuads);
            for (const subject of trustSubjects) {
              await this.store.deleteByPattern({
                graph: remapVmGraph,
                subject,
                predicate: TRUST_LEVEL_PREDICATE,
              });
            }
          }
        }

        const ual = publishResult.ual;
        if (ctxGraphId) {
          // REMAP flow: the per-cgId partition is this KA's ONLY meta home —
          // the default-graph rows are MOVED, not duplicated — so the full
          // row set (status / accessPolicy / attribution / receipt / …) must
          // travel with it. Wholesale CONSTRUCT-move, unchanged. The legacy
          // `<ual>/<n>` subjects are included for old-shape rows still
          // present in the default meta (RFC ka-metadata-trim P3.1
          // read-both); collapsed-shape rows all live on the UAL subject.
          const kaUals = publishResult.kaManifest.map(ka => `${ual}/${ka.tokenId}`);
          const metaSubjects = new Set([ual, ...kaUals]);
          const metaQuery = `CONSTRUCT { ?s ?p ?o } WHERE {
            GRAPH <${defaultMetaGraph}> {
              VALUES ?s { ${[...metaSubjects].map(s => `<${s}>`).join(' ')} }
              ?s ?p ?o .
            }
          }`;
          const metaResult = await this.store.query(metaQuery);
          if (metaResult.type === 'quads' && metaResult.quads.length > 0) {
            await this.store.insert(metaResult.quads.map(q => ({ ...q, graph: ctxMetaGraph })));
            await this.store.delete(metaResult.quads.map(q => ({ ...q, graph: defaultMetaGraph })));
          }
        } else {
          // RFC ka-metadata-trim Phase 3 (P3.5): same-graph publishes keep
          // their full KC rows in the label `_meta`; the per-cgId partition
          // gets ONLY the documented minimal shape (restateKaPartition
          // parity) the RS prover needs:
          //   - the collapsed member-entity pair on the UAL subject (the
          //     partOf-equivalent linkage, P3.1 — no `<ual>/<n>` tokens),
          //   - `dkg:batchId` (the UAL resolution edge),
          //   - `dkg:merkleRoot` (+ `dkg:privateMerkleRoot` when present);
          //   - `dkg:materializedVersion` is stamped below.
          // The RS prover and the backfill route are read-both, so old
          // wholesale-copied partitions keep working.
          const partitionKaId = publishResult.onChainResult!.kaId ?? publishResult.onChainResult!.batchId;
          await this.store.insert(
            buildScopedMinimalMeta(ual, partitionKaId, publishResult.merkleRoot, publishResult.kaManifest, ctxMetaGraph),
          );
        }

        // Stamp the publish version so a later update can compare against it
        // (and a concurrent stale re-promote is rejected above).
        await writeMaterializedVersion(this.store, ctxMetaGraph, publishResult.ual, publishVersion);

        this.log.info(ctx, `Promoted ${publishResult.kaManifest.length} KAs from default graph to context graph ${targetCgId}`);
        }
        });
    }

    // SWM cleanup: ALWAYS remove published triples from SWM after chain confirmation.
    // Published triples must not linger in SWM; they live in LTM now.
    // clearSharedMemoryAfter controls only whether the REMAINING unpublished triples are also cleared.
    if (publishResult.status === 'confirmed') {
      if (graphPublish) {
        await this.clearPublishedKnowledgeAssetSwm(
          contextGraphId,
          sharedMemoryScope,
          options?.subGraphName,
          ctx,
          graphPublish.scope.ual,
        );
      } else {
        const kaMap = skolemizeByEntity(quads);
        await this.clearPublishedSwmRoots(
          contextGraphId,
          [...kaMap.keys()],
          options?.subGraphName,
          ctx,
          sharedMemoryScope,
        );
      }
      // If clearSharedMemoryAfter is explicitly true, also clear any remaining unpublished content.
      // Default is false: unpublished entities stay in SWM for future publishes.
      if (options?.clearSharedMemoryAfter === true) {
        await this.clearRemainingSharedMemory(contextGraphId, options?.subGraphName, ctx);
      }
    }

    // RFC ka-metadata-trim Phase 0: the promoted→published lifecycle-record
    // update that lived here was dead code — its SPARQL gate joined
    // `dkg:agent`, a predicate the lifecycle writer never emits (it writes
    // `prov:wasAttributedTo`), so it never fired. The SWM→VM flip is done
    // imperatively in dkg-agent-publish.ts.

    return publishResult;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(...args: Parameters<DKGPublisher['publishFromSharedMemory']>): ReturnType<DKGPublisher['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
  }

  /**
   * Collect receiver signatures from peers via a provided responder function.
   * Deduplicates by identityId.
   */
  async collectReceiverSignatures(params: {
    merkleRoot: string;
    publicByteSize: bigint;
    peerResponder: (peerId: string, merkleRoot: string, publicByteSize: bigint) => Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>>;
    minimumRequired: number;
    timeoutMs: number;
  }): Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>> {
    const sigs = await Promise.race([
      params.peerResponder('*', params.merkleRoot, params.publicByteSize),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Receiver signature collection timed out after ${params.timeoutMs}ms`)), params.timeoutMs),
      ),
    ]);

    // Deduplicate by identityId
    const seen = new Set<bigint>();
    const unique = sigs.filter((s) => {
      if (seen.has(s.identityId)) return false;
      seen.add(s.identityId);
      return true;
    });

    if (unique.length < params.minimumRequired) {
      throw new Error(
        `Insufficient receiver signatures: got ${unique.length}, need ${params.minimumRequired}`,
      );
    }

    return unique;
  }

  /**
   * Collect context graph participant signatures via a provided responder function.
   * Deduplicates by identityId.
   */
  async collectParticipantSignatures(params: {
    contextGraphId: bigint;
    merkleRoot: string;
    participantResponder: () => Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>>;
    minimumRequired: number;
    timeoutMs: number;
  }): Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>> {
    const sigs = await Promise.race([
      params.participantResponder(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Participant signature collection timed out after ${params.timeoutMs}ms`)), params.timeoutMs),
      ),
    ]);

    const seen = new Set<bigint>();
    const unique = sigs.filter((s) => {
      if (seen.has(s.identityId)) return false;
      seen.add(s.identityId);
      return true;
    });

    if (unique.length < params.minimumRequired) {
      throw new Error(
        `Insufficient participant signatures: got ${unique.length}, need ${params.minimumRequired}`,
      );
    }

    return unique;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const explicitPublishEpochs = resolvePublishEpochsOverride(options.publishEpochs);

    // Sub-graph routing: data triples go to `did:dkg:context-graph:{id}/{subGraph}`.
    // KC metadata (status, authorship proofs) stays in the root `_meta` graph so that
    // AccessHandler.lookupKAMeta() and DKGQueryEngine.resolveKA() can still discover
    // the KC without knowing which sub-graph holds the data triples.
    if (options.subGraphName && !options.targetGraphUri) {
      const sgValidation = validateSubGraphName(options.subGraphName);
      if (!sgValidation.valid) throw new Error(`Invalid sub-graph name: ${sgValidation.reason}`);

      const sgUri = contextGraphSubGraphUri(options.contextGraphId, options.subGraphName);
      if (!(await this.isSubGraphRegistered(options.contextGraphId, options.subGraphName))) {
        throw new Error(
          `Sub-graph "${options.subGraphName}" has not been registered in context graph "${options.contextGraphId}". ` +
          `Call createSubGraph() first.`,
        );
      }

      options = {
        ...options,
        targetGraphUri: sgUri,
      };
    }

    const {
      contextGraphId,
      quads,
      privateQuads = [],
      publisherPeerId = '',
      accessPolicy,
      allowedPeers,
      operationCtx,
      entityProofs = false,
      onPhase,
    } = options;
    // Round 9 Bug 25 + Round 12 Bug 34: reject user-authored reserved-
    // namespace subjects. The bypass is keyed on a module-private
    // `INTERNAL_ORIGIN_TOKEN` Symbol (see its declaration near the top
    // of the file) — NOT on the public `fromSharedMemory` flag. That
    // means external callers cannot bypass this guard by setting a
    // public option; only in-file code paths (specifically
    // `publishFromSharedMemory`) can mint the token. Public
    // `fromSharedMemory` retains its V10 ACK-path semantic
    // independently.
    if (!isInternalOrigin(options)) {
      rejectUserAuthoredProtocolMetadata(quads);
      if (privateQuads.length > 0) rejectUserAuthoredProtocolMetadata(privateQuads);
    }
    rejectOversizedRdfLiterals(quads, 'publish.quads');
    if (privateQuads.length > 0) rejectOversizedRdfLiterals(privateQuads, 'publish.privateQuads');
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    const effectiveAccessPolicy = accessPolicy ?? (privateQuads.length > 0 ? 'ownerOnly' : 'public');
    const normalizedAllowedPeers = [...new Set((allowedPeers ?? []).map((p) => p.trim()).filter(Boolean))];
    const normalizedPublisherPeerId = publisherPeerId.trim();
    const graphPublish = resolveGraphScopedPublishDescriptor(options);
    const onChainContextGraphId = options.onChainContextGraphId ?? options.publishContextGraphId;
    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(onChainContextGraphId ?? contextGraphId);
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Descriptive SWM graph names stay on the existing tentative/mock path.
    }
    // Per-publish attribution override (RFC-001 §4): see PublishOptions
    // docstring. `hasAttributionOverride` lets a caller force a specific
    // attribution value (including `0n` for the contract's no-attribution
    // mode); without an override we fall through to whatever this
    // publisher's persistent V10 identity is (which is `0n` for daemons
    // that never registered a Profile — e.g. edge nodes).
    //
    // OT-RFC-38 §1.1 — edge agents that haven't (and won't) register an
    // on-chain Profile MUST still be able to publish curated CGs to VM.
    // `attributionIdentityId === 0n` is the contract's no-attribution mode
    // and `KnowledgeAssetsV10.publishKnowledgeCollections` accepts it, so
    // we no longer gate the on-chain attempt on identity presence. The
    // `publisherSigner` still resolves from the chain adapter regardless
    // of profile state — see `inferAdapterPublisherAddress`. If no signer
    // can be resolved at all, the on-chain branch throws
    // `PublisherWalletRequiredError` instead of silently degrading.
    const hasAttributionOverride = options.publisherNodeIdentityIdOverride !== undefined;
    const publisherPlanning = await this.publisherPlanner.prepare(publisherContextGraphId);
    const chainV10Ready = publisherPlanning.chainV10Ready;
    const canAttemptOnChainPublish = publisherPlanning.canAttemptOnChainPublish;

    // RFC-001 §9.x — sign-at-creation. The publisher is a pure
    // transport layer for the AuthorAttestation: the seal is built at
    // `agent.assertion.finalize()` time and forwarded here verbatim
    // via `precomputedAttestation`. The publisher never signs the
    // AuthorAttestation itself.
    //
    // For on-chain publishes, `precomputedAttestation` MUST be
    // supplied. The agent layer is responsible for producing it
    // (custodial / self-sovereign / publisher-fallback all resolved
    // there); see `agent.assertion.finalize`. This check fires below
    // once we know whether we're going on-chain.

    if (effectiveAccessPolicy !== 'public' && normalizedPublisherPeerId.length === 0) {
      throw new Error(
        `Publish rejected: accessPolicy "${effectiveAccessPolicy}" requires a non-empty "publisherPeerId"`,
      );
    }

    if (effectiveAccessPolicy === 'allowList' && normalizedAllowedPeers.length === 0) {
      throw new Error('Publish rejected: accessPolicy "allowList" requires non-empty "allowedPeers"');
    }
    if (effectiveAccessPolicy !== 'allowList' && normalizedAllowedPeers.length > 0) {
      throw new Error('Publish rejected: "allowedPeers" is only valid when accessPolicy is "allowList"');
    }

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:ensureContextGraph', 'start');
    this.log.info(ctx, `Preparing publish: ${quads.length} public triples, ${privateQuads.length} private`);
    if (options.skipContextGraphEnsure) {
      this.log.info(ctx, `Skipping context graph ensure for prevalidated direct publish: ${contextGraphId}`);
    } else {
      await this.graphManager.ensureContextGraph(contextGraphId);
    }
    onPhase?.('prepare:ensureContextGraph', 'end');

    onPhase?.('prepare:partition', 'start');
    await this.assertTrustedCatalogTriplesAllowed({
      contextGraphId,
      trustedNonManifestCatalogTriples: options.trustedNonManifestCatalogTriples,
      onChainContextGraphId: publisherContextGraphId,
      internalCatalogOrigin: isTrustedCatalogInternalOrigin(options),
    });
    let canonical: ReturnType<typeof canonicalPublishPayload> | undefined;
    let canonicalPrivateQuads: Quad[] = [];
    let allSkolemizedQuads: Quad[];
    let privateRoots: Uint8Array[];
    if (graphPublish) {
      assertNoKnowledgeAssetPayloadNamedGraphs(quads, privateQuads);
      const canonicalParts = await skolemizeKnowledgeAssetParts(quads, privateQuads, {
        allowCanonicalSkolemTerms: isInternalOrigin(options),
      });
      allSkolemizedQuads = canonicalParts.publicQuads;
      canonicalPrivateQuads = canonicalParts.privateQuads;
      const vmGraph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        graphPublish.scope,
        options.subGraphName,
      );
      const validation = validateCanonicalGraphScopedKnowledgeAssetPayload(
        allSkolemizedQuads.map((quad) => ({ ...quad, graph: vmGraph })),
        vmGraph,
        graphPublish.publicTripleCount,
      );
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
      }
      if (canonicalPrivateQuads.length !== graphPublish.privateTripleCount) {
        throw new Error(
          `Graph-scoped KA private triple count mismatch: envelope=${graphPublish.privateTripleCount}, ` +
            `canonical=${canonicalPrivateQuads.length}`,
        );
      }
      const privateRoot = computePrivateRoot(canonicalPrivateQuads);
      if (graphPublish.expectedPrivateMerkleRoot) {
        if (
          !privateRoot
          || privateRoot.length !== graphPublish.expectedPrivateMerkleRoot.length
          || !privateRoot.every((byte, index) => byte === graphPublish.expectedPrivateMerkleRoot![index])
        ) {
          throw new Error('Graph-scoped KA private Merkle root does not match the envelope commitment');
        }
      }
      privateRoots = privateRoot ? [privateRoot] : [];
    } else {
      canonical = canonicalPublishPayload(quads, privateQuads, {
        trustedNonManifestCatalogTriples: options.trustedNonManifestCatalogTriples,
      });
      allSkolemizedQuads = canonical.skolemizedPublicQuads;
      privateRoots = canonical.privateRoots;
    }
    onPhase?.('prepare:partition', 'end');

    const manifestEntries: KAManifestEntry[] = [];
    const kaMetadata: KAMetadata[] = [];

    onPhase?.('prepare:manifest', 'start');
    // OT-RFC-44 / Design B: one file/lifecycle = ONE Knowledge Asset, however
    // many entities it contains. The on-chain KA count and ACK digest stay at
    // one below, while these token IDs remain compatibility labels for
    // per-root response/meta subjects (`<ual>/1`, `<ual>/2`, ...).
    // GH #936 — mint the compatibility tokenIds over a CANONICAL (lexicographic
    // by rootEntity) order, the SAME order the replica reconcile/gossip path
    // uses in `FinalizationHandler.promoteSharedMemoryToCanonical`. Without this,
    // the ORIGINATOR would label `<ual>/<tokenId>` by input-quad order while
    // replicas label by sorted order, so a multi-root KC could resolve a
    // different root for the same token label depending on which node a client
    // queries. These tokenIds are non-on-chain compatibility labels (the
    // on-chain KA count is 1), so a content-derived sort is safe.
    const orderedEntries = [...(canonical?.manifestEntries ?? [])].sort((a, b) =>
      compareRootIris(a.rootEntity, b.rootEntity),
    );
    let compatibilityTokenId = 1n;
    for (const entry of orderedEntries) {
      const tokenId = compatibilityTokenId++;
      manifestEntries.push({
        tokenId,
        rootEntity: entry.rootEntity,
        privateMerkleRoot: entry.privateMerkleRoot,
        privateTripleCount: entry.privateTripleCount,
      });

      kaMetadata.push({
        rootEntity: entry.rootEntity,
        kcUal: '',
        tokenId,
        publicTripleCount: entry.publicTripleCount,
        privateTripleCount: entry.privateTripleCount,
        privateMerkleRoot: entry.privateMerkleRoot,
      });
    }

    onPhase?.('prepare:manifest', 'end');

    onPhase?.('prepare:validate', 'start');
    if (!graphPublish) {
      const publishOwnershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      const existing = this.ownedEntities.get(publishOwnershipKey) ?? new Set();
      const validation = validatePublishRequest(
        allSkolemizedQuads,
        manifestEntries,
        contextGraphId,
        existing,
        {
          trustedNonManifestCatalogTriples: options.trustedNonManifestCatalogTriples,
        },
      );
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
      }
    }
    onPhase?.('prepare:validate', 'end');

    onPhase?.('prepare:merkle', 'start');
    const kcMerkleRoot = graphPublish
      ? computeFlatKCRoot(allSkolemizedQuads, privateRoots)
      : canonical!.kcMerkleRoot;
    const kcMerkleLeafCount = computeFlatKCMerkleLeafCountV10(allSkolemizedQuads, privateRoots);
    if (kcMerkleLeafCount > 0xffffffff) {
      throw new Error(`V10 merkleLeafCount exceeds uint32: ${kcMerkleLeafCount}`);
    }
    this.log.info(ctx, `Computed kcMerkleRoot (structured: hashPair(publicRoot, privateDataHash)) over ${allSkolemizedQuads.length} public triple hashes + ${privateRoots.length} private root(s), public leafCount=${kcMerkleLeafCount}`);
    // Design B: a publish mints exactly ONE KA regardless of entity count.
    // `entityCount` is informational; `kaCount` is what goes on chain as
    // `knowledgeAssetsAmount` (the contract requires == 1) and into the ACK
    // digest. The old `kaCount = manifestEntries.length` + `kaCount !== 1`
    // guard conflated entity count with KA count and blocked multi-entity
    // files; that conflation is the bug OT-RFC-44 removes.
    const entityCount = manifestEntries.length;
    const kaCount = 1;
    if (!graphPublish && entityCount < 1) {
      throw new Error('V10 publish requires at least one entity');
    }
    this.log.info(
      ctx,
      graphPublish
        ? `Publishing 1 graph-scoped KA with ${allSkolemizedQuads.length} public triples`
        : `Design B: publishing 1 KA with ${entityCount} member entit${entityCount === 1 ? 'y' : 'ies'}`,
    );
    onPhase?.('prepare:merkle', 'end');

    onPhase?.('prepare', 'end');
    onPhase?.('store', 'start');

    const dataGraph = graphPublish
      ? knowledgeAssetLayerGraphUri(
          contextGraphId,
          MemoryLayer.VerifiableMemory,
          graphPublish.scope,
          options.subGraphName,
        )
      : options.targetGraphUri ?? this.graphManager.dataGraphUri(contextGraphId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    // RC11 / PR2: defer the public-data insert into the root data graph
    // until AFTER on-chain confirmation (or until the publisher's chain
    // branch is intentionally skipped because there is no chain to
    // confirm against — NoChainAdapter / non-V10 / no on-chain CG id).
    // Inserting pre-chain caused the "tentative VM" leak where
    // /api/query would surface quads from a publish that the chain
    // later rejected as if they were verifiable memory. See the chain
    // success branch + the `publisherContextGraphId/chainV10Ready`
    // skip branches below — each writes `normalizedQuads` exactly once,
    // never on the chain-failure catch path.
    //
    // Private-store insert stays here. The private store is namespaced
    // outside the VM-visible data graph and access is gated by
    // `AccessHandler`'s per-entity policy check, so it does not
    // contribute to the VM leakage surface this PR closes. Keeping it
    // pre-chain also keeps the private store's contents lined up with
    // the precomputed `privateMerkleRoot` the publisher just committed
    // to ACK / chain digests — moving it past the chain-success branch
    // would risk a race where the publisher returns 'confirmed' before
    // its own private store has the data.
    // GH #1078 — persist the finalized private slices. DEFERRED to the terminal
    // branches (post-chain-confirmation, or the intentional-local finalize) and
    // NEVER run on the chain-failure path. Because `storePrivateTriples(…,
    // commitmentId)` now SUPERSEDES a root's prior private slice when the
    // commitment differs, running it pre-chain would let a failed/rejected
    // re-publish delete the private data of the still-current KA while the chain
    // still points at the old version. Gating it on confirmation keeps the
    // private store consistent with the committed `privateMerkleRoot`, and
    // invoking it BEFORE the publish returns 'confirmed' preserves the
    // no-"confirmed-before-data" guarantee the pre-chain insert used to give.
    const persistFinalizedPrivateSlices = async (): Promise<void> => {
      if (graphPublish) {
        await this.privateStore.replaceKnowledgeAssetPrivateTriples(
          contextGraphId,
          graphPublish.scope,
          canonicalPrivateQuads,
          options.subGraphName,
        );
        return;
      }
      for (const entry of canonical!.manifestEntries) {
        const entityPrivateQuads = privateQuads.filter(
          (q) => q.subject === entry.rootEntity || q.subject.startsWith(entry.rootEntity + '/.well-known/genid/'),
        );
        if (entityPrivateQuads.length > 0) {
          // Tag the stored slice with the commitment this root committed (its
          // privateMerkleRoot) so a later re-publish supersedes the stale slice.
          const commitmentId = entry.privateMerkleRoot
            ? Buffer.from(entry.privateMerkleRoot).toString('hex')
            : undefined;
          await this.privateStore.storePrivateTriples(contextGraphId, entry.rootEntity, entityPrivateQuads, options.subGraphName, commitmentId);
        }
      }
    };

    onPhase?.('store', 'end');

    // Compute publicByteSize early — needed for signature collection
    const nquadsStr = allSkolemizedQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph || dataGraph}> .`,
      )
      .join('\n');
    const publicNquadsBytes = new TextEncoder().encode(nquadsStr);
    const publicByteSize = BigInt(publicNquadsBytes.length);

    // Legacy payloads retain the combined catalog model. V2 graph-scoped KAs
    // use a detached protocol-owned floor: their KC Merkle root and exact
    // publicTripleCount cover only the submitted canonical RDF, while the
    // independent catalogRoot/catalogLeafCount pair commits the generated
    // public floor. This also prevents a user-authored CG-DID triple from being
    // stripped out of the atomic KA or leaked into the plaintext catalog.
    const { catalogQuads, otherQuads } = resolveCatalogProofMaterial(
      allSkolemizedQuads,
      contextGraphId,
      graphPublish !== undefined,
      options.trustedNonManifestCatalogTriples,
      dataGraph,
    );
    const encryptableNquadsStr = catalogQuads.length === 0
      ? nquadsStr
      : otherQuads
          .map(
            (q) =>
              `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
          )
          .join('\n');

    // OT-RFC-49 / WS-D — the CURATED random-sampling commitment is the PUBLIC
    // `_catalog` Merkle root (NOT the stripped ciphertext root). Compute it ONCE
    // from the committed catalog leaf-set (`partitionCatalogQuads` output minus
    // the post-publish stamps — see `catalogCommittedLeaves`) so the on-chain
    // `catalogRoot`, the ACK digest, the curated ACK intent payload, and the
    // pricing `byteSize` all derive from a SINGLE source and cannot desync. The
    // prover's `catalog-extractor` rebuilds over the SAME committed set, so the
    // committed root == the proven root by construction.
    //
    // `committedCatalogLeaves` are graph-less triples; serialize them as plain
    // N-Triples (no graph term) so the curated ACK handler's
    // `parseSimpleNQuads` → `computeCatalogRoot(catalogCommittedLeaves(...))`
    // rebuild reproduces the identical leaf hashes (`hashTripleV10` excludes the
    // graph by design). undefined for public CGs and any curated CG with no
    // catalog entry (then catalog fields stay zero on chain).
    const committedCatalogLeaves = catalogCommittedLeaves(catalogQuads);
    const catalogCommitment = committedCatalogLeaves.length > 0
      ? computeCatalogRoot(committedCatalogLeaves)
      : undefined;
    const catalogNquadsStr = committedCatalogLeaves
      .map(
        (t) =>
          `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`,
      )
      .join('\n');
    const catalogByteSize = BigInt(new TextEncoder().encode(catalogNquadsStr).length);
    // Persist the catalog entry plaintext into the public `_catalog` graph so it
    // survives the post-publish SWM clear and is queryable/servable (the data
    // stays encrypted-only). Bounded named graph ⇒ the §7 facet open-serve can
    // release exactly this and nothing gated.
    //
    // B3: this write MUST NOT happen until the publish actually persists. If we
    // wrote it here (pre-ACK, pre-chain) a failed ACK collection or a reverted
    // on-chain tx would still leave a public catalog entry exposing a CG whose
    // verifiable memory never landed. So we only PREPARE the deferred writer
    // here and invoke it from the exact branches that persist the main publish
    // result: each intentional-local branch (via `finalizeIntentionalLocalPublish`)
    // and the confirmed chain-success branch. The chain-failure catch path never
    // calls it, so a failed publish leaves the `_catalog` graph untouched.
    const persistCatalogEntry = async (): Promise<void> => {
      if (catalogQuads.length === 0) return;
      // Canonical location (shared with projection + open-serve): graph =
      // contextGraphCatalogUri(contextGraphId) (`<source-cg>/_catalog`), subject =
      // the context-graph DID. B4: CLEAR/REPLACE — purge any prior catalog
      // entry for these subjects in this graph before inserting the refreshed
      // one, so repeated publishes don't accumulate stale catalog triples.
      const catalogGraph = contextGraphCatalogUri(contextGraphId);
      const catalogSubjects = new Set(catalogQuads.map((q) => q.subject));
      for (const subject of catalogSubjects) {
        await this.store.deleteByPattern({ graph: catalogGraph, subject });
      }
      await this.store.insert(catalogQuads.map((q) => ({ ...q, graph: catalogGraph })));
    };

    const merkleRootHex = ethers.hexlify(kcMerkleRoot);
    let publishOperationId = '';
    let ual = '';
    const ensurePublishOperationIdentity = () => {
      if (publishOperationId.length > 0) return;
      const tentativeSeq = ++this.tentativeCounter;
      // RFC-001 §3.5 publication identifier. Stable across tentative and
      // confirmed states for this publish so the `dkg:Publication` subject
      // emitted in metadata stays the same after on-chain confirmation.
      publishOperationId = `${this.sessionId}-${tentativeSeq}`;
    };

    // V10: Collect core node StorageACKs (spec §9.0, Phase 3).
    // For direct publish: send staging quads inline via P2P so core nodes
    // can verify the merkle root without needing SWM pre-positioning.
    // For public callers using fromSharedMemory: data is already in peers'
    // SWM via shared memory gossip — do NOT send inline quads; core nodes
    // verify against their local SWM copy (preserving storage-attestation).
    // Internal publishFromSharedMemory() calls set a private ACK staging policy
    // to inline small public payloads on the first ACK attempt, avoiding the
    // public-CG subscription gap; oversized payloads keep the SWM fallback.
    // Folded public+private publishes send only the private Merkle roots on
    // the ACK wire. Core nodes verify the public quads they store and fold
    // those commitments into the claimed KC root without seeing private
    // plaintext.
    // OT-RFC-38 / LU-5: when an encryptInlinePayload hook is wired (curated
    // CGs only — DKGAgent resolves this from accessPolicy), ALWAYS send the
    // payload inline as AEAD ciphertext, regardless of `fromSharedMemory`.
    // Cores can't decrypt and they're not subscribed to curated SWM yet
    // (substrate split lands in LU-6), so SWM-lookup would always decline
    // with NO_DATA_IN_SWM — the exact bug §1.1 surfaces. Public CGs keep
    // strict external `fromSharedMemory` semantics; only an internal explicit
    // ACK staging policy can opt into size-gated inline staging.
    // GH #1121 — take the encrypted-inline path whenever a REAL encryption
    // callback is wired. The ONE exception: skip the async-lift mapper's
    // fail-closed DEFAULT on a chainless / local-only publish (ownerOnly KA on
    // an unregistered CG, chain-not-ready node, …). Such a publish ships nothing
    // to other nodes, so there is no plaintext-to-cores leak to guard — and the
    // default (which exists only to prevent that leak) cannot resolve a real
    // chain-key off-chain, so invoking it would needlessly fail a legitimate
    // local publish. For an actual on-chain publish the default still fires
    // (fail-closed): a private payload is never shipped to cores in the clear.
    const inlineEncryptCb = options.encryptInlinePayload;
    const useEncryptedInline =
      typeof inlineEncryptCb === 'function'
      && (canAttemptOnChainPublish || !isFailClosedInlineEncrypt(inlineEncryptCb));
    // OT-RFC-49 / WS-D — a curated publish is now identified by a non-zero
    // catalog commitment. The on-chain commitment + the core ACK verify the
    // PUBLIC `_catalog`; the PRIVATE data stays encrypted for MEMBERS only.
    // `useCuratedCatalog` gates the inline-catalog ACK path (cores rebuild the
    // catalog root from the inline plaintext and DECLINE on mismatch).
    const useCuratedCatalog = useEncryptedInline && catalogCommitment !== undefined;
    if (useEncryptedInline && privateRoots.length > 0 && !graphPublish) {
      throw new Error(
        'Encrypted inline publishes with privateQuads are not supported by the current V10 ACK model. ' +
        'The publisher can collect either curated-catalog ACKs or folded-private public-CG ACKs, ' +
        'but not both in one publish without a mixed ACK mode that preserves curated confidentiality.',
      );
    }
    // Funding/signer selection must finish before either encryption hook runs:
    // the chunked hook persists and gossips member ciphertext, so invoking it
    // for an unfundable publish would leave remote staging artifacts behind.
    // Curated ACK pricing is known from the public catalog commitment without
    // running member-side encryption, which lets us finalize the whole plan at
    // this fail-fast boundary.
    const stagingByteSize = useEncryptedInline && useCuratedCatalog
      ? catalogByteSize
      : publicByteSize;
    const effectiveByteSize = useEncryptedInline ? stagingByteSize : publicByteSize;
    const finalizedPublisherPlan = await publisherPlanning.finalize({
      explicitPublishEpochs,
      effectiveByteSize,
      ctx,
    });
    const publisherSigner = finalizedPublisherPlan.kind === 'on-chain'
      ? finalizedPublisherPlan.signer
      : undefined;
    const publisherAddress = finalizedPublisherPlan.publisherAddress;
    const publishEpochs = finalizedPublisherPlan.publishEpochs;
    const precomputedTokenAmount = finalizedPublisherPlan.tokenAmount;

    let stagingQuads: Uint8Array | undefined;
    if (useEncryptedInline) {
      // MEMBER-SIDE ENCRYPTION STAYS. The private (non-catalog) data is still
      // AEAD-encrypted and distributed to CG members — via the chunked SWM
      // fan-out when wired (preferred), else the single-blob hook. This is
      // member distribution ONLY; OT-RFC-49 stripped the ciphertext from the
      // on-chain commitment, the core ACK, and pricing, so the returned
      // ciphertext root/bytes are intentionally DISCARDED here.
      const plaintextBytes = new TextEncoder().encode(encryptableNquadsStr);
      if (typeof options.encryptInlineChunked === 'function') {
        ensurePublishOperationIdentity();
        // batchId = V10 KC merkleRoot (member-side per-chunk persistence key);
        // publishOperationId is the per-operation AEAD nonce domain.
        await options.encryptInlineChunked({
          plaintextNquads: plaintextBytes,
          batchId: kcMerkleRoot,
          publishOperationId,
        });
      } else {
        // Single-blob member encryption (no chunked emitter wired): run the
        // hook so members still receive ciphertext; discard the bytes.
        await options.encryptInlinePayload!(plaintextBytes);
      }
      // The ACK wire payload for a curated CG is the PUBLIC catalog N-quads
      // (plaintext — the catalog is public by design). Cores rebuild the
      // catalog root from these bytes, verify == the claimed `catalogRoot`,
      // persist them to `<cg>/_catalog`, and sign. byteSize == the catalog
      // footprint, derived from the SAME committed leaf-set as the root.
      if (useCuratedCatalog) {
        stagingQuads = new TextEncoder().encode(catalogNquadsStr);
      } else {
        // Curated CG with no catalog entry — nothing public to commit/serve.
        // Leave staging empty; this publish carries a zero catalog commitment.
        stagingQuads = undefined;
      }
    } else {
      // A2 (§1.1 fix): internal public-CG VM publishes ship small plaintext
      // quads inline on the first ACK attempt — the
      // SAME bytes the NO_DATA_IN_SWM self-heal retry (fromSharedMemory:false)
      // and the curated catalog path above already send. Relying on a core's
      // local SWM copy declines NO_DATA_IN_SWM / times out the round whenever
      // the core never subscribed to the public CG's workspace topic (the
      // common case on public networks: cores only auto-subscribe curated
      // workspace topics). byteSize (`publicByteSize`/`effectiveByteSize`),
      // `kcMerkleRoot` and the ACK digest all derive from `nquadsStr`, so this
      // is byte-identical to the self-heal path — just on attempt 1, which
      // avoids the failed first round + 120s storage_ack_timeout.
      // Exception: above the core's inline cap keep
      // the SWM-lookup fallback so a large publish can still ACK from cores that
      // synced the data (the bound-graph SWM lookup in A3 keeps that path fast).
      // Public callers that set `fromSharedMemory: true` keep the strict SWM
      // contract and therefore omit `stagingQuads`.
      stagingQuads = selectPublicStagingQuads(
        resolvePublicACKStagingMode(options),
        publicNquadsBytes,
      );
    }

    // The adapter-owned plan above has already finalized signer, lifetime, and
    // exact token amount before encryption or ACK collection. Those same values
    // feed the H5-prefixed ACK digest and the chain call. For curated CGs the
    // priced byte size is the committed public catalog footprint; for public
    // CGs it is the plaintext footprint. This keeps fundability, pricing, ACK,
    // and transaction inputs on one coherent plan.
    // Identifier split for V10 publishes.
    //
    //   `contextGraphId` (outer) = the SWM graph id the publisher reads
    //     data from (e.g. "devnet-test" or "42").
    //   `options.publishContextGraphId` (optional) = the TARGET on-chain
    //     numeric CG id that the ACK digest + publishDirect tx use.
    //
    // Remap flow: `publishFromSharedMemory("devnet-test", { publishContextGraphId: "42" })`
    //   → swmGraphId = "devnet-test", target CG id = 42. Peers read SWM at
    //   "devnet-test" and sign the ACK against on-chain id 42.
    //
    // Direct flow: `dkg publish "42"` → both are "42"; no remap.
    //
    // The previous code force-picked `contextGraphId` whenever
    // `isPublishFromSharedMemory` was true, which made the ACK digest and
    // the on-chain tx see the SOURCE name (not a number) in the remap
    // flow → `BigInt()` threw → silent 0n → evm-adapter fail-loud →
    // ZeroContextGraphId. Always prefer the explicit target override.
    const v10CgDomain = String(onChainContextGraphId ?? contextGraphId);
    const swmGraphId = contextGraphId;
    const attributionIdentityId: bigint = hasAttributionOverride
      ? options.publisherNodeIdentityIdOverride!
      : this.publisherNodeIdentityId;
    const lifecycle = new PublishLifecycleLogger({
      log: this.log,
      ctx,
      localPeerId: normalizedPublisherPeerId || 'unknown',
      localNodeIdentityId: attributionIdentityId.toString(),
      resolveAssetUal: (kaId) => this.resolveKaUal(kaId),
    });
    if (canAttemptOnChainPublish && options.precomputedAttestation?.reservedKaId !== undefined) {
      await lifecycle.rememberAssetUal(options.precomputedAttestation.reservedKaId);
      lifecycle.emit('identity', 'asset_ual_allocated', {
        metadata: {
          contextGraphId,
          kaId: options.precomputedAttestation.reservedKaId.toString(),
          publisherAddress,
          entityCount,
          publicRecordCount: allSkolemizedQuads.length,
          hiddenCommitmentCount: privateRoots.length,
        },
      });
    }
    lifecycle.emit('wm', 'write', {
      metadata: {
        contextGraphId,
        recordCount: allSkolemizedQuads.length,
        rootEntityCount: manifestEntries.length,
        accessPolicy: effectiveAccessPolicy,
        hiddenCommitmentCount: privateRoots.length,
        subGraphName: options.subGraphName,
      },
    });
    lifecycle.emit('swm_share', 'prepared', {
      metadata: {
        contextGraphId,
        swmGraphId,
        source: options.fromSharedMemory ? 'shared_memory' : 'inline',
        recordCount: allSkolemizedQuads.length,
        byteSize: effectiveByteSize.toString(),
        encryptedInline: useEncryptedInline,
        catalogCommitment: useCuratedCatalog ? 'present' : 'absent',
      },
    });

    // Numeric-negative and numeric-zero CG ids are programming errors —
    // reject them here BEFORE burning CPU on ACK collection or on-chain
    // tx construction, so the caller sees the real
    // error instead of watching it decay through a swallowed ACK warning
    // into a misleading `tentative` status. Descriptive SWM graph names
    // (e.g. `"devnet-test"`, `"test-contextGraph"`) MUST still fall through to
    // the soft `v10CgId = 0n` coercion below — mock adapter tests and
    // integration fixtures publish with those names and rely on the
    // data-flow path continuing to exercise. So we only fail loud when
    // `BigInt(v10CgDomain)` actually parses and the parsed value is
    // non-positive, which is specifically the "numeric but invalid" case.
    {
      let parsedDomain: bigint | null = null;
      try {
        parsedDomain = BigInt(v10CgDomain);
      } catch {
        // Non-numeric descriptive name — stays on the soft path below.
      }
      if (parsedDomain !== null && parsedDomain <= 0n) {
        throw new Error(
          `V10 publish requires a positive on-chain context graph id; ` +
          `got '${v10CgDomain}' (parsed to ${parsedDomain}). ` +
          'Register the CG via ContextGraphs.createContextGraph first ' +
          'and pass the returned numeric id as `publishContextGraphId` ' +
          '(or as the first argument to `publish()`).',
        );
      }
    }

    // Collect ACKs only when this publish can actually submit to V10.
    // Descriptive/local CG ids may still pass a daemon-provided provider
    // (the agent wires it eagerly), but those are intentional local
    // publishes and must not fail before the local branch below can run.
    const v10ACKProvider = options.v10ACKProvider;
    const shouldCollectV10ACKs =
      v10ACKProvider !== undefined &&
      canAttemptOnChainPublish;
    let v10ACKs: V10CoreNodeACK[] | undefined;
    if (shouldCollectV10ACKs) {
      onPhase?.('collect_v10_acks', 'start');
      try {
        const rootEntities = manifestEntries.map(m => m.rootEntity);
        const reservedAckKaId =
          (options as PublishOptions).reservedKaId ?? options.precomputedAttestation?.reservedKaId;
        const assetUal = await lifecycle.rememberAssetUal(reservedAckKaId);
        // OT-RFC-49 / WS-D: for curated CGs the publisher pays / signs against
        // the catalog footprint (`effectiveByteSize` == `catalogByteSize`) and
        // the curated commitment is `catalogCommitment`. For public CGs nothing
        // changed — `effectiveByteSize === publicByteSize` and no catalog.
        const commonACKParams = {
          merkleRoot: kcMerkleRoot,
          contextGraphId: v10CgDomain,
          kaCount,
          rootEntities,
          publicByteSize: effectiveByteSize,
          epochs: publishEpochs,
          tokenAmount: precomputedTokenAmount,
          swmGraphId,
          subGraphName: options.subGraphName,
          merkleLeafCount: kcMerkleLeafCount,
          assetUal,
          ...(graphPublish
            ? {
                contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
                kaUal: graphPublish.scope.ual,
                assertionVersion: graphPublish.scope.assertionVersion,
                publicTripleCount: graphPublish.publicTripleCount,
                ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
                privateTripleCount: graphPublish.privateTripleCount,
                accessPolicy: effectiveAccessPolicy,
                allowedPeers: [...normalizedAllowedPeers],
              }
            : {}),
        };
        const lifecycleAckMode = useCuratedCatalog
          ? 'curated_catalog'
          : privateRoots.length > 0
            ? 'folded_private'
            : 'public';
        lifecycle.emit('storage_ack', 'request', {
          metadata: {
            contextGraphId: v10CgDomain,
            swmGraphId,
            subGraphName: options.subGraphName,
            ackMode: lifecycleAckMode,
            kaCount,
            rootEntityCount: rootEntities.length,
            publicByteSize: effectiveByteSize.toString(),
            tokenAmount: precomputedTokenAmount.toString(),
            merkleLeafCount: kcMerkleLeafCount,
            outcome: 'request',
          },
        });
        if (useCuratedCatalog) {
          if (!catalogCommitment || !stagingQuads || stagingQuads.length === 0) {
            throw new Error('Curated catalog ACK mode requires a non-empty catalog commitment and stagingQuads');
          }
          v10ACKs = await invokeV10ACKProvider(v10ACKProvider, {
            ...commonACKParams,
            stagingQuads,
            ackMode: {
              kind: 'curated-catalog',
              catalogCommitment: {
                catalogRoot: catalogCommitment.root,
                catalogLeafCount: catalogCommitment.leafCount,
              },
            },
          });
        } else if (privateRoots.length > 0) {
          v10ACKs = await invokeV10ACKProvider(v10ACKProvider, {
            ...commonACKParams,
            stagingQuads,
            ackMode: {
              kind: 'folded-private',
              privateMerkleRoots: privateRoots,
            },
          });
        } else {
          v10ACKs = await invokeV10ACKProvider(v10ACKProvider, {
            ...commonACKParams,
            stagingQuads,
            ackMode: { kind: 'public' },
          });
        }
        // PR5 ACK-provenance summary — one line per publish that names
        // every ACKing core and the LU-6 Phase B discovery path that
        // brought it to the curated CG. Lets an operator answer
        // "*why* did this CG get hosted by these cores?" from the
        // daemon log alone instead of cross-referencing the chain
        // event poller, beacon receiver, and reconciler timer.
        // Pre-PR5 cores show `?` for the source; that's the honest
        // shape until they upgrade.
        const provenance = v10ACKs
          .map((a) => `${a.peerId.slice(-8)}:${a.subscriptionSource ?? '?'}`)
          .join(', ');
        for (const ack of v10ACKs) {
          lifecycle.emit('storage_ack', 'success', {
            peer: ack.peerId,
            peerNodeIdentityId: ack.nodeIdentityId.toString(),
            metadata: {
              outcome: 'success',
              quorumCollected: v10ACKs.length,
              subscriptionSource: ack.subscriptionSource,
            },
          });
        }
        lifecycle.emit('storage_ack', 'quorum', {
          metadata: {
            outcome: 'success',
            quorumCollected: v10ACKs.length,
          },
        });
        this.log.info(
          ctx,
          `V10: Collected ${v10ACKs.length} core node ACKs [${provenance}]`,
        );
      } catch (err) {
        // RC11 / PR1+PR3: no self-signed ACK fallback. ACK collection
        // failure is a publish failure — propagate the underlying
        // ACKProvider error verbatim so callers (and the daemon log)
        // see the real cause (RPC pre-flight, quorum unmet, transport,
        // etc.) instead of a single self-signed ACK that the contract
        // would reject anyway on any network with
        // `minimumRequiredSignatures >= 2`.
        //
        // PR3: the agent's V10 ACK provider now throws typed
        // `RpcPreconditionError` / `QuorumUnmetError` subclasses (see
        // `ack-errors.ts`). The typed `.name` lands in `err.toString()`
        // automatically, so this log line distinguishes
        // "RpcPreconditionError(getEvmChainId: ... upstream=-32016)"
        // from "QuorumUnmetError(collected=0/3, peers=[...])"
        // without any further plumbing.
        const tag = err instanceof Error ? err.name : 'unknown';
        if (isQuorumUnmetError(err)) {
          for (const peerOutcome of err.peerOutcomes) {
            const reason = peerOutcome.reason;
            const outcome = reason?.startsWith('STORAGE_ACK_DECLINE')
              ? 'decline'
              : reason === 'no_response'
                ? 'timeout'
                : reason === 'ACK' || reason?.startsWith('ACK:')
                  ? 'success'
                  : 'failure';
            lifecycle.emit('storage_ack', outcome, {
              level: 'warn',
              peer: peerOutcome.peerId,
              metadata: {
                outcome,
                reason,
                dialOk: peerOutcome.dialOk,
                protocolSupported: peerOutcome.protocolSupported,
                swmHostModeAdvertised: peerOutcome.swmHostModeAdvertised,
              },
            });
          }
          lifecycle.emit('storage_ack', 'quorum', {
            level: 'warn',
            metadata: {
              outcome: 'failure',
              quorumCollected: err.collected,
              quorumRequired: err.required,
              peerDialled: err.dialled,
            },
          });
        }
        lifecycle.emit('storage_ack', 'failure', {
          level: 'warn',
          metadata: {
            outcome: 'failure',
            errorClass: tag,
            reason: err instanceof Error ? err.message : String(err),
          },
        });
        this.log.warn(
          ctx,
          `V10 ACK collection failed (${tag}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      } finally {
        onPhase?.('collect_v10_acks', 'end');
      }
    }

    // Resolve the target CG id bigint once for the whole V10 block so the
    // publisher digest (in the chain-submit block) sees a stable value.
    // Non-numeric domains resolve to 0n
    // here — the V10 contract rejects `contextGraphId == 0` with
    // `ZeroContextGraphId`, so the authoritative fail-loud lives at the EVM
    // adapter boundary (`evm-adapter.ts:createKnowledgeAssets` pre-tx
    // check) and at the core-node `storage-ack-handler.ts`. Keeping the
    // publisher-side resolution soft lets mock adapters and integration
    // tests that publish with descriptive SWM CG names continue to exercise
    // the data-flow path without needing per-test fixture gymnastics.
    let v10CgId: bigint;
    try {
      v10CgId = BigInt(v10CgDomain);
    } catch {
      v10CgId = 0n;
    }

    // Numeric EVM chainId + kav10Address are needed by the publisher digest
    // (H5 prefix) in the chain-submit path below. Fetch once; the adapter
    // field `this.chain.chainId` is a namespaced string like `evm:31337` and
    // is not directly parseable with `BigInt()`. Wrap in try/catch so
    // non-V10-capable adapters (e.g. `NoChainAdapter`, whose stubs throw)
    // do not crash the publish path — they simply leave both values
    // undefined and the V10 readiness check in the chain branch below
    // produces the loud, typed error.
    let v10ChainId: bigint | undefined;
    let v10KavAddress: string | undefined;
    try {
      v10ChainId = await this.chain.getEvmChainId();
      v10KavAddress = await this.chain.getKnowledgeAssetsLifecycleAddress();
    } catch {
      v10ChainId = undefined;
      v10KavAddress = undefined;
    }

    // RC11 / PR1: the legacy "self-sign ACK as last resort" block lived
    // here. It synthesised a single ACK with `peerId: 'self'` against
    // the publisher's own identity when no real ACKs had been collected,
    // which was rejected on-chain by `minimumRequiredSignatures` on
    // every real network (default 3). Removed in favour of fail-loud:
    // ACK collection produces real ACKs from real cores, or the publish
    // fails. See `packages/publisher/test/_helpers/acks.ts` for the
    // in-memory multi-signer fixture tests use instead.

    onPhase?.('chain', 'start');

    let onChainResult: OnChainPublishResult | undefined;
    let status: 'tentative' | 'confirmed' = 'tentative';
    ensurePublishOperationIdentity();
    // The operation id may be needed earlier as an encryption nonce domain,
    // but its UAL is derived exactly once, after signer reservation is final.
    ual = graphPublish?.scope.ual
      ?? `did:dkg:${this.chain.chainId}/${publisherAddress}/t${publishOperationId}`;

    // Resolve the on-chain attribution target from the per-call override
    // (computed above) or fall back to the daemon's persistent identity.
    // `0n` is a VALID explicit override value (mode (d) "no attribution"
    // — contract validates this case) and must NOT be confused with
    // "override absent". The daemon's own identity is still used
    // elsewhere (signer resolution); this only affects the on-chain
    // `PublishParams.publisherNodeIdentityId`.
    let usedV10Path = false;

    // Gate: skip on-chain only when we can't resolve a target CG id or
    // the chain adapter doesn't advertise V10 readiness. The earlier
    // identity-zero gate is gone (OT-RFC-38 §1.1) — edge agents without
    // a Profile publish in no-attribution mode (`attributionIdentityId
    // === 0n`), which the contract accepts.
    // RC11 / PR2: helper for the two legitimate non-chain branches
    // below. Sets the tentative-form UAL on every manifest entry so
    // the returned `kaManifest[*].kcUal` is consistent with the
    // tentative `ual` and writes the public quads into the root data
    // graph (intentional local-only publish). NOT used on the
    // chain-failure path — that re-throws and never reaches a store
    // write.
    const finalizeIntentionalLocalPublish = async (reasonLog: string) => {
      for (const km of kaMetadata) {
        km.kcUal = ual;
      }
      // RC11 / PR3: write the KC + KA metadata + tentative status quad
      // alongside the public quads so downstream consumers
      // (`access-handler`, `assertion-history`, the `verifiable-memory`
      // view) can still locate this publish by its tentative UAL.
      // Pre-PR2 this was the responsibility of the chain-failure
      // catch block via `generateTentativeMetadata`. PR2 deleted that
      // unconditional catch (failed *chain* publishes now write
      // nothing locally), but the two intentional-local branches
      // (`no on-chain CG id`, `chain not V10-ready`) both need the metadata
      // to keep the local data-graph queryable. Replicating the
      // tentative-metadata generation here scopes the metadata write
      // exclusively to those intentional-skip branches and keeps the
      // chain-failure path inert.
      // RC11 / PR2 (review fix): preserve the exact provenance + meta-graph
      // routing the pre-PR2 catch block did. Two strictly-additive
      // requirements relative to the minimal call above:
      //
      //   1. `authorAddress` — feeds the KC row's `prov:wasAttributedTo`
      //      so downstream consumers (`access-handler`,
      //      `assertion-history`, the verifiable-memory view) can still
      //      attribute the publish locally before any chain confirmation.
      //      The on-chain `KnowledgeBatch.authorAddress` is canonical only
      //      once the publish confirms; until then this is a self-claim.
      //      `publisherSigner` may be undefined (no-chain / no-key path) —
      //      skip the field in that case. (The former `dkg:Publication`
      //      mirror keyed on `publishOperationId` was dropped — RFC
      //      ka-metadata-trim Phase 1, zero readers.)
      //
      //   2. `targetMetaGraphUri` remap — every generated meta quad sits
      //      in the default `did:dkg:context-graph:<id>/_meta` graph. If
      //      the caller supplied a `targetMetaGraphUri` (e.g. for SWM /
      //      private-channel meta isolation) the pre-PR2 path remapped
      //      them; without this, intentional-local publishes targeting a
      //      non-default meta graph would silently drop their `_meta`
      //      triples into the wrong graph and become invisible to the
      //      caller's own meta-graph queries.
      const commonMeta = {
        ual,
        contextGraphId,
        merkleRoot: kcMerkleRoot,
        publisherPeerId: normalizedPublisherPeerId || 'unknown',
        accessPolicy: effectiveAccessPolicy,
        allowedPeers: normalizedAllowedPeers,
        timestamp: new Date(),
        subGraphName: options.subGraphName,
        ...((options.precomputedAttestation?.authorAddress
          ?? publisherSigner?.address) != null
          ? {
              authorAddress: (options.precomputedAttestation?.authorAddress
                ?? publisherSigner!.address),
            }
          : {}),
      };
      let tentativeMeta = graphPublish
        ? generateGraphKnowledgeAssetMetadata(
            {
              ...commonMeta,
              assertionVersion: graphPublish.scope.assertionVersion,
              publicTripleCount: graphPublish.publicTripleCount,
              privateTripleCount: graphPublish.privateTripleCount,
              ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
              assertionGraph: dataGraph,
            },
            { status: 'tentative' },
          )
        : generateTentativeMetadata(commonMeta, kaMetadata);
      if (options.targetMetaGraphUri) {
        const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
        tentativeMeta = tentativeMeta.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
        );
      }
      if (graphPublish && !isAgentRegistryContextGraph(contextGraphId)) {
        // Keep locally authored ACLs outside peer-sync-visible metadata. A
        // later exact durable replacement can then preserve only trusted
        // controls anchored to this assertion version and root.
        await replaceLocallyTrustedKnowledgeAssetControls(
          this.store,
          graphPublish.scope.ual,
          tentativeMeta,
        );
      }
      this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store (${reasonLog})`);
      if (graphPublish) {
        await this.replaceExactKnowledgeAssetGraph(
          dataGraph,
          normalizedQuads,
          'Graph-scoped local publish',
        );
      } else {
        await this.store.insert(normalizedQuads);
      }
      // GH #1078 — persist private slices on this intentional-local terminal
      // branch too (a chainless / ownerOnly publish still finalizes here).
      await persistFinalizedPrivateSlices();
      // #1233 — the agents registry CG never confirms on-chain and its
      // per-publish tentative `_meta` record has no consumer (agent facts are
      // served from the DATA graph); persisting one per heartbeat would grow
      // `agents/_meta` without bound and stall offset-0 sync. Skip it there.
      if (!isAgentRegistryContextGraph(contextGraphId)) {
        await this.store.insert(tentativeMeta);
      }
      // B3: only now that the local publish has persisted do we refresh the
      // public catalog entry (CLEAR/REPLACE — see persistCatalogEntry).
      await persistCatalogEntry();
    };

    // GH #1013 — record WHY a local-only publish skipped chain so the async
    // lift can tell an honest local finalization (no chain) from a publish
    // that failed to reach the chain it should have.
    let localChainSkipReason: 'no-chain' | undefined;
    if (publisherContextGraphId === undefined) {
      this.log.warn(ctx, `No positive on-chain context graph id resolved from "${v10CgDomain}" — skipping on-chain publish`);
      localChainSkipReason = 'no-chain';
      await finalizeIntentionalLocalPublish('no on-chain CG id');
    } else if (!chainV10Ready) {
      this.log.warn(ctx, 'Chain adapter is not V10-ready — skipping on-chain publish');
      localChainSkipReason = 'no-chain';
      await finalizeIntentionalLocalPublish('chain not V10-ready');
    } else {
      const tokenAmount = precomputedTokenAmount;
      usedV10Path = true;

      // ─────────────────────────────────────────────────────────────
      // SEAL INTEGRITY PREFLIGHT (Round 4 review §12)
      //
      // When a precomputedAttestation IS provided, validate it BEFORE
      // the on-chain try/catch so seal-integrity failures (mismatched
      // expectedMerkleRoot, wrong-signer recovery) propagate up as
      // hard errors instead of being downgraded to a "tentative"
      // result with a `On-chain tx failed` log line. These are
      // protocol-correctness violations, not transient chain issues.
      // Named lifecycle publish callers must see a 4xx for a
      // broken seal, not a 200 OK with `status: tentative` and
      // `kaId: 0` (which the daemon previously had to special-case).
      //
      // Missing-seal — `precomputedAttestation === undefined` — is
      // checked inside the chain-submit branch below, after ACK
      // collection has proven this is a real V10 publish attempt. RC11
      // / PR-A deliberately rethrows that failure instead of
      // downgrading to local tentative VM, so ACK-ready no-seal callers
      // get a clear contract error and no root data-graph write.
      // Intentional local publishes (no on-chain CG id / non-V10)
      // still bypass this branch and can remain tentative.
      // ─────────────────────────────────────────────────────────────
      if (
        options.precomputedAttestation &&
        v10ChainId !== undefined &&
        v10KavAddress !== undefined
      ) {
        const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
        const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
        // #1116: the seal is CG-independent — the AuthorAttestation no longer
        // binds the on-chain CG id. v10CgId is still submitted to the contract
        // (createKnowledgeAssets below) as the mint target / publisher-auth gate.
        const authorTypedData = buildAuthorAttestationTypedData({
          chainId: v10ChainId,
          kav10Address: v10KavAddress,
          merkleRoot: kcMerkleRoot,
          authorAddress: effectiveAuthorAddress,
          reservedKaId: options.precomputedAttestation.reservedKaId,
          schemeVersion: effectiveSchemeVersion,
        });
        {
          const expected = options.precomputedAttestation.expectedMerkleRoot;
          if (expected.length !== kcMerkleRoot.length || !expected.every((b, i) => b === kcMerkleRoot[i])) {
            throw new Error(
              `precomputedAttestation.expectedMerkleRoot mismatch: ` +
              `seal expects ${ethers.hexlify(expected)} but publish-time recompute yielded ${ethers.hexlify(kcMerkleRoot)}. ` +
              `Either the assertion's quads were mutated after finalize, or the caller's merkle algorithm differs from the publisher's. Re-finalize the assertion.`,
            );
          }
        }
        {
          const sig = ethers.Signature.from({
            r: ethers.hexlify(options.precomputedAttestation.signature.r),
            yParityAndS: ethers.hexlify(options.precomputedAttestation.signature.vs),
          });
          const digest = ethers.TypedDataEncoder.hash(
            authorTypedData.domain,
            authorTypedData.types,
            authorTypedData.message,
          );
          // Off-chain seal-integrity preflight: ECDSA recover-and-compare
          // only works for EOA authors. For smart-contract wallets
          // (incl. EIP-7702-delegated EOAs), the wallet's
          // `IERC1271.isValidSignature` is the source of truth; signing
          // typically routes through an owner EOA whose address differs
          // from the wallet contract, so ECDSA recover would (correctly)
          // report a mismatch even on a valid 1271 signature. The
          // on-chain `_verifyAuthorAttestation` already dispatches via
          // `authorAddress.code.length` — let it be authoritative for
          // the contract-author branch. EOAs still get the hard-fail
          // preflight that traps corrupt seals before tx submit.
          const isContractAuthor =
            typeof this.chain.hasContractCode === 'function'
              ? await this.chain.hasContractCode(effectiveAuthorAddress)
              : false;
          if (!isContractAuthor) {
            const recovered = ethers.recoverAddress(digest, sig);
            if (recovered.toLowerCase() !== effectiveAuthorAddress.toLowerCase()) {
              throw new Error(
                `precomputedAttestation signer mismatch: signature recovers ${recovered} ` +
                `but address claims ${effectiveAuthorAddress}. The seal's signature does not match its recorded authorAddress; ` +
                `the assertion's _meta block is corrupt and the assertion must be re-finalized.`,
              );
            }
          }
        }
      }
      // ── End preflight ───────────────────────────────────────────

      let signStarted = false;
      let submitStarted = false;
      try {
        onPhase?.('chain:sign', 'start');
        signStarted = true;
        if (!publisherSigner) throw new PublisherWalletRequiredError('publish');
        this.log.info(
          ctx,
          `Signing on-chain publish (attributionId=${attributionIdentityId}${hasAttributionOverride ? ' [override]' : ''}, signer=${publisherSigner.address}, source=${publisherSigner.source})`,
        );

        onPhase?.('chain:sign', 'end');
        signStarted = false;
        onPhase?.('chain:submit', 'start');
        submitStarted = true;
        this.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, byteSize=${effectiveByteSize}${useCuratedCatalog ? ' [catalog]' : ''}, tokenAmount=${tokenAmount})`);

        if (!v10ACKs || v10ACKs.length === 0) {
          throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
        }
        if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) {
          throw new Error(
            'Chain adapter is not V10-ready (isV10Ready() returned false or is missing). ' +
            'Publish is routed through KnowledgeAssetsV10.publish, which requires ' +
            'the adapter to expose createKnowledgeAssets, getEvmChainId, and ' +
            'getKnowledgeAssetsLifecycleAddress — use an EVM adapter pointed at a chain where ' +
            'KnowledgeAssetsV10 is deployed.',
          );
        }
        if (v10ChainId === undefined || v10KavAddress === undefined) {
          throw new Error(
            'V10 publish requires the chain adapter to expose getEvmChainId() and ' +
            'getKnowledgeAssetsLifecycleAddress(); neither was resolved. The adapter is not V10-capable.',
          );
        }
        if (!options.precomputedAttestation) {
          throw new Error(
            'Publish rejected: on-chain publish requires precomputedAttestation. ' +
            'RFC-001 §9.x — every published assertion must be sealed at finalize-time. ' +
            'Call agent.assertion.finalize(...) first; the daemon\'s assertion-name-aware ' +
            '/api/knowledge-assets/:name/vm/publish route resolves the seal automatically.',
          );
        }
        const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
        const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
        // #1116: the seal is CG-independent — the AuthorAttestation no longer
        // binds the on-chain CG id. v10CgId is still submitted to the contract
        // (createKnowledgeAssets below) as the mint target / publisher-auth gate.
        const authorTypedData = buildAuthorAttestationTypedData({
          chainId: v10ChainId,
          kav10Address: v10KavAddress,
          merkleRoot: kcMerkleRoot,
          authorAddress: effectiveAuthorAddress,
          reservedKaId: options.precomputedAttestation.reservedKaId,
          schemeVersion: effectiveSchemeVersion,
        });
        const authorSig: ethers.Signature = ethers.Signature.from({
          r: ethers.hexlify(options.precomputedAttestation.signature.r),
          yParityAndS: ethers.hexlify(options.precomputedAttestation.signature.vs),
        });
        // Note: the seal-integrity validations (expectedMerkleRoot
        // match, signer recovery) are now done as preflight above
        // before this try block, so they propagate as hard errors
        // instead of being silently downgraded to tentative
        // (Round 4 review §12).
        // P-1 review (iter-2): `chain:writeahead:start` now fires
        // *from inside* the adapter via the `onBroadcast` callback,
        // which the adapter invokes immediately before the real
        // `publishDirect` broadcast — after any TRAC `approve()` tx
        // and allowance top-up. Listeners that checkpoint on
        // `:start` therefore only record recovery state for a
        // publish tx that is actually about to hit the wire.
        //
        // The surrounding `try/finally` still guarantees
        // `:end` always pairs with `:start`: if the adapter throws
        // BEFORE invoking `onBroadcast` (e.g. revert during
        // `approve()`, `estimateGas`, ACK preflight) neither
        // `:start` nor `:end` fires, so listeners see no WAL
        // boundary for a broadcast that never happened. If the
        // adapter throws AFTER invoking `onBroadcast` (revert on
        // the publish tx itself), `:start` has fired and the
        // `finally` emits `:end` — this is the recoverable-crash
        // window spec axiom 4 / §06 asks nodes to persist.
        //
        // Spec axiom 4 / §06: nodes persist a "publish attempt
        // about to hit the wire" record BEFORE any
        // `eth_sendRawTransaction` RPC so that a crash between
        // "tx on wire" and "receipt observed" can be recovered
        // without a double-submit. Older adapters that don't
        // invoke `onBroadcast` fall back to the previous behaviour
        // (no `:start` / `:end` on that path) — the publisher
        // emits neither and listeners simply see the parent `chain`
        // phase; adapters upgrading to the new hook regain the
        // precise boundary. See P-1 / P-1.2 in BUGS_FOUND.md.
        let wroteAhead = false;
        const emitPhase = async (phase: string, status: 'start' | 'end') => {
          await (onPhase?.(phase, status) as unknown as Promise<void> | void);
        };
        const emitWriteAheadStart = async (info?: { txHash?: string }) => {
          if (wroteAhead) return;
          wroteAhead = true;
          // PR #241 Codex iter-5: emit a hash-bearing phase BEFORE the
          // generic `chain:writeahead:start` so WAL listeners can
          // persist the signed-but-not-yet-broadcast tx identity
          // (spec axiom 4 / §06 "txHash persisted" requirement, P-1.2
          // in BUGS_FOUND.md). The phase name encodes the hash because
          // `PhaseCallback` is a 2-arg function; adding a detail
          // parameter would be a source-level break for existing
          // onPhase consumers. Listeners can regex the phase string
          // to recover the hash, or legacy consumers can ignore it.
          //
          // Emit balanced `start` + `end` back-to-back: the phase is a
          // single-shot breadcrumb (the actual broadcast window is
          // already bracketed by `chain:writeahead`), and keeping
          // starts balanced by ends preserves the "every start has a
          // matching end" golden-sequence invariant.
          if (info?.txHash) {
            const phase = `chain:txsigned:tx-${info.txHash}`;
            await emitPhase(phase, 'start');
            await emitPhase(phase, 'end');
          }
          await emitPhase('chain:writeahead', 'start');
        };
        // OT-RFC-43 Option 1 — reserve the deterministic packed kaId for this
        // author BEFORE the on-chain mint, so the UAL is known pre-tx and the
        // contract _safeMints exactly this id. `undefined` when no allocator is
        // configured (mock/no-chain); the real EVM adapter then throws.
        //
        // OT-RFC-43 A2 (decision 1) — when the caller stamped a packed kaId at
        // finalize (`options.reservedKaId`), REUSE it and skip allocation so a
        // finalize→publish mints exactly the stamped id (no double-allocation).
        const reservedKaId = await this.ensureReservedKaId(
          effectiveAuthorAddress,
          // §F2 — mint EXACTLY the id the agent signed: the finalize path threads it
          // as options.reservedKaId; the ephemeral selection path carries it on the
          // precomputedAttestation (the agent is the single allocation point).
          (options as PublishOptions).reservedKaId ?? options.precomputedAttestation?.reservedKaId,
        );
        if (graphPublish && reservedKaId !== undefined) {
          if (reservedKaId !== graphPublish.expectedPackedKaId) {
            throw new Error(
              `Graph-scoped publish reserved kaId ${reservedKaId} does not derive from ` +
                `UAL ${graphPublish.scope.ual} (expected ${graphPublish.expectedPackedKaId}); refusing to mint`,
            );
          }
          if (!graphScopeTargetsChain(
            graphPublish.scope.chainId,
            this.chain.chainId,
            v10ChainId,
          )) {
            throw new Error(
              `Graph-scoped publish UAL ${graphPublish.scope.ual} targets chain ` +
                `${graphPublish.scope.chainId}, but this publisher mints on ` +
                `${this.chain.chainId} (EIP-155 ${v10ChainId})`,
            );
          }
        }
        await lifecycle.rememberAssetUal(reservedKaId);
        if (!lifecycle.identityAllocatedEmitted && reservedKaId !== undefined) {
          lifecycle.emit('identity', 'asset_ual_allocated', {
            metadata: {
              contextGraphId,
              kaId: reservedKaId.toString(),
              publisherAddress,
              entityCount,
              publicRecordCount: allSkolemizedQuads.length,
              hiddenCommitmentCount: privateRoots.length,
            },
          });
        }
        try {
          // OT-RFC-49 / WS-D — handshake hardening. When the publisher ran the
          // curated catalog path, the chain submit MUST carry the same
          // `(catalogRoot, catalogLeafCount)` pair that was signed into the ACK
          // digest. Anything else (e.g. silently submitting `bytes32(0)` / `0`
          // on a curated KC) would leave the on-chain catalog commitment empty
          // — RFC-39 random sampling would then skip the KC because the picker
          // filters zero-commitment curated CGs out of the curated draw, and
          // curated proving would be inert. Fail loud here so the bug surfaces
          // at the publisher instead of as missing reward proofs days later.
          if (useCuratedCatalog) {
            if (
              !catalogCommitment
              || catalogCommitment.root.length !== 32
              || catalogCommitment.leafCount <= 0
              || catalogCommitment.root.every((b) => b === 0)
            ) {
              throw new Error(
                `OT-RFC-49: dkg-publisher refused to submit a curated publish with an empty ` +
                `catalog commitment (root=${catalogCommitment?.root.length ?? 0} bytes, ` +
                `count=${catalogCommitment?.leafCount ?? 0}). The catalog root MUST be the V10 ` +
                `Merkle root over the committed catalog leaf-set, never bytes32(0) — without it ` +
                `the prover cannot prove the curated CG and random sampling skips the KC.`,
              );
            }
          }
          lifecycle.emit('chain', 'submit', {
            metadata: {
              contextGraphId: v10CgId.toString(),
              kaId: reservedKaId?.toString(),
              byteSize: effectiveByteSize.toString(),
              tokenAmount: tokenAmount.toString(),
              ackCount: v10ACKs.length,
              merkleLeafCount: kcMerkleLeafCount,
            },
          });
          onChainResult = await this.chain.createKnowledgeAssets!({
            publishOperationId,
            contextGraphId: v10CgId,
            publisherAddress: publisherSigner.address,
            reservedKaId,
            merkleRoot: kcMerkleRoot,
            knowledgeAssetsAmount: kaCount,
            byteSize: effectiveByteSize,
            catalogRoot: useCuratedCatalog ? catalogCommitment?.root : undefined,
            catalogLeafCount: useCuratedCatalog ? catalogCommitment?.leafCount : undefined,
            // PCA strict-equality: must match the value committed to the
            // ACK digest produced by the ACK collector
            // (`packages/publisher/src/ack-collector.ts:159` invokes
            // `computePublishACKDigest`) so the on-chain ECDSA recovery
            // yields the same operator address each core signed with.
            // Hard-coding `1` here re-introduces a digest mismatch on
            // PCA-funded publishes and trips `SignerIsNotNodeOperator`
            // even though the
            // signatures were produced correctly.
            epochs: publishEpochs,
            tokenAmount,
            merkleLeafCount: kcMerkleLeafCount,
            isImmutable: false,
            publisherNodeIdentityId: attributionIdentityId,
            author: {
              address: effectiveAuthorAddress,
              signature: {
                r: ethers.getBytes(authorSig.r),
                vs: ethers.getBytes(authorSig.yParityAndS),
              },
              schemeVersion: effectiveSchemeVersion,
            },
            ackSignatures: v10ACKs.map(ack => ({
              identityId: ack.nodeIdentityId,
              r: ack.signatureR,
              vs: ack.signatureVS,
            })),
            onBroadcast: emitWriteAheadStart,
          });
        } finally {
          if (wroteAhead) onPhase?.('chain:writeahead', 'end');
        }

        onChainResult.tokenAmount = tokenAmount;

        const kaId = onChainResult.kaId ?? onChainResult.batchId;
        if (reservedKaId !== undefined && kaId !== reservedKaId) {
          throw new Error(
            `OT-RFC-43 Option 1: on-chain mint returned kaId ${kaId} but the publisher reserved ` +
            `${reservedKaId} — the contract must _safeMint the reserved id. Aborting to avoid a ` +
            `UAL/chain split.`,
          );
        }
        const storageAddr =
          onChainResult.knowledgeAssetsContract
          ?? (this.chain.getDKGKnowledgeAssetsAddress
            ? await this.chain.getDKGKnowledgeAssetsAddress()
            : undefined);
        if (!storageAddr && !graphPublish) {
          throw new Error('Publish succeeded but DKGKnowledgeAssets address is unavailable for UAL assignment');
        }
        if (graphPublish) {
          if (kaId !== graphPublish.expectedPackedKaId) {
            throw new Error(
              `Graph-scoped publish returned kaId ${kaId}, but UAL ${graphPublish.scope.ual} ` +
                `derives packed kaId ${graphPublish.expectedPackedKaId}`,
            );
          }
          ual = graphPublish.scope.ual;
        } else {
          ual = `did:dkg:${this.chain.chainId}/${storageAddr!.toLowerCase()}/${kaId.toString()}`;
        }
        lifecycle.setAssetUal(ual);
        lifecycle.emit('chain', 'confirm', {
          metadata: {
            contextGraphId: v10CgId.toString(),
            kaId: kaId.toString(),
            txHash: onChainResult.txHash,
            blockNumber: onChainResult.blockNumber,
            txIndex: onChainResult.txIndex,
            tokenAmount: tokenAmount.toString(),
          },
        });

        for (const km of kaMetadata) {
          km.kcUal = ual;
        }
        const confirmedProvenance = {
          txHash: onChainResult.txHash,
          blockNumber: onChainResult.blockNumber,
          blockTimestamp: onChainResult.blockTimestamp,
          publisherAddress: onChainResult.publisherAddress,
          batchId: onChainResult.batchId,
          chainId: this.chain.chainId,
        };
        const confirmedMeta = {
          ual,
          contextGraphId,
          merkleRoot: kcMerkleRoot,
          publisherPeerId: normalizedPublisherPeerId || 'unknown',
          accessPolicy: effectiveAccessPolicy,
          allowedPeers: normalizedAllowedPeers,
          timestamp: new Date(),
          subGraphName: options.subGraphName,
          authorAddress: effectiveAuthorAddress,
        };
        let confirmedQuads = graphPublish
          ? generateGraphKnowledgeAssetMetadata(
              {
                ...confirmedMeta,
                assertionVersion: graphPublish.scope.assertionVersion,
                publicTripleCount: graphPublish.publicTripleCount,
                privateTripleCount: graphPublish.privateTripleCount,
                ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
                assertionGraph: knowledgeAssetLayerGraphUri(
                  contextGraphId,
                  MemoryLayer.VerifiableMemory,
                  graphPublish.scope,
                  options.subGraphName,
                ),
              },
              {
                status: 'confirmed',
                confirmation: { kind: 'transaction', provenance: confirmedProvenance },
              },
            )
          : generateConfirmedFullMetadata(
              confirmedMeta,
              kaMetadata,
              confirmedProvenance,
            );
        // GH #936 — append the SHARED deterministic per-root token rows (the
        // same helper the gossip / chain-reconcile path uses) so the originator
        // exposes the IDENTICAL `<ual>/<tokenId>` → root map as replicas. kaMetadata
        // is already in canonical (sorted) tokenId order. graph = default
        // `<cg>/_meta` so the remap below routes them to the per-cgId `_meta`.
        if (!graphPublish) {
          confirmedQuads = [
            ...confirmedQuads,
            ...buildDeterministicTokenRows(ual, kaMetadata, `did:dkg:context-graph:${contextGraphId}/_meta`),
          ];
        }
        if (options.targetMetaGraphUri) {
          const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
          confirmedQuads = confirmedQuads.map((q) =>
            q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
          );
        }
        if (graphPublish) {
          await replaceLocallyTrustedKnowledgeAssetControls(
            this.store,
            graphPublish.scope.ual,
            confirmedQuads,
          );
        }
        // RC11 / PR2: write the published public quads into the root
        // data graph ONLY after the chain has confirmed (KCCreated
        // returned via `createKnowledgeAssets`). Pre-PR2 this insert
        // ran unconditionally before the chain interaction, so any
        // publish that failed mid-flight left "tentative VM" quads
        // visible to /api/query. Order matters: data quads BEFORE
        // confirmedQuads + stampTrustLevel below so the trust stamp's
        // subject set actually matches existing rows.
        // Uniform layout: published data lands in the per-KA verifiable-memory graph
        // …/_verifiable_memory/{author}/{number} (author+number unpacked from the minted
        // kaId), not the monolithic root data graph. The default query reads the
        // /_verifiable_memory/ prefix (read-both with root).
        const vmNumber = kaId & ((1n << 96n) - 1n);
        const vmAuthor = '0x' + (kaId >> 96n).toString(16).padStart(40, '0');
        const vmGraph = graphPublish
          ? knowledgeAssetLayerGraphUri(
              contextGraphId,
              MemoryLayer.VerifiableMemory,
              graphPublish.scope,
              options.subGraphName,
            )
          : contextGraphLayerUri(contextGraphId, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber, options.subGraphName);
        const vmQuads = normalizedQuads.map((q) => ({ ...q, graph: vmGraph }));
        this.log.info(ctx, `Storing ${vmQuads.length} triples in ${vmGraph} (post-confirmation)`);
        if (graphPublish) {
          await this.replaceExactKnowledgeAssetGraph(
            vmGraph,
            vmQuads,
            'Graph-scoped confirmed publish',
          );
        } else {
          await this.store.insert(vmQuads);
        }
        await this.store.insert(confirmedQuads);
        // GH #1078 — supersede/persist private slices only now that the chain
        // has confirmed (before returning 'confirmed', so no read sees the KA
        // confirmed without its private data).
        await persistFinalizedPrivateSlices();
        if (!graphPublish) {
          await stampTrustLevel(
            this.store,
            vmGraph,
            collectTrustSubjectsForRoots(
              vmQuads,
              manifestEntries.map((entry) => entry.rootEntity),
            ),
            TrustLevel.SelfAttested,
          );
        }

        // RFC ka-metadata-trim Phase 1: the off-chain AuthorshipProof block
        // (`dkg:authoredBy` bnode + signature quads, spec §9.0.6) is no
        // longer written — zero code readers; the on-chain
        // `KnowledgeBatch.authorAddress` is canonical.

        // B3: the on-chain publish has now confirmed and the verifiable-memory
        // quads are committed — refresh the public catalog entry here, inside
        // the success branch, so a failed ACK/chain publish never exposes one
        // (CLEAR/REPLACE — see persistCatalogEntry).
        await persistCatalogEntry();
        lifecycle.emit('vm', 'promote', {
          metadata: {
            kaId: kaId.toString(),
            vmGraph,
            vmRecordCount: vmQuads.length,
            rootEntityCount: manifestEntries.length,
            status: 'confirmed',
          },
        });

        status = 'confirmed';
        onPhase?.('chain:submit', 'end');
        submitStarted = false;
        onPhase?.('chain:metadata', 'start');
        this.log.info(ctx, `On-chain confirmed: UAL=${ual} batchId=${onChainResult.batchId} tx=${onChainResult.txHash}`);
      } catch (err) {
        if (signStarted) onPhase?.('chain:sign', 'end');
        if (submitStarted) onPhase?.('chain:submit', 'end');
        // RC11 / PR2: re-throw chain failures instead of silently
        // downgrading to a "tentative" result with a local data-graph
        // write. Pre-PR2 this branch swallowed the error and fell
        // through to `generateTentativeMetadata` + a `store.insert` of
        // the (potentially never-confirmed) quads, which surfaced
        // through /api/query as if they were real verifiable memory.
        // The data-graph insert now lives exclusively inside the
        // success branch above and the two non-chain skip branches —
        // a failed on-chain publish therefore writes NOTHING to the
        // root data graph. Caller (DKGAgent / daemon publish route)
        // sees the typed error and is responsible for surfacing it.
        //
        // RC11 / PR3: surface the error class name in the log so a
        // typed `ACKProviderError` (RpcPrecondition / QuorumUnmet)
        // that slipped past the earlier ACK-collection catch is
        // visually distinct from a real chain revert (`callException`,
        // `insufficientFunds`, etc.). The original error rethrows
        // unchanged so callers preserve `instanceof` checks.
        const tag = err instanceof Error ? err.name : 'unknown';
        const msg = err instanceof Error ? err.message : String(err);
        lifecycle.emit('chain', 'failure', {
          level: 'error',
          metadata: {
            outcome: 'failure',
            contextGraphId: v10CgId.toString(),
            ackCount: v10ACKs?.length ?? 0,
            errorClass: tag,
            reason: msg,
          },
        });
        this.log.warn(ctx, `On-chain publish failed (${tag}): ${msg}`);
        throw err instanceof Error ? err : new Error(msg);
      }
    }

    // Track owned entities and batch→context graph binding on confirmed publishes
    if (status === 'confirmed' && onChainResult) {
      const confirmOwnershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      if (!this.ownedEntities.has(confirmOwnershipKey)) {
        this.ownedEntities.set(confirmOwnershipKey, new Set());
      }
      for (const e of manifestEntries) {
        this.ownedEntities.get(confirmOwnershipKey)!.add(e.rootEntity);
      }
      this.knownBatchContextGraphs.set(String(onChainResult.batchId), contextGraphId);
      // RS prevention (GH #1264): self-promote the confirmed KC into the SCOPED
      // context-graph graphs the Random Sampling prover reads. The one-shot
      // `dkg publish --file` path otherwise leaves the KC only in the legacy
      // label graphs, so every prover tick reports `kc-not-synced` and no proof
      // ever lands. Best-effort — the KC is already on-chain, so a promote error
      // must NOT fail the publish (the layer-3 heal backstop is the fallback).
      // Skipped for sub-graph publishes (RS samples root CGs; sub-graph KCs use a
      // different layout); remap is not applicable on this one-shot path.
      if (!options.subGraphName) {
        try {
          await this.promoteConfirmedKCToScopedGraph(
            contextGraphId,
            onChainResult,
            ual,
            kcMerkleRoot,
            manifestEntries,
            allSkolemizedQuads,
            publisherContextGraphId,
            ctx,
          );
        } catch (err) {
          this.log.warn(ctx, `RS scoped-promote failed for ${ual} (heal backstop will retry): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      onPhase?.('chain:metadata', 'end');
    }

    onPhase?.('chain', 'end');

    const result: PublishResult = {
      kaId: graphPublish
        ? onChainResult?.kaId
          ?? ((BigInt(graphPublish.scope.agentAddress) << 96n) | BigInt(graphPublish.scope.kaNumber))
        : onChainResult?.batchId ?? 0n,
      ual,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status,
      onChainResult,
      localChainSkipReason, // GH #1013
      publicQuads: allSkolemizedQuads,
      v10ACKs,
      v10Origin: usedV10Path,
      subGraphName: options.subGraphName,
      ...(graphPublish
        ? {
            contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
            assertionVersion: graphPublish.scope.assertionVersion,
            publicTripleCount: graphPublish.publicTripleCount,
            ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
            privateTripleCount: graphPublish.privateTripleCount,
            accessPolicy: effectiveAccessPolicy,
            allowedPeers: [...normalizedAllowedPeers],
          }
        : {}),
    };
    lifecycle.emit('finalization', 'complete', {
      metadata: {
        kaId: result.kaId.toString(),
        status: result.status,
        ackCount: result.v10ACKs?.length ?? 0,
        localChainSkipReason: result.localChainSkipReason,
      },
    });

    this.eventBus.emit(DKGEvent.KC_PUBLISHED, {
      ...result,
      contextGraphId,
      tripleCount: allSkolemizedQuads.length,
    });
    return result;
  }

  /**
   * RS prevention (GH #1264) — self-promote a confirmed one-shot `publish()`
   * into the SCOPED context-graph graphs the Random Sampling prover reads
   * (`<NAME>/context/<cgId>/_meta` + `/data`, see `ka-extractor.ts`
   * `extractV10KCFromStore`).
   *
   * The one-shot `dkg publish --file` path writes the KC only to the LEGACY
   * label graphs (`<NAME>/_meta` + the per-KA verifiable-memory data graph) and
   * used to rely on chain-reconcile to promote it to scoped. That promotion
   * never reliably fired for the publisher's OWN KC, so every prover tick
   * reported `kc-not-synced` and no proof landed (#1264; #1259 covered only the
   * gossip-receiver strand). We resolve the cgId from CHAIN TRUTH
   * (`getKAContextGraphId`, the exact call the prover uses) right after the
   * publish tx confirms — when the KA→CG binding is already committed on-chain,
   * so it is immune to the local cgId-resolver lag that caused the strand — and
   * write the scoped graphs here so the KC is provable on the first prover tick.
   *
   * Mirrors the same-graph promotion in `publishFromSharedMemory` (the SWM path
   * that already self-promotes). KEEP THE MINIMAL-META SHAPE IN SYNC with that
   * block and with what `extractV10KCFromStore` reads.
   */
  private async promoteConfirmedKCToScopedGraph(
    contextGraphId: string,
    onChainResult: OnChainPublishResult,
    ual: string,
    merkleRoot: Uint8Array,
    manifestEntries: ReadonlyArray<KAManifestEntry>,
    publicQuads: Quad[],
    fallbackCgId: bigint | undefined,
    ctx: OperationContext,
  ): Promise<void> {
    // The packed kaId (author<<96 | number) keys ContextGraphStorage.kaToContextGraph
    // and is the prover's `challenge.knowledgeAssetId` / `dkg:batchId` lookup value.
    const partitionKaId = onChainResult.kaId ?? onChainResult.batchId;

    // 1. Resolve the on-chain cgId from chain truth. Post-confirmation the
    //    KA→CG binding is committed, so this is lag-free (unlike the agent's
    //    local resolver that caused the strand). Fall back to the cgId domain
    //    the confirmed publish tx itself used.
    let scopedCgId: bigint | undefined;
    if (typeof this.chain.getKAContextGraphId === 'function') {
      try {
        const resolved = await this.chain.getKAContextGraphId(partitionKaId);
        if (resolved > 0n) scopedCgId = resolved;
      } catch (err) {
        this.log.info(ctx, `RS scoped-promote: getKAContextGraphId(${partitionKaId}) failed (RPC lag?): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (scopedCgId === undefined && fallbackCgId !== undefined && fallbackCgId > 0n) {
      scopedCgId = fallbackCgId;
    }
    if (scopedCgId === undefined) {
      this.log.info(ctx, `RS scoped-promote: no on-chain cgId for ${ual} (kaId=${partitionKaId}); heal backstop will relocate`);
      return;
    }

    const targetCgId = scopedCgId.toString();
    const ctxDataGraph = contextGraphDataUri(contextGraphId, targetCgId);
    const ctxMetaGraph = contextGraphMetaUri(contextGraphId, targetCgId);
    const publishVersion: MaterializedVersion = {
      blockNumber: onChainResult.blockNumber ?? 0,
      txIndex: onChainResult.txIndex ?? 0,
    };

    // GH#842 last-writer-wins: serialise the gate + promotion + version stamp
    // under the per-KA lock so a concurrent update's restate can't be clobbered
    // by this (possibly already-stale) publish promotion.
    await withMaterializationLock(ctxMetaGraph, ual, async () => {
      if (!(await shouldApplyMaterialization(this.store, ctxMetaGraph, ual, publishVersion))) {
        this.log.info(ctx, `RS scoped-promote: skipped ${ual} — a newer materialisation is present`);
        return;
      }

      // Data: copy the public quads into the scoped data graph — the prover
      // pulls triples per root entity from here.
      if (publicQuads.length > 0) {
        const scopedData = publicQuads.map((q) => ({ ...q, graph: ctxDataGraph }));
        await this.store.insert(scopedData);
        await stampTrustLevel(
          this.store,
          ctxDataGraph,
          collectTrustSubjectsForRoots(scopedData, manifestEntries.map((m) => m.rootEntity)),
          TrustLevel.SelfAttested,
        );
      }

      // Promote the minimal scoped-meta rows the RS prover + access handler read.
      // Single source of truth across both publish paths — see
      // `buildScopedMinimalMeta` (it documents the collapsed shape + the
      // multi-root `<ual>/<tokenId>` pairing rows the AccessHandler needs).
      await this.store.insert(
        buildScopedMinimalMeta(ual, partitionKaId, merkleRoot, manifestEntries, ctxMetaGraph),
      );
      await writeMaterializedVersion(this.store, ctxMetaGraph, ual, publishVersion);
      this.log.info(ctx, `RS scoped-promote: promoted ${ual} → context graph ${targetCgId} (kaId=${partitionKaId})`);
    });
  }

  /**
   * Trusted graph-scoped update entrypoint. It accepts no public RDF payload;
   * the publisher reloads the complete exact SWM graph itself, then marks the
   * resulting internal call so canonical retry skolem IRIs are accepted.
   */
  async updateKnowledgeAssetFromSharedMemory(
    kaId: bigint,
    options: Omit<PublishOptions, 'quads'>,
  ): Promise<PublishResult> {
    const descriptor = resolveGraphScopedPublishDescriptor({
      ...options,
      quads: [],
    });
    if (!descriptor) {
      throw new Error('Graph-scoped SWM update requires a complete V2 content envelope');
    }
    const swmBucket = this.graphManager.sharedMemoryUri(
      options.contextGraphId,
      options.subGraphName,
    );
    const scope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: {
        agentAddress: descriptor.scope.agentAddress,
        kaNumber: BigInt(descriptor.scope.kaNumber),
      },
    };
    const quads = await loadSharedMemoryQuadsForScope(
      this.store,
      swmBucket,
      'all',
      scope,
      { quadFilter: (quad) => !isSwmMerkleExcludedQuad(quad) },
    );
    const hasTrustedCatalogTriples =
      trustedCatalogTripleKeySet(options.trustedNonManifestCatalogTriples).size > 0;
    if (hasTrustedCatalogTriples) {
      // Validate the capability here, but do not mutate the exact SWM payload.
      // `update()` derives the detached catalog commitment from this trusted
      // marker after separately canonicalizing the submitted KA graph.
      assertTrustedCatalogTriplesAreGeneratedFloor(
        options.contextGraphId,
        options.trustedNonManifestCatalogTriples,
      );
    }
    // Fully private KAs legitimately have ZERO public SWM quads — the update
    // then carries only the private partition and its commitment (an empty
    // envelope is already rejected by the descriptor). Reject only when the
    // envelope promises public content that shared memory lacks.
    if (quads.length === 0 && descriptor.publicTripleCount > 0) {
      throw new Error(
        `No public or private quads available for graph-scoped KA ${descriptor.scope.ual}`,
      );
    }
    return this.update(kaId, {
      ...options,
      quads: quads.map((quad) => ({ ...quad, graph: '' })),
      [INTERNAL_ORIGIN_TOKEN]: true,
      ...(hasTrustedCatalogTriples
        ? { [TRUSTED_CATALOG_ORIGIN_TOKEN]: true as const }
        : {}),
    } as InternalPublishOptions);
  }

  /**
   * Effective access-control metadata for a graph-scoped update. Graph-scoped
   * updates converge the KA's `_meta` row set to exactly what the metadata
   * generator emits, so any field regenerated from raw update options loses
   * its stored value. For the access fields that is a privacy hole: the
   * generator defaults a missing `accessPolicy` to 'public', so an update
   * that omitted policy options flipped a private KA public (PR #1712 review,
   * otReviewAgent 3586192289). Resolution order per field: explicit update
   * option → existing stored `_meta` row → the same private-content default
   * `publish()` applies. Conflicting or invalid stored policy rows (e.g. an
   * interrupted converge) fail closed to 'ownerOnly' — mirroring the access
   * handler, which denies on invalid explicit policy rather than serving.
   */
  private async resolveGraphScopedUpdateAccessMeta(
    metaGraph: string,
    kaUal: string,
    options: PublishOptions,
    hasPrivateContent: boolean,
  ): Promise<{
    accessPolicy: 'public' | 'ownerOnly' | 'allowList';
    publisherPeerId: string;
    allowedPeers: string[];
  }> {
    const DKG_ONT = 'http://dkg.io/ontology/';
    const safeUal = assertSafeIri(kaUal);
    const existing = await this.store.query(
      `SELECT ?policy ?peer ?allowed WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
        { <${safeUal}> <${DKG_ONT}accessPolicy> ?policy }
        UNION { <${safeUal}> <${DKG_ONT}publisherPeerId> ?peer }
        UNION { <${safeUal}> <${DKG_ONT}allowedPeer> ?allowed }
      } }`,
    );
    const storedPolicies = new Set<string>();
    const storedPeerIds = new Set<string>();
    const storedAllowedPeers = new Set<string>();
    if (existing.type === 'bindings') {
      for (const row of existing.bindings) {
        const policy = stripSparqlLiteral(row['policy']);
        if (policy) storedPolicies.add(policy);
        const peer = stripSparqlLiteral(row['peer']);
        if (peer && peer !== 'unknown') storedPeerIds.add(peer);
        const allowed = stripSparqlLiteral(row['allowed']);
        if (allowed) storedAllowedPeers.add(allowed);
      }
    }
    const isPolicy = (v: string): v is 'public' | 'ownerOnly' | 'allowList' =>
      v === 'public' || v === 'ownerOnly' || v === 'allowList';
    let storedPolicy: 'public' | 'ownerOnly' | 'allowList' | undefined;
    const [firstPolicy] = storedPolicies;
    if (storedPolicies.size === 1 && firstPolicy !== undefined && isPolicy(firstPolicy)) {
      storedPolicy = firstPolicy;
    } else if (storedPolicies.size > 0) {
      storedPolicy = 'ownerOnly';
    }
    // Distinct real stored owner ids are ambiguous — treat as absent so a
    // non-public update must name the owner explicitly instead of guessing.
    const [storedPeerId] = storedPeerIds.size === 1 ? storedPeerIds : [];

    const explicitPeerId = options.publisherPeerId?.trim() || undefined;
    const explicitAllowedPeers = options.allowedPeers === undefined
      ? undefined
      : [...new Set(options.allowedPeers.map((p) => p.trim()).filter(Boolean))];

    const accessPolicy = options.accessPolicy
      ?? storedPolicy
      ?? (hasPrivateContent ? 'ownerOnly' : 'public');
    const publisherPeerId = explicitPeerId ?? storedPeerId ?? '';
    const allowedPeers = explicitAllowedPeers
      ?? (accessPolicy === 'allowList' ? [...storedAllowedPeers] : []);

    if (accessPolicy !== 'public' && publisherPeerId.length === 0) {
      throw new Error(
        `Update rejected: accessPolicy "${accessPolicy}" requires a non-empty "publisherPeerId" ` +
          '(none supplied and no unambiguous stored owner to preserve)',
      );
    }
    if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
      throw new Error('Update rejected: accessPolicy "allowList" requires non-empty "allowedPeers"');
    }
    if (accessPolicy !== 'allowList' && (explicitAllowedPeers?.length ?? 0) > 0) {
      throw new Error('Update rejected: "allowedPeers" is only valid when accessPolicy is "allowList"');
    }
    return { accessPolicy, publisherPeerId: publisherPeerId || 'unknown', allowedPeers };
  }

  async update(kaId: bigint, options: PublishOptions): Promise<PublishResult> {
    const { contextGraphId, quads, privateQuads = [], operationCtx, onPhase } = options;
    const graphUpdate = resolveGraphScopedPublishDescriptor(options);
    if (graphUpdate) {
      if (graphUpdate.expectedPackedKaId !== kaId) {
        throw new Error(
          `Graph-scoped update kaId ${kaId} does not match UAL-derived kaId ` +
            `${graphUpdate.expectedPackedKaId}`,
        );
      }
      // 🔴 PR #1712 review (3586686572): the packed-id check above proves
      // author+number but ignores the UAL's chain namespace, so an update
      // could be submitted on this chain while persisting and returning an
      // identity that names another chain. Mirror publish()'s pre-mint guard;
      // chainless (NoChainAdapter) updates stay exempt like local publishes —
      // with no chain identity there is nothing for the UAL to disagree with.
      if (this.chain.chainId !== 'none') {
        let updateEvmChainId: bigint | undefined;
        try {
          updateEvmChainId = await this.chain.getEvmChainId?.();
        } catch {
          // Legacy/non-V10 adapters can still compare exact labels or their
          // configured numeric suffix; V10 adapters are checked again while
          // validating the update attestation before submission.
        }
        if (!graphScopeTargetsChain(
          graphUpdate.scope.chainId,
          this.chain.chainId,
          updateEvmChainId,
        )) {
          throw new Error(
            `Graph-scoped update UAL ${graphUpdate.scope.ual} targets chain ` +
              `${graphUpdate.scope.chainId}, but this publisher operates on ` +
              `${this.chain.chainId}` +
              (updateEvmChainId === undefined ? '' : ` (EIP-155 ${updateEvmChainId})`),
          );
        }
      }
    }
    // Round 12 Bug 34: `update()` is a Bucket A public write entry
    // point (accepts user-authored quads) that Round 9 missed. Apply
    // the same reserved-namespace guard as `publish()` / `assertionWrite`
    // / `share` / `conditionalShare`, gated on the same internal-origin
    // token so legitimate internal update flows can bypass. Currently
    // there are no internal callers of `update()`, so the token check
    // is a forward-looking safety net — the common path is always
    // guarded.
    if (!isInternalOrigin(options)) {
      rejectUserAuthoredProtocolMetadata(quads);
      if (privateQuads.length > 0) rejectUserAuthoredProtocolMetadata(privateQuads);
    }
    rejectOversizedRdfLiterals(quads, 'update.quads');
    if (privateQuads.length > 0) rejectOversizedRdfLiterals(privateQuads, 'update.privateQuads');
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    await this.ensureSubGraphRegistered(contextGraphId, options.subGraphName);
    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(options.publishContextGraphId ?? contextGraphId);
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Descriptive SWM graph names are valid local/mock update scopes.
    }
    const localOnlyUpdate = this.chain.chainId === 'none';
    const hasAttributionOverride = options.publisherNodeIdentityIdOverride !== undefined;
    const attributionIdentityId: bigint = hasAttributionOverride
      ? options.publisherNodeIdentityIdOverride!
      : this.publisherNodeIdentityId;
    let resolvedPublisherAddress: string | undefined;
    if (localOnlyUpdate) {
      resolvedPublisherAddress = this.publisherAddress;
    } else if (typeof this.chain.getLatestMerkleRootPublisher === 'function') {
      try {
        resolvedPublisherAddress = coercePublisherAddress(
          await this.chain.getLatestMerkleRootPublisher(kaId),
        );
      } catch {
        // Adapter-managed updates can still let the adapter resolve the
        // original publisher while submitting the transaction.
      }
    }
    if (!resolvedPublisherAddress && !localOnlyUpdate) {
      resolvedPublisherAddress = await this.resolveKnownBatchPublisherAddress(
        contextGraphId,
        kaId,
        options.targetMetaGraphUri,
      );
    }
    if (!resolvedPublisherAddress && !localOnlyUpdate) {
      resolvedPublisherAddress = await this.resolvePublisherAddress(undefined, {
        includeReservingPublisherProbe: false,
        includeGenericSignMessageProbe: false,
      });
    }
    const publisherAddress = resolvedPublisherAddress ?? (
      localOnlyUpdate ? this.localTentativePublisherAddress() : undefined
    );
    this.log.info(ctx, `Updating kaId=${kaId} with ${quads.length} triples`);
    // Uniform layout: a KA update replaces published data in the SAME per-KA
    // verifiable-memory graph publish() wrote (…/_verifiable_memory/{author}/{number}),
    // keyed by kaId. restateLabelGraphForUpdate purges the old roots there + writes the new
    // (matches the receiver-side update-handler.ts). Without this the update lands in root
    // while stale data lingers in the per-KA graph, and read-both returns both.
    const dataGraph = graphUpdate
      ? knowledgeAssetLayerGraphUri(
          contextGraphId,
          MemoryLayer.VerifiableMemory,
          graphUpdate.scope,
          options.subGraphName,
        )
      : contextGraphLayerUri(
          contextGraphId,
          MemoryLayer.VerifiableMemory,
          '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
          kaId & ((1n << 96n) - 1n),
          options.subGraphName,
        );

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:partition', 'start');
    await this.assertTrustedCatalogTriplesAllowed({
      contextGraphId,
      trustedNonManifestCatalogTriples: options.trustedNonManifestCatalogTriples,
      onChainContextGraphId: publisherContextGraphId,
      internalCatalogOrigin: isTrustedCatalogInternalOrigin(options),
    });
    let kaMap = new Map<string, Quad[]>();
    let contentRootMap = new Map<string, Quad[]>();
    let canonicalPrivateQuads: Quad[] = [];
    let allSkolemizedQuads: Quad[];
    let updatePrivateRoots: Uint8Array[];
    let graphUpdateAccess:
      | { accessPolicy: 'public' | 'ownerOnly' | 'allowList'; publisherPeerId: string; allowedPeers: string[] }
      | undefined;
    if (graphUpdate) {
      assertNoKnowledgeAssetPayloadNamedGraphs(quads, privateQuads);
      const canonicalParts = await skolemizeKnowledgeAssetParts(quads, privateQuads, {
        allowCanonicalSkolemTerms: isInternalOrigin(options),
      });
      allSkolemizedQuads = canonicalParts.publicQuads;
      canonicalPrivateQuads = canonicalParts.privateQuads;
      const validation = validateCanonicalGraphScopedKnowledgeAssetPayload(
        allSkolemizedQuads.map((quad) => ({ ...quad, graph: dataGraph })),
        dataGraph,
        graphUpdate.publicTripleCount,
      );
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
      }
      if (canonicalPrivateQuads.length !== graphUpdate.privateTripleCount) {
        throw new Error(
          `Graph-scoped KA private triple count mismatch: envelope=${graphUpdate.privateTripleCount}, ` +
            `canonical=${canonicalPrivateQuads.length}`,
        );
      }
      const privateRoot = computePrivateRoot(canonicalPrivateQuads);
      if (graphUpdate.expectedPrivateMerkleRoot) {
        if (
          !privateRoot
          || privateRoot.length !== graphUpdate.expectedPrivateMerkleRoot.length
          || !privateRoot.every((byte, index) => byte === graphUpdate.expectedPrivateMerkleRoot![index])
        ) {
          throw new Error('Graph-scoped KA private Merkle root does not match the envelope commitment');
        }
      }
      updatePrivateRoots = privateRoot ? [privateRoot] : [];
      graphUpdateAccess = await this.resolveGraphScopedUpdateAccessMeta(
        options.targetMetaGraphUri ?? this.graphManager.metaGraphUri(contextGraphId),
        graphUpdate.scope.ual,
        options,
        graphUpdate.privateTripleCount > 0,
      );
    } else {
      kaMap = skolemizeByEntity(quads);
      const split = splitTrustedGeneratedCatalogRootMap(
        kaMap,
        options.trustedNonManifestCatalogTriples,
      );
      contentRootMap = split.contentRootMap;
      for (const rootEntity of split.generatedCatalogRootEntities) {
        const hiddenPrivateQuads = privateQuads.filter(
          (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
        );
        if (hiddenPrivateQuads.length > 0) {
          throw new Error(
            `Generated catalog subject "${rootEntity}" has private triples; ` +
            'refusing to exclude it from the KA manifest',
          );
        }
      }
      allSkolemizedQuads = [...kaMap.values()].flat();
      updatePrivateRoots = [];
    }
    onPhase?.('prepare:partition', 'end');

    onPhase?.('prepare:manifest', 'start');
    const manifestEntries: KAManifestEntry[] = [];
    const entityPrivateMap = new Map<string, Quad[]>();

    let tokenCounter = 1n;
    for (const [rootEntity] of contentRootMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      entityPrivateMap.set(rootEntity, entityPrivateQuads);

      manifestEntries.push({
        tokenId: tokenCounter++,
        rootEntity,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads) : undefined,
        privateTripleCount: entityPrivateQuads.length,
      });
    }
    onPhase?.('prepare:manifest', 'end');

    onPhase?.('prepare:merkle', 'start');
    if (!graphUpdate) {
      updatePrivateRoots = manifestEntries
        .map(m => m.privateMerkleRoot)
        .filter((r): r is Uint8Array => r != null);
    }
    const kcMerkleRoot = computeFlatKCRoot(allSkolemizedQuads, updatePrivateRoots);
    const kcMerkleLeafCount = computeFlatKCMerkleLeafCountV10(allSkolemizedQuads, updatePrivateRoots);
    if (kcMerkleLeafCount > 0xffffffff) {
      throw new Error(`V10 merkleLeafCount exceeds uint32: ${kcMerkleLeafCount}`);
    }
    onPhase?.('prepare:merkle', 'end');
    onPhase?.('prepare', 'end');

    const updatePrivateRootByRoot = new Map<string, Uint8Array>();
    for (const m of manifestEntries) {
      if (m.privateMerkleRoot) updatePrivateRootByRoot.set(m.rootEntity, m.privateMerkleRoot);
    }

    const storeUpdatedQuads = async (
      version?: MaterializedVersion,
      provenance?: OnChainProvenance,
    ): Promise<void> => {
      onPhase?.('store', 'start');

      if (graphUpdate) {
        const labelMeta = options.targetMetaGraphUri
          ?? this.graphManager.metaGraphUri(contextGraphId);
        // GH#842 last-writer-wins + atomicity. Serialise the whole exact-graph
        // replace + private replace + metadata converge + version stamp under
        // the per-KA materialization lock, and skip a stale (lower chain
        // version) re-run — exactly like the publish-promote path (~4182) and
        // the legacy update restate. Without this the graph-scoped update was
        // the only materialising writer with no lock and no version gate: two
        // racing updates could interleave their multi-step replace, and a late
        // v2 could overwrite a materialised v3's data graph and delete v3's
        // metadata rows via the converge, leaving the node permanently serving
        // the superseded assertion with no self-heal (cross-node divergence).
        await withMaterializationLock(labelMeta, graphUpdate.scope.ual, async () => {
          // Gate only on a confirmed run (one that carries a chain version); the
          // tentative local write has none and is the current-version write.
          if (
            version
            && !(await shouldApplyMaterialization(
              this.store,
              labelMeta,
              graphUpdate.scope.ual,
              version,
              BigInt(graphUpdate.scope.assertionVersion),
            ))
          ) {
            this.log.info(
              ctx,
              `Graph-scoped update: skipped ${graphUpdate.scope.ual} — a newer materialisation is present`,
            );
            return;
          }
          const inherited = await this.readGraphKnowledgeAssetIdentity(
            labelMeta,
            graphUpdate.scope.ual,
          );
          if (inherited.subGraphName !== options.subGraphName) {
            throw new Error(
              `Graph-scoped KA update cannot move ${graphUpdate.scope.ual} from ` +
                `${inherited.subGraphName ?? '(root)'} to ${options.subGraphName ?? '(root)'}`,
            );
          }
          await this.replaceExactKnowledgeAssetGraph(
            dataGraph,
            allSkolemizedQuads,
            'Graph-scoped KA update',
          );
          await this.privateStore.replaceKnowledgeAssetPrivateTriples(
            contextGraphId,
            graphUpdate.scope,
            canonicalPrivateQuads,
            options.subGraphName,
          );
          // 🔴 PR #1712 review (3586192289): the converge below replaces the
          // KA's entire access row set, so passing raw update options here let
          // an update that omitted `accessPolicy` rewrite a private KA to the
          // metadata generator's 'public' default (and its owner to 'unknown'),
          // silently exposing its private triples. `graphUpdateAccess` resolves
          // explicit option → existing stored row → publish()'s private-content
          // default, with publish()'s option validation applied.
          const metadata = generateGraphKnowledgeAssetMetadata(
            {
              ual: graphUpdate.scope.ual,
              contextGraphId,
              merkleRoot: kcMerkleRoot,
              publisherPeerId: graphUpdateAccess!.publisherPeerId,
              accessPolicy: graphUpdateAccess!.accessPolicy,
              allowedPeers: graphUpdateAccess!.allowedPeers.length > 0
                ? graphUpdateAccess!.allowedPeers
                : undefined,
              timestamp: new Date(),
              subGraphName: inherited.subGraphName,
              authorAddress: inherited.authorAddress,
              assertionVersion: graphUpdate.scope.assertionVersion,
              publicTripleCount: graphUpdate.publicTripleCount,
              privateTripleCount: graphUpdate.privateTripleCount,
              ...(updatePrivateRoots[0]
                ? { privateMerkleRoot: updatePrivateRoots[0] }
                : {}),
              assertionGraph: dataGraph,
            },
            provenance
              ? {
                  status: 'confirmed',
                  confirmation: { kind: 'transaction', provenance },
                }
              : { status: 'tentative' },
          );
          await replaceLocallyTrustedKnowledgeAssetControls(
            this.store,
            graphUpdate.scope.ual,
            metadata,
          );
          await this.convergeKnowledgeAssetMetadataRows(
            labelMeta,
            graphUpdate.scope.ual,
            metadata,
          );
          if (version) {
            await writeMaterializedVersion(
              this.store,
              labelMeta,
              graphUpdate.scope.ual,
              version,
            );
          }
        });
        onPhase?.('store', 'end');
        return;
      }

      // Discover the PRIOR root entities from `_meta` BEFORE the label
      // restatement wipes them (Codex review #2 on PR #845). When an update
      // changes the root entity, the v1 fix only purged private triples for
      // the NEW roots, so the prior root's private payload was left in
      // `PrivateContentStore` (keyed by `(contextGraph, rootEntity)`) and
      // would leak into any future KA that reused the prior root in the
      // same context graph.
      const DKG_ONT = 'http://dkg.io/ontology/';
      const priorRootEntities = new Set<string>();
      try {
        const labelMetaForPriors = this.graphManager.metaGraphUri(contextGraphId);
        let ualForPriors = await resolveUalByBatchId(this.store, labelMetaForPriors, kaId);
        if (!ualForPriors) {
          // Same local-only deterministic-UAL fallback as the restate
          // block below (PR #845 review #8). Keeps the prior-root scan
          // working for `NoChainAdapter` updates.
          if (localOnlyUpdate && publisherAddress) {
            ualForPriors = `did:dkg:${this.chain.chainId}/${publisherAddress}/${kaId}`;
          } else {
            ualForPriors = await this.resolveKaUal(kaId);
          }
        }
        if (ualForPriors) {
          // Read-both (RFC ka-metadata-trim P3.1): collapsed-shape rows carry
          // `dkg:rootEntity` on the UAL subject; legacy rows on `<ual>/<n>`.
          const priorRes = await this.store.query(
            `SELECT DISTINCT ?root WHERE { GRAPH <${labelMetaForPriors}> {
               { ?ka <${DKG_ONT}partOf> <${ualForPriors}> ; <${DKG_ONT}rootEntity> ?root }
               UNION
               { <${ualForPriors}> <${DKG_ONT}rootEntity> ?root }
             } }`,
          );
          if (priorRes.type === 'bindings') {
            for (const row of priorRes.bindings) {
              const r = row['root'];
              if (typeof r === 'string' && r.length > 0) priorRootEntities.add(r);
            }
          }
        }
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to resolve prior root entities for kaId=${kaId} private-triple purge: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Private triples: purge BOTH prior + new roots, then store the new
      // payload. Purging the union (and not just the new roots) is what
      // closes the leak described above.
      const rootsToPurge = new Set<string>(priorRootEntities);
      for (const [rootEntity] of contentRootMap) rootsToPurge.add(rootEntity);
      for (const rootEntity of rootsToPurge) {
        await this.privateStore.deletePrivateTriples(contextGraphId, rootEntity, options.subGraphName);
      }
      for (const [rootEntity] of contentRootMap) {
        const entityPrivateQuads = entityPrivateMap.get(rootEntity) ?? [];
        if (entityPrivateQuads.length > 0) {
          await this.privateStore.storePrivateTriples(contextGraphId, rootEntity, entityPrivateQuads, options.subGraphName);
        }
      }

      // Public + meta: full-restate the label graph (GH#842 §7.1). The old
      // approach deleted/inserted only the NEW payload roots, leaving the prior
      // root entity (and its triples) behind in both label data and `_meta` —
      // so `agent.query` returned stale+new and the per-cgId copy was built
      // from a stale source. `restateLabelGraphForUpdate` purges the prior
      // roots' data, repoints `rootEntity` (preserving rich provenance), and
      // refreshes `merkleRoot`. The version guard makes a later stale
      // re-materialisation a no-op.
      //
      // PR #845 review #8 (@branarakic): public restatement is the CORE
      // write — it must NOT be swallowed. Pre-fix code wrapped this in
      // try/catch, so a `NoChainAdapter` update (where `resolveKaUal`
      // throws because `getDKGKnowledgeAssetsAddress` returns undefined)
      // would report tentative/confirmed success with private triples
      // changed but public triples STILL stale — silently breaking
      // `agent.query` on the label graph.
      //
      // Fix: for the local-only path we have a deterministic UAL
      // (`did:dkg:<chainId>/<publisherAddress>/<kaId>` — same scheme the
      // result UAL uses at L2941), so use that as the last-resort UAL
      // when `resolveKaUal` would throw. For the on-chain path we still
      // let `resolveKaUal` throw (failing the update) — which is the
      // correct behavior when chain-truth is required but unavailable.
      const labelMeta = this.graphManager.metaGraphUri(contextGraphId);
      let ualForRestate = await resolveUalByBatchId(this.store, labelMeta, kaId);
      if (!ualForRestate) {
        if (localOnlyUpdate && publisherAddress) {
          // Mirror the `result.ual` formula below so the restated meta
          // joins with what `update()`'s caller sees as the KA's UAL.
          ualForRestate = `did:dkg:${this.chain.chainId}/${publisherAddress}/${kaId}`;
        } else {
          ualForRestate = await this.resolveKaUal(kaId);
        }
      }
      await restateLabelGraphForUpdate({
        store: this.store,
        dataGraph,
        metaGraph: labelMeta,
        ual: ualForRestate,
        merkleRoot: kcMerkleRoot,
        payloadByRoot: contentRootMap,
        privateRootByRoot: updatePrivateRootByRoot,
        version,
      });
      onPhase?.('store', 'end');
    };

    if (localOnlyUpdate) {
      this.log.warn(ctx, 'No chain configured — applying update locally and returning tentative result');
      await storeUpdatedQuads();
      const result: PublishResult = {
        kaId,
        ual: graphUpdate?.scope.ual
          ?? `did:dkg:${this.chain.chainId}/${publisherAddress}/${kaId}`,
        merkleRoot: kcMerkleRoot,
        kaManifest: manifestEntries,
        status: 'tentative',
        publicQuads: allSkolemizedQuads,
      };
      this.eventBus.emit(DKGEvent.KA_UPDATED, result);
      return result;
    }

    onPhase?.('chain', 'start');
    onPhase?.('chain:submit', 'start');

    // Compute real serialized byte size — must match the publish path serializer.
    // Done BEFORE `chain:writeahead:start` so any error during serialization
    // does not leave an unmatched write-ahead boundary.
    const updateNquadsStr = allSkolemizedQuads
      .map(
        (q: { subject: string; predicate: string; object: string; graph?: string }) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph || dataGraph}> .`,
      )
      .join('\n');
    const updateByteSize = BigInt(new TextEncoder().encode(updateNquadsStr).length);

    // OT-RFC-49 / WS-D (update) — mirror the curated PUBLISH producer
    // (dkg-publisher.ts:2030-2169). A value-adding curated update commits the
    // PUBLIC `_catalog` Merkle root (NOT the stripped ciphertext root). Partition
    // the catalog leaf-set out of the update's skolemized quads, compute the
    // commitment ONCE from the committed leaves (post-publish stamps stripped via
    // `catalogCommittedLeaves`), serialize them to the byte-identical plain
    // N-Triples (no graph term — same expression as the publish path at
    // 2059-2064), and price the update off that catalog footprint. The PRIVATE
    // (non-catalog) data stays AEAD-encrypted for CG MEMBERS only; the catalog is
    // public and rides inline as `stagingQuads` so cores can rebuild/verify it.
    // Identity-based partition: the only catalog subject is this CG's canonical
    // DID, so a forged `rdf:type dkg:PrivateContextGraph` cannot route a user
    // entity into the plaintext `_catalog`.
    const { catalogQuads: updateCatalogQuads, otherQuads: updateOtherQuads } =
      resolveCatalogProofMaterial(
        allSkolemizedQuads,
        contextGraphId,
        graphUpdate !== undefined,
        options.trustedNonManifestCatalogTriples,
        dataGraph,
      );
    // Non-catalog plaintext fed to the MEMBER encryptor (graph term retained,
    // mirror 2031-2038). No-op for public updates / curated updates with no
    // catalog entry (then encryptableUpdateNquadsStr === updateNquadsStr).
    const encryptableUpdateNquadsStr = updateCatalogQuads.length === 0
      ? updateNquadsStr
      : updateOtherQuads
          .map(
            (q) =>
              `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
          )
          .join('\n');
    // Committed catalog commitment — derived from the SAME source as the
    // serialized bytes and the on-chain root so byteSize and the commitment
    // cannot desync across pricing, ACK digest, and chain tx. undefined for
    // public updates and any curated update with no catalog entry.
    const committedUpdateCatalogLeaves = catalogCommittedLeaves(updateCatalogQuads);
    const updateCatalogCommitment = committedUpdateCatalogLeaves.length > 0
      ? computeCatalogRoot(committedUpdateCatalogLeaves)
      : undefined;
    // Plain N-Triples (no graph term — byte-identical to publish 2059-2064) so
    // the core's `parseSimpleNQuads` → `catalogCommittedLeaves` → `computeCatalogRoot`
    // rebuild reproduces the identical leaf hashes (`hashTripleV10` excludes graph).
    const updateCatalogNquadsStr = committedUpdateCatalogLeaves
      .map(
        (t) =>
          `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`,
      )
      .join('\n');
    const updateCatalogByteSize = BigInt(new TextEncoder().encode(updateCatalogNquadsStr).length);
    // A curated update is identified by a wired `encryptInlinePayload` hook
    // (DKGAgent resolves this from accessPolicy === curated — wired in the
    // agent half) AND a non-zero catalog commitment (mirror 2125/2131). When
    // the hook is absent this is a PUBLIC update and EVERY new path below is a
    // no-op: zero catalog, full-quads stagingQuads, newByteSize=updateByteSize.
    const useEncryptedInlineUpdate = typeof options.encryptInlinePayload === 'function';
    const useCuratedUpdate = useEncryptedInlineUpdate && updateCatalogCommitment !== undefined;
    // Select the inline staging payload + the byteSize that gets priced/signed.
    // Curated update → the PUBLIC catalog N-quads + the catalog footprint
    // (THE BYTESIZE TRAP, §3: the core's parity check is vs `newByteSize`, which
    // we therefore set to `updateCatalogByteSize`). Public update → unchanged:
    // full update quads inline (when no private roots are mixed in) + updateByteSize.
    let updateStagingQuads: Uint8Array | undefined;
    let effectiveUpdateByteSize = updateByteSize;
    if (useEncryptedInlineUpdate) {
      // MEMBER-SIDE ENCRYPTION STAYS. AEAD-encrypt the private (non-catalog)
      // data and DISTRIBUTE it to CG members — via the chunked SWM fan-out when
      // wired (PREFERRED; the single-blob hook is pure and does NOT distribute),
      // mirroring curated publish (:2134-2155). OT-RFC-49 stripped the ciphertext
      // from the on-chain commitment, the core ACK, and pricing, so the returned
      // ciphertext root/bytes are intentionally DISCARDED — the gossip side
      // effect (members receive the updated payload) is the point.
      const plaintextBytes = new TextEncoder().encode(encryptableUpdateNquadsStr);
      if (typeof options.encryptInlineChunked === 'function') {
        // batchId = V10 KC merkleRoot (member-side per-chunk persistence key);
        // the op id is the per-operation AEAD nonce domain — the update path has
        // none of its own, so derive a session-scoped, content-unique one.
        const updateOperationId = `${this.sessionId}-upd-${ethers.hexlify(kcMerkleRoot).slice(2, 18)}`;
        await options.encryptInlineChunked({
          plaintextNquads: plaintextBytes,
          batchId: kcMerkleRoot,
          publishOperationId: updateOperationId,
        });
      } else {
        // No chunked emitter (single-blob fallback): the hook is pure and does
        // NOT distribute, so members rely on SWM convergence in this case.
        await options.encryptInlinePayload!(plaintextBytes);
      }
      if (useCuratedUpdate) {
        // The ACK wire payload is the PUBLIC catalog N-quads (plaintext —
        // public by design). Cores rebuild the catalog root from these bytes,
        // verify == the claimed `newCatalogRoot`, persist to `<cg>/_catalog`,
        // and sign. byteSize == the catalog footprint, from the SAME leaf-set.
        updateStagingQuads = new TextEncoder().encode(updateCatalogNquadsStr);
        effectiveUpdateByteSize = updateCatalogByteSize;
      } else {
        // Curated update with no catalog entry — nothing public to commit/serve.
        // Carry a zero catalog commitment; leave staging empty.
        updateStagingQuads = undefined;
        effectiveUpdateByteSize = updateByteSize;
      }
    } else {
      // PUBLIC update — unchanged from the prior behaviour: send the full
      // update N-quads inline so peers recompute `newMerkleRoot`, unless private
      // roots are mixed in (then the peer can't recompute and we omit staging).
      updateStagingQuads = updatePrivateRoots.length === 0
        ? new TextEncoder().encode(updateNquadsStr)
        : undefined;
      effectiveUpdateByteSize = updateByteSize;
    }
    // B6 — deferred PUBLIC `_catalog` persist. Structurally identical to the
    // publish path's `persistCatalogEntry` (2079-2092): CLEAR/REPLACE by subject
    // so repeated updates never accumulate stale catalog triples. Invoked ONLY
    // from the confirmed-chain-success branch below — never on local-only,
    // tentative, early-return/definitive-error, or `!txResult.success` paths, so
    // a failed update never exposes a public catalog entry whose verifiable
    // memory never landed. Stricter than publish: also gated on `useCuratedUpdate`
    // because in `update()` ANY `_catalog` write is new behaviour.
    const persistUpdateCatalogEntry = async (): Promise<void> => {
      if (!useCuratedUpdate || updateCatalogQuads.length === 0) return;
      const catalogGraph = contextGraphCatalogUri(contextGraphId);
      const catalogSubjects = new Set(updateCatalogQuads.map((q) => q.subject));
      for (const subject of catalogSubjects) {
        await this.store.deleteByPattern({ graph: catalogGraph, subject });
      }
      await this.store.insert(updateCatalogQuads.map((q) => ({ ...q, graph: catalogGraph })));
    };

    if (!options.precomputedUpdateAttestation) {
      throw new Error(
        'Update rejected: on-chain update requires precomputedUpdateAttestation. ' +
        'Sign UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress) off-band and pass the seal in this call.',
      );
    }
    const updateSeal = options.precomputedUpdateAttestation;
    const effectiveAuthorAddress = updateSeal.authorAddress;
    const effectiveSchemeVersion = updateSeal.schemeVersion;
    // Single source of truth for the "update rejected on chain" result shape,
    // shared by the pre-staging owner check and the chain-submit path below so
    // a definitive rejection returns one canonical failed PublishResult.
    const buildFailedUpdateResult = async (): Promise<PublishResult> => ({
      kaId,
      ual: graphUpdate?.scope.ual ?? await this.resolveKaUal(kaId),
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status: 'failed',
      publicQuads: allSkolemizedQuads,
    });
    try {
      await assertValidPrecomputedUpdateAttestation(
        this.chain,
        kaId,
        kcMerkleRoot,
        updateSeal,
      );
    } catch (attestErr) {
      // Fail-closed contract: update() returns {status:'failed'} and mutates
      // nothing when the chain has no updatable KA. This pre-staging owner
      // check reads chain-truth (getKnowledgeAssetOwner -> ownerOf) BEFORE the
      // chain-submit try/catch below, so an update against a non-existent KA
      // reverts HERE and — before the rootless cutover moved this check ahead
      // of staging — would escape update() as a throw instead of a failed
      // result. Convert only the definitive "no updatable KA" class to a failed
      // result; every authorization failure (wrong owner of an EXISTING KA ->
      // KA_UPDATE_AUTHOR_NOT_OWNER, signer mismatch, or a missing-adapter-method
      // config error) still throws, preserving reject-unauthorized-before-staging.
      const errorName = extractV10UpdateRejectionName(attestErr);
      if (!errorName || !PRE_STAGING_NO_UPDATABLE_KA_ERRORS.includes(errorName)) {
        throw attestErr;
      }
      this.log.warn(
        ctx,
        `V10 update rejected pre-staging (${errorName}) for kaId=${kaId}: no updatable KA on chain`,
      );
      onPhase?.('chain:submit', 'end');
      onPhase?.('chain', 'end');
      return buildFailedUpdateResult();
    }

    // P-1 review (iter-2): `chain:writeahead:start` fires from inside
    // the V10 adapter via `onBroadcast` — i.e. AFTER allowance +
    // `approve()`, RIGHT BEFORE the real `updateDirect` broadcast.
    // This keeps the WAL boundary precise (listeners only record
    // recovery state when a concrete update tx is imminent) while the
    // outer try/finally still guarantees balanced `:start`/`:end`
    // when the adapter throws after invoking `onBroadcast`. The V9
    // legacy update fallback was archived in
    // `archive-non-v10-contracts` (issue 0004) — adapters must now
    // provide the V10 `updateKnowledgeCollectionV10` surface.
    let txResult: { success: boolean; hash: string; blockNumber?: number; txIndex?: number; publisherAddress?: string };
    let earlyReturn: PublishResult | undefined;
    let wroteAhead = false;
    const emitPhase = async (phase: string, status: 'start' | 'end') => {
      await (onPhase?.(phase, status) as unknown as Promise<void> | void);
    };
    const emitWriteAheadStart = async (info?: { txHash?: string }) => {
      if (wroteAhead) return;
      wroteAhead = true;
      // Mirror the publish path (above): emit a balanced, hash-bearing
      // phase first so WAL listeners record the signed-but-not-yet-
      // broadcast update tx identity, then the generic
      // `chain:writeahead:start` for legacy consumers.
      if (info?.txHash) {
        const phase = `chain:txsigned:tx-${info.txHash}`;
        await emitPhase(phase, 'start');
        await emitPhase(phase, 'end');
      }
      await emitPhase('chain:writeahead', 'start');
    };
    // CRITICAL CORRECTNESS INVARIANT (consensus): the digest fields the
    // peers sign MUST be byte-identical to what the on-chain update tx
    // carries + what the contract reads. We source the on-chain-resolved
    // fields (contextGraphId, preUpdateMerkleRootCount, floored
    // newTokenAmount, mintAmount, burnTokenIds) ONCE here via
    // `chain.getUpdateAckDigestFields` — the SAME reads the adapter's
    // `updateKnowledgeCollectionV10` performs — then (a) hand them to the
    // ACK provider so peers sign exactly those, and (b) pin the tx to the
    // resolved `newTokenAmount` via `boundNewTokenAmount` below. This
    // closes the recompute-drift gap: no value is derived twice.
    let v10UpdateACKs: V10CoreNodeACK[] | undefined;
    let boundUpdateTokenAmount: bigint | undefined;
    const v10UpdateACKProvider = options.v10UpdateACKProvider;
    if (v10UpdateACKProvider) {
      onPhase?.('collect_v10_update_acks', 'start');
      try {
        const getFields = (this.chain as unknown as {
          getUpdateAckDigestFields?: (p: {
            kaId: bigint;
            newByteSize: bigint;
            userProvidedNewTokenAmount?: bigint;
            mintAmount?: bigint;
            burnTokenIds?: bigint[];
          }) => Promise<{
            contextGraphId: bigint;
            preUpdateMerkleRootCount: bigint;
            newTokenAmount: bigint;
            mintAmount: bigint;
            burnTokenIds: bigint[];
          }>;
        }).getUpdateAckDigestFields;
        if (typeof getFields !== 'function') {
          throw new Error(
            'V10 update ACK collection requires chain.getUpdateAckDigestFields() so the off-chain-signed ' +
            'digest matches the on-chain update tx. The adapter does not expose it.',
          );
        }
        // Greenfield update: mintAmount=0, burnTokenIds=[]. These mirror
        // the values the tx submits (see updateKnowledgeCollectionV10
        // params below), keeping the signed digest and the tx aligned.
        const digestFields = await getFields.call(this.chain, {
          kaId,
          // THE BYTESIZE TRAP (§3): price off the catalog footprint for a curated
          // update so the floored `newTokenAmount` (pinned into the tx via
          // `boundUpdateTokenAmount` AND signed into the ACK digest) matches the
          // catalog-priced ACK. Public updates keep `updateByteSize`.
          newByteSize: effectiveUpdateByteSize,
          mintAmount: 0n,
          burnTokenIds: [],
        });
        if (
          graphUpdate
          && BigInt(graphUpdate.scope.assertionVersion)
            !== digestFields.preUpdateMerkleRootCount + 1n
        ) {
          throw new Error(
            `Graph-scoped update assertionVersion ${graphUpdate.scope.assertionVersion} must equal ` +
              `preUpdateMerkleRootCount + 1 (${digestFields.preUpdateMerkleRootCount + 1n})`,
          );
        }
        boundUpdateTokenAmount = digestFields.newTokenAmount;
        v10UpdateACKs = await v10UpdateACKProvider({
          kaId,
          // Pass the on-chain-resolved numeric cgId (decimal string) — NOT
          // the cleartext `contextGraphId` name — so the digest's TARGET id
          // matches the tx + the contract read.
          contextGraphId: digestFields.contextGraphId.toString(),
          preUpdateMerkleRootCount: digestFields.preUpdateMerkleRootCount,
          newMerkleRoot: kcMerkleRoot,
          // THE BYTESIZE TRAP (§3): the core's curated-update parity check is vs
          // `newByteSize` (no `publicByteSize` on UpdateIntent), so this MUST be
          // the catalog footprint for a curated update. Public update: unchanged.
          newByteSize: effectiveUpdateByteSize,
          newTokenAmount: digestFields.newTokenAmount,
          mintAmount: digestFields.mintAmount,
          burnTokenIds: digestFields.burnTokenIds,
          newMerkleLeafCount: kcMerkleLeafCount,
          // OT-RFC-49 / WS-D — curated commitment rides the UpdateIntent so the
          // core can rebuild/verify the public catalog. Gated on `useCuratedUpdate`
          // (NOT merely a non-empty commitment) so a PUBLIC update that happens to
          // carry a CG-DID-subject quad never ships a non-zero root (which would
          // trip the on-chain `PublicCGCannotHaveCatalogCommitment` gate).
          newCatalogRoot: useCuratedUpdate ? updateCatalogCommitment!.root : undefined,
          newCatalogLeafCount: useCuratedUpdate ? updateCatalogCommitment!.leafCount : undefined,
          // Curated → cores gate the inline-catalog rebuild/verify/persist path
          // on this flag (mirror the publish closure passing isEncryptedPayload).
          isEncryptedPayload: useEncryptedInlineUpdate ? true : undefined,
          // For a curated update the inline ACK payload is the PUBLIC catalog
          // N-quads (`updateStagingQuads` == the catalog bytes). For a public
          // update it stays the full update N-quads (when no private roots are
          // mixed in) so peers can recompute `newMerkleRoot`; otherwise the peer
          // falls back to verifying against its SWM copy. Selected above.
          stagingQuads: updateStagingQuads,
          swmGraphId: contextGraphId,
          subGraphName: options.subGraphName,
          ...(graphUpdate
            ? {
                contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
                kaUal: graphUpdate.scope.ual,
                assertionVersion: graphUpdate.scope.assertionVersion,
                publicTripleCount: graphUpdate.publicTripleCount,
                ...(updatePrivateRoots[0]
                  ? { privateMerkleRoot: updatePrivateRoots[0] }
                  : {}),
                privateTripleCount: graphUpdate.privateTripleCount,
              }
            : {}),
        });
        this.log.info(
          ctx,
          `V10: Collected ${v10UpdateACKs.length} core node update ACKs`,
        );
      } finally {
        onPhase?.('collect_v10_update_acks', 'end');
      }
    }

    try {
      if (typeof this.chain.updateKnowledgeCollectionV10 === 'function') {
        try {
          txResult = await this.chain.updateKnowledgeCollectionV10({
            kaId,
            newMerkleRoot: kcMerkleRoot,
            // THE BYTESIZE TRAP (§3): the tx byteSize MUST equal the value signed
            // into the ACK digest + priced via getUpdateAckDigestFields — the
            // catalog footprint for a curated update, `updateByteSize` otherwise.
            newByteSize: effectiveUpdateByteSize,
            newMerkleLeafCount: kcMerkleLeafCount,
            // OT-RFC-49 / WS-D — carry the SAME catalog commitment the ACK digest
            // bound + the on-chain gate expects. Gated on `useCuratedUpdate` so a
            // public update submits bytes32(0)/0 (the contract's
            // `PublicCGCannotHaveCatalogCommitment` gate enforces this too).
            newCatalogRoot: useCuratedUpdate ? updateCatalogCommitment!.root : undefined,
            newCatalogLeafCount: useCuratedUpdate ? updateCatalogCommitment!.leafCount : undefined,
            mintAmount: 0,
            // Pin the tx's newTokenAmount to the floored value the ACK
            // collector already had the peers sign (resolved via
            // `getUpdateAckDigestFields`). Without this the adapter would
            // recompute and could drift from the signed digest, making the
            // collected ACK signatures fail the on-chain verify. Undefined
            // when no provider ran (minSig=1 self-sign path) — the adapter
            // then derives newTokenAmount itself as before.
            boundNewTokenAmount: boundUpdateTokenAmount,
            publisherAddress,
            publisherNodeIdentityId: attributionIdentityId,
            v10Origin: true,
            authorAddress: effectiveAuthorAddress,
            authorR: updateSeal.signature.r,
            authorVS: updateSeal.signature.vs,
            authorSchemeVersion: effectiveSchemeVersion,
            ackSignatures: v10UpdateACKs?.map((ack) => ({
              identityId: ack.nodeIdentityId,
              r: ack.signatureR,
              vs: ack.signatureVS,
            })),
            onBroadcast: emitWriteAheadStart,
          });
        } catch (v10Err) {
          const errorName = extractV10UpdateRejectionName(v10Err);
          if (errorName && V10_DEFINITIVE_UPDATE_ERRORS.includes(errorName)) {
            this.log.warn(ctx, `V10 update rejected (${errorName}): ${v10Err instanceof Error ? v10Err.message : String(v10Err)}`);
            earlyReturn = await buildFailedUpdateResult();
            txResult = { success: false, hash: '' };
          } else {
            // V9 legacy update fallback archived (issue 0004).
            throw v10Err;
          }
        }
      } else {
        throw new Error('Chain adapter does not support V10 updates (updateKnowledgeCollectionV10 missing)');
      }
    } finally {
      if (wroteAhead) onPhase?.('chain:writeahead', 'end');
    }

    if (earlyReturn) {
      onPhase?.('chain:submit', 'end');
      onPhase?.('chain', 'end');
      return earlyReturn;
    }

    if (!txResult.success) {
      onPhase?.('chain:submit', 'end');
      onPhase?.('chain', 'end');
      return buildFailedUpdateResult();
    }
    let effectivePublisherAddress = coercePublisherAddress(txResult.publisherAddress);
    if (!effectivePublisherAddress && typeof this.chain.getLatestMerkleRootPublisher === 'function') {
      try {
        effectivePublisherAddress = coercePublisherAddress(
          await this.chain.getLatestMerkleRootPublisher(kaId),
        );
      } catch {
        // Some legacy adapters can submit updates but cannot report the
        // effective publisher. Refuse confirmed metadata below rather than
          // inventing a publisher address that did not come from chain state.
      }
    }
    onPhase?.('chain:submit', 'end');
    onPhase?.('chain', 'end');
    if (!effectivePublisherAddress) {
      this.log.warn(
        ctx,
        'Chain adapter returned a successful update without publisherAddress. ' +
        'Applying local data update as tentative instead of confirming unproven attribution.',
      );
      await storeUpdatedQuads();
      const result: PublishResult = {
        kaId,
        ual: graphUpdate?.scope.ual ?? await this.resolveKaUal(kaId),
        merkleRoot: kcMerkleRoot,
        kaManifest: manifestEntries,
        status: 'tentative',
        publicQuads: allSkolemizedQuads,
      };
      this.eventBus.emit(DKGEvent.KA_UPDATED, result);
      return result;
    }

    // Chain version for the GH#842 last-writer-wins guard. The update's
    // `(blockNumber, txIndex)` is the on-chain ordering key — same-block
    // publish + update are distinguished by `txIndex`, so a late stale
    // publish-promotion can never overwrite this materialisation.
    const updateVersion: MaterializedVersion = {
      blockNumber: txResult.blockNumber ?? 0,
      txIndex: txResult.txIndex ?? 0,
    };
    const updateProvenance: OnChainProvenance = {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber ?? 0,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: effectivePublisherAddress,
      batchId: kaId,
      chainId: this.chain.chainId,
    };
    await storeUpdatedQuads(updateVersion, updateProvenance);

    // B6 — the on-chain update has confirmed and the verifiable-memory quads are
    // committed: REPLACE-persist the rotated PUBLIC `_catalog` here, inside the
    // confirmed-success branch ONLY (no-op unless `useCuratedUpdate`), so a
    // failed/tentative update never exposes a public catalog entry. Mirrors the
    // publish path's deferred `persistCatalogEntry` invocation (2989).
    await persistUpdateCatalogEntry();

    const ual = graphUpdate?.scope.ual ?? await this.resolveKaUal(kaId);

    // GH #842: promote the update payload into the per-cgId partition that the
    // Random Sampling prover reads (`extractV10KCFromStore`). Without this the
    // prover keeps extracting the stale pre-update KA from the original publish
    // promotion and every updated KA is permanently unprovable
    // (`data-corrupted` / leaf-count-mismatch). Best-effort: skip silently when
    // the on-chain cgId is unknown — RS behaviour is then unchanged (the KA
    // simply stays `kc-not-synced`), so this can never regress a publish.
    if (!graphUpdate && publisherContextGraphId !== undefined && publisherContextGraphId > 0n) {
      try {
        const privateRootByRoot = new Map<string, Uint8Array>();
        for (const m of manifestEntries) {
          if (m.privateMerkleRoot) privateRootByRoot.set(m.rootEntity, m.privateMerkleRoot);
        }
        await promoteUpdatedKaToPerCgId({
          store: this.store,
          contextGraphId,
          cgId: publisherContextGraphId.toString(),
          ual,
          kaId,
          merkleRoot: kcMerkleRoot,
          payloadByRoot: contentRootMap,
          privateRootByRoot,
          version: updateVersion,
        });
      } catch (err) {
        this.log.warn(
          ctx,
          `GH#842 per-cgId update promotion failed for kaId=${kaId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const result: PublishResult = {
      kaId,
      ual,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status: 'confirmed',
      publicQuads: allSkolemizedQuads,
      onChainResult: {
        batchId: kaId,
        kaId,
        txHash: txResult.hash,
        blockNumber: txResult.blockNumber ?? 0,
        blockTimestamp: Math.floor(Date.now() / 1000),
        publisherAddress: effectivePublisherAddress,
      },
    };

    this.eventBus.emit(DKGEvent.KA_UPDATED, result);
    return result;
  }

  setIdentityId(id: bigint): void {
    this.publisherNodeIdentityId = id;
  }

  getIdentityId(): bigint {
    return this.publisherNodeIdentityId;
  }

  skolemizeByEntity(quads: Quad[]): KAManifestEntry[] {
    const kaMap = skolemizeByEntity(quads);
    let tokenId = 1n;
    return [...kaMap.keys()].map((rootEntity) => ({
      tokenId: tokenId++,
      rootEntity,
    }));
  }

  /**
   * @deprecated Use {@link skolemizeByEntity}. Kept as a one-release
   * compatibility alias for callers that use the public instance method.
   */
  autoPartition(quads: Quad[]): KAManifestEntry[] {
    return this.skolemizeByEntity(quads);
  }

  skolemize(rootEntity: string, quads: Quad[]): Quad[] {
    return skolemize(rootEntity, quads);
  }

  /**
   * Reconstruct the in-memory sharedMemoryOwnedEntities map from persisted
   * ownership triples in SWM meta graphs. Call on startup.
   *
   * Validates each ownership triple against share-operation metadata
   * (wasAttributedTo) to guard against tampered triples. Conflicts are
   * resolved deterministically by keeping the alphabetically first creator.
   */
  async reconstructSharedMemoryOwnership(): Promise<number> {
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    const SWM_META_SUFFIX = '/_shared_memory_meta';
    const CG_PREFIX = 'did:dkg:context-graph:';
    try {
      const allContextGraphs = await listGraphsByPrefix(this.store, CG_PREFIX);
      let total = 0;

      // Build list of (ownershipKey, swmMetaGraphUri) pairs: root + sub-graph scoped
      const targets: Array<{ ownershipKey: string; swmMetaGraph: string }> = [];
      const targetKeys = new Set<string>();
      const swmMetaGraphs = allContextGraphs
        .filter((graph) => graph.endsWith(SWM_META_SUFFIX))
        .map((graph) => ({
          graph,
          cgPath: graph.slice(CG_PREFIX.length, graph.length - SWM_META_SUFFIX.length),
        }))
        .filter(({ cgPath }) => cgPath.length > 0);
      for (const { graph, cgPath } of swmMetaGraphs) {
        // Derive the ownership key from EXPLICIT registration metadata, not a
        // naive last-slash split. A wallet-scoped root CG id is slash-shaped
        // (`<addr>/<name>`), so its root-level SWM-meta graph
        // (`<addr>/<name>/_shared_memory_meta`) is BYTE-IDENTICAL to the
        // sub-graph SWM-meta graph for root `<addr>`, sub `<name>`
        // (`<addr>/<name>/_shared_memory_meta`). The last-slash split alone
        // cannot tell them apart, and the previous code mis-keyed a slash-shaped
        // root as `<addr>\0<name>` whenever a sub-graph named `<name>` happened
        // to be registered under `<addr>` — splitting that root's ownership from
        // the key the write path (`_shareImpl`, plain `contextGraphId`) used.
        //
        // Resolution order (must reproduce the write-side `ownershipKey`):
        //   1. The FULL cgPath is itself a registered root CG → root SWM,
        //      key = cgPath. Explicit root registration wins the collision; it
        //      matches the wallet-scoped `<addr>/<name>` convention.
        //   2. else last-slash split; the trailing segment is registered as a
        //      sub-graph of the leading part → key = `<root>\0<sub>`.
        //   3. else → root, key = cgPath.
        // Identical to the prior behaviour on every non-colliding input
        // (`42`→root, `42/tasks`→sub, sub-graphs under slash-shaped roots→sub);
        // only the genuine collision now resolves toward the explicit root.
        let ownershipKey = cgPath;
        if (!(await this.isContextGraphRegistered(cgPath))) {
          const slash = cgPath.lastIndexOf('/');
          const rootId = slash > 0 ? cgPath.slice(0, slash) : '';
          const subGraphName = slash > 0 ? cgPath.slice(slash + 1) : '';
          const isRegisteredSubGraph =
            rootId.length > 0 &&
            subGraphName.length > 0 &&
            !subGraphName.includes('/') &&
            await this.isSubGraphRegistered(rootId, subGraphName);
          if (isRegisteredSubGraph) {
            ownershipKey = `${rootId}\0${subGraphName}`;
          }
        }
        if (targetKeys.has(ownershipKey)) continue;
        targetKeys.add(ownershipKey);
        targets.push({ ownershipKey, swmMetaGraph: graph });
      }

      for (const { ownershipKey, swmMetaGraph } of targets) {
        total += await this.reconstructOwnershipFromGraph(ownershipKey, swmMetaGraph, DKG, PROV);
      }
      return total;
    } catch (err) {
      this.log.warn(
        createOperationContext('reconstruct'),
        `reconstructSharedMemoryOwnership failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private async reconstructOwnershipFromGraph(
    ownershipKey: string, swmMetaGraph: string, DKG: string, PROV: string,
  ): Promise<number> {
    const durableOwners = await this.loadValidatedSharedMemoryOwners(
      swmMetaGraph,
      DKG,
      PROV,
      undefined,
      'reconstruct',
    );
    if (durableOwners.size === 0) return 0;

    if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
      this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
    }
    const ownedMap = this.sharedMemoryOwnedEntities.get(ownershipKey)!;
    let count = 0;
    for (const [entity, creator] of durableOwners) {
      if (ownedMap.has(entity)) {
        const existing = ownedMap.get(entity)!;
        if (existing !== creator) {
          this.log.warn(
            createOperationContext('reconstruct'),
            `Conflicting ownership for ${entity}: "${existing}" vs "${creator}"; keeping alphabetically first`,
          );
          setEffectiveOwner(ownedMap, entity, creator);
        }
        continue;
      }

      ownedMap.set(entity, creator);
      count++;
    }
    return count;
  }

  private async loadValidatedSharedMemoryOwners(
    swmMetaGraph: string,
    DKG: string,
    PROV: string,
    rootEntities: readonly string[] | undefined,
    logOperation: 'reconstruct' | 'share',
  ): Promise<Map<string, string>> {
    const valuesClause = rootEntities?.length
      ? `VALUES ?entity { ${rootEntities.map((root) => `<${assertSafeIri(root)}>`).join(' ')} }`
      : '';

    const ownershipResult = await this.store.query(
      `SELECT DISTINCT ?entity ?creator WHERE {
        GRAPH <${assertSafeIri(swmMetaGraph)}> {
          ${valuesClause}
          ?entity <${DKG}workspaceOwner> ?creator .
        }
      }`,
    );
    if (ownershipResult.type !== 'bindings' || ownershipResult.bindings.length === 0) {
      return new Map();
    }

    // GH #748: prefer the dedicated `dkg:publisherPeerId` literal; fall
    // back to a literal-form `prov:wasAttributedTo` for legacy un-migrated
    // rows. Skip post-fix URI attribution — `workspaceOwner` (queried
    // above) is always a peer-ID literal, so a URI `?creator` from
    // `wasAttributedTo` would never match and every ownership row would
    // be rejected as unvalidated. `FILTER(BOUND(?creator))` guards against
    // an op having `rootEntity` but neither peer-ID source.
    const operationResult = await this.store.query(
      `SELECT DISTINCT ?entity ?creator WHERE {
        GRAPH <${assertSafeIri(swmMetaGraph)}> {
          ${valuesClause}
          ?op <${DKG}rootEntity> ?entity .
          OPTIONAL { ?op <${DKG}publisherPeerId> ?pidField }
          OPTIONAL { ?op <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
          BIND(COALESCE(?pidField, ?attrField) AS ?creator)
          FILTER(BOUND(?creator))
        }
      }`,
    );

    const validatedOwners = new Map<string, Set<string>>();
    if (operationResult.type === 'bindings') {
      for (const row of operationResult.bindings) {
        const entity = row['entity'];
        const creator = stripSparqlLiteral(row['creator']);
        if (!entity || !creator) continue;
        addOwner(validatedOwners, entity, creator);
      }
    }

    const durableOwners = new Map<string, string>();
    for (const row of ownershipResult.bindings) {
      const entity = row['entity'];
      const creator = stripSparqlLiteral(row['creator']);
      if (!entity || !creator) continue;
      const validPeers = validatedOwners.get(entity);
      if (!validPeers?.has(creator)) {
        this.log.warn(
          createOperationContext(logOperation),
          `Skipping unvalidated ownership: entity=${entity} creator=${creator}`,
        );
        continue;
      }

      const existing = durableOwners.get(entity);
      if (existing && existing !== creator) {
        this.log.warn(
          createOperationContext(logOperation),
          `Conflicting ownership for ${entity}: "${existing}" vs "${creator}"; keeping alphabetically first`,
        );
      }
      setEffectiveOwner(durableOwners, entity, creator);
    }

    return durableOwners;
  }

  private async sharedMemoryOwnersForPromotion(
    contextGraphId: string,
    subGraphName: string | undefined,
    ownershipKey: string,
    rootEntities: readonly string[],
  ): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    const liveOwned = this.sharedMemoryOwnedEntities.get(ownershipKey);
    if (liveOwned) {
      for (const [root, owner] of liveOwned) {
        setEffectiveOwner(owners, root, owner);
      }
    }

    if (rootEntities.length === 0) return owners;

    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);
    const durableOwners = await this.loadValidatedSharedMemoryOwners(
      swmMetaGraph,
      DKG,
      PROV,
      rootEntities,
      'share',
    );
    if (durableOwners.size === 0) return owners;

    if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
      this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
    }
    const hydratedOwned = this.sharedMemoryOwnedEntities.get(ownershipKey)!;

    for (const [entity, creator] of durableOwners) {
      setEffectiveOwner(owners, entity, creator);
      setEffectiveOwner(hydratedOwned, entity, creator);
    }

    return owners;
  }

  /** @deprecated Use reconstructSharedMemoryOwnership */
  async reconstructWorkspaceOwnership(): Promise<number> {
    return this.reconstructSharedMemoryOwnership();
  }

  /**
   * One-shot startup migration for GH #748: rewrite SWM
   * `prov:wasAttributedTo` from peer-ID string literals to agent DID
   * URIs (`<did:dkg:agent:0x…>`). Idempotent — each CG carries a
   * `<urn:dkg:migration:swm-attr-agent-did> dkg:appliedAt "<ts>"`
   * marker in `_meta` after a successful pass; subsequent boots skip
   * marked CGs. Best-effort: rows whose peer ID can't be resolved
   * against the AGENTS system graph are left in place.
   */
  async migrateSwmAttributionToAgentDid(): Promise<{ rewritten: number; skipped: number; swmMetaGraphs: number }> {
    // GH #748 Codex round 3: the AGENTS registry vocabulary is the spec-aligned
    // `https://dkg.network/ontology#` namespace (see `buildAgentProfile` and
    // `discovery.ts:findAgentByPeerId`), distinct from the internal
    // `http://dkg.io/ontology/` namespace used by SWM meta predicates
    // (`dkg:rootEntity`, `dkg:publisherPeerId`, `dkg:workspaceOwner`, etc.).
    // The migration touches both: SWM meta predicates use DKG_INTERNAL; the
    // AGENTS registry lookup uses DKG_REGISTRY. Confirmed against live data:
    // a real node's `did:dkg:context-graph:agents` graph carries
    // `https://dkg.network/ontology#peerId`, not `http://dkg.io/ontology/peerId`.
    const DKG = 'http://dkg.io/ontology/';
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const SWM_META_SUFFIX = '/_shared_memory_meta';
    const CG_PREFIX = 'did:dkg:context-graph:';
    const MIGRATION_MARKER_SUBJECT = 'urn:dkg:migration:swm-attr-agent-did';
    // Use the canonical AGENTS system-graph URI helper rather than hardcoding;
    // `contextGraphDataGraphUri('agents')` yields `did:dkg:context-graph:agents`
    // (no `/_data` suffix), which is where `registerAgent()` actually writes.
    const AGENTS_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const ctx = createOperationContext('migrate-swm-attr');

    let totalRewritten = 0;
    let totalSkipped = 0;
    // GH #748 Codex round 7: counts SWM-meta graphs processed (root + any
    // sub-graph-scoped ones), not distinct context graphs — the migration
    // operates per SWM-meta graph after the round-6 enumeration fix. Field
    // name kept honest so the startup log doesn't over-report "CG(s)".
    let swmMetaGraphsProcessed = 0;

    try {
      const peerToAddress = new Map<string, string | null>();
      const allGraphs = await listGraphsByPrefix(this.store, CG_PREFIX);
      // GH #748 Codex round 6 (user report): enumerate `_shared_memory_meta`
      // graphs directly from the store's context-graph prefix. The earlier approach used
      // `graphManager.listContextGraphs()`, but that helper filters out CG
      // IDs containing a slash (storage/graph-manager.ts:104) to dedupe
      // sub-graph paths — which also excludes legitimate curated CGs of the
      // `<addr>/<slug>` shape (the on-chain-anchored ones a user is NOT the
      // curator of). On a real node, that meant the migration silently
      // skipped every curated CG and only touched bare-slug shadows.
      // Iterating the SWM-meta graphs directly catches both forms (curated
      // root + sub-graph-scoped) naturally — each graph is processed once,
      // marker stored adjacent at `<...>/_meta`.
      const swmMetaGraphs = allGraphs.filter(
        g => g.startsWith(CG_PREFIX) && g.endsWith(SWM_META_SUFFIX),
      );

      for (const swmMetaGraph of swmMetaGraphs) {
        // Defensive: skip system graphs even though they shouldn't carry SWM.
        const cgPath = swmMetaGraph.slice(CG_PREFIX.length, swmMetaGraph.length - SWM_META_SUFFIX.length);
        if (cgPath === 'agents' || cgPath === 'ontology') continue;

        // Derive marker graph by swapping the suffix — works for root CG
        // and sub-graph-scoped SWMs alike. Marker lives in the adjacent
        // `_meta` graph so a SWM graph wipe doesn't accidentally re-arm
        // the migration.
        const markerGraph = `${CG_PREFIX}${cgPath}/_meta`;

        const markerResult = await this.store.query(
          `SELECT ?ts WHERE { GRAPH <${markerGraph}> { <${MIGRATION_MARKER_SUBJECT}> <${DKG}appliedAt> ?ts } } LIMIT 1`,
        );
        const markerPresent =
          markerResult.type === 'bindings' && markerResult.bindings.length > 0;

        // GH #748 (user-reported regression): the round-1 → round-6 delete
        // logic used `store.delete([{ object: literalString }])` which
        // silently no-op'd against `xsd:string`-typed literals on a
        // persistent oxigraph store — the URI insert succeeded but the
        // literal stayed. Affected stores end up with BOTH forms for the
        // same subject. If a marker is present BUT subjects exist with
        // BOTH a literal AND a URI `wasAttributedTo`, the previous pass
        // was broken — override the marker so we re-process and clean up.
        // Only this exact broken state triggers re-run; legitimate
        // remaining literals (e.g. `"unknown"` permanent placeholders) do
        // not, because they don't also have a URI counterpart.
        if (markerPresent) {
          const staleCheck = await this.store.query(
            `ASK { GRAPH <${swmMetaGraph}> {
              ?s <${PROV}wasAttributedTo> ?lit . FILTER(isLiteral(?lit))
              ?s <${PROV}wasAttributedTo> ?uri . FILTER(isURI(?uri))
            } }`,
          );
          const hasBrokenDuplicates = staleCheck.type === 'boolean' && staleCheck.value;
          if (!hasBrokenDuplicates) continue;
          // Drop the stale marker so we record a fresh `appliedAt`
          // timestamp when the (now-fixed) pass completes.
          await this.store.deleteByPattern({
            graph: markerGraph,
            subject: MIGRATION_MARKER_SUBJECT,
            predicate: `${DKG}appliedAt`,
          });
        }

        let swmRewritten = 0;
        // GH #748 Codex round 4: track retriable vs permanent skips
        // separately. Marker-block decision uses retriable only — permanent
        // misses (sentinel `"unknown"`, empty string) can never be resolved,
        // so they must not keep the migration hot on every boot.
        let swmRetriableSkipped = 0;
        let swmPermanentSkipped = 0;

        const sparql = `SELECT ?s ?o WHERE { GRAPH <${swmMetaGraph}> { ?s <${PROV}wasAttributedTo> ?o . FILTER(isLiteral(?o)) } }`;
        const result = await this.store.query(sparql);
        if (result.type === 'bindings') {
          for (const row of result.bindings) {
            const subject = row['s'];
            const objectLit = row['o'];
            if (!subject || !objectLit) continue;

            const peerId = objectLit.startsWith('"')
              ? objectLit.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
              : objectLit;
            // Permanent skip: the literal sentinel `"unknown"` (legacy
            // `generateKCMetadata` placeholder when peer ID wasn't supplied)
            // or empty — neither can ever resolve to an agent address.
            if (!peerId || peerId === 'unknown') {
              swmPermanentSkipped++;
              continue;
            }

            let address: string | null;
            if (peerToAddress.has(peerId)) {
              address = peerToAddress.get(peerId)!;
            } else {
              address = await this.resolveAgentAddressForPeer(peerId, AGENTS_GRAPH, DKG_REGISTRY, RDF);
              peerToAddress.set(peerId, address);
            }

            if (!address) {
              // Retriable: AGENTS record might sync on a future boot.
              swmRetriableSkipped++;
              continue;
            }

            // Backward-compat: per-root snapshot rows historically stored the
            // peer ID only via `wasAttributedTo`. If this subject has no
            // `dkg:publisherPeerId` quad yet, materialise one from the literal
            // we're about to rewrite — otherwise the post-fix readers (which
            // now query `dkg:publisherPeerId` rather than `wasAttributedTo`)
            // would lose the peer ID entirely for migrated rows.
            const hasPeerIdField = await this.store.query(
              `ASK { GRAPH <${swmMetaGraph}> { <${subject}> <${DKG}publisherPeerId> ?x } }`,
            );
            const peerIdFieldPresent =
              hasPeerIdField.type === 'boolean' ? hasPeerIdField.value : false;
            if (!peerIdFieldPresent) {
              await this.store.insert([{
                subject,
                predicate: `${DKG}publisherPeerId`,
                object: objectLit,
                graph: swmMetaGraph,
              }]);
            }

            // GH #748 (user-reported regression): use `deleteByPattern` rather
            // than `store.delete([{ object: literalString }])`. Exact-match
            // delete silently no-op'd against `xsd:string`-typed literals on
            // a persistent oxigraph store — the literal stayed alongside the
            // newly-inserted URI, leaving the legend with duplicate
            // peer-ID + agent-DID attribution for every migrated row.
            // Pattern-based delete is form-agnostic; safe to wipe all
            // wasAttributedTo for this subject because writers only ever
            // emit one (we're about to insert the canonical URI).
            await this.store.deleteByPattern({
              graph: swmMetaGraph,
              subject,
              predicate: `${PROV}wasAttributedTo`,
            });
            await this.store.insert([{
              subject,
              predicate: `${PROV}wasAttributedTo`,
              object: `did:dkg:agent:${address}`,
              graph: swmMetaGraph,
            }]);
            swmRewritten++;
          }
        }

        // GH #748 Codex rounds 2 + 4: write the marker when there are no
        // RETRIABLE misses left. Permanent placeholders (sentinel
        // `"unknown"`) are never resolvable, so blocking the marker on them
        // would keep the migration hot on every boot forever. Retriable
        // misses (AGENTS record not yet synced) still suppress the marker so
        // future boots retry. The re-run cost is bounded by the residual
        // literal count — already-rewritten rows fail the `isLiteral(?o)`
        // filter and contribute zero work.
        if (swmRetriableSkipped === 0) {
          await this.store.insert([{
            subject: MIGRATION_MARKER_SUBJECT,
            predicate: `${DKG}appliedAt`,
            object: `"${new Date().toISOString()}"^^<${XSD}dateTime>`,
            graph: markerGraph,
          }]);
        }

        const swmSkipped = swmRetriableSkipped + swmPermanentSkipped;
        totalRewritten += swmRewritten;
        totalSkipped += swmSkipped;
        swmMetaGraphsProcessed++;

        if (swmRewritten > 0 || swmSkipped > 0) {
          const retryNote = swmRetriableSkipped > 0
            ? ` (${swmRetriableSkipped} will retry on next boot, ${swmPermanentSkipped} permanent placeholders)`
            : swmPermanentSkipped > 0
              ? ` (${swmPermanentSkipped} permanent placeholders)`
              : '';
          this.log.info(
            ctx,
            `SWM ${cgPath}: rewrote ${swmRewritten} attribution literal(s) to agent DID, left ${swmSkipped} unresolved${retryNote}`,
          );
        }
      }

      return { rewritten: totalRewritten, skipped: totalSkipped, swmMetaGraphs: swmMetaGraphsProcessed };
    } catch (err) {
      this.log.warn(
        ctx,
        `migrateSwmAttributionToAgentDid failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { rewritten: totalRewritten, skipped: totalSkipped, swmMetaGraphs: swmMetaGraphsProcessed };
    }
  }

  private async resolveAgentAddressForPeer(
    peerId: string, agentsGraph: string, dkgRegistry: string, RDF: string,
  ): Promise<string | null> {
    // SPARQL string-literal escape: only `"` and `\` are special inside `"..."`.
    const escaped = peerId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // GH #748 Codex rounds 2, 3, 5: resolve the agent address for a peer ID.
    // - Round 3: vocabulary is `https://dkg.network/ontology#` (the registry
    //   namespace `buildAgentProfile` writes), NOT the internal
    //   `http://dkg.io/ontology/` one — the latter matches zero rows.
    // - Round 2: a libp2p PeerId can be shared across multiple registered
    //   agents on the same node (multi-agent-per-node via
    //   `DKGAgent.registerAgent`). Reject genuine cross-agent ambiguity.
    // - Round 5: an upgraded store can legitimately have multiple AGENTS
    //   records for the SAME agent — e.g. the legacy
    //   `did:dkg:agent:<peerId>` subject (profile.ts fallback) plus the
    //   canonical `did:dkg:agent:<address>` subject. Prefer the explicit
    //   `dkg:agentAddress` literal as the source of truth, and dedup by
    //   normalised address before deciding the mapping is ambiguous.
    // - The fallback subject-URI parse handles records that pre-date the
    //   `dkg:agentAddress` field and still encode the address only in the
    //   subject (`did:dkg:agent:0x<40hex>`).
    const sparql = `SELECT ?agent ?addr WHERE {
      GRAPH <${agentsGraph}> {
        ?agent <${RDF}type> <${dkgRegistry}Agent> ;
               <${dkgRegistry}peerId> "${escaped}" .
        OPTIONAL { ?agent <${dkgRegistry}agentAddress> ?addr }
      }
    }`;
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;

    const addresses = new Set<string>();
    for (const row of result.bindings) {
      const explicit = row['addr'];
      if (explicit) {
        // `dkg:agentAddress` is a literal — strip surrounding quotes.
        const raw = explicit.startsWith('"')
          ? explicit.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
          : explicit;
        if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
          addresses.add(raw.toLowerCase());
          continue;
        }
      }
      // Fallback: parse the subject URI for records without an explicit
      // `agentAddress` field. Only accept the canonical wallet-DID shape
      // — a legacy `did:dkg:agent:<peerId>` subject is NOT an address and
      // contributes nothing useful here.
      const agentUri = row['agent'];
      if (agentUri && agentUri.startsWith('did:dkg:agent:')) {
        const tail = agentUri.slice('did:dkg:agent:'.length);
        if (/^0x[0-9a-fA-F]{40}$/.test(tail)) {
          addresses.add(tail.toLowerCase());
        }
      }
    }

    // 0 distinct addresses → no resolvable mapping.
    // 1 → unambiguous: same agent (possibly across multiple profile records).
    // 2+ → genuinely multiple agents on this peer; refuse to mis-attribute.
    if (addresses.size !== 1) return null;
    return [...addresses][0];
  }

  /**
   * Issue #864 — guard the silent "Promoted 0 triples" path.
   *
   * Called from `assertionPromote` whenever the CONSTRUCT against the
   * assertion's data graph returns zero quads. Inspects the CG's `_meta`
   * graph for the two markers `routes/assertion.ts` stamps when an
   * `import-file` request finishes a structural extraction:
   *   <assertionGraph> dkg:extractionStatus "completed"
   *   <assertionGraph> dkg:structuralTripleCount "<n>"^^xsd:integer
   *
   * If BOTH are present AND the count is positive, the graph SHOULD hold
   * content — the inconsistency is a real failure, not a no-op. Throws
   * `AssertionNotPersistedError` so the daemon route can translate it to
   * a 409 with a structured body. In every other case (no markers at
   * all, status not "completed", count is zero) this is a legitimate
   * empty promote: return silently and let the caller fall through to
   * the existing `{ promotedCount: 0 }` return.
   *
   * Read-only, single SELECT — does not mutate state.
   */
  private async assertAssertionDataPersisted(
    contextGraphId: string,
    assertionGraph: string,
  ): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?status ?count ?layer ?urnLayer WHERE {
         GRAPH <${metaGraph}> {
           OPTIONAL { <${assertionGraph}> <${DKG}extractionStatus> ?status }
           OPTIONAL { <${assertionGraph}> <${DKG}structuralTripleCount> ?count }
           OPTIONAL { <${assertionGraph}> <${DKG}memoryLayer> ?layer }
           # The memoryLayer marker is canonically on the lifecycle URN
           # (assertionLifecycleUri), reachable via the dkg:assertionGraph
           # back-link. File-imported assertions carry it ONLY there, not on
           # the data-graph URI, so read it too — otherwise the "already
           # promoted (SWM/VM) -> harmless no-op" check below cannot see their
           # layer and a re-promote misfires AssertionNotPersistedError.
           OPTIONAL { ?lc <${DKG}assertionGraph> <${assertionGraph}> ; <${DKG}memoryLayer> ?urnLayer }
         }
       } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return;
    const row = result.bindings[0];
    const statusRaw = row?.['status'];
    const countRaw = row?.['count'];
    const layerRaw = row?.['layer'] ?? row?.['urnLayer'];
    // Codex review on #898 — the previous version raised
    // `AssertionNotPersistedError` whenever `extractionStatus="completed"`
    // + a positive `structuralTripleCount` were stamped, even after a
    // successful promote. `assertionPromote` empties the assertion data
    // graph as part of the WM → SWM transition (line ~4260) but
    // intentionally leaves those two extraction markers behind in
    // `_meta` for audit purposes. The lifecycle marker that DOES move
    // is `dkg:memoryLayer`, set to `"WM"` by `assertionCreate` and
    // flipped to `"SWM"` by `assertionPromote` (line ~4270). A retry /
    // stale double-click then hits this guard with `layer="SWM"` and
    // must be treated as a harmless no-op rather than misclassified as
    // ASSERTION_NOT_PERSISTED.
    //
    // Adversarial review F4: the publish-time SWM→VM flip
    // (dkg-agent-publish.ts) UPDATES the WM-graph marker to `"VM"` (it
    // briefly deleted it, which would have erased this witness). Any
    // non-"WM" value — "SWM" (post-promote), "VM" (post-publish), or a
    // legacy old-store value — is the read-both no-op path here; only a
    // literal "WM" falls through to the persistence check.
    if (typeof layerRaw === 'string') {
      const layerValue = stripSparqlLiteral(layerRaw);
      if (layerValue !== 'WM') return;
    }
    if (typeof statusRaw !== 'string' || typeof countRaw !== 'string') return;
    const statusValue = stripSparqlLiteral(statusRaw);
    if (statusValue !== 'completed') return;
    const expected = parseCountLiteral(countRaw);
    if (!Number.isFinite(expected) || expected <= 0) return;
    throw new AssertionNotPersistedError({
      contextGraphId,
      assertionGraph,
      expectedTripleCount: expected,
    });
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const result = await this.store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${metaGraph}> { ?op ${ENTITY_PRED_ALT} <${rootEntity}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;

      await this.store.delete([
        { subject: op, predicate: DKG_ROOT_ENTITY_LEGACY, object: rootEntity, graph: metaGraph },
        { subject: op, predicate: DKG_ENTITY, object: rootEntity, graph: metaGraph },
      ]);

      const remaining = await this.store.query(
        `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> ${ENTITY_PRED_ALT} ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = parseCountLiteral(rawCount);
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }

  /**
   * #1116 — read an assertion's member root entities from the lifecycle URN,
   * independent of any seal. `generateAssertionPromotedMetadata` stamps these
   * (predicate dkg:rootEntity / dkg:entity) on EVERY promote — sealed or not —
   * so this is the seal-independent source `pull-from swm` uses to reconstruct
   * a WM draft for an asset that was shared unsealed (seal-in-SWM / recovery).
   */
  private async readPromotedRootEntities(
    contextGraphId: string,
    agentAddress: string,
    name: string,
    subGraphName?: string,
  ): Promise<string[]> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const res = await this.store.query(
      `SELECT DISTINCT ?root WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> ${ENTITY_PRED_ALT} ?root } }`,
    );
    if (res.type !== 'bindings') return [];
    const roots: string[] = [];
    for (const row of res.bindings) {
      const root = row['root'];
      if (typeof root === 'string' && root.length > 0) roots.push(root);
    }
    return roots;
  }

  /**
   * #1116 (review A1) — SWM-share-complete marker.
   *
   * A FULL share (entities:"all", all roots actually landed in SWM) stamps a
   * single boolean marker on the lifecycle URN. `finalize(layer:"swm")` gates
   * on it so a SUBSET share — which also stamps `dkg:rootEntity` member rows,
   * the source `readPromotedRootEntities` reads — can NOT be sealed-in-SWM and
   * published as a partial asset under the KA name. Subset shares are SWM-only,
   * never publishable; only a complete full share sets this marker, and a later
   * subset / reduced-scope share CLEARS it (`clearSwmShareComplete`), so the marker
   * always reflects whether the CURRENT shared state is a complete full share.
   * Modelled on `readPromotedRootEntities` /
   * `_stampSwmPointer`: same meta graph (`contextGraphMetaUri(cg)`) and subject
   * (`assertionLifecycleUri(...)`).
   */
  async markSwmShareComplete(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => this.markSwmShareCompleteUnlocked(contextGraphId, name, agentAddress, subGraphName),
    );
  }

  private async markSwmShareCompleteUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    // Idempotent: drop any prior marker first, then insert exactly one.
    await this.store.deleteByPattern({
      graph: metaGraph,
      subject: lifecycleUri,
      predicate: SWM_SHARE_COMPLETE_PRED,
    });
    await this.store.insert([{
      subject: lifecycleUri,
      predicate: SWM_SHARE_COMPLETE_PRED,
      object: '"true"',
      graph: metaGraph,
    }]);
  }

  /**
   * #1116 (review A1, round 5) — CLEAR the SWM-share-complete marker.
   *
   * `markSwmShareComplete` only ever SET the marker (so a benign full-share
   * recreate-retry never lost it), but that left two holes: a marked
   * full-share that was later DISCARDED, or RE-shared as a strict SUBSET, kept
   * a stale marker — letting `finalize(layer:"swm")` (and the seal-less
   * pull-from source) publish a partial asset under the KA name. We now clear
   * the marker at exactly the two moments scope is genuinely reduced: on
   * `assertionDiscard`, and on a subset share (promote's non-full branch). It
   * survives a full-share recreate-retry because A2_PRESERVE re-arms it and the
   * full-share path re-stamps it — it is only cleared when scope actually drops.
   */
  async clearSwmShareComplete(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => this.clearSwmShareCompleteUnlocked(contextGraphId, name, agentAddress, subGraphName),
    );
  }

  private async clearSwmShareCompleteUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    await this.store.deleteByPattern({
      graph: metaGraph,
      subject: lifecycleUri,
      predicate: SWM_SHARE_COMPLETE_PRED,
    });
  }

  /** #1116 (review A1) — ASK whether the SWM-share-complete marker is present. */
  async hasSwmShareComplete(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<boolean> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const res = await this.store.query(
      `ASK { GRAPH <${metaGraph}> { <${lifecycleUri}> <${SWM_SHARE_COMPLETE_PRED}> ?o } }`,
    );
    return res.type === 'boolean' && res.value;
  }

  /**
   * #1116 (round 7) — delete the assertion SEAL (all ASSERTION_SEAL_PREDICATES)
   * for this KA, under BOTH the name-keyed assertion URI and the numbered WM
   * graph URI (the seal lives under one or the other, pre/post-mint). The seal
   * lives on a DIFFERENT subject than the lifecycle URN, so the create/discard
   * clean-slates that key on the lifecycle URN don't reach it.
   *
   * Caller: `assertionDiscard`, when neither durable VM state nor an exact
   * graph-scoped SWM head still needs a recovery commitment.
   *
   * NOTE (#1116 round 8+): finalize(layer="swm") does NOT pre-clear the seal.
   * The SWM pull resolves scope from the marker-gated promoted member rows —
   * never `seal.rootEntities`. Pull-from archives the last finalized seal under
   * a recovery-only subject before clearing the active draft seal, so editing is
   * still enabled without letting a crash or discard strand durable SWM/VM data.
   */
  async clearAssertionSeal(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      async () => {
        await this.assertNoUnfinishedAssertionPromote(
          contextGraphId,
          name,
          agentAddress,
          subGraphName,
        );
        await this.clearAssertionSealUnlocked(contextGraphId, name, agentAddress, subGraphName);
      },
    );
  }

  private async clearAssertionSealUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    await this.clearActiveAssertionSeal(contextGraphId, name, agentAddress, subGraphName);
    const recoveryGraph = this.assertionRecoverySealGraph(contextGraphId, subGraphName);
    const recoverySubject = this.assertionRecoverySealSubject(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    for (const predicate of Object.values(ASSERTION_SEAL_PREDICATES)) {
      await this.store.deleteByPattern({ graph: recoveryGraph, subject: recoverySubject, predicate });
    }
  }

  private assertionRecoverySealGraph(
    contextGraphId: string,
    subGraphName?: string,
  ): string {
    return subGraphName
      ? contextGraphSubGraphPrivateUri(contextGraphId, subGraphName)
      : contextGraphPrivateUri(contextGraphId);
  }

  private assertionRecoverySealSubject(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): string {
    return `${contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    )}/_recovery_seal`;
  }

  private async activeAssertionSealSubjects(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<string[]> {
    const nameKeyed = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    const currentWmGraph = await this.wmGraphUri(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    return [...new Set([nameKeyed, currentWmGraph])];
  }

  private async clearActiveAssertionSeal(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    for (const subject of await this.activeAssertionSealSubjects(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    )) {
      for (const predicate of Object.values(ASSERTION_SEAL_PREDICATES)) {
        await this.store.deleteByPattern({ graph: metaGraph, subject, predicate });
      }
    }
  }

  /**
   * Discard may run while a confirmed VM version and a newly-finalized draft
   * coexist. Retain an active seal only when it is the seal for that confirmed
   * VM head; every other active seal belongs to the draft being discarded.
   * Recovery seals live in the private partition and are deliberately untouched.
   */
  private async clearActiveAssertionSealsNotMatchingMerkle(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    confirmedVmMerkleHex: string,
    subGraphName?: string,
  ): Promise<void> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const expected = confirmedVmMerkleHex.replace(/^0x/i, '').toLowerCase();
    for (const subject of await this.activeAssertionSealSubjects(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    )) {
      const result = await this.store.query(
        `CONSTRUCT { <${subject}> ?p ?o } WHERE {
          GRAPH <${metaGraph}> { <${subject}> ?p ?o }
        }`,
      );
      const quads = result.type === 'quads' ? result.quads : [];
      let matchesConfirmedVm = false;
      try {
        const seal = parseAssertionSealQuads(quads, subject);
        matchesConfirmedVm = seal !== undefined
          && ethers.hexlify(seal.merkleRoot).slice(2).toLowerCase() === expected;
      } catch {
        // A torn or mixed active seal cannot describe the confirmed VM head and
        // must not outrank the complete recovery archive on the next pull.
      }
      if (matchesConfirmedVm) continue;
      for (const predicate of Object.values(ASSERTION_SEAL_PREDICATES)) {
        await this.store.deleteByPattern({ graph: metaGraph, subject, predicate });
      }
    }
  }

  private async loadAssertionSeals(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<Array<{ seal: AssertionSeal; subject: string; quads: Quad[] }>> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const recoveryGraph = this.assertionRecoverySealGraph(contextGraphId, subGraphName);
    const recoverySubject = this.assertionRecoverySealSubject(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    const candidates: Array<{ subject: string; graph: string }> = [
      ...(await this.activeAssertionSealSubjects(contextGraphId, name, agentAddress, subGraphName))
        .map((subject) => ({ subject, graph: metaGraph })),
      { subject: recoverySubject, graph: recoveryGraph },
    ];
    const loaded: Array<{ seal: AssertionSeal; subject: string; quads: Quad[] }> = [];
    const seen = new Set<string>();
    for (const { subject, graph } of candidates) {
      const key = `${graph}\0${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await this.store.query(
        `CONSTRUCT { <${subject}> ?p ?o } WHERE {
          GRAPH <${graph}> { <${subject}> ?p ?o }
        }`,
      );
      const quads = result.type === 'quads' ? result.quads : [];
      try {
        const seal = parseAssertionSealQuads(quads, subject);
        if (seal) loaded.push({ seal, subject, quads });
      } catch {
        // A complete recovery archive may coexist with a torn active-seal
        // deletion after a crash. Ignore only the unusable candidate; the
        // source payload is still verified against whichever complete seal wins.
      }
    }
    return loaded;
  }

  /** Copy a verified active seal to a recovery-only subject before unlocking WM. */
  private async archiveAssertionSeal(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    loaded: { seal: AssertionSeal; subject: string; quads: Quad[] },
    subGraphName?: string,
  ): Promise<Quad[]> {
    const recoveryGraph = this.assertionRecoverySealGraph(contextGraphId, subGraphName);
    const recoverySubject = this.assertionRecoverySealSubject(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    const sealPredicates = new Set<string>(Object.values(ASSERTION_SEAL_PREDICATES));
    const recoveryQuads = loaded.quads
      .filter((quad) => sealPredicates.has(quad.predicate))
      .map((quad) => ({ ...quad, subject: recoverySubject, graph: recoveryGraph }));
    if (loaded.subject !== recoverySubject) {
      for (const predicate of sealPredicates) {
        await this.store.deleteByPattern({ graph: recoveryGraph, subject: recoverySubject, predicate });
      }
      await this.store.insert(recoveryQuads);
    }
    return recoveryQuads;
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  private static validateOptionalSubGraph(subGraphName: string | undefined): void {
    if (subGraphName !== undefined) {
      const v = validateSubGraphName(subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name: ${v.reason}`);
    }
  }

  private async isSubGraphRegistered(contextGraphId: string, subGraphName: string): Promise<boolean> {
    const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
    const registered = await this.store.query(
      `ASK { GRAPH <did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta> {
        <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
          <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
          <http://dkg.io/ontology/createdBy> ?createdBy .
      } }`,
    );
    return registered.type === 'boolean' && registered.value;
  }

  /**
   * Is `contextGraphId` declared as a ROOT context graph in local storage?
   *
   * Reads the explicit registration triple `<did:dkg:context-graph:<id>> a
   * dkg:ContextGraph`, which `createContextGraph` writes into the CG's own
   * `_meta` graph (curated/private CGs) or the ONTOLOGY data graph (public CGs)
   * — so the ASK is intentionally cross-graph (`GRAPH ?g`) to find it in either
   * place. The subject-URI shape (`did:dkg:context-graph:<id>`) is identical for
   * a root and a sub-graph, so the `dkg:ContextGraph` rdf:type is the ONLY thing
   * that distinguishes a registered root from a registered sub-graph. Used by
   * `reconstructSharedMemoryOwnership` to disambiguate a slash-shaped root CG id
   * (`<addr>/<name>`) from a `<root>/<sub-graph>` SWM-meta graph.
   */
  private async isContextGraphRegistered(contextGraphId: string): Promise<boolean> {
    const cgUri = contextGraphDataUri(contextGraphId);
    // SECURITY (Codex #1171): registration's `<cgUri> a dkg:ContextGraph` triple is
    // written ONLY into the system ONTOLOGY data graph (public CGs + every publish)
    // or the CG's own `_meta` graph (curated CGs) — see createContextGraph `defGraph`
    // (= isCurated ? cgMeta : ontology) and the publish ontology emitter. It is NEVER
    // written into a user-authored data/sub-graph. The previous cross-graph
    // `ASK { GRAPH ?g … }` matched ANY graph, so a publisher could author
    // `<cgUri> a dkg:ContextGraph` in their own content graph (the rdf:type OBJECT is
    // not a reserved IRI) and SPOOF registration — making reconstructSharedMemoryOwnership
    // treat a sub-graph as a registered root and derive the wrong ownership key after
    // restart. Scope the ASK to exactly the two authoritative graphs.
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const registered = await this.store.query(
      `ASK {
        { GRAPH <${assertSafeIri(ontologyGraph)}> { <${assertSafeIri(cgUri)}> a <http://dkg.io/ontology/ContextGraph> . } }
        UNION
        { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(cgUri)}> a <http://dkg.io/ontology/ContextGraph> . } }
      }`,
    );
    return registered.type === 'boolean' && registered.value;
  }

  /**
   * Throws if `subGraphName` is provided but not registered in the CG's `_meta` graph.
   * Mirrors the registration check in `publish()` for mutation paths that would
   * otherwise create new orphaned sub-graph state.
   */
  private async ensureSubGraphRegistered(
    contextGraphId: string,
    subGraphName: string | undefined,
  ): Promise<void> {
    if (subGraphName === undefined) return;
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    if (!(await this.isSubGraphRegistered(contextGraphId, subGraphName))) {
      throw new Error(
        `Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}". ` +
        `Register it first via DKGAgent.createSubGraph() or by inserting the sub-graph registration into the context graph "_meta" graph.`,
      );
    }
  }

  clearSubGraphOwnership(ownershipKey: string): void {
    this.sharedMemoryOwnedEntities.delete(ownershipKey);
    this.ownedEntities.delete(ownershipKey);
    this.privateStore.clearCache(ownershipKey);
  }

  /** Resolve the canonical graph suffix from reservedUal, with legacy fallback. */
  private async resolveKaGraphIdentity(
    contextGraphId: string,
    agentAddress: string,
    name: string,
    subGraphName?: string,
  ): Promise<{ agentAddress: string; number: bigint; kaUal?: string } | null> {
    const urn = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const res = await this.store.query(
      `SELECT ?n ?u WHERE { GRAPH <${metaGraph}> {
        <${urn}> <http://dkg.io/ontology/kaId> ?n .
        OPTIONAL { <${urn}> <http://dkg.io/ontology/reservedUal> ?u }
      } } LIMIT 1`,
    );
    if (res.type === 'bindings' && res.bindings.length > 0) {
      const m = res.bindings[0]['n']?.match(/(\d+)/);
      if (!m) return null;
      const number = BigInt(m[1]);
      const rawUal = res.bindings[0]['u']
        ?.replace(/^"/, '')
        .replace(/"(\^\^<[^>]+>)?$/, '')
        .trim();
      if (rawUal) {
        try {
          const scope = createGraphKnowledgeAssetScope(rawUal, 1);
          if (BigInt(scope.kaNumber) !== number) {
            throw new Error(`reservedUal number ${scope.kaNumber} does not match kaId ${number}`);
          }
          return { agentAddress: scope.agentAddress, number, kaUal: scope.ual };
        } catch (err) {
          this.log.warn(
            createOperationContext('share'),
            `Ignoring invalid reservedUal on <${urn}>: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { agentAddress, number };
    }
    return null;
  }

  /** Mutation gate: missing/legacy scope is query/export-only. */
  private async assertGraphScopedLifecycleWritable(
    contextGraphId: string,
    agentAddress: string,
    name: string,
    subGraphName?: string,
  ): Promise<void> {
    const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?scope WHERE { GRAPH <${metaGraph}> {
        <${lifecycle}> <${ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION}> ?scope
      } } LIMIT 1`,
    );
    const raw = result.type === 'bindings' ? result.bindings[0]?.['scope'] : undefined;
    const version = raw?.match(/(\d+)/)?.[1];
    if (version !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
  }

  /**
   * A draft mutation is only valid while the lifecycle is exactly created/WM.
   * The checks are separate and bounded so corrupt duplicate rows cannot form
   * an unbounded Cartesian product in a recovery path.
   */
  private async assertWorkingMemoryLifecycleMutable(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const [stateResult, layerResult] = await Promise.all([
      this.store.query(
        `SELECT ?state WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/state> ?state
        } } LIMIT 2`,
      ),
      this.store.query(
        `SELECT ?layer WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/memoryLayer> ?layer
        } } LIMIT 2`,
      ),
    ]);
    const state = stateResult.type === 'bindings' && stateResult.bindings.length === 1
      ? stripOptionalLiteral(stateResult.bindings[0]?.['state'])
      : undefined;
    const layer = layerResult.type === 'bindings' && layerResult.bindings.length === 1
      ? stripOptionalLiteral(layerResult.bindings[0]?.['layer'])
      : undefined;
    if (state !== 'created' || layer !== MemoryLayer.WorkingMemory) {
      throw Object.assign(
        new Error(
          `Assertion "${name}" is not an active Working Memory draft; reopen it before mutating it`,
        ),
        { code: 'KA_WM_LIFECYCLE_REQUIRED' },
      );
    }
  }

  /**
   * Once an operation ID or immutable promote intent is durable, WM is frozen
   * until promote either completes or receives a definitive rejection. This
   * prevents a sequential write/discard from erasing the only state capable of
   * repairing an acknowledgement whose outcome is still ambiguous.
   */
  private async assertNoUnfinishedAssertionPromote(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const [operationIdResult, intentResult, layerResult] = await Promise.all([
      this.store.query(
        `SELECT ?id WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(lifecycle)}> <${SHARE_OPERATION_ID_PRED}> ?id
        } } LIMIT 2`,
      ),
      this.store.query(
        `ASK { GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(lifecycle)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?intent
        } }`,
      ),
      this.store.query(
        `SELECT ?layer WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/memoryLayer> ?layer
        } } LIMIT 2`,
      ),
    ]);
    const operationIdBindings = operationIdResult.type === 'bindings'
      ? operationIdResult.bindings
      : undefined;
    const hasOperationId = operationIdBindings === undefined || operationIdBindings.length > 0;
    const hasIntent = intentResult.type !== 'boolean' || intentResult.value;
    const layer = layerResult.type === 'bindings' && layerResult.bindings.length === 1
      ? stripOptionalLiteral(layerResult.bindings[0]?.['layer'])
      : undefined;
    if (layer === MemoryLayer.VerifiableMemory) return;
    if (!hasOperationId && !hasIntent && layer !== MemoryLayer.SharedWorkingMemory) return;
    if (layer === MemoryLayer.SharedWorkingMemory) {
      const rawOperationId = operationIdBindings?.length === 1
        ? operationIdBindings[0]?.['id']
        : undefined;
      let operationId: string | undefined;
      try {
        const parsed: unknown = rawOperationId === undefined
          ? undefined
          : JSON.parse(rawOperationId);
        operationId = typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
      } catch {
        operationId = undefined;
      }
      const sealSubject = contextGraphAssertionUri(
        contextGraphId,
        agentAddress,
        name,
        subGraphName,
      );
      const sealResult = await this.store.query(
        `CONSTRUCT { <${assertSafeIri(sealSubject)}> ?p ?o } WHERE {
          GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(sealSubject)}> ?p ?o }
        }`,
      );
      const seal = parseAssertionSealQuads(
        sealResult.type === 'quads' ? sealResult.quads : [],
        sealSubject,
      );
      // A completed promote consumes its provisional lifecycle pointer. The
      // monotonic SWM head is then the authoritative recovery pointer. Resolve
      // it only for the clean completed shape; an intent without its matching
      // lifecycle ID remains corrupt and must fail closed below.
      if (
        !operationId
        && !hasOperationId
        && !hasIntent
        && seal?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
        && seal.kaUal
      ) {
        const head = await resolveKnowledgeAssetWorkspaceHead({
          store: this.store,
          graphManager: this.graphManager,
          contextGraphId,
          kaUal: seal.kaUal,
          subGraphName,
        });
        operationId = head?.shareOperationId;
      }
      if (
        operationId
        && seal?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
        && seal.kaUal
        && seal.assertionVersion
        && await this.hasSwmShareComplete(contextGraphId, name, agentAddress, subGraphName)
        && await this.hasDurableAssertionPromoteTail(
          contextGraphId,
          operationId,
          seal.kaUal,
          seal.assertionVersion,
          subGraphName,
        )
      ) {
        return;
      }
    }
    throw Object.assign(
      new Error(
        `Assertion "${name}" has an unfinished promote; retry assertionPromote before mutating its draft`,
      ),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED' },
    );
  }

  private async hasDurableAssertionPromoteTail(
    contextGraphId: string,
    operationId: string,
    kaUal: string,
    assertionVersion: string | number | bigint,
    subGraphName?: string,
  ): Promise<boolean> {
    const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
    const workspaceMetaGraph = this.graphManager.sharedMemoryMetaUri(
      contextGraphId,
      subGraphName,
    );
    const operationSubject = `urn:dkg:share:${contextGraphId}:${operationId}`;
    const headSubject = `${scope.ual}#dkg-swm-head`;
    const assertionGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
      subGraphName,
    );
    const versionLiteral = `${JSON.stringify(scope.assertionVersion)}` +
      '^^<http://www.w3.org/2001/XMLSchema#integer>';
    const durableTail = await this.store.query(
      `ASK { GRAPH <${assertSafeIri(workspaceMetaGraph)}> {
        <${assertSafeIri(operationSubject)}> <http://dkg.io/ontology/shareOperationId> ${JSON.stringify(operationId)} ;
          <http://dkg.io/ontology/publicQuadsDigest> ?digest ;
          <http://dkg.io/ontology/publicQuadsCount> ?count ;
          <http://dkg.io/ontology/kaUal> <${assertSafeIri(scope.ual)}> ;
          <http://dkg.io/ontology/assertionVersion> ${versionLiteral} .
        <${assertSafeIri(headSubject)}> <http://dkg.io/ontology/shareOperationId> ${JSON.stringify(operationId)} ;
          <http://dkg.io/ontology/kaUal> <${assertSafeIri(scope.ual)}> ;
          <http://dkg.io/ontology/assertionVersion> ${versionLiteral} ;
          <http://dkg.io/ontology/assertionGraph> <${assertSafeIri(assertionGraph)}> .
      } }`,
    );
    return durableTail.type === 'boolean' && durableTail.value;
  }

  /** Read a KA's allocated number (dkg:kaId) off its lifecycle URN, or null if not yet minted. */
  private async resolveKaNumber(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): Promise<bigint | null> {
    return (await this.resolveKaGraphIdentity(contextGraphId, agentAddress, name, subGraphName))?.number ?? null;
  }

  /** A KA's WM graph URI: the per-KA `…/_working_memory/{addr}/{number}` once minted (D1), else legacy name-keyed. */
  async wmGraphUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): Promise<string> {
    const identity = await this.resolveKaGraphIdentity(contextGraphId, agentAddress, name, subGraphName);
    return identity !== null
      ? contextGraphLayerUri(contextGraphId, MemoryLayer.WorkingMemory, identity.agentAddress, identity.number, subGraphName)
      : contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
  }

  private async assertionScopedGraphUris(wmGraphUri: string): Promise<string[]> {
    return listAssertionScopedGraphUris(this.store, wmGraphUri);
  }

  private async assertionScopedQuads(wmGraphUri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for (const graph of await this.assertionScopedGraphUris(wmGraphUri)) {
      const result = await this.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`,
      );
      if (result.type !== 'quads') continue;
      const originalGraph = assertionOriginalGraph(wmGraphUri, graph);
      quads.push(...result.quads.map((quad) => ({ ...quad, graph: originalGraph })));
    }
    return quads;
  }

  private async assertionScopedHasQuads(wmGraphUri: string): Promise<boolean> {
    for (const graph of await this.assertionScopedGraphUris(wmGraphUri)) {
      const result = await this.store.query(`ASK { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`);
      if (result.type === 'boolean' && result.value) return true;
    }
    return false;
  }

  private async deleteAssertionScopedQuads(wmGraphUri: string, quads: Quad[]): Promise<void> {
    const byGraph = new Map<string, Quad[]>();
    for (const quad of quads) {
      const graph = assertionScopedGraphUri(wmGraphUri, quad.graph);
      const scopedQuad = { ...quad, graph };
      const bucket = byGraph.get(graph);
      if (bucket) {
        bucket.push(scopedQuad);
      } else {
        byGraph.set(graph, [scopedQuad]);
      }
    }
    for (const [graph, bucket] of byGraph.entries()) {
      await this.store.delete(bucket);
      if (graph !== wmGraphUri) {
        const stillHasQuads = await this.store.query(`ASK { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`);
        if (stillHasQuads.type === 'boolean' && !stillHasQuads.value) {
          await this.store.dropGraph(graph);
        }
      }
    }
  }

  private async dropAssertionScopedGraphs(wmGraphUri: string): Promise<void> {
    for (const graph of await listAssertionScopedGraphUris(this.store, wmGraphUri, 'named-only')) {
      await this.store.dropGraph(graph);
    }
    await this.store.dropGraph(wmGraphUri);
  }

  private async replaceExactKnowledgeAssetGraph(
    graphUri: string,
    quads: readonly Quad[],
    operation: string,
  ): Promise<void> {
    const graphQuads = quads.map((quad) => ({ ...quad, graph: graphUri }));
    const replaced = await tryReplaceGraphAtomically(this.store, graphUri, graphQuads);
    if (!replaced) {
      throw Object.assign(
        new Error(
          `${operation} requires atomic complete-graph replacement, but the configured triple store does not support it`,
        ),
        { code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED', graphUri },
      );
    }
  }

  /**
   * Retry-safe replacement of one KA's rows inside a shared metadata graph.
   * Insert the complete new row set first, then prune rows from the previous
   * snapshot that are no longer present. An interruption can temporarily leave
   * duplicate values, but never removes the only discoverable metadata copy;
   * retry converges to the exact requested set.
   */
  private async convergeKnowledgeAssetMetadataRows(
    metaGraph: string,
    subject: string,
    quads: readonly Quad[],
  ): Promise<void> {
    const previous = await this.store.query(
      `CONSTRUCT { <${assertSafeIri(subject)}> ?p ?o } WHERE { ` +
        `GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(subject)}> ?p ?o } }`,
    );
    await this.store.insert(quads.map((quad) => ({ ...quad, graph: metaGraph })));
    if (previous.type !== 'quads') return;
    const nextKeys = new Set(
      quads.map((quad) => JSON.stringify([quad.subject, quad.predicate, quad.object])),
    );
    const stale = previous.quads.filter(
      (quad) => !nextKeys.has(JSON.stringify([quad.subject, quad.predicate, quad.object])),
    );
    if (stale.length > 0) {
      // CONSTRUCT results carry no graph — restore the metadata graph before
      // deleting, otherwise the delete targets the default graph and every
      // superseded control-plane row survives alongside the new value.
      await this.store.delete(stale.map((quad) => ({ ...quad, graph: metaGraph })));
    }
  }

  /** Load the immutable access/sub-graph identity of an existing graph KA. */
  private async readGraphKnowledgeAssetIdentity(
    metaGraph: string,
    ual: string,
  ): Promise<{
    accessPolicy: 'public' | 'ownerOnly' | 'allowList';
    allowedPeers: string[];
    publisherPeerId: string;
    authorAddress?: string;
    subGraphName?: string;
  }> {
    const dkg = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?scopeVersion ?policy ?allowedPeer ?publisherPeerId ?attributedTo ?subGraphName WHERE {
         GRAPH <${assertSafeIri(metaGraph)}> {
           OPTIONAL { <${assertSafeIri(ual)}> <${dkg}contentScopeVersion> ?scopeVersion }
           OPTIONAL { <${assertSafeIri(ual)}> <${dkg}accessPolicy> ?policy }
           OPTIONAL { <${assertSafeIri(ual)}> <${dkg}allowedPeer> ?allowedPeer }
           OPTIONAL { <${assertSafeIri(ual)}> <${dkg}publisherPeerId> ?publisherPeerId }
           OPTIONAL { <${assertSafeIri(ual)}> <http://www.w3.org/ns/prov#wasAttributedTo> ?attributedTo }
           OPTIONAL { <${assertSafeIri(ual)}> <${dkg}subGraphName> ?subGraphName }
         }
       }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      throw new Error(`Graph-scoped KA update requires existing metadata for ${ual}`);
    }
    const values = (name: string): Set<string> => new Set(
      result.bindings
        .map((row) => rdfLexicalValue(row[name]))
        .filter((value): value is string => value !== undefined && value.length > 0),
    );
    const single = (name: string, required: boolean): string | undefined => {
      const found = values(name);
      if (found.size > 1 || (required && found.size !== 1)) {
        throw new Error(
          `Graph-scoped KA update found ambiguous or missing ${name} metadata for ${ual}`,
        );
      }
      return [...found][0];
    };
    if (single('scopeVersion', true) !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Graph-scoped KA update requires V2 metadata for ${ual}`);
    }
    const policy = single('policy', true);
    if (policy !== 'public' && policy !== 'ownerOnly' && policy !== 'allowList') {
      throw new Error(`Graph-scoped KA update has invalid access policy for ${ual}`);
    }
    const allowedPeers = [...values('allowedPeer')];
    if (
      (policy === 'allowList' && allowedPeers.length === 0)
      || (policy !== 'allowList' && allowedPeers.length > 0)
    ) {
      throw new Error(`Graph-scoped KA update has inconsistent allow-list metadata for ${ual}`);
    }
    const attributedTo = single('attributedTo', false);
    const subGraphName = single('subGraphName', false);
    const authorMatch = attributedTo
      ? /^did:dkg:agent:(0x[0-9a-f]{40})$/i.exec(attributedTo)
      : null;
    return {
      accessPolicy: policy,
      allowedPeers,
      publisherPeerId: single('publisherPeerId', true)!,
      ...(authorMatch ? { authorAddress: authorMatch[1] } : {}),
      ...(subGraphName ? { subGraphName } : {}),
    };
  }

  /**
   * Materialize the exact canonical WM payload under its deterministic UAL graph.
   *
   * Finalization calls this before persisting the seal. It deliberately does not
   * remove the source draft: source cleanup happens only after durable metadata,
   * which makes every interruption retryable without losing the pre-finalize data.
   */
  async materializeCanonicalWorkingMemory(
    contextGraphId: string,
    kaUal: string,
    assertionVersion: string | number | bigint,
    quads: readonly Quad[],
    subGraphName?: string,
  ): Promise<string> {
    const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
    const graphUri = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.WorkingMemory,
      scope,
      subGraphName,
    );
    await this.replaceExactKnowledgeAssetGraph(
      graphUri,
      quads,
      'Knowledge Asset finalization',
    );
    return graphUri;
  }

  /**
   * Remove obsolete name-keyed/original-graph WM sources after the canonical
   * target and seal are durable. When a source already is the canonical target,
   * only its encoded named-graph descendants are removed.
   */
  async cleanupCanonicalWorkingMemorySources(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    canonicalGraphUri: string,
    additionalSourceGraphUris: readonly string[] = [],
    subGraphName?: string,
  ): Promise<void> {
    const nameKeyedSource = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    const sources = new Set([nameKeyedSource, ...additionalSourceGraphUris]);
    for (const sourceGraphUri of sources) {
      for (const graph of await listAssertionScopedGraphUris(
        this.store,
        sourceGraphUri,
        'named-only',
      )) {
        if (graph !== canonicalGraphUri) await this.store.dropGraph(graph);
      }
      if (sourceGraphUri !== canonicalGraphUri) {
        await this.store.dropGraph(sourceGraphUri);
      }
    }
  }

  /** A promoted KA's SWM graph URI: per-KA `…/_shared_memory/{addr}/{number}` (resolved from the assertion), else the legacy bucket. */
  private async swmGraphUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): Promise<string> {
    const identity = await this.resolveKaGraphIdentity(contextGraphId, agentAddress, name, subGraphName);
    const bucketGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
    return identity !== null
      ? contextGraphLayerUri(
          contextGraphId,
          MemoryLayer.SharedWorkingMemory,
          identity.agentAddress,
          identity.number,
          subGraphName,
        )
      : bucketGraph;
  }

  /** SWM graph URI from an explicit `{author, number}` (receiver-side / freshly-allocated generic share). */
  private swmGraphUriFor(contextGraphId: string, agentAddress: string, kaNumber: bigint, subGraphName?: string): string {
    return contextGraphLayerUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      agentAddress,
      kaNumber,
      subGraphName,
    );
  }

  /**
   * Every SWM graph under a bucket: the bare bucket PLUS the per-KA
   * `…/_shared_memory/{addr}/{number}` graphs. SWM deletes/cleanup must
   * span all of them under the uniform layout (the `_shared_memory_meta`
   * graph is intentionally excluded — it is not under the `/` prefix).
   */
  private async swmGraphsUnder(bucketGraph: string): Promise<string[]> {
    return listGraphFamily(this.store, bucketGraph);
  }

  /**
   * Drain the SWM copy of `rootEntities` after their content reached
   * Verifiable Memory: data + skolem children from every graph under the
   * SWM bucket (uniform per-KA layout), ownership rows + workspace-op meta
   * from `_shared_memory_meta`, and the in-memory ownership registry.
   *
   * #1099: extracted from `publishFromSharedMemory`'s confirmed-publish
   * block so the named-lifecycle UPDATE path
   * (`DKGAgent.publishFromFinalizedAssertion` → `publisher.update`) can run
   * the SAME cleanup — updates previously left the re-shared SWM copy in
   * place forever, so SWM and VM permanently disagreed after any edit loop.
   */
  async clearPublishedSwmRoots(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName: string | undefined,
    ctx: OperationContext,
    scope: SharedMemoryGraphScope = { kind: 'complete-family' },
  ): Promise<void> {
    if (rootEntities.length === 0) return;
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
    const plan = await this.resolvePublishedSwmCleanupPlan(swmGraph, scope);
    await this.deletePublishedSwmRootData(rootEntities, plan.dataGraphs);

    const rootsToClearMetadata = plan.kind === 'complete-family'
      ? rootEntities
      : await this.namedLifecycleRootsWithoutRemainingShares(swmGraph, rootEntities);
    await this.clearPublishedSwmRootMetadata(
      contextGraphId,
      rootsToClearMetadata,
      subGraphName,
      ctx,
    );
  }

  /**
   * Drain one complete rootless KA from SWM after its VM graph is durable.
   * The named-lifecycle scope is the ownership boundary, so cleanup drops
   * only that exact graph (plus historical casing aliases for the same KA).
   */
  async clearPublishedKnowledgeAssetSwm(
    contextGraphId: string,
    scope: SharedMemoryGraphScope,
    subGraphName: string | undefined,
    ctx: OperationContext,
    kaUal: string,
  ): Promise<void> {
    if (scope.kind !== 'named-lifecycle') {
      throw new Error('Graph-scoped KA SWM cleanup requires an exact named-lifecycle scope');
    }
    const kaScope = createGraphKnowledgeAssetScope(kaUal, 1);
    if (
      kaScope.agentAddress.toLowerCase() !== scope.identity.agentAddress.toLowerCase()
      || BigInt(kaScope.kaNumber) !== scope.identity.kaNumber
    ) {
      throw new Error('Graph-scoped KA SWM cleanup UAL does not match the named-lifecycle scope');
    }
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);
    const headSubject = assertSafeIri(`${kaScope.ual}#dkg-swm-head`);
    const operationRows = await this.store.query(`
      SELECT DISTINCT ?operation WHERE {
        GRAPH <${assertSafeIri(swmMetaGraph)}> {
          <${headSubject}> <http://dkg.io/ontology/shareOperationId> ?shareId .
          ?operation <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>
              <http://dkg.io/ontology/WorkspaceOperation> ;
            <http://dkg.io/ontology/shareOperationId> ?shareId ;
            <http://dkg.io/ontology/kaUal> <${assertSafeIri(kaScope.ual)}> .
        }
      }
      LIMIT 16
    `);
    const operationSubjects = operationRows.type === 'bindings'
      ? [...new Set(operationRows.bindings.map((row) => row['operation']).filter(Boolean))]
      : [];
    const graphs = await resolveSharedMemoryScopeGraphs(this.store, swmGraph, scope);
    for (const graph of graphs) {
      await this.store.dropGraph(graph);
    }
    await this.store.deleteByPattern({ graph: swmMetaGraph, subject: headSubject });
    for (const operationSubject of operationSubjects) {
      await this.store.deleteByPattern({
        graph: swmMetaGraph,
        subject: assertSafeIri(operationSubject),
      });
    }
    this.log.info(
      ctx,
      `Cleared graph-scoped KA SWM ${scope.identity.agentAddress}/${scope.identity.kaNumber.toString()} ` +
        `from ${graphs.length} exact graph(s) and ${operationSubjects.length + 1} metadata subject(s)`,
    );
  }

  private async resolvePublishedSwmCleanupPlan(
    swmGraph: string,
    scope: SharedMemoryGraphScope,
  ): Promise<PublishedSwmCleanupPlan> {
    const dataGraphs = await resolveSharedMemoryScopeGraphs(this.store, swmGraph, scope);
    return scope.kind === 'complete-family'
      ? { kind: 'complete-family', dataGraphs }
      : { kind: 'named-lifecycle', dataGraphs };
  }

  private async deletePublishedSwmRootData(
    rootEntities: string[],
    swmGraphsForClear: string[],
  ): Promise<void> {
    for (const rootEntity of rootEntities) {
      for (const g of swmGraphsForClear) {
        await this.store.deleteByPattern({ graph: g, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(g, rootEntity + '/.well-known/genid/');
        await this.store.deleteByPattern({
          graph: g, subject: rootEntity, predicate: WORKSPACE_OWNER_PREDICATE,
        });
      }
    }
  }

  /**
   * Root-keyed ownership metadata remains live only while another SWM family
   * graph still contains the root. One family read reconciles the entire
   * published set after the exact lifecycle's data has been deleted.
   */
  private async namedLifecycleRootsWithoutRemainingShares(
    swmGraph: string,
    rootEntities: string[],
  ): Promise<string[]> {
    const rootsWithRemainingShares = new Set<string>();
    const remaining = await loadSelectedSharedMemoryQuads(
      this.store,
      swmGraph,
      { rootEntities },
      { querySource: 'publisher.clearPublishedNamedKnowledgeAssetRoots.reconcileOwnership' },
    );
    for (const quad of remaining) {
      for (const rootEntity of rootEntities) {
        if (
          quad.subject === rootEntity
          || quad.subject.startsWith(`${rootEntity}/.well-known/genid/`)
        ) {
          rootsWithRemainingShares.add(rootEntity);
        }
      }
    }
    return rootEntities.filter((rootEntity) => !rootsWithRemainingShares.has(rootEntity));
  }

  private async clearPublishedSwmRootMetadata(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName: string | undefined,
    ctx: OperationContext,
  ): Promise<void> {
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);
    const swmOwnershipKey = subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
    let ownerDeletedTotal = 0;
    for (const rootEntity of rootEntities) {
      ownerDeletedTotal += await this.store.deleteByPattern({
        graph: swmMetaGraph, subject: rootEntity, predicate: WORKSPACE_OWNER_PREDICATE,
      });
      await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
      this.sharedMemoryOwnedEntities.get(swmOwnershipKey)?.delete(rootEntity);
    }
    if (ownerDeletedTotal > 0) {
      this.log.info(ctx, `Cleared ${ownerDeletedTotal} published SWM triple(s) after confirmed publish`);
    }
  }

  async clearRemainingSharedMemory(
    contextGraphId: string,
    subGraphName: string | undefined,
    ctx: OperationContext,
  ): Promise<void> {
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);
    const swmOwnershipKey = subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
    let remainingCount = 0;
    for (const graph of await this.swmGraphsUnder(swmGraph)) {
      remainingCount += await this.store.deleteByPattern({ graph });
    }
    const remainingMetaCount = await this.store.deleteByPattern({ graph: swmMetaGraph });
    if (remainingCount > 0 || remainingMetaCount > 0) {
      this.log.info(ctx, `Cleared remaining SWM content: ${remainingCount} triples, ${remainingMetaCount} meta`);
    }
    this.sharedMemoryOwnedEntities.delete(swmOwnershipKey);
  }

  /**
   * Explicit, opt-in migration for a legacy name-keyed Working Memory draft.
   *
   * The normal mutation APIs deliberately keep legacy/root-scoped KAs
   * read-only. Local durable integrations such as `agent-context/chat-turns`,
   * however, can predate graph-scoped KA storage and must survive an upgrade.
   * This operation is therefore intentionally separate from `assertionCreate`:
   * callers must select the exact local assertion they are willing to migrate.
   *
   * The publisher only owns the lifecycle write lock and the primitive
   * boundary; phase ordering, classification, and the safety properties live
   * in `legacy-wm-migration.ts`.
   */
  async migrateLegacyRootScopedWorkingMemory(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
    opts?: { allocateKaNumber?: () => Promise<{ number: bigint; reservedUal: string }> },
  ): Promise<LegacyWmMigrationResult> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => runLegacyWorkingMemoryMigration(this.legacyWmMigrationHost(), {
        contextGraphId,
        name,
        agentAddress,
        subGraphName,
        allocateKaNumber: opts?.allocateKaNumber,
      }),
    );
  }

  /**
   * The complete primitive surface the legacy-WM migration is allowed to
   * touch. Everything here is a thin binding onto existing publisher
   * internals — no migration policy.
   */
  private legacyWmMigrationHost(): LegacyWmMigrationHost {
    return {
      store: this.store,
      validateOptionalSubGraph: (subGraphName) =>
        DKGPublisher.validateOptionalSubGraph(subGraphName),
      ensureSubGraphRegistered: (contextGraphId, subGraphName) =>
        this.ensureSubGraphRegistered(contextGraphId, subGraphName),
      loadAssertionScopedQuads: (graphUri) => this.assertionScopedQuads(graphUri),
      loadPrivateDraftQuads: (contextGraphId, agentAddress, name, subGraphName) =>
        this.privateStore.getKnowledgeAssetPrivateDraftTriples(
          contextGraphId,
          agentAddress,
          name,
          subGraphName,
        ),
      validateMigratableContent: (publicQuads, privateQuads) => {
        rejectUserAuthoredProtocolMetadata(publicQuads);
        rejectOversizedRdfLiterals(publicQuads, 'legacyWorkingMemoryMigration.publicQuads');
        rejectOversizedRdfLiterals(privateQuads, 'legacyWorkingMemoryMigration.privateQuads');
      },
      canSelfAllocateGraphIdentity: (agentAddress) =>
        this.kaAllocator !== undefined && /^0x[a-fA-F0-9]{40}$/.test(agentAddress),
      createGraphScopedDraft: (contextGraphId, name, agentAddress, subGraphName, opts) =>
        this.assertionCreateUnlocked(contextGraphId, name, agentAddress, subGraphName, opts),
      writeGraphScopedDraft: (contextGraphId, name, agentAddress, quads, subGraphName) =>
        this.assertionWriteUnlocked(contextGraphId, name, agentAddress, quads, subGraphName),
      wmGraphUri: (contextGraphId, agentAddress, name, subGraphName) =>
        this.wmGraphUri(contextGraphId, agentAddress, name, subGraphName),
      logInfo: (message) => this.log.info(createOperationContext('system'), message),
    };
  }

  async assertionCreate(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
    opts?: { allocateKaNumber?: () => Promise<{ number: bigint; reservedUal: string }> },
  ): Promise<string> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      async () => {
        await this.assertNoUnfinishedAssertionPromote(
          contextGraphId,
          name,
          agentAddress,
          subGraphName,
        );
        return this.assertionCreateUnlocked(
          contextGraphId,
          name,
          agentAddress,
          subGraphName,
          opts,
        );
      },
    );
  }

  private async assertionCreateUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
    opts?: { allocateKaNumber?: () => Promise<{ number: bigint; reservedUal: string }> },
  ): Promise<string> {
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);

    // Clear any stale lifecycle data from a previous create/discard cycle
    // so re-using the same assertion name doesn't leave orphaned triples.
    // This removes the assertion entity AND its prov:Activity event
    // sub-entities (whose URIs are prefixed with the lifecycle URI).
    //
    // OT-RFC-43 A2 — but PRESERVE the KA's persistent identity + per-layer
    // pointers (dkg:kaId / dkg:reservedUal / dkg:{wm,swm,vm}CurrentAssertion /
    // prov:wasRevisionOf). These represent the KA's stable on-chain identity
    // and confirmed-layer state, NOT "stale draft data": re-opening a draft on
    // a name that was previously published (pull-from / discard+recreate) must
    // KEEP the minted kaId so the next publish routes to UPDATE (same id), not
    // a fresh mint. Without this carry-over the clean-slate wipe would burn the
    // KA's identity and double-allocate on every edit cycle.
    const A2_DKG = 'http://dkg.io/ontology/';
    const A2_PRESERVE_PREDS = new Set<string>([
      `${A2_DKG}kaId`,
      `${A2_DKG}reservedUal`,
      `${A2_DKG}wmCurrentAssertion`,
      `${A2_DKG}swmCurrentAssertion`,
      `${A2_DKG}vmCurrentAssertion`,
      `${A2_DKG}contentScopeVersion`,
      `${A2_DKG}assertionVersion`,
      'http://www.w3.org/ns/prov#wasRevisionOf',
      // #1116 (review A1): the full-SWM-share marker that gates finalize(layer:"swm").
      // pull-from's clean-slate (the seal-in-SWM reconstruction) MUST preserve it,
      // or a finalize that fails after the re-seed would strip the marker and make
      // the already-fully-shared asset un-sealable — the inverse of the bug it guards.
      // Round 6 — use the shared SWM_SHARE_COMPLETE_PRED constant (the same one
      // mark/clear/has use) so a future rename can't silently break preservation.
      SWM_SHARE_COMPLETE_PRED,
    ]);
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const preserved: Quad[] = [];
    const preserveRes = await this.store.query(
      `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleSubject}> ?p ?o } }`,
    );
    if (preserveRes.type === 'bindings') {
      const scopeObject = preserveRes.bindings.find(
        (row) => row['p'] === `${A2_DKG}contentScopeVersion`,
      )?.['o'];
      const scopeVersion = scopeObject?.match(/(\d+)/)?.[1];
      if (
        (scopeVersion !== undefined && scopeVersion !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)) ||
        (scopeVersion === undefined && preserveRes.bindings.length > 0)
      ) {
        throw new LegacyKnowledgeAssetReadOnlyError();
      }
      for (const row of preserveRes.bindings) {
        const p = row['p'];
        const o = row['o'];
        if (p && o != null && A2_PRESERVE_PREDS.has(p)) {
          preserved.push({ subject: lifecycleSubject, predicate: p, object: o, graph: metaGraph });
        }
      }
    }
    const staleEvents = await this.store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o . FILTER(STR(?s) = "${lifecycleSubject}" || STRSTARTS(STR(?s), "${lifecycleSubject}/")) } }`,
    );
    if (staleEvents.type === 'bindings') {
      for (const row of staleEvents.bindings) {
        const subj = row['s'];
        if (subj) await this.store.deleteByPattern({ graph: metaGraph, subject: subj });
      }
    }
    if (preserved.length > 0) {
      await this.store.insert(preserved);
    }

    // D1 (identity-at-create): mint the KA number now, UNLESS the draft already
    // carries a persistent identity. The A2 preserve step above re-inserts a prior
    // kaId on discard+recreate / pull-from, so reuse it and never double-allocate
    // (this is the re-open guard the create-time allocation needs).
    const hasPreservedKaId = preserved.some((q) => q.predicate === `${A2_DKG}kaId`);
    let kaNumber: bigint | undefined;
    let reservedUal: string | undefined;
    if (hasPreservedKaId) {
      const m = preserved.find((q) => q.predicate === `${A2_DKG}kaId`)?.object?.match(/(\d+)/);
      if (m) kaNumber = BigInt(m[1]);
    } else if (opts?.allocateKaNumber) {
      ({ number: kaNumber, reservedUal } = await opts.allocateKaNumber());
    } else if (this.kaAllocator && /^0x[a-fA-F0-9]{40}$/.test(agentAddress)) {
      // Direct (non-agent-wrapper) callers still get a number from the SHARED allocator
      // (same instance the agent wrapper uses — no double-mint), so the per-KA graph is
      // the ONE layout. Without this, a direct create would fall back to a name-keyed
      // graph the indexed `_working_memory/{addr}/` read can never find.
      const kaId = await this.ensureReservedKaId(agentAddress);
      if (kaId !== undefined) {
        kaNumber = kaId & ((1n << 96n) - 1n);
        reservedUal = `did:dkg:${this.chain.chainId}/${agentAddress.toLowerCase()}/${kaNumber}`;
      }
    }

    // Uniform layout: WM data lives in the per-KA graph keyed by {number} once the KA
    // has an identity (D1). Now that the number is known, build + create that graph.
    const graphUri = kaNumber !== undefined
      ? contextGraphLayerUri(contextGraphId, MemoryLayer.WorkingMemory, agentAddress, kaNumber, subGraphName)
      : contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    await this.store.createGraph(graphUri);

    const lifecycleQuads = generateAssertionCreatedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName,
      timestamp: new Date(),
      kaNumber,
      reservedUal,
    }, { provenanceEvents: this.provenanceEvents });
    if (!preserved.some((quad) => quad.predicate === `${A2_DKG}contentScopeVersion`)) {
      lifecycleQuads.push({
        subject: lifecycleSubject,
        predicate: `${A2_DKG}contentScopeVersion`,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      });
    }
    await this.store.insert(lifecycleQuads);

    await this.store.insert([{
      subject: graphUri,
      predicate: 'http://dkg.io/ontology/memoryLayer',
      object: '"WM"',
      graph: metaGraph,
    }]);

    return graphUri;
  }

  async assertionWrite(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    input: Quad[] | Array<{ subject: string; predicate: string; object: string }>,
    subGraphName?: string,
  ): Promise<void> {
    // Keep the reserved-namespace security boundary ahead of lock and store
    // access so invalid input fails deterministically even while this KA is busy.
    const stableInput = input.map((quad) => ({ ...quad })) as typeof input;
    rejectUserAuthoredProtocolMetadata(stableInput.map((quad) => ({
      subject: quad.subject,
      predicate: quad.predicate,
      object: quad.object,
      graph: 'graph' in quad ? String(quad.graph ?? '') : '',
    })));
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => this.assertionWriteUnlocked(
        contextGraphId,
        name,
        agentAddress,
        stableInput,
        subGraphName,
      ),
    );
  }

  private async assertionWriteUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    input: Quad[] | Array<{ subject: string; predicate: string; object: string }>,
    subGraphName?: string,
  ): Promise<void> {
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);
    await this.assertGraphScopedLifecycleWritable(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    await this.assertNoUnfinishedAssertionPromote(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    await this.assertWorkingMemoryLifecycleMutable(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    const graphUri = await this.wmGraphUri(contextGraphId, agentAddress, name, subGraphName);
    const scopedGraphs = new Set<string>([graphUri]);
    const quads = input.map((t) => {
      const originalGraph = normalizeAssertionInputGraph(
        contextGraphId,
        subGraphName,
        graphUri,
        'graph' in t ? String(t.graph ?? '') : '',
      );
      if (originalGraph !== '') assertSafeIri(originalGraph);
      const graph = assertionScopedGraphUri(graphUri, originalGraph);
      scopedGraphs.add(graph);
      return {
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        graph,
      };
    });
    for (const graph of scopedGraphs) {
      await this.store.createGraph(graph);
    }
    // Round 9 Bug 25: reject user-authored quads whose subject is in a
    // protocol-reserved URN namespace. See RESERVED_SUBJECT_PREFIXES above.
    rejectUserAuthoredProtocolMetadata(quads);
    rejectOversizedRdfLiterals(quads, 'assertionWrite.quads');
    await this.store.insert(quads);
  }

  /**
   * Append private content to the mutable draft of one graph-scoped KA.
   * Private draft triples never enter the public WM graph; finalize
   * canonicalizes both partitions together and commits one private root.
   */
  async assertionWritePrivate(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    input: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    // Private storage erases the physical graph term. Reject named-graph and
    // reserved-namespace input before waiting on any lifecycle mutation.
    const stableInput = input.map((quad) => ({ ...quad }));
    assertNoKnowledgeAssetPayloadNamedGraphs(stableInput);
    rejectUserAuthoredProtocolMetadata(stableInput.map((quad) => ({ ...quad, graph: '' })));
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => this.assertionWritePrivateUnlocked(
        contextGraphId,
        name,
        agentAddress,
        stableInput,
        subGraphName,
      ),
    );
  }

  private async assertionWritePrivateUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    input: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);
    await this.assertGraphScopedLifecycleWritable(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    await this.assertNoUnfinishedAssertionPromote(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    await this.assertWorkingMemoryLifecycleMutable(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    rejectOversizedRdfLiterals(input, 'assertionWritePrivate.quads');
    await this.privateStore.storeKnowledgeAssetPrivateDraftTriples(
      contextGraphId,
      agentAddress,
      name,
      input,
      subGraphName,
    );
  }

  async assertionQuery(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = await this.wmGraphUri(contextGraphId, agentAddress, name, subGraphName);
    return this.assertionScopedQuads(graphUri);
  }

  async assertionQueryPrivate(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    return this.privateStore.getKnowledgeAssetPrivateDraftTriples(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
  }

  /**
   * Re-open one sealed rootless KA from its exact SWM or VM graph.
   *
   * V2 never reconstructs content from root/member rows or scans a shared
   * bucket. The seal's (UAL, assertionVersion) tuple resolves one physical
   * source graph, and the complete public/private payload is verified against
   * that seal before any existing draft is removed. Legacy KAs remain readable
   * through query/export surfaces but cannot enter this mutation path.
   */
  async assertionPullFrom(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    sourceLayer: 'swm' | 'vm',
    opts?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
  ): Promise<{
    seeded: number;
    seededPublic: number;
    seededPrivate: number;
    fromLayer: 'swm' | 'vm';
    contentScopeVersion: number;
    kaUal: string;
    assertionVersion: string;
  }> {
    const stableOpts = opts ? { ...opts } : undefined;
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      stableOpts?.subGraphName,
      () => this.assertionPullFromUnlocked(
        contextGraphId,
        name,
        agentAddress,
        sourceLayer,
        stableOpts,
      ),
    );
  }

  private async assertionPullFromUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    sourceLayer: 'swm' | 'vm',
    opts?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
  ): Promise<{
    seeded: number;
    seededPublic: number;
    seededPrivate: number;
    fromLayer: 'swm' | 'vm';
    contentScopeVersion: number;
    kaUal: string;
    assertionVersion: string;
  }> {
    const subGraphName = opts?.subGraphName;
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);
    await this.assertNoUnfinishedAssertionPromote(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    const sealSubject = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    const loadedSeals = await this.loadAssertionSeals(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    if (loadedSeals.length === 0) {
      throw Object.assign(
        new Error(
          `Cannot pull "${name}" from ${sourceLayer.toUpperCase()}: rootless mutation requires a finalized v2 assertion seal`,
        ),
        { code: 'UNSEALED_PULL_FROM_BLOCKED' },
      );
    }

    let selectedSeal: typeof loadedSeals[number] | undefined;
    let selectedScope: GraphKnowledgeAssetScope | undefined;
    let validated: Awaited<ReturnType<typeof validateGraphScopedPayloadAgainstSeal>> | undefined;
    let candidateError: unknown;
    let sawLegacySeal = false;

    // Active and recovery seals may legitimately coexist while an edit is
    // open. Validate candidates against the requested exact source graph in
    // priority order; a discarded/torn active seal must never shadow the last
    // complete VM/SWM recovery commitment.
    for (const loadedSeal of loadedSeals) {
      const seal = loadedSeal.seal;
      if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
        sawLegacySeal = true;
        continue;
      }
      if (
        !seal.kaUal
        || !seal.assertionVersion
        || seal.publicTripleCount === undefined
        || seal.privateTripleCount === undefined
      ) {
        candidateError = new Error(`Graph-scoped assertion seal for <${sealSubject}> is incomplete`);
        continue;
      }

      try {
        const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
        const sourceGraph = knowledgeAssetLayerGraphUri(
          contextGraphId,
          sourceLayer === 'swm'
            ? MemoryLayer.SharedWorkingMemory
            : MemoryLayer.VerifiableMemory,
          scope,
          subGraphName,
        );
        const sourcePublicQuads = (await this.assertionScopedQuads(sourceGraph)).filter(
          (quad) => !isSwmMerkleExcludedQuad(quad),
        );
        const sourcePrivateQuads = await this.privateStore.getKnowledgeAssetPrivateTriples(
          contextGraphId,
          scope,
          subGraphName,
        );
        if (sourcePublicQuads.length === 0 && sourcePrivateQuads.length === 0) {
          throw Object.assign(
            new Error(
              `No exact ${sourceLayer.toUpperCase()} content found for sealed KA ${scope.ual} assertion ${scope.assertionVersion}; WM draft was not modified.`,
            ),
            { code: 'PULL_FROM_EMPTY_SOURCE' },
          );
        }
        const candidatePayload = await validateGraphScopedPayloadAgainstSeal(
          seal,
          sourcePublicQuads,
          sourcePrivateQuads,
          `${sourceLayer}-memory`,
        );
        selectedSeal = loadedSeal;
        selectedScope = scope;
        validated = candidatePayload;
        break;
      } catch (error) {
        candidateError = error;
      }
    }

    if (!selectedSeal || !selectedScope || !validated) {
      if (candidateError) throw candidateError;
      if (sawLegacySeal) throw new LegacyKnowledgeAssetReadOnlyError();
      throw Object.assign(
        new Error(
          `Cannot pull "${name}" from ${sourceLayer.toUpperCase()}: no complete v2 assertion seal matches the exact source graph`,
        ),
        { code: 'UNSEALED_PULL_FROM_BLOCKED' },
      );
    }

    const scope = selectedScope;
    const wmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.WorkingMemory,
      scope,
      subGraphName,
    );

    const publicDraftExists = await this.assertionScopedHasQuads(wmGraph);
    const privateDraft = await this.privateStore.getKnowledgeAssetPrivateDraftTriples(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    const hasDraft = publicDraftExists || privateDraft.length > 0;
    if (hasDraft && (opts?.onConflict ?? 'reject') === 'reject') {
      throw Object.assign(
        new Error(`A WM draft already exists for "${name}" in context graph "${contextGraphId}"; pass onConflict:"replace" to overwrite it.`),
        { code: 'WM_DRAFT_CONFLICT' },
      );
    }

    // Archive the verified recovery commitment before unlocking the active
    // draft seal. Finalization must see no active seal so a sanctioned edit can
    // create the next assertion version, while pull/discard recovery can still
    // verify the last durable SWM/VM copy after a crash.
    await this.archiveAssertionSeal(
      contextGraphId,
      name,
      agentAddress,
      selectedSeal,
      subGraphName,
    );
    await this.clearActiveAssertionSeal(contextGraphId, name, agentAddress, subGraphName);

    // The complete source has been validated. Only now is replace allowed to
    // remove a dirty public or private draft.
    if (hasDraft) {
      await this.dropAssertionScopedGraphs(wmGraph);
      await this.privateStore.deleteKnowledgeAssetPrivateDraft(
        contextGraphId,
        agentAddress,
        name,
        subGraphName,
      );
    }
    await this.assertionCreateUnlocked(contextGraphId, name, agentAddress, subGraphName);
    // The source was already canonicalized and seal-verified. Re-materialize it
    // through the internal exact-graph primitive: public assertionWrite rightly
    // rejects protocol-owned c14n skolem IRIs as user input.
    await this.replaceExactKnowledgeAssetGraph(
      wmGraph,
      validated.normalizedPublicQuads,
      'Knowledge Asset pull-from',
    );
    if (validated.normalizedPrivateQuads.length > 0) {
      await this.privateStore.storeKnowledgeAssetPrivateDraftTriples(
        contextGraphId,
        agentAddress,
        name,
        validated.normalizedPrivateQuads,
        subGraphName,
      );
    }
    return {
      seeded: validated.normalizedPublicQuads.length + validated.normalizedPrivateQuads.length,
      seededPublic: validated.normalizedPublicQuads.length,
      seededPrivate: validated.normalizedPrivateQuads.length,
      fromLayer: sourceLayer,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
    };
  }

  async assertionPromote(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: AssertionPromoteOptions,
  ): Promise<AssertionPromoteResult> {
    const stableOpts: AssertionPromoteOptions | undefined = opts
      ? {
          ...opts,
          ...(Array.isArray(opts.entities) ? { entities: [...opts.entities] } : {}),
          ...(opts.allowedPeers ? { allowedPeers: [...opts.allowedPeers] } : {}),
          ...(opts.trustedNonManifestCatalogTriples
            ? {
                trustedNonManifestCatalogTriples:
                  new Set(opts.trustedNonManifestCatalogTriples),
              }
            : {}),
        }
      : undefined;
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      stableOpts?.subGraphName,
      () => this.assertionPromoteUnlocked(contextGraphId, name, agentAddress, stableOpts),
    );
  }

  private async assertionPromoteUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: AssertionPromoteOptions,
  ): Promise<AssertionPromoteResult> {
    // #1464 (PR1, diagnostic) — every awaited op below runs BEFORE the
    // `store.insert(swmQuads)` that actually lands the root in SWM. A masked
    // rejection here (typically a sparql-http read hitting the 30s
    // `AbortSignal.timeout` under load) is the leading hypothesis for the
    // intermittent count-0. `tagPromoteStep` re-labels any such throw as
    // "[promote:<step>] …" so CI/UI names the failing op — it does NOT retry,
    // swallow, or change control flow, and the `store.insert` write itself is
    // deliberately left untagged.
    await tagPromoteStep('ensureSubGraphRegistered', () => this.ensureSubGraphRegistered(contextGraphId, opts?.subGraphName));
    await tagPromoteStep('assertGraphScopedLifecycleWritable', () =>
      this.assertGraphScopedLifecycleWritable(
        contextGraphId,
        agentAddress,
        name,
        opts?.subGraphName,
      ));
    if (opts?.entities && opts.entities !== 'all') {
      throw Object.assign(
        new Error(
          'A graph-scoped Knowledge Asset is atomic. Create a new KA instead of sharing a subject subset.',
        ),
        { code: 'KA_ATOMIC_SHARE_REQUIRED' },
      );
    }
    const sealSubject = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const promoteMetaGraph = contextGraphMetaUri(contextGraphId);
    const sealResult = await this.store.query(
      `CONSTRUCT { <${assertSafeIri(sealSubject)}> ?p ?o } WHERE {
        GRAPH <${assertSafeIri(promoteMetaGraph)}> { <${assertSafeIri(sealSubject)}> ?p ?o }
      }`,
    );
    const seal = parseAssertionSealQuads(
      sealResult.type === 'quads' ? sealResult.quads : [],
      sealSubject,
    );
    if (!seal) {
      throw Object.assign(
        new Error('Graph-scoped KA sharing requires a finalized v2 assertion seal'),
        { code: 'UNSEALED_SHARE_BLOCKED' },
      );
    }
    if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    if (
      !seal.kaUal
      || !seal.assertionVersion
      || seal.publicTripleCount === undefined
      || seal.privateTripleCount === undefined
    ) {
      throw new Error(`Graph-scoped assertion seal for <${sealSubject}> is incomplete`);
    }
    const contentScope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
    const immutablePrivateQuads = await tagPromoteStep(
      'knowledgeAssetPrivateQuads',
      () => this.privateStore.getKnowledgeAssetPrivateTriples(
        contextGraphId,
        contentScope,
        opts?.subGraphName,
      ),
    );
    const graphUri = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.WorkingMemory,
      contentScope,
      opts?.subGraphName,
    );
    const swmGraphUri = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      contentScope,
      opts?.subGraphName,
    );
    const vmGraphUri = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      contentScope,
      opts?.subGraphName,
    );

    // #1116 (round 10) — the swmShareComplete marker MUST be maintained on EVERY
    // return path of assertionPromote, not just the success tail. A non-full share
    // (subset/partial/foreign-skipped) that filters to ZERO promotable quads (the
    // early returns below) would otherwise leave a STALE marker from a prior full
    // share, letting finalize(layer:"swm")/publish pass their gate against the OLD
    // SWM contents. `promotingAllEntities` is hoisted here so every exit can
    // compute the correct scope; `maintainMarker(isFull)` is called before each
    // return with `isFull = promotingAllEntities && promotedAllRoots` for that path.
    // (Member-row REPLACE stays at the success path — it only matters when quads
    // are actually promoted; the MARKER is the cross-cutting invariant.)
    const promotingAllEntities = true;
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const maintainMarker = async (isFullCompletePromote: boolean): Promise<void> => {
      if (isFullCompletePromote) {
        await this.markSwmShareCompleteUnlocked(contextGraphId, name, agentAddress, opts?.subGraphName);
      } else {
        await this.clearSwmShareCompleteUnlocked(contextGraphId, name, agentAddress, opts?.subGraphName);
      }
    };

    let assertionQuads = await tagPromoteStep(
      'assertionScopedQuads',
      () => this.assertionScopedQuads(graphUri),
    );
    const parsePlainLiteral = (raw: string | undefined, code: string): string | undefined => {
      if (raw === undefined) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value === 'string' && value.length > 0) return value;
      } catch {
        // Fall through to the typed corruption error below.
      }
      throw Object.assign(
        new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> contains malformed state`),
        { code },
      );
    };
    // Read the layer first. On empty-WM recovery the exact SWM graph must be
    // validated and any stale completion marker cleared before operation
    // metadata is parsed: corrupt IDs/intents must never leave a publishable
    // marker exposed.
    const layerResult = await this.store.query(
      `SELECT ?layer WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
        <${assertSafeIri(lifecycleSubject)}> <http://dkg.io/ontology/memoryLayer> ?layer
      } } LIMIT 2`,
    );
    if (layerResult.type !== 'bindings') {
      throw Object.assign(
        new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
        { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
      );
    }
    if (layerResult.bindings.length > 1) {
      throw Object.assign(
        new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting memory layers`),
        { code: 'KA_LIFECYCLE_LAYER_CONFLICT' },
      );
    }
    const lifecycleLayer = parsePlainLiteral(
      layerResult.bindings[0]?.['layer'],
      'KA_LIFECYCLE_LAYER_CORRUPT',
    );
    const hasCompletionMarker = await this.hasSwmShareComplete(
      contextGraphId,
      name,
      agentAddress,
      opts?.subGraphName,
    );
    let resumingCommittedSwm = false;
    let preserveLegacyCompletionMarker = false;
    if (assertionQuads.length > 0 && hasCompletionMarker) {
      // A live WM source means this is either a reopened draft or an
      // interrupted promote whose exact SWM write landed before WM cleanup.
      // In both cases the old marker is not proof that the current durable
      // tail is complete. Clear it before parsing fallible operation metadata
      // so malformed recovery state can never leave a publishable marker.
      await maintainMarker(false);
    }
    if (assertionQuads.length === 0) {
      if (lifecycleLayer === MemoryLayer.VerifiableMemory) {
        // A confirmed publish consumes SWM and leaves WM empty. A stale retry
        // must be a non-mutating no-op, but only after the exact VM graph and
        // immutable private partition still validate against the persisted seal.
        // This retains the old idempotency guarantee without trusting legacy
        // extraction markers or reconstructing scope from RDF subjects.
        const existingVmQuads = (await this.assertionScopedQuads(vmGraphUri)).filter(
          (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
        );
        const existingPrivateQuads = immutablePrivateQuads.filter(
          (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
        );
        await validateGraphScopedPayloadAgainstSeal(
          seal,
          existingVmQuads,
          existingPrivateQuads,
          'verifiable-memory',
        );
        await maintainMarker(false);
        return { promotedCount: 0, promotedAllRoots: false };
      }

      const existingSwmQuads = (await this.assertionScopedQuads(swmGraphUri)).filter(
        (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
      );
      if (
        hasCompletionMarker
        || lifecycleLayer === MemoryLayer.SharedWorkingMemory
        || existingSwmQuads.length > 0
      ) {
        // A completed promote deliberately removes WM. A crash can also land
        // the exact SWM graph before the lifecycle, operation snapshot, head,
        // or completion marker. Validate the complete sealed payload and then
        // run the idempotent commit tail again so a retry repairs every durable
        // record and returns gossip for replay instead of merely saying no-op.
        const existingPrivateQuads = immutablePrivateQuads.filter(
          (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
        );
        try {
          await validateGraphScopedPayloadAgainstSeal(
            seal,
            existingSwmQuads,
            existingPrivateQuads,
            'shared-memory',
          );
        } catch (error) {
          await maintainMarker(false);
          throw error;
        }
        // A marker inherited from an older commit ordering is not proof that
        // the immutable operation snapshot and monotonic head are durable.
        // Clear it immediately after the exact SWM payload validates, before
        // parsing any fallible operation metadata. The sole exception is a
        // completed pre-intent promotion: those rows have a durable operation
        // ID, snapshot, head, and marker but no promoteOperationIntent. Keep
        // that already-published state readable as a non-mutating no-op once
        // its complete durable tail is verified below; it cannot be replayed
        // because its original wire timestamp is unavailable.
        if (hasCompletionMarker) {
          const intentPresence = await this.store.query(
            `ASK { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
              <${assertSafeIri(lifecycleSubject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?intent
            } }`,
          );
          if (intentPresence.type !== 'boolean') {
            await maintainMarker(false);
            throw Object.assign(
              new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
              { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
            );
          }
          preserveLegacyCompletionMarker = !intentPresence.value;
        }
        if (!preserveLegacyCompletionMarker) await maintainMarker(false);
        assertionQuads = existingSwmQuads;
        resumingCommittedSwm = true;
      }
    }

    // Keep the operation cardinality checks separate and bounded. Combining
    // OPTIONALs creates a Cartesian product on corrupt rows — precisely the
    // sort of recovery path that should not double as an accidental OOM test.
    const [operationIdResult, promoteIntentResult] = await Promise.all([
      this.store.query(
        `SELECT ?shareOperationId WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
          <${assertSafeIri(lifecycleSubject)}> <${SHARE_OPERATION_ID_PRED}> ?shareOperationId
        } } LIMIT 2`,
      ),
      this.store.query(
        `SELECT ?promoteIntent WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
          <${assertSafeIri(lifecycleSubject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?promoteIntent
        } } LIMIT 2`,
      ),
    ]);
    if (preserveLegacyCompletionMarker) {
      if (
        operationIdResult.type === 'bindings'
        && operationIdResult.bindings.length === 1
        && promoteIntentResult.type === 'bindings'
        && promoteIntentResult.bindings.length === 0
      ) {
        let legacyOperationId: string | undefined;
        try {
          legacyOperationId = parsePlainLiteral(
            operationIdResult.bindings[0]?.['shareOperationId'],
            'KA_SHARE_OPERATION_ID_CORRUPT',
          );
        } catch (error) {
          await maintainMarker(false);
          throw error;
        }
        if (
          legacyOperationId
          && await this.hasDurableAssertionPromoteTail(
            contextGraphId,
            legacyOperationId,
            contentScope.ual,
            contentScope.assertionVersion,
            opts?.subGraphName,
          )
        ) {
          return {
            promotedCount: 0,
            promotedAllRoots: false,
            shareOperationId: legacyOperationId,
          };
        }
      }
      // The shape was not a complete legacy commit. Remove the stale marker
      // before the normal conflict/corruption path reports the exact reason.
      await maintainMarker(false);
    }
    if (operationIdResult.type !== 'bindings' || promoteIntentResult.type !== 'bindings') {
      throw Object.assign(
        new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
        { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
      );
    }
    if (operationIdResult.bindings.length > 1) {
      throw Object.assign(
        new Error(
          `Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting durable share operation IDs`,
        ),
        { code: 'KA_SHARE_OPERATION_ID_CONFLICT' },
      );
    }
    if (promoteIntentResult.bindings.length > 1) {
      throw Object.assign(
        new Error(
          `Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting durable promote intent`,
        ),
        { code: 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' },
      );
    }
    const durableShareOperationId = parsePlainLiteral(
      operationIdResult.bindings[0]?.['shareOperationId'],
      'KA_SHARE_OPERATION_ID_CORRUPT',
    );
    const durablePromoteIntentValue = parsePlainLiteral(
      promoteIntentResult.bindings[0]?.['promoteIntent'],
      'KA_PROMOTE_OPERATION_INTENT_CORRUPT',
    );
    if (!durableShareOperationId && durablePromoteIntentValue) {
      throw Object.assign(
        new Error(
          `Graph-scoped assertion lifecycle <${lifecycleSubject}> has promote intent without an operation ID`,
        ),
        { code: 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' },
      );
    }
    const durablePromoteIntent = durablePromoteIntentValue && durableShareOperationId
      ? parsePromoteOperationIntent(durablePromoteIntentValue, durableShareOperationId)
      : undefined;
    if (assertionQuads.length > 0 && durableShareOperationId) {
      // The exact SWM graph may have committed before a later snapshot/head
      // write failed, while WM is intentionally retained for retry. Recognize
      // that old-or-new atomic outcome only when it matches this sealed KA and
      // a durable operation claim exists; an older mismatching SWM version is
      // simply replaced by the normal path below.
      const existingSwmQuads = (await this.assertionScopedQuads(swmGraphUri)).filter(
        (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
      );
      if (existingSwmQuads.length > 0) {
        try {
          await validateGraphScopedPayloadAgainstSeal(
            seal,
            existingSwmQuads,
            immutablePrivateQuads.filter(
              (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
            ),
            'shared-memory',
          );
          resumingCommittedSwm = true;
        } catch {
          // A previous SWM version is not an interrupted commit of this seal.
        }
      }
    }
    if (assertionQuads.length === 0 && immutablePrivateQuads.length === 0) {
      await maintainMarker(false);
      throw Object.assign(
        new Error(
          `Finalized graph-scoped assertion <${sealSubject}> has no materialized public or private content`,
        ),
        { code: 'KA_GRAPH_CONTENT_MISSING' },
      );
    }

    let quadsToPromote = assertionQuads;

    // ── Bug 8 (Codex Round 4) + Round 9 Bug 25 — import-bookkeeping filter ──
    // Defense-in-depth: reserved-prefix subjects SHOULD already have
    // been rejected at the write boundary by `rejectReservedSubjectPrefixes`
    // (Round 9 Bug 25 per `19_MARKDOWN_CONTENT_TYPE.md §10.2`). User-
    // authored writes with `urn:dkg:file:*` or `urn:dkg:extraction:*`
    // subjects are short-circuited at `assertionWrite`, `share`,
    // `conditionalShare`, and non-`fromSharedMemory` `publish` entry
    // points. This promote-time filter is kept as a belt-and-suspenders
    // safety net for quads that legitimately enter the store through
    // a path that bypasses the write guard — namely the daemon's
    // import-file handler, which writes file descriptors and
    // ExtractionProvenance blocks via a direct `store.insert` call
    // (documented at `daemon.ts:2663-2668`) precisely because those
    // URN subjects are protocol-reserved and belong in WM/`_meta`,
    // not promoted SWM.
    //
    // The `<urn:dkg:file:...>` file descriptor block (rows 4-8 of the
    // §10.2 linkage table) and the `<urn:dkg:extraction:<uuid>>`
    // ExtractionProvenance block (rows 9-13) are subordinate metadata
    // about the extraction RUN, not semantic knowledge about an Entity.
    // Without this filter, `skolemizeByEntity` below would treat
    // `<urn:dkg:file:keccak256:abc>` as a root entity and cross-assertion
    // ownership would contend when two different assertions reference
    // the same file content (same keccak256 → same URN → same
    // ownership slot). Filtering the subject-prefix before partitioning
    // means:
    //   - Row 1 (`<entityUri> dkg:sourceFile <urn:dkg:file:...>`)
    //     SURVIVES because its subject is the doc entity, not the file
    //     URN — only OBJECTs are `urn:dkg:file:...`, not subjects. So
    //     SWM consumers still see "this entity came from this file".
    //   - Rows 4-5, 8 on `<fileUri>` are stripped — file descriptor
    //     absent from SWM. Content-addressed blob lookup remains
    //     available via the literal `dkg:sourceFileHash` in `_meta`.
    //   - Rows 9-13 on `<provUri>` are stripped — prov block absent
    //     from SWM.
    //
    // Because Bug 25's write-time guard means no user-authored data
    // in those namespaces can exist in the store, filtering by prefix
    // on promote cannot drop legitimate user data.
    //
    // See `19_MARKDOWN_CONTENT_TYPE.md §10.2` for the normative rule
    // and Codex Bug 8 Round 4 reconciled ruling for the history (Round
    // 3 tried blank-node subjects but an `skolemizeByEntity` audit showed
    // they silently drop rows 9-13 on promote, which was worse).
    // Round 12 Bug 35: source the prefix list from `RESERVED_SUBJECT_PREFIXES`
    // instead of hardcoding the two literals inline. If the reserved
    // namespace list ever gains a new prefix at the top of the file
    // (e.g., a future `urn:dkg:prov:` or `urn:dkg:ack:`), the promote
    // filter picks it up automatically without a separate code change —
    // single source of truth. The Round 9 write-time guard uses the
    // same constant, so both defenses always stay in sync.
    //
    // Round 14 Bug 41: use the case-insensitive `isReservedSubject`
    // helper instead of byte-level `startsWith`. Per RFC 8141 the URN
    // scheme and NID are case-insensitive, so `URN:dkg:file:...` is
    // semantically equivalent to `urn:dkg:file:...` and must be
    // filtered identically. See the helper's docstring for the full
    // argument.
    quadsToPromote = quadsToPromote.filter(
      (q) => !isReservedSubject(q.subject) && !isTrustLevelQuad(q),
    );

    await tagPromoteStep('assertTrustedCatalogTriplesAllowed', () => this.assertTrustedCatalogTriplesAllowed({
      contextGraphId,
      trustedNonManifestCatalogTriples: opts?.trustedNonManifestCatalogTriples,
      onChainContextGraphId: opts?.onChainContextGraphId,
      allowLocalPrivateContextGraph: true,
    }));
    const privateQuadsToPromote = immutablePrivateQuads.filter(
      (q) => !isReservedSubject(q.subject) && !isTrustLevelQuad(q),
    );
    if (quadsToPromote.length === 0 && privateQuadsToPromote.length === 0) {
      await maintainMarker(false);
      throw Object.assign(
        new Error(
          `Finalized graph-scoped assertion <${sealSubject}> contains only filtered protocol metadata`,
        ),
        { code: 'KA_GRAPH_CONTENT_MISSING' },
      );
    }

    const operationId = durableShareOperationId
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Canonicalize both partitions together so blank-node labels stay stable
    // across the public/private boundary and validate the complete sealed KA.
    let validatedPayload: Awaited<ReturnType<typeof validateGraphScopedPayloadAgainstSeal>>;
    try {
      validatedPayload = await validateGraphScopedPayloadAgainstSeal(
        seal,
        quadsToPromote,
        privateQuadsToPromote,
        'working-memory',
      );
    } catch (error) {
      await maintainMarker(false);
      throw error;
    }
    const normalizedQuads = validatedPayload.normalizedPublicQuads;
    const normalizedPrivateQuads = validatedPayload.normalizedPrivateQuads;
    const promotedPrivateRoot = validatedPayload.privateMerkleRoot;
    // A prior completed version may leave its marker intentionally preserved
    // while a new WM draft is prepared. Once this exact new payload validates,
    // retire that old proof before any encoding, confirmation, or other
    // fallible work. Only the final commit tail may expose completion again.
    await maintainMarker(false);
    const requestedAccessPolicy = opts?.accessPolicy
      ?? (normalizedPrivateQuads.length > 0 ? 'ownerOnly' : 'public');
    const requestedAllowedPeers = [...new Set(
      (opts?.allowedPeers ?? []).map((peerId) => peerId.trim()).filter(Boolean),
    )].sort();
    if (!durableShareOperationId) {
      if (requestedAccessPolicy === 'allowList' && requestedAllowedPeers.length === 0) {
        throw new Error('Graph-scoped assertion allowList policy requires allowedPeers');
      }
      if (requestedAccessPolicy !== 'allowList' && requestedAllowedPeers.length > 0) {
        throw new Error('Graph-scoped assertion allowedPeers requires allowList policy');
      }
    }

    if (!durablePromoteIntent && durableShareOperationId) {
      // Older partial commits persisted the ID but not the exact timestamp and
      // access envelope used on the wire. Reconstructing those fields from the
      // later operation record can change a replay under the same ID, so this
      // state is deliberately query/export-only until explicitly reconciled.
      throw Object.assign(
        new Error(
          `Durable share operation ${durableShareOperationId} has no immutable promote intent and cannot be replayed safely`,
        ),
        { code: 'KA_PROMOTE_OPERATION_INTENT_MISSING' },
      );
    }

    const operationIntent: PromoteOperationIntent = durablePromoteIntent ?? {
      version: 1,
      operationId,
      timestampMs: Date.now(),
      ...(opts?.publisherPeerId?.trim() ? { publisherPeerId: opts.publisherPeerId.trim() } : {}),
      confirmationRequired: opts?.confirmBeforeCommit !== undefined,
      accessPolicy: requestedAccessPolicy,
      allowedPeers: requestedAllowedPeers,
    };
    const accessPolicy = operationIntent.accessPolicy;
    const allowedPeers = operationIntent.allowedPeers;
    const operationTimestamp = new Date(operationIntent.timestampMs);
    if (opts?.confirmBeforeCommit && !operationIntent.publisherPeerId) {
      throw Object.assign(
        new Error('Curator-confirmed promote requires a publisherPeerId before claiming an operation ID'),
        { code: 'KA_PROMOTE_PUBLISHER_PEER_REQUIRED' },
      );
    }
    if (operationIntent.confirmationRequired && !opts?.confirmBeforeCommit) {
      throw Object.assign(
        new Error('This durable promote operation requires curator confirmation on every retry'),
        { code: 'KA_PROMOTE_CONFIRMATION_REQUIRED' },
      );
    }
    // Pre-encode gossip message and enforce size limit BEFORE any destructive
    // mutations, so oversized promotions are rejected cleanly while the
    // assertion is still intact in WM.
    let gossipMessage: Uint8Array | undefined;
    const operationPublisherPeerId = operationIntent.publisherPeerId;
    if (operationPublisherPeerId) {
      const dataGraph = this.graphManager.dataGraphUri(contextGraphId);
      const nquadsStr = normalizedQuads
        .map(
          (q) =>
            `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`,
        )
        .join('\n');
      const timestampMs = operationIntent.timestampMs;
      const encoded = encodeWorkspacePublishRequest({
        contextGraphId: contextGraphId,
        nquads: new TextEncoder().encode(nquadsStr),
        manifest: [],
        publisherPeerId: operationPublisherPeerId,
        shareOperationId: operationId,
        timestampMs,
        operationId,
        subGraphName: opts?.subGraphName,
        agentAddress: contentScope.agentAddress,
        kaNumber: contentScope.kaNumber,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: contentScope.ual,
        assertionVersion: contentScope.assertionVersion,
        publicTripleCount: normalizedQuads.length,
        ...(promotedPrivateRoot ? { privateMerkleRoot: promotedPrivateRoot } : {}),
        privateTripleCount: normalizedPrivateQuads.length,
        accessPolicy,
        allowedPeers,
      });

      // Wrap the plaintext publish-request in the encrypted envelope
      // when the CG requires it. Mirrors the `share()` and
      // `conditionalShare()` paths — without this, the receiver-side
      // check at `SharedMemoryHandler.handle` rejects the gossip
      // ("Sender Key encrypted workspace payload required for private
      // or agent-gated context graph"). Returns plaintext for public
      // CGs (resolver returns requiresEncryption=false).
      const wrapped = await tagPromoteStep('encodeWorkspaceGossipPayload', () => this.encodeWorkspaceGossipPayload(
        contextGraphId,
        encoded,
        {
          localOnly: opts?.localOnly === true,
          senderAgentAddress: opts?.senderAgentAddress,
          operationId,
          shareOperationId: operationId,
          timestampMs,
          subGraphName: opts?.subGraphName,
          publisherPeerId: operationPublisherPeerId,
        },
      ));

      if (wrapped.length > DKG_GOSSIP_MAX_MESSAGE_BYTES) {
        const hint = 'Reduce the complete assertion payload size.';
        throw new SwmGossipPayloadTooLargeError({
          actualBytes: wrapped.length,
          maxBytes: DKG_GOSSIP_MAX_MESSAGE_BYTES,
          operation: 'promote',
          message:
            `Promoted assertion too large for gossip (${formatBytesAsKb(wrapped.length)}, limit ${formatGossipLimit(DKG_GOSSIP_MAX_MESSAGE_BYTES)}). ` +
            hint,
          hint,
        });
      }
      gossipMessage = wrapped;
    }

    // Persist the ID and its immutable envelope in one store call before any
    // external confirmer can apply it. Every retry reuses these exact fields;
    // one operation ID can never quietly acquire a new timestamp or policy.
    const serializedOperationIntent = JSON.stringify(operationIntent);
    const operationIdQuad: Quad = {
      subject: lifecycleSubject,
      predicate: SHARE_OPERATION_ID_PRED,
      object: `"${operationId}"`,
      graph: promoteMetaGraph,
    };
    const operationIntentQuad: Quad = {
      subject: lifecycleSubject,
      predicate: PROMOTE_OPERATION_INTENT_PRED,
      object: JSON.stringify(serializedOperationIntent),
      graph: promoteMetaGraph,
    };
    if (!durableShareOperationId) {
      await this.store.insert([operationIdQuad, operationIntentQuad]);

      // The in-memory lifecycle lock is deliberately instance-local. Re-read
      // the claim after insertion so two daemon processes sharing one store
      // cannot both pass an empty-state check and confirm different IDs. This
      // is a conservative compare-after-insert: a collision may make both
      // callers withdraw, but it can never let both escape externally.
      const [claimedIdsResult, claimedIntentsResult] = await Promise.all([
        this.store.query(
          `SELECT ?id WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
            <${assertSafeIri(lifecycleSubject)}> <${SHARE_OPERATION_ID_PRED}> ?id
          } } LIMIT 2`,
        ),
        this.store.query(
          `SELECT ?intent WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
            <${assertSafeIri(lifecycleSubject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?intent
          } } LIMIT 2`,
        ),
      ]);
      const claimedId = claimedIdsResult.type === 'bindings'
        && claimedIdsResult.bindings.length === 1
        ? parsePlainLiteral(claimedIdsResult.bindings[0]?.['id'], 'KA_SHARE_OPERATION_ID_CORRUPT')
        : undefined;
      const claimedIntent = claimedIntentsResult.type === 'bindings'
        && claimedIntentsResult.bindings.length === 1
        ? parsePlainLiteral(
            claimedIntentsResult.bindings[0]?.['intent'],
            'KA_PROMOTE_OPERATION_INTENT_CORRUPT',
          )
        : undefined;
      if (claimedId !== operationId || claimedIntent !== serializedOperationIntent) {
        await this.store.delete([operationIdQuad, operationIntentQuad]);
        throw Object.assign(
          new Error(`A different promote operation already claimed assertion "${name}"`),
          { code: 'KA_SHARE_OPERATION_ID_CONFLICT' },
        );
      }
    }

    // Strict curator-ack gate (OT-RFC-49 curator-leader) for the WM→SWM promote
    // path — the same confirm-before-commit seam as `_shareImpl`, here between the
    // gossip-message build (above) and the SWM mutation (below). A non-confirmation
    // aborts the promote with NO SWM mutation, leaving WM intact for retry. The
    // per-KA promote lock stays held across confirmation and the complete local
    // commit, so concurrent callers cannot expose two operation IDs for one
    // UAL/version. Fail closed if the message is somehow absent (cannot confirm
    // what we cannot send).
    if (opts?.confirmBeforeCommit) {
      if (!gossipMessage) throw new CuratorUnconfirmedError(contextGraphId);
      const confirmation = await opts.confirmBeforeCommit(gossipMessage);
      if (!confirmation.applied) {
        if (confirmation.rejected) {
          // A definitive rejection proves the curator did not apply this
          // provisional operation, so a corrected fresh-WM retry may claim a
          // new ID. An ID that existed at method entry is never removed: an
          // earlier ambiguous confirmation may already have applied it.
          if (!durableShareOperationId) {
            await this.store.delete([operationIdQuad, operationIntentQuad]);
          }
          throw new CuratorRejectedError(contextGraphId);
        }
        throw new CuratorUnconfirmedError(contextGraphId);
      }
    }

    // The UAL-derived graph is the ownership boundary. Replace the complete
    // graph; never inspect, claim, skip, or delete individual RDF subjects.
    const swmQuads = normalizedQuads.map((q) => ({ ...q, graph: swmGraphUri }));
    await this.replaceExactKnowledgeAssetGraph(
      swmGraphUri,
      swmQuads,
      'Knowledge Asset WM-to-SWM promotion',
    );
    // #2079: the SIXTH replace site. Same graph the catch-up witness keys on,
    // so the memo now describes content that is gone — and a replace leaves the
    // quad count intact, which is exactly what the count gate cannot see.
    //
    // Reachable on default config: this node witnesses its own KA
    // (`onSnapshotReady(snapshot, 'cache')` has no self-peer filter), and the
    // curator-ack gate is off by default, so gossip publishes only after promote
    // returns. Promote v2, let the fallible tail below throw, and the curator
    // still advertises v1 — the next round's descriptor is v1, the count
    // matches, and a standing v1 witness would HIT.
    //
    // Deliberately NOT folded into `replaceExactKnowledgeAssetGraph`: of its
    // SIX call sites this is the only one targeting a SWM assertion graph — the
    // rest are `dataGraph` ×2, `vmGraph`, `wmGraph`, and one pass-through
    // `graphUri` — so folding it in would add a serialised changelog round-trip
    // to five replaces that can never hold a witness. Enumerated, not counted:
    // an earlier revision of this comment said "five of seven" and was wrong on
    // both numbers.
    await invalidateSwmMaterializationWitness(this.store, swmGraphUri, {
      source: 'publisher.promoteWmToSwm.witnessInvalidate',
    }).catch(() => {});
    // NB: WM source cleanup and the pending-share-operation clear happen at the
    // very END of this tail. Every write between here and there is fallible; if
    // WM were dropped now (or the recovery pointer cleared), a failure below
    // would strand the promotion: retry re-enters, reads empty WM, and aborts
    // with KA_GRAPH_CONTENT_MISSING / a seal count mismatch.

    // Update the assertion's memory layer from WM → SWM in _meta
    const assertionMetaGraph = contextGraphMetaUri(contextGraphId);
    const DKG_MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';
    await this.store.deleteByPattern({
      graph: assertionMetaGraph,
      subject: graphUri,
      predicate: DKG_MEMORY_LAYER,
    });
    await this.store.insert([{
      subject: swmGraphUri,
      predicate: DKG_MEMORY_LAYER,
      object: '"SWM"',
      graph: assertionMetaGraph,
    }]);
    const promotedAllRoots = true; // compatibility return name; v2 has no roots.
    const isFullCompletePromote = true;
    await this.store.deleteByPattern({ graph: promoteMetaGraph, subject: lifecycleSubject, predicate: DKG_ROOT_ENTITY_LEGACY });
    await this.store.deleteByPattern({ graph: promoteMetaGraph, subject: lifecycleSubject, predicate: DKG_ENTITY });

    // Update assertion lifecycle record in _meta: created → promoted
    const promoted = generateAssertionPromotedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName: opts?.subGraphName,
      kaNumber: BigInt(contentScope.kaNumber),
      shareOperationId: operationId,
      rootEntities: [],
      timestamp: operationTimestamp,
    }, { provenanceEvents: this.provenanceEvents });
    await this.store.delete(promoted.delete);
    await this.store.insert(promoted.insert);

    await storeKnowledgeAssetOperationPublicQuads({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId,
      shareOperationId: operationId,
      kaUal: contentScope.ual,
      assertionVersion: contentScope.assertionVersion,
      quads: swmQuads,
      ...(promotedPrivateRoot ? { privateMerkleRoot: promotedPrivateRoot } : {}),
      privateTripleCount: normalizedPrivateQuads.length,
      publisherPeerId: operationIntent.publisherPeerId,
      accessPolicy,
      allowedPeers,
      agentAddress: contentScope.agentAddress,
      subGraphName: opts?.subGraphName,
      timestamp: operationTimestamp,
      publicSnapshotStore: this.publicSnapshotStore,
    });
    // The originator does not receive its own GossipSub message, so it must
    // persist the same monotonic KA head the receiver writes. Without this,
    // a delayed older peer replay could look like the first version locally
    // and replace the freshly promoted graph.
    await storeKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId,
      shareOperationId: operationId,
      kaUal: contentScope.ual,
      assertionVersion: contentScope.assertionVersion,
      subGraphName: opts?.subGraphName,
    });

    // This is the final commit record. It is intentionally written only after
    // the exact SWM graph, lifecycle operation id, immutable operation snapshot,
    // and monotonic KA head are durable. A retry that sees any earlier partial
    // state repairs the tail above before this marker can become visible.
    await maintainMarker(isFullCompletePromote);

    // Keep both the shareOperationId and immutable intent as durable replay
    // metadata. The former is also the lifecycle identity written by
    // generateAssertionPromotedMetadata; the latter is required to reproduce
    // the exact timestamp, policy, and publisher on an idempotent retry.
    // Reopened drafts explicitly wipe both rows in assertionCreateUnlocked.
    await this.dropAssertionScopedGraphs(graphUri);

    return {
      promotedCount: resumingCommittedSwm
        ? 0
        : swmQuads.length + normalizedPrivateQuads.length,
      gossipMessage,
      promotedAllRoots,
      shareOperationId: operationId,
    };
  }

  async assertionDiscard(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      () => this.assertionDiscardUnlocked(contextGraphId, name, agentAddress, subGraphName),
    );
  }

  private async assertionDiscardUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    await this.assertGraphScopedLifecycleWritable(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
    await this.assertNoUnfinishedAssertionPromote(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    await this.assertWorkingMemoryLifecycleMutable(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
    );
    const graphUri = await this.wmGraphUri(contextGraphId, agentAddress, name, subGraphName);
    // Drop the assertion data graph AND clean up any `_meta` rows keyed
    // by this assertion's UAL in the CG root `_meta` graph. Without this
    // second step, `<assertionUal> dkg:sourceFileHash ?h` and friends
    // would still resolve after a discard, pointing at a source blob
    // for an assertion graph that no longer exists. See spec §10.2.
    //
    // Pairs with the import-file route's stale-`_meta` cleanup: a
    // discarded assertion MUST leave zero rows in `_meta` keyed by its
    // UAL, so a subsequent re-create/re-import starts from a clean slate.
    //
    // Ordering (Codex Bug 12 fix): `_meta` cleanup FIRST, then data
    // graph drop. Previously the order was reversed, which meant a
    // transient failure on `deleteByPattern` would leave the assertion
    // body gone but `_meta` pointing at a hash for a vanished graph —
    // actively misleading to consumers ("why does `_meta` reference
    // this hash but `GET /assertion/name` 404s?"). With `_meta` first:
    //   - If `deleteByPattern` fails, the data graph is still intact
    //     and retry converges. No visible corruption.
    //   - If `dropGraph` fails after `_meta` succeeded, the data graph
    //     is orphaned (no `_meta` trail) — debuggable ("why does this
    //     graph exist with no `_meta`?") but not actively misleading.
    //
    // The non-atomicity is bounded by retries; neither partial state is
    // catastrophic. An atomic combined DELETE+DROP via a single SPARQL
    // UPDATE is tracked as a follow-up on the storage layer (needs a
    // new method on the `TripleStore` public interface).
    // Update assertion lifecycle record: created → discarded (before destructive ops)
    const discarded = generateAssertionDiscardedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName,
      timestamp: new Date(),
    }, { provenanceEvents: this.provenanceEvents });
    // #1095: discarding an open WM DRAFT of a KA that already has a
    // confirmed VM version must not mark the KA itself "discarded" — the
    // published assertion is still live on-chain (the descriptor would
    // otherwise report the contradictory pair state="discarded" +
    // status="vm-confirmed"). Keep the AssertionDiscarded event (it
    // accurately records that a draft was thrown away) but preserve the
    // "published" state and DON'T stamp prov:wasInvalidatedBy on the
    // lifecycle subject.
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const cgMetaGraphForDiscard = contextGraphMetaUri(contextGraphId);
    const vmPointerRes = await this.store.query(
      `SELECT ?vm WHERE { GRAPH <${cgMetaGraphForDiscard}> {
        <${lifecycleSubject}> <${VM_CURRENT_ASSERTION_PRED}> ?vm
      } } LIMIT 1`,
    );
    const confirmedVmMerkleHex = stripSparqlLiteral(
      vmPointerRes.type === 'bindings' ? vmPointerRes.bindings[0]?.['vm'] : undefined,
    )?.replace(/^0x/i, '').toLowerCase();
    const hasVmVersion = confirmedVmMerkleHex !== undefined;
    let preserveSwmRecoverySeal = false;
    if (!hasVmVersion) {
      const loadedSeals = await this.loadAssertionSeals(
        contextGraphId,
        name,
        agentAddress,
        subGraphName,
      );
      for (const loadedSeal of loadedSeals) {
        const seal = loadedSeal.seal;
        if (
          seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
          || !seal.kaUal
          || !seal.assertionVersion
        ) continue;
        const head = await resolveKnowledgeAssetWorkspaceHead({
          store: this.store,
          graphManager: this.graphManager,
          contextGraphId,
          kaUal: seal.kaUal,
          subGraphName,
        });
        preserveSwmRecoverySeal = head?.kaUal === seal.kaUal
          && head.assertionVersion === seal.assertionVersion;
        if (preserveSwmRecoverySeal) {
          await this.archiveAssertionSeal(
            contextGraphId,
            name,
            agentAddress,
            loadedSeal,
            subGraphName,
          );
          break;
        }
      }
    }
    if (hasVmVersion) {
      // A newly-finalized edit has an active seal even though the VM pointer
      // still identifies the prior confirmed assertion. Discard that draft
      // seal now; retain only an active seal that actually matches VM. The
      // archived recovery seal for the confirmed version remains untouched.
      await this.clearActiveAssertionSealsNotMatchingMerkle(
        contextGraphId,
        name,
        agentAddress,
        confirmedVmMerkleHex,
        subGraphName,
      );
      const DKG_STATE_PRED = 'http://dkg.io/ontology/state';
      const PROV_INVALIDATED = 'http://www.w3.org/ns/prov#wasInvalidatedBy';
      discarded.insert = discarded.insert.filter(
        (q) => !(q.subject === lifecycleSubject && (q.predicate === DKG_STATE_PRED || q.predicate === PROV_INVALIDATED)),
      );
    }
    await this.store.delete(discarded.delete);
    await this.store.insert(discarded.insert);

    const metaGraph = contextGraphMetaUri(contextGraphId);
    await this.store.deleteByPattern({ subject: graphUri, graph: metaGraph });
    // #1116 (review A1, round 5) — drop the SWM-share-complete marker too. A
    // marker survives discard via A2_PRESERVE on recreate, so a full-share →
    // discard → recreate → subset-share cycle would otherwise leave a stale
    // marker and let finalize(layer:"swm") publish the subset as the full KA.
    // Clearing on discard re-arms the gate: the next share must re-prove
    // completeness (a full share re-stamps it; a subset never sets it).
    //
    // #1116 (round 9) — ASYMMETRY (verified sound): the marker is cleared
    // UNconditionally here, but the seal + member rows only when !hasVmVersion
    // below. This is consistent: a confirmed publish already cleared the marker
    // (round 9 step 3), so a published KA (hasVmVersion) has NO marker at discard
    // and the unconditional clear is a no-op for it; its seal + rows are preserved
    // (they back the on-chain state / receipt lookups). There is no state where the
    // marker's absence misleads a consumer about a surviving seal: the marker gates
    // "publishable full share", and a published KA is correctly NOT re-publishable
    // as a fresh full share (its seal is the published one, used only for VM ops).
    await this.store.deleteByPattern({
      graph: metaGraph,
      subject: lifecycleSubject,
      predicate: SWM_SHARE_COMPLETE_PRED,
    });
    // #1116 (round 7) — CLEAR the lifecycle-URN member rows (dkg:rootEntity /
    // dkg:entity) too. They are the seal-less SWM-reconstruction source and they
    // SURVIVE a discard+recreate via A2_PRESERVE; without clearing them, a
    // discarded asset's stale members are carried into the recreated draft and a
    // later full skipSeal re-share would seal the stale UNION (the round-7 bug).
    // ONLY clear when the KA has no confirmed VM version: a draft-discard of an
    // already-PUBLISHED KA (hasVmVersion) preserves the on-chain state, and its
    // members back the receipt lookups — leave them (the next full publish
    // REPLACEs them with the current set anyway). A SWM-only / never-published
    // asset has no membership once discarded.
    if (!hasVmVersion) {
      await this.store.deleteByPattern({ graph: metaGraph, subject: lifecycleSubject, predicate: DKG_ROOT_ENTITY_LEGACY });
      await this.store.deleteByPattern({ graph: metaGraph, subject: lifecycleSubject, predicate: DKG_ENTITY });
    }
    // A never-shared draft has no durable source and must lose its seal. An
    // exact graph-scoped SWM head, however, is immutable recovery state just
    // like VM: retain its matching v2 seal so a later pull can reopen it.
    if (!hasVmVersion) {
      if (preserveSwmRecoverySeal) {
        await this.clearActiveAssertionSeal(contextGraphId, name, agentAddress, subGraphName);
      } else {
        await this.clearAssertionSealUnlocked(contextGraphId, name, agentAddress, subGraphName);
      }
    }
    await this.dropAssertionScopedGraphs(graphUri);
    await this.privateStore.deleteKnowledgeAssetPrivateDraft(
      contextGraphId,
      agentAddress,
      name,
      subGraphName,
    );
  }

  /**
   * #1116 — clear the Working-Memory draft DATA graph for an assertion plus the
   * now-stale WM lifecycle pointer, leaving the seal + SWM/VM state intact. Used
   * by the seal-in-SWM flow (finalize layer=swm) to drop the transient WM draft
   * it reconstructed from SWM, so the asset ends up resident PURELY in SWM (with
   * its fresh seal) instead of duplicated across WM+SWM. This mirrors
   * `assertionDiscard`'s data-graph teardown but does NOT stamp a "discarded"
   * lifecycle event.
   *
   * Two `_meta` clean-ups happen here:
   *   1. Rows keyed by the WM DATA-graph URI (the memoryLayer pointer etc.).
   *   2. #1116 FIX 2 — the `dkg:wmCurrentAssertion` pointer on the LIFECYCLE URN.
   *      `assertionFinalize` stamped it when it sealed the reconstructed WM draft,
   *      but once that draft is dropped the WM data no longer exists; without
   *      removing the pointer `agent.assertion.history()` / status APIs keep
   *      reporting a sealed WM draft ("wm-sealed") that is gone. We only clear it
   *      when `dkg:swmCurrentAssertion` IS present on the lifecycle URN — i.e. the
   *      content is genuinely SWM-resident — so the status flips to "swm-shared"
   *      (SWM-resident), consistent with the dropped WM data.
   *
   * Deliberately UNtouched: the seal (keyed by the assertion URI), `dkg:rootEntity`,
   * `dkg:kaId`, and `dkg:swmCurrentAssertion`/`dkg:vmCurrentAssertion`.
   */
  async clearWmDraftDataGraph(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    return this.withAssertionLifecycleWriteLock(
      contextGraphId,
      name,
      agentAddress,
      subGraphName,
      async () => {
        await this.assertNoUnfinishedAssertionPromote(
          contextGraphId,
          name,
          agentAddress,
          subGraphName,
        );
        await this.clearWmDraftDataGraphUnlocked(contextGraphId, name, agentAddress, subGraphName);
      },
    );
  }

  private async clearWmDraftDataGraphUnlocked(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = await this.wmGraphUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    await this.store.deleteByPattern({ subject: graphUri, graph: metaGraph });
    await this.dropAssertionScopedGraphs(graphUri);

    // #1116 FIX 2 — retire the stale WM lifecycle pointer once the WM draft is
    // gone, but only for SWM-resident content (swmCurrentAssertion set). The WM
    // pointer lives on the lifecycle URN, a DIFFERENT subject than the WM data
    // graph cleared above, so the deleteByPattern there never reaches it.
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const swmPointerRes = await this.store.query(
      `ASK { GRAPH <${metaGraph}> { <${lifecycleUri}> <${SWM_CURRENT_ASSERTION_PRED}> ?swm } }`,
    );
    const isSwmResident = swmPointerRes.type === 'boolean' && swmPointerRes.value === true;
    if (isSwmResident) {
      await this.store.deleteByPattern({
        subject: lifecycleUri,
        predicate: WM_CURRENT_ASSERTION_PRED,
        graph: metaGraph,
      });
    }
  }

  private async resolveKaUal(kaId: bigint): Promise<string> {
    const storageAddr = this.chain.getDKGKnowledgeAssetsAddress
      ? await this.chain.getDKGKnowledgeAssetsAddress()
      : undefined;
    if (!storageAddr) {
      throw new Error('Cannot resolve KA UAL: DKGKnowledgeAssets address unavailable');
    }
    return `did:dkg:${this.chain.chainId}/${storageAddr.toLowerCase()}/${kaId.toString()}`;
  }

  /**
   * OT-RFC-43 Option 1 — reserve the deterministic packed kaId for `author`'s
   * next V10 mint, or return `undefined` when no allocator is configured
   * (mock/no-chain/pre-Option-1 flows; the real EVM adapter then throws on the
   * missing reservedKaId). On first use per author this process it reconciles
   * the allocator's floor against the chain's highest minted number
   * (`max(local, chainMax) + 1`) so a stale local DB never re-hands a burned
   * `(author, number)` — that reconciliation also satisfies the allocator's
   * cold-start guard so `allocate()` is permitted.
   *
   * OT-RFC-43 A2 (decision 1) — when `precomputed` is supplied (a packed kaId
   * the AGENT already reserved+stamped at `assertionFinalize`), REUSE it
   * verbatim and SKIP allocation entirely. This makes finalize the single
   * source of truth for the id and eliminates the double-allocation that would
   * otherwise burn a second `(author, number)` on every finalize→publish.
   */
  private async ensureReservedKaId(author: string, precomputed?: bigint): Promise<bigint | undefined> {
    if (precomputed !== undefined) return precomputed;
    if (!this.kaAllocator) return undefined;
    const key = author.toLowerCase();
    if (!this.reconciledKaAuthors.has(key)) {
      let chainMax = -1n;
      if (this.chain.getMaxKaNumberForAuthor) {
        try {
          chainMax = await this.chain.getMaxKaNumberForAuthor(author);
        } catch (err) {
          // A flaky/incapable oracle must not silently let the allocator reuse a
          // number; surface it so the operator notices rather than burning ids.
          // (The contract's _safeMint revert remains the ultimate backstop.)
          throw new Error(
            `OT-RFC-43 Option 1: failed to reconcile KA-number floor for author ${author} ` +
            `against chain: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (chainMax >= 0n) {
        // chainMax is the highest minted number; reconcile() raises the floor to chainMax + 1.
        // Pass the bigint straight through (PR #976 F6) — `Number()` would lose precision past 2^53.
        this.kaAllocator.reconcile(author, chainMax);
      }
      this.kaAllocator.markReconciled();
      this.reconciledKaAuthors.add(key);
    }
    const { kaId } = this.kaAllocator.allocate(author);
    return kaId;
  }

}

/**
 * Parse a SPARQL COUNT result that may be a bare number string, a quoted
 * string, or a typed literal (e.g. `"0"^^<xsd:integer>`, `"0"^^<xsd:long>`).
 * Returns the numeric value, or NaN if unparseable.
 */
function parseCountLiteral(val: string | false | undefined): number {
  if (!val) return NaN;
  const stripped = val.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : NaN;
}

function stripSparqlLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('"')) return value;
  return value.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
}

function rdfLexicalValue(value: string | undefined): string | undefined {
  return stripSparqlLiteral(value);
}

function addOwner(owners: Map<string, Set<string>>, root: string, owner: string): void {
  if (!owners.has(root)) owners.set(root, new Set());
  owners.get(root)!.add(owner);
}

function setEffectiveOwner(owners: Map<string, string>, root: string, owner: string): void {
  const existing = owners.get(root);
  if (!existing || owner < existing) {
    owners.set(root, owner);
  }
}
