import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter, OnChainPublishResult, AddBatchToContextGraphParams } from '@origintrail-official/dkg-chain';
import { enrichEvmError } from '@origintrail-official/dkg-chain';
import type { EventBus, OperationContext } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, sha256, encodeWorkspacePublishRequest, encodeEncryptedWorkspacePayload, encryptWorkspacePayload, contextGraphDataUri, contextGraphDataGraphUri, contextGraphMetaUri, contextGraphAssertionUri, assertionLifecycleUri, contextGraphSubGraphUri, contextGraphSubGraphMetaUri, SYSTEM_CONTEXT_GRAPHS, validateSubGraphName, isSafeIri, assertSafeIri, assertSafeRdfTerm, DKG_GOSSIP_MAX_MESSAGE_BYTES, type Ed25519Keypair, buildAuthorAttestationTypedData, buildUpdateAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, TrustLevel, TRUST_LEVEL_PREDICATE, assertNoUserAuthoredTrustLevelQuads, buildTrustLevelQuads, isTrustLevelQuad, DKG_ENTITY, DKG_ROOT_ENTITY_LEGACY, ENTITY_PRED_ALT } from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { DEFAULT_PUBLISH_EPOCHS, MAX_PUBLISH_EPOCHS, type Publisher, type PublishOptions, type PublishResult, type KAManifestEntry, type PhaseCallback, type V10CoreNodeACK } from './publisher.js';
import { skolemizeByEntity } from './auto-partition.js';
import { canonicalPublishPayload } from './canonical-publish-payload.js';
import { RESERVED_SUBJECT_PREFIXES, findReservedSubjectPrefix, isReservedSubject } from './reserved-subjects.js';
import { skolemize } from './skolemize.js';
import {
  computeTripleHashV10 as computeTripleHash,
  computePrivateRootV10 as computePrivateRoot,
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from './merkle.js';
import { validatePublishRequest } from './validation.js';
import {
  generateConfirmedFullMetadata,
  generateOwnershipQuads,
  generateAuthorshipProof,
  generateShareTransitionMetadata,
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateAssertionPublishedMetadata,
  generateAssertionDiscardedMetadata,
  generateTentativeMetadata,
  toHex,
  resolveUalByBatchId,
  promoteUpdatedKaToPerCgId,
  restateLabelGraphForUpdate,
  shouldApplyMaterialization,
  withMaterializationLock,
  writeMaterializedVersion,
  type MaterializedVersion,
  type KAMetadata,
} from './metadata.js';
import { storeWorkspaceOperationPublicQuads } from './workspace-resolution.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';
import { ethers } from 'ethers';
import type { WorkspaceAgentRecipientResolver } from './workspace-agent-recipients.js';
import {
  PublisherWalletRequiredError,
  StaleWriteError,
  ReservedNamespaceError,
  AssertionNotPersistedError,
  MultiRootPublishNotAtomicError,
  type CASCondition,
} from './errors.js';

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
  type CASCondition,
};

const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

/**
 * Minimal structural view of the OT-RFC-43 Option-1 KA-number allocator the
 * publisher needs to mint deterministic packed ids. The concrete
 * `KaNumberAllocator` (packages/agent) satisfies this; typing it structurally
 * here avoids an agent→publisher dependency cycle.
 */
export interface KaIdAllocator {
  /** Allocate the next packed kaId = (uint160(author)<<96)|number for `author`. */
  allocate(author: string): { kaId: bigint; number: number };
  /** Raise the per-author floor to `observedNumber + 1` (never lower) so the next allocate skips minted numbers. */
  reconcile(author: string, observedNumber: number): void;
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

function coercePublisherAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return undefined;
  const normalized = ethers.getAddress(value);
  return normalized === ethers.ZeroAddress ? undefined : normalized;
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

type InternalPublishOptions = PublishOptions & {
  [INTERNAL_ORIGIN_TOKEN]?: true;
};

interface PublisherSigner {
  address: string;
  source: 'publisherPrivateKey' | 'chainAdapter';
  signMessage(message: Uint8Array): Promise<string>;
  /**
   * Sign EIP-712 typed data. Required for RFC-001 author attestations
   * which use `\x19\x01` framing rather than the EIP-191 prefix that
   * `signMessage` applies. Native on `ethers.Wallet`; chain-adapter
   * fallbacks throw because the adapter's `signMessage` / `signMessageAs`
   * surface only handles EIP-191 hashes.
   */
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

function isInternalOrigin(options: PublishOptions): boolean {
  return (options as InternalPublishOptions)[INTERNAL_ORIGIN_TOKEN] === true;
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
  assertNoUserAuthoredTrustLevelQuads(quads);
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

  constructor(config: DKGPublisherConfig) {
    this.store = config.store;
    this.chain = config.chain;
    this.kaAllocator = config.kaAllocator;
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
    this.writeLocks = config.writeLocks ?? new Map();
    this.workspaceAgentRecipientResolver = config.workspaceAgentRecipientResolver;
    this.workspaceSenderKeyEncryptor = config.workspaceSenderKeyEncryptor;
    this.publicSnapshotStore = config.publicSnapshotStore;
  }

  setWorkspaceAgentRecipientResolver(resolver: WorkspaceAgentRecipientResolver | undefined): void {
    this.workspaceAgentRecipientResolver = resolver;
  }

  setWorkspaceSenderKeyEncryptor(encryptor: WorkspaceSenderKeyEncryptor | undefined): void {
    this.workspaceSenderKeyEncryptor = encryptor;
  }

  private async resolvePublisherAddress(
    contextGraphId?: bigint,
    options: PublisherAddressResolutionOptions = {},
  ): Promise<string | undefined> {
    if (this.publisherAddress) return this.publisherAddress;
    if (this.publisherAddressResolver) {
      const resolved = normalizePublisherAddress(await this.publisherAddressResolver(contextGraphId));
      if (resolved) return resolved;
    }
    return this.inferAdapterPublisherAddress(contextGraphId, options);
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

  private isChainV10Ready(): boolean {
    return this.chain.chainId !== 'none' &&
      typeof this.chain.isV10Ready === 'function' &&
      this.chain.isV10Ready();
  }

  private async refreshChainV10Readiness(): Promise<boolean> {
    if (this.isChainV10Ready()) return true;
    if (this.chain.chainId === 'none') return false;
    try {
      const chainIdGetter = (this.chain as unknown as { getEvmChainId?: () => Promise<bigint> }).getEvmChainId;
      const kavAddressGetter = (this.chain as unknown as { getKnowledgeAssetsLifecycleAddress?: () => Promise<string> })
        .getKnowledgeAssetsLifecycleAddress;
      if (typeof chainIdGetter === 'function') await chainIdGetter.call(this.chain);
      if (typeof kavAddressGetter === 'function') await kavAddressGetter.call(this.chain);
    } catch {
      // V9-only or incompletely configured adapters stay off the V10 path.
    }
    return this.isChainV10Ready();
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

  private async withWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const predecessor = Promise.all(uniqueKeys.map(k => this.writeLocks.get(k) ?? Promise.resolve()));
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    for (const k of uniqueKeys) {
      this.writeLocks.set(k, gate);
    }
    await predecessor;
    try {
      return await fn();
    } finally {
      resolve();
      for (const k of uniqueKeys) {
        if (this.writeLocks.get(k) === gate) this.writeLocks.delete(k);
      }
    }
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
      throw new Error(
        `SWM message too large (${formatBytesAsKb(message.length)}, limit ${formatGossipLimit(DKG_GOSSIP_MAX_MESSAGE_BYTES)}). ` +
        `Split large writes into multiple share() calls partitioned by root entity.`,
      );
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
      subGraphName?: string;
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
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');

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
          throw new Error(
            `Context graph "${contextGraphId}" is not registered on-chain. ` +
            `Run 'dkg context-graph register ${contextGraphId}' first to enable Verified Memory publishing.`,
          );
        }
      }
    }

    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options?.subGraphName);

    let sparql: string;
    if (selection === 'all') {
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`;
    } else {
      const roots = [...new Set(
        selection.rootEntities
          .map((r) => String(r).trim())
          .filter((r) => isSafeIri(r)),
      )];
      if (roots.length === 0) {
        const hadInput = selection.rootEntities.length > 0;
        throw new Error(
          hadInput
            ? `No valid rootEntities provided (all ${selection.rootEntities.length} entries failed IRI validation)`
            : `No rootEntities provided for context graph ${contextGraphId}`,
        );
      }
      const values = roots.map((r) => `<${r}>`).join(' ');
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        GRAPH <${swmGraph}> {
          VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )
        }
      }`;
    }

    const result = await this.store.query(sparql);
    const quads: Quad[] = result.type === 'quads'
      ? result.quads.filter((q) => !isTrustLevelQuad(q) && q.predicate !== WORKSPACE_OWNER_PREDICATE)
      : [];

    if (quads.length === 0) {
      throw new Error(`No quads in shared memory for context graph ${contextGraphId} matching selection`);
    }
    // OT-RFC-44 / Design B: once the caller has selected one lifecycle/file,
    // that payload may contain N root entities and still publish as ONE KA in a
    // single transaction. Higher-level selection endpoints keep their
    // unrelated-root guard until they can identify that one lifecycle boundary.
    const rootEntities = [...skolemizeByEntity(quads).keys()];

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

    this.log.info(ctx, `Publishing ${quads.length} quads from shared memory to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'data graph'}${chainCgId && !ctxGraphId ? ` (on-chain CG ${chainCgId})` : ''}${options?.subGraphName ? ` (sub-graph: ${options.subGraphName})` : ''}`);
    const internalPublishOptions: InternalPublishOptions = {
      contextGraphId,
      quads: quads.map((q) => ({ ...q, graph: '' })),
      operationCtx: ctx,
      onPhase: options?.onPhase,
      v10ACKProvider: options?.v10ACKProvider,
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
      [INTERNAL_ORIGIN_TOKEN]: true,
    };
    const publishResult = await this.publish(internalPublishOptions);

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
    if (targetCgId && publishResult.status === 'confirmed' && publishResult.onChainResult) {
      // V10 publishDirect already registers the KC to the context graph
      // via an internal call to ContextGraphs.registerKnowledgeAsset
      // (Hub-authorized only — EOAs cannot call it directly). The legacy
      // V9 flow required a separate addBatchToContextGraph tx; that path
      // is no longer available. Attempt the explicit verify call as a
      // fallback for non-V10 chains, but treat "Only Contracts in Hub"
      // rejections as success (V10 already handled it).
      let registered = false;
      if (typeof this.chain.verify === 'function') {
        let participantSigs = options?.contextGraphSignatures ?? [];
        if (participantSigs.length === 0 && typeof this.chain.signMessage === 'function') {
          const identityId = this.publisherNodeIdentityId;
          if (identityId > 0n) {
            const digest = ethers.solidityPackedKeccak256(
              ['uint256', 'bytes32'],
              [BigInt(targetCgId), ethers.hexlify(publishResult.merkleRoot)],
            );
            const sig = await this.chain.signMessage(ethers.getBytes(digest));
            participantSigs = [{ identityId, ...sig }];
          }
        }

        const sortedSigs = [...participantSigs]
          .sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
          .filter((s, i, arr) => i === 0 || s.identityId !== arr[i - 1].identityId);

        try {
          const txResult = await this.chain.verify({
            contextGraphId: BigInt(targetCgId),
            batchId: publishResult.onChainResult.batchId,
            merkleRoot: publishResult.merkleRoot,
            signerSignatures: sortedSigs,
          });
          if (txResult && typeof txResult === 'object' && 'success' in txResult && txResult.success) {
            registered = true;
            this.log.info(ctx, `Batch ${publishResult.onChainResult.batchId} verified on context graph ${targetCgId}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // V10 publishDirect handles registration internally via a
          // Hub-authorized call. Any revert here (typically
          // "Only Contracts in Hub" / CALL_EXCEPTION) means the
          // explicit verify path is not applicable — treat as success.
          registered = true;
          this.log.info(ctx, `Explicit verify not needed (V10 auto-registered): ${msg.slice(0, 120)}`);
        }
      } else {
        registered = true;
        this.log.info(ctx, `No verify function on chain adapter — assuming V10 auto-registration for context graph ${targetCgId}`);
      }

      if (registered) {
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
          const storedQuads = publishResult.publicQuads.map(q => ({ ...q, graph: defaultDataGraph }));
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
                graph: defaultDataGraph,
                subject,
                predicate: TRUST_LEVEL_PREDICATE,
              });
            }
          }
        }

        const ual = publishResult.ual;
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
          // Copy meta to the per-cgId graph (RS prover's
          // `extractV10KCFromStore` resolves UALs from
          // `dkg:batchId` here). On remap publishes the original
          // copy at `<NAME>/_meta` is also moved; on same-graph
          // publishes we leave the default copy in place so
          // existing meta queries against the label-only URI
          // continue to resolve.
          await this.store.insert(metaResult.quads.map(q => ({ ...q, graph: ctxMetaGraph })));
          if (ctxGraphId) {
            await this.store.delete(metaResult.quads.map(q => ({ ...q, graph: defaultMetaGraph })));
          }
        }

        // Stamp the publish version so a later update can compare against it
        // (and a concurrent stale re-promote is rejected above).
        await writeMaterializedVersion(this.store, ctxMetaGraph, publishResult.ual, publishVersion);

        this.log.info(ctx, `Promoted ${publishResult.kaManifest.length} KAs from default graph to context graph ${targetCgId}`);
        }
        });
      }
    }

    // SWM cleanup: ALWAYS remove published triples from SWM after chain confirmation.
    // Published triples must not linger in SWM — they live in LTM now.
    // clearSharedMemoryAfter controls only whether the REMAINING unpublished triples are also cleared.
    if (publishResult.status === 'confirmed') {
      const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, options?.subGraphName);
      const swmOwnershipKey = options?.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      const kaMap = skolemizeByEntity(quads);
      let ownerDeletedTotal = 0;
      for (const rootEntity of kaMap.keys()) {
        await this.store.deleteByPattern({ graph: swmGraph, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(swmGraph, rootEntity + '/.well-known/genid/');
        await this.store.deleteByPattern({
          graph: swmGraph, subject: rootEntity, predicate: WORKSPACE_OWNER_PREDICATE,
        });
        const ownerDeleted = await this.store.deleteByPattern({
          graph: swmMetaGraph, subject: rootEntity, predicate: WORKSPACE_OWNER_PREDICATE,
        });
        ownerDeletedTotal += ownerDeleted;
        await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
        this.sharedMemoryOwnedEntities.get(swmOwnershipKey)?.delete(rootEntity);
      }
      if (ownerDeletedTotal > 0) {
        this.log.info(ctx, `Cleared ${ownerDeletedTotal} published SWM triple(s) after confirmed publish`);
      }
      // If clearSharedMemoryAfter is explicitly true, also clear any remaining unpublished content.
      // Default is false: unpublished entities stay in SWM for future publishes.
      if (options?.clearSharedMemoryAfter === true) {
        const remainingCount = await this.store.deleteByPattern({ graph: swmGraph });
        const remainingMetaCount = await this.store.deleteByPattern({ graph: swmMetaGraph });
        if (remainingCount > 0 || remainingMetaCount > 0) {
          this.log.info(ctx, `Cleared remaining SWM content: ${remainingCount} triples, ${remainingMetaCount} meta`);
        }
        this.sharedMemoryOwnedEntities.delete(swmOwnershipKey);
      }
    }

    // Update assertion lifecycle records: promoted → published.
    // Runs for both confirmed and tentative publishes since data has
    // already moved to VM in either case.
    if (publishResult.ual) {
      const cgMetaGraph = contextGraphMetaUri(contextGraphId);
      const publishedRoots = publishResult.kaManifest.map((ka: any) => ka.rootEntity);
      const rootValues = publishedRoots.map((r) => `<${r}>`).join(' ');
      const findAssertions = await this.store.query(
        `SELECT DISTINCT ?assertion ?agent ?name WHERE {
          GRAPH <${cgMetaGraph}> {
            VALUES ?root { ${rootValues} }
            ?assertion a <http://dkg.io/ontology/Assertion> ;
                       <http://dkg.io/ontology/state> "promoted" ;
                       <http://dkg.io/ontology/rootEntity> ?root ;
                       <http://dkg.io/ontology/agent> ?agent ;
                       <http://dkg.io/ontology/assertionName> ?name .
          }
        }`,
      );
      if (findAssertions.type === 'bindings') {
        for (const row of findAssertions.bindings) {
          const agentUri = row['agent'];
          const assertionName = row['name']?.replace(/^"|"$/g, '');
          if (!agentUri || !assertionName) continue;
          const agentAddr = agentUri.replace('did:dkg:agent:', '');
          const published = generateAssertionPublishedMetadata({
            contextGraphId,
            agentAddress: agentAddr,
            assertionName,
            kcUal: publishResult.ual,
            timestamp: new Date(),
          });
          await this.store.delete(published.delete);
          await this.store.insert(published.insert);
        }
      }
    }

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
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    const effectiveAccessPolicy = accessPolicy ?? (privateQuads.length > 0 ? 'ownerOnly' : 'public');
    const normalizedAllowedPeers = [...new Set((allowedPeers ?? []).map((p) => p.trim()).filter(Boolean))];
    const normalizedPublisherPeerId = publisherPeerId.trim();
    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(options.publishContextGraphId ?? contextGraphId);
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
    const willAttemptOnChainPublish = publisherContextGraphId !== undefined;
    const chainV10Ready = await this.refreshChainV10Readiness();
    const canResolveOnChainPublisher = willAttemptOnChainPublish && chainV10Ready;
    const resolvedPublisherAddress = canResolveOnChainPublisher
      ? await this.resolvePublisherAddress(publisherContextGraphId)
      : await this.resolvePublisherAddress(undefined, {
        includeReservingPublisherProbe: false,
        includeGenericSignMessageProbe: false,
      });
    const publisherSigner = canResolveOnChainPublisher
      ? await this.getPublisherSigner(resolvedPublisherAddress)
      : undefined;
    const publisherAddress = resolvedPublisherAddress ?? this.localTentativePublisherAddress();
    const canAttemptOnChainPublish = willAttemptOnChainPublish &&
      chainV10Ready &&
      publisherSigner !== undefined;

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

    if (willAttemptOnChainPublish && chainV10Ready && !publisherSigner) {
      throw new PublisherWalletRequiredError('publish');
    }

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:ensureContextGraph', 'start');
    this.log.info(ctx, `Preparing publish: ${quads.length} public triples, ${privateQuads.length} private`);
    await this.graphManager.ensureContextGraph(contextGraphId);
    onPhase?.('prepare:ensureContextGraph', 'end');

    onPhase?.('prepare:partition', 'start');
    const canonical = canonicalPublishPayload(quads, privateQuads);
    onPhase?.('prepare:partition', 'end');

    const manifestEntries: KAManifestEntry[] = [];
    const kaMetadata: KAMetadata[] = [];

    onPhase?.('prepare:manifest', 'start');
    // OT-RFC-44 / Design B: one file/lifecycle = ONE Knowledge Asset, however
    // many entities it contains. The on-chain KA count and ACK digest stay at
    // one below, while these token IDs remain compatibility labels for
    // per-root response/meta subjects (`<ual>/1`, `<ual>/2`, ...).
    let compatibilityTokenId = 1n;
    for (const entry of canonical.manifestEntries) {
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

    const allSkolemizedQuads = canonical.skolemizedPublicQuads;
    onPhase?.('prepare:manifest', 'end');

    onPhase?.('prepare:validate', 'start');
    const publishOwnershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const existing = this.ownedEntities.get(publishOwnershipKey) ?? new Set();
    const validation = validatePublishRequest(allSkolemizedQuads, manifestEntries, contextGraphId, existing);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
    }
    onPhase?.('prepare:validate', 'end');

    onPhase?.('prepare:merkle', 'start');
    const privateRoots = canonical.privateRoots;
    const kcMerkleRoot = canonical.kcMerkleRoot;
    const kcMerkleLeafCount = computeFlatKCMerkleLeafCountV10(allSkolemizedQuads, privateRoots);
    if (kcMerkleLeafCount > 0xffffffff) {
      throw new Error(`V10 merkleLeafCount exceeds uint32: ${kcMerkleLeafCount}`);
    }
    this.log.info(ctx, `Computed kcMerkleRoot (flat) over ${allSkolemizedQuads.length} triple hashes + ${privateRoots.length} private root(s), leafCount=${kcMerkleLeafCount}`);
    // Design B: a publish mints exactly ONE KA regardless of entity count.
    // `entityCount` is informational; `kaCount` is what goes on chain as
    // `knowledgeAssetsAmount` (the contract requires == 1) and into the ACK
    // digest. The old `kaCount = manifestEntries.length` + `kaCount !== 1`
    // guard conflated entity count with KA count and blocked multi-entity
    // files; that conflation is the bug OT-RFC-44 removes.
    const entityCount = manifestEntries.length;
    const kaCount = 1;
    if (entityCount < 1) {
      throw new Error('V10 publish requires at least one entity');
    }
    this.log.info(ctx, `Design B: publishing 1 KA with ${entityCount} member entit${entityCount === 1 ? 'y' : 'ies'}`);
    onPhase?.('prepare:merkle', 'end');

    onPhase?.('prepare', 'end');
    onPhase?.('store', 'start');

    const dataGraph = options.targetGraphUri ?? this.graphManager.dataGraphUri(contextGraphId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    // RC11 / PR2: defer the public-data insert into the root data graph
    // until AFTER on-chain confirmation (or until the publisher's chain
    // branch is intentionally skipped because there is no chain to
    // confirm against — NoChainAdapter / non-V10 / no on-chain CG id).
    // Inserting pre-chain caused the "tentative VM" leak where
    // /api/query would surface quads from a publish that the chain
    // later rejected as if they were verified memory. See the chain
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
    for (const entry of canonical.manifestEntries) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === entry.rootEntity || q.subject.startsWith(entry.rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(contextGraphId, entry.rootEntity, entityPrivateQuads, options.subGraphName);
      }
    }

    onPhase?.('store', 'end');

    // Compute publicByteSize early — needed for signature collection
    const nquadsStr = allSkolemizedQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
      )
      .join('\n');
    const publicByteSize = BigInt(new TextEncoder().encode(nquadsStr).length);
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
      ual = `did:dkg:${this.chain.chainId}/${publisherAddress}/t${publishOperationId}`;
    };

    // V10: Collect core node StorageACKs (spec §9.0, Phase 3).
    // For direct publish: send staging quads inline via P2P so core nodes
    // can verify the merkle root without needing SWM pre-positioning.
    // For publishFromSharedMemory (publishContextGraphId set): data is already in
    // peers' SWM via shared memory gossip — do NOT send inline quads; core nodes
    // verify against their local SWM copy (preserving storage-attestation).
    // Skipped for private publishes because StorageACKHandler cannot
    // recompute private merkle roots from SWM data alone.
    const hasPrivateData = privateRoots.length > 0;
    const isPublishFromSharedMemory = !!options.fromSharedMemory;
    // OT-RFC-38 / LU-5: when an encryptInlinePayload hook is wired (curated
    // CGs only — DKGAgent resolves this from accessPolicy), ALWAYS send the
    // payload inline as AEAD ciphertext, regardless of `fromSharedMemory`.
    // Cores can't decrypt and they're not subscribed to curated SWM yet
    // (substrate split lands in LU-6), so SWM-lookup would always decline
    // with NO_DATA_IN_SWM — the exact bug §1.1 surfaces. Public CGs keep
    // the existing behaviour: `fromSharedMemory` → cores look up SWM
    // locally; otherwise plaintext inline.
    const useEncryptedInline = typeof options.encryptInlinePayload === 'function';
    // OT-RFC-38 LU-11: chunked path takes precedence when wired. The
    // agent always sets BOTH callbacks for curated CGs (see
    // `_resolveEncryptInlinePayload` + `_resolveEncryptInlineChunked`
    // on DKGAgent) so this branch picks the strictly-better path
    // without needing per-call flag plumbing. A future commit can drop
    // the LU-5 single-blob callback once chunked is the only path.
    const useChunkedInline = useEncryptedInline && typeof options.encryptInlineChunked === 'function';
    let stagingQuads: Uint8Array | undefined;
    let stagingByteSize = publicByteSize;
    let chunkedCommitment: {
      ciphertextChunksRoot: Uint8Array;
      ciphertextChunkCount: number;
    } | undefined;
    if (useChunkedInline) {
      const plaintextBytes = new TextEncoder().encode(nquadsStr);
      ensurePublishOperationIdentity();
      // batchId = V10 KC merkleRoot. It remains the core-side
      // persistence/sampling key, while publishOperationId is the
      // distinct per-operation nonce domain for chunked AEAD.
      const chunked = await options.encryptInlineChunked!({
        plaintextNquads: plaintextBytes,
        batchId: kcMerkleRoot,
        publishOperationId,
      });
      // No stagingQuads on the chunked path — chunks travel via SWM
      // gossip, never on the ACK wire. Cores recompute the root from
      // local per-chunk store and DECLINE on mismatch.
      stagingQuads = undefined;
      stagingByteSize = BigInt(chunked.totalCiphertextBytes);
      chunkedCommitment = {
        ciphertextChunksRoot: chunked.ciphertextChunksRoot,
        ciphertextChunkCount: chunked.ciphertextChunkCount,
      };
    } else if (useEncryptedInline) {
      const plaintextBytes = new TextEncoder().encode(nquadsStr);
      const ciphertext = await options.encryptInlinePayload!(plaintextBytes);
      stagingQuads = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
      // For curated CGs the publisher PAYS for ciphertext bytes (cores
      // sign that into the V10 digest). Override publicByteSize for the
      // ACK collection branch below; the chain TX still uses the
      // ciphertext byte size as `byteSize` since that's what's signed.
      stagingByteSize = BigInt(stagingQuads.length);
    } else {
      stagingQuads = isPublishFromSharedMemory
        ? undefined
        : new TextEncoder().encode(nquadsStr);
    }

    // Pre-compute tokenAmount and epochs so they can be included in the
    // H5-prefixed publish ACK digest (incl. merkleLeafCount) — matches
    // `packages/core/src/crypto/ack.ts:computePublishACKDigest` and
    // `KnowledgeAssetsV10._executePublishCore`.
    //
    // PCA discount eligibility (`KnowledgeAssetsV10.publish`): the
    // contract takes the PCA branch only when (1) the wallet is a
    // registered PCA agent, (2) the PCA is not expired, AND
    // (3) `p.epochs == lockDurationEpochs`. Any miss silently falls
    // through to direct spend at FULL price. To make sure registered
    // agents actually get the discount they paid for, we probe for the
    // PCA mapping and snap `publishEpochs` to the PCA's
    // `lockDurationEpochs` when one is found AND the caller did not
    // explicitly override the publish lifetime. Wallets without a PCA
    // (direct-spend branch) use the ordinary default lifetime.
    let publishEpochs = explicitPublishEpochs ?? DEFAULT_PUBLISH_EPOCHS;
    if (
      explicitPublishEpochs === undefined &&
      canAttemptOnChainPublish &&
      publisherSigner !== undefined &&
      typeof this.chain.getConvictionAgentAccountId === 'function' &&
      typeof this.chain.getConvictionAccountLockDurationEpochs === 'function'
    ) {
      try {
        const accountId = await this.chain.getConvictionAgentAccountId(publisherSigner.address);
        if (accountId > 0n) {
          const lockEpochs = await this.chain.getConvictionAccountLockDurationEpochs(accountId);
          if (lockEpochs > 0) {
            publishEpochs = lockEpochs;
            this.log.info(
              ctx,
              `PCA-funded publish detected (signer=${publisherSigner.address}, accountId=${accountId}) — coercing publishEpochs to lockDurationEpochs=${lockEpochs}`,
            );
          }
        }
      } catch (err) {
        // PCA probe is best-effort. On any RPC hiccup we keep the
        // already-resolved publish lifetime. The contract is still the source
        // of truth: if the signer turns out to be a PCA agent but
        // `p.epochs != lockDurationEpochs`, the publish silently
        // falls through to direct spend at full price (no revert).
        // That degraded path is acceptable for a hot publish — the
        // missed discount is observable via the lack of a
        // `CostCovered` event on the receipt.
        this.log.warn(
          ctx,
          `PCA epochs probe failed — falling back to publishEpochs=${publishEpochs}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // LU-5: pricing follows the byteSize that gets signed into the V10
    // digest. For curated (encrypted-inline) publishes that's the
    // ciphertext byte count; for public publishes it stays as plaintext
    // bytes. Single source of truth so ACK pricing == chain tx pricing.
    const effectiveByteSize = useEncryptedInline ? stagingByteSize : publicByteSize;
    let precomputedTokenAmount = canAttemptOnChainPublish ? BigInt(publishEpochs) : 0n;
    if (canAttemptOnChainPublish && typeof this.chain.getRequiredPublishTokenAmount === 'function') {
      try {
        precomputedTokenAmount = await this.chain.getRequiredPublishTokenAmount(effectiveByteSize, publishEpochs);
        const minTokenAmount = BigInt(publishEpochs);
        if (precomputedTokenAmount < minTokenAmount) {
          this.log.warn(ctx, `getRequiredPublishTokenAmount returned ${precomputedTokenAmount} for byteSize=${effectiveByteSize}, epochs=${publishEpochs} — using ${minTokenAmount} as minimum so per-epoch CG value stays non-zero`);
          precomputedTokenAmount = minTokenAmount;
        }
      } catch (err) {
        this.log.warn(
          ctx,
          `getRequiredPublishTokenAmount failed — publish will fall back to tentative if on-chain submit cannot proceed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
    const v10CgDomain = options.publishContextGraphId ?? contextGraphId;
    const swmGraphId = contextGraphId;

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
      !hasPrivateData &&
      canAttemptOnChainPublish;
    let v10ACKs: V10CoreNodeACK[] | undefined;
    if (shouldCollectV10ACKs) {
      onPhase?.('collect_v10_acks', 'start');
      try {
        const rootEntities = manifestEntries.map(m => m.rootEntity);
        // LU-5: for curated CGs the publisher pays / signs against the
        // ciphertext byte size (`effectiveByteSize`). For public CGs
        // nothing changed — `effectiveByteSize === publicByteSize`.
        v10ACKs = await v10ACKProvider(
          kcMerkleRoot, v10CgDomain, kaCount, rootEntities,
          effectiveByteSize, stagingQuads,
          publishEpochs, precomputedTokenAmount,
          swmGraphId, options.subGraphName,
          kcMerkleLeafCount,
          useEncryptedInline,
          chunkedCommitment,
        );
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
        this.log.warn(
          ctx,
          `V10 ACK collection failed (${tag}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      } finally {
        onPhase?.('collect_v10_acks', 'end');
      }
    } else if (v10ACKProvider && hasPrivateData && canAttemptOnChainPublish) {
      this.log.info(ctx, `V10 ACK collection skipped: publish contains private quads (${privateRoots.length} private roots)`);
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

    // Resolve the on-chain attribution target from the per-call override
    // (computed above) or fall back to the daemon's persistent identity.
    // `0n` is a VALID explicit override value (mode (d) "no attribution"
    // — contract validates this case) and must NOT be confused with
    // "override absent". The daemon's own identity is still used
    // elsewhere (signer resolution); this only affects the on-chain
    // `PublishParams.publisherNodeIdentityId`.
    const attributionIdentityId: bigint = hasAttributionOverride
      ? options.publisherNodeIdentityIdOverride!
      : this.publisherNodeIdentityId;
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
      // (`access-handler`, `assertion-history`, the `verified-memory`
      // view) can still locate this publish by its tentative UAL.
      // Pre-PR2 this was the responsibility of the chain-failure
      // catch block via `generateTentativeMetadata`. PR2 deleted that
      // unconditional catch (failed *chain* publishes now write
      // nothing locally), but the three intentional-local branches
      // (`no on-chain CG id`, `chain not V10-ready`,
      // `private data — no ACKs collectable`) all need the metadata
      // to keep the local data-graph queryable. Replicating the
      // tentative-metadata generation here scopes the metadata write
      // exclusively to those intentional-skip branches and keeps the
      // chain-failure path inert.
      // RC11 / PR2 (review fix): preserve the exact provenance + meta-graph
      // routing the pre-PR2 catch block did. Two strictly-additive
      // requirements relative to the minimal call above:
      //
      //   1. `authorAddress` / `publishOperationId` — emits the
      //      `dkg:Publication` + `dkg:authoredBy` quads that RFC-001 §3.5
      //      requires for tentative publishes so downstream consumers
      //      (`access-handler`, `assertion-history`, the verified-memory
      //      view) can still attribute the publish locally before any
      //      chain confirmation. The on-chain `KnowledgeBatch.authorAddress`
      //      is canonical only once the publish confirms; until then this
      //      is a self-claim. `publisherSigner` may be undefined
      //      (no-chain / no-key path) — skip the fields in that case so
      //      the publication subject is not emitted with a missing author.
      //
      //   2. `targetMetaGraphUri` remap — every generated meta quad sits
      //      in the default `did:dkg:context-graph:<id>/_meta` graph. If
      //      the caller supplied a `targetMetaGraphUri` (e.g. for SWM /
      //      private-channel meta isolation) the pre-PR2 path remapped
      //      them; without this, intentional-local publishes targeting a
      //      non-default meta graph would silently drop their `_meta`
      //      triples into the wrong graph and become invisible to the
      //      caller's own meta-graph queries.
      let tentativeMeta = generateTentativeMetadata(
        {
          ual,
          contextGraphId,
          merkleRoot: kcMerkleRoot,
          kaCount,
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
                publishOperationId,
              }
            : {}),
        },
        kaMetadata,
      );
      if (options.targetMetaGraphUri) {
        const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
        tentativeMeta = tentativeMeta.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
        );
      }
      this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store (${reasonLog})`);
      await this.store.insert(normalizedQuads);
      await this.store.insert(tentativeMeta);
    };

    // RC11 / PR3: extra intentional-local-only branch for publishes
    // with `hasPrivateData === true`. Peer ACK collection is
    // *structurally* skipped at line 1954 above (`!hasPrivateData`
    // gate) because peers can't see private payloads and therefore
    // can't sign anything meaningful — there is no transport that
    // could ever produce a valid V10 ACK quorum for these. They are
    // NOT a real on-chain publish failure; they are a configuration
    // where on-chain submission was never feasible in the first
    // place. Routing them through `finalizeIntentionalLocalPublish`
    // gives them the same intentional local-only behaviour the
    // "no CG id" / "chain not V10-ready" branches above already
    // guarantee.
    //
    // The structurally-similar "no v10ACKProvider wired" case is
    // INTENTIONALLY NOT caught here. Per the plan that case is a
    // configuration error in a publishing node (the daemon should
    // wire one); it must surface as the loud
    // "V10 ACKs required for on-chain publish" throw from the
    // submit-branch guard so the operator notices instead of
    // silently downgrading to tentative.
    const noPathToOnChainACKs =
      hasPrivateData && (!v10ACKs || v10ACKs.length === 0);

    if (publisherContextGraphId === undefined) {
      this.log.warn(ctx, `No positive on-chain context graph id resolved from "${v10CgDomain}" — skipping on-chain publish`);
      await finalizeIntentionalLocalPublish('no on-chain CG id');
    } else if (!chainV10Ready) {
      this.log.warn(ctx, 'Chain adapter is not V10-ready — skipping on-chain publish');
      await finalizeIntentionalLocalPublish('chain not V10-ready');
    } else if (noPathToOnChainACKs) {
      const reason = 'private data — no ACKs collectable (peers cannot see private payloads)';
      this.log.warn(
        ctx,
        `Skipping on-chain submission: ${reason}. Storing locally as tentative.`,
      );
      await finalizeIntentionalLocalPublish(reason);
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
      // protocol-correctness violations, not transient chain issues —
      // /api/shared-memory/publish callers must see a 4xx for a
      // broken seal, not a 200 OK with `status: tentative` and
      // `kaId: 0` (which the daemon previously had to special-case).
      //
      // Missing-seal — `precomputedAttestation === undefined` — is
      // checked inside the chain-submit branch below, after ACK
      // collection has proven this is a real V10 publish attempt. RC11
      // / PR-A deliberately rethrows that failure instead of
      // downgrading to local tentative VM, so ACK-ready no-seal callers
      // get a clear contract error and no root data-graph write.
      // Intentional local publishes (no on-chain CG id / non-V10 /
      // private data) still bypass this branch and can remain tentative.
      // ─────────────────────────────────────────────────────────────
      if (
        options.precomputedAttestation &&
        v10ChainId !== undefined &&
        v10KavAddress !== undefined
      ) {
        const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
        const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
        const authorTypedData = buildAuthorAttestationTypedData({
          chainId: v10ChainId,
          kav10Address: v10KavAddress,
          contextGraphId: v10CgId,
          merkleRoot: kcMerkleRoot,
          authorAddress: effectiveAuthorAddress,
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
        this.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, byteSize=${effectiveByteSize}${useEncryptedInline ? ' [ciphertext]' : ''}, tokenAmount=${tokenAmount})`);

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
            '/api/shared-memory/publish path resolves the seal automatically.',
          );
        }
        const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
        const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
        const authorTypedData = buildAuthorAttestationTypedData({
          chainId: v10ChainId,
          kav10Address: v10KavAddress,
          contextGraphId: v10CgId,
          merkleRoot: kcMerkleRoot,
          authorAddress: effectiveAuthorAddress,
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
        const emitWriteAheadStart = (info?: { txHash?: string }) => {
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
            onPhase?.(phase, 'start');
            onPhase?.(phase, 'end');
          }
          onPhase?.('chain:writeahead', 'start');
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
          (options as PublishOptions).reservedKaId,
        );
        try {
          // OT-RFC-38 LU-11 / OT-RFC-39 — handshake hardening.
          // When the publisher ran the chunked emit path, the chain
          // submit MUST carry the same `(ciphertextChunksRoot,
          // ciphertextChunkCount)` pair that was signed into the V2
          // ACK digest. Anything else (e.g. silently submitting
          // `bytes32(0)` / `0` on a curated KC) would leave the
          // on-chain commitment empty — RFC-39 random sampling would
          // then skip the KC because `_isCGEligible` filters zero-
          // commitment curated CGs out of the picker. Fail loud
          // here so the bug surfaces at the publisher instead of as
          // missing reward proofs days later.
          if (useChunkedInline) {
            if (
              !chunkedCommitment
              || chunkedCommitment.ciphertextChunksRoot.length !== 32
              || chunkedCommitment.ciphertextChunkCount <= 0
            ) {
              throw new Error(
                `LU-11: dkg-publisher refused to submit chunked publish with empty commitment ` +
                `(root=${chunkedCommitment?.ciphertextChunksRoot.length ?? 0} bytes, ` +
                `count=${chunkedCommitment?.ciphertextChunkCount ?? 0}). ` +
                `Either the chunked emitter returned no chunks (publisher bug — see ` +
                `_resolveEncryptInlineChunked) or the commitment was lost between encrypt ` +
                `and submit (threading bug — chunkedCommitment is intentionally optional ` +
                `on the chain adapter so non-chunked callers stay unchanged).`,
              );
            }
            const zeroRoot = chunkedCommitment.ciphertextChunksRoot
              .every((b) => b === 0);
            if (zeroRoot) {
              throw new Error(
                `LU-11: dkg-publisher refused to submit chunked publish with zero ciphertextChunksRoot — ` +
                `treat as a programmer error in the chunked emitter; the root MUST be the keccak256 ` +
                `Merkle root over per-chunk leaves, never bytes32(0).`,
              );
            }
          }
          onChainResult = await this.chain.createKnowledgeAssets!({
            publishOperationId,
            contextGraphId: v10CgId,
            publisherAddress: publisherSigner.address,
            reservedKaId,
            merkleRoot: kcMerkleRoot,
            knowledgeAssetsAmount: kaCount,
            byteSize: effectiveByteSize,
            ciphertextChunksRoot: chunkedCommitment?.ciphertextChunksRoot,
            ciphertextChunkCount: chunkedCommitment?.ciphertextChunkCount,
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
        if (!storageAddr) {
          throw new Error('Publish succeeded but DKGKnowledgeAssets address is unavailable for UAL assignment');
        }
        ual = `did:dkg:${this.chain.chainId}/${storageAddr.toLowerCase()}/${kaId.toString()}`;

        for (const km of kaMetadata) {
          km.kcUal = ual;
        }
        let confirmedQuads = generateConfirmedFullMetadata(
          {
            ual,
            contextGraphId,
            merkleRoot: kcMerkleRoot,
            kaCount,
            publisherPeerId: normalizedPublisherPeerId || 'unknown',
            accessPolicy: effectiveAccessPolicy,
            allowedPeers: normalizedAllowedPeers,
            timestamp: new Date(),
            subGraphName: options.subGraphName,
            authorAddress: effectiveAuthorAddress,
            publishOperationId,
          },
          kaMetadata,
          {
            txHash: onChainResult.txHash,
            blockNumber: onChainResult.blockNumber,
            blockTimestamp: onChainResult.blockTimestamp,
            publisherAddress: onChainResult.publisherAddress,
            batchId: onChainResult.batchId,
            chainId: this.chain.chainId,
          },
        );
        if (options.targetMetaGraphUri) {
          const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
          confirmedQuads = confirmedQuads.map((q) =>
            q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
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
        this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store (post-confirmation)`);
        await this.store.insert(normalizedQuads);
        await this.store.insert(confirmedQuads);
        await stampTrustLevel(
          this.store,
          dataGraph,
          collectTrustSubjectsForRoots(
            normalizedQuads,
            manifestEntries.map((entry) => entry.rootEntity),
          ),
          TrustLevel.SelfAttested,
        );

        // Agent authorship proof (spec §9.0.6): sign keccak256(merkleRoot) and store in _meta
        try {
          const merkleHashBytes = ethers.keccak256(kcMerkleRoot);
          const sig = await publisherSigner.signMessage(ethers.getBytes(merkleHashBytes));
          const proofQuads = generateAuthorshipProof({
            kcUal: ual,
            contextGraphId,
            agentAddress: publisherSigner.address,
            signature: sig,
            signedHash: merkleHashBytes,
          });
          if (options.targetMetaGraphUri) {
            const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
            const remapped = proofQuads.map((q) =>
              q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
            );
            await this.store.insert(remapped);
          } else {
            await this.store.insert(proofQuads);
          }
          this.log.info(ctx, `Authorship proof stored for agent ${publisherSigner.address}`);
        } catch (proofErr) {
          this.log.warn(ctx, `Failed to generate authorship proof: ${proofErr instanceof Error ? proofErr.message : String(proofErr)}`);
        }

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
        // through /api/query as if they were real verified memory.
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
      onPhase?.('chain:metadata', 'end');
    }

    onPhase?.('chain', 'end');

    const result: PublishResult = {
      kaId: onChainResult?.batchId ?? 0n,
      ual,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status,
      onChainResult,
      publicQuads: allSkolemizedQuads,
      v10ACKs,
      v10Origin: usedV10Path,
      subGraphName: options.subGraphName,
    };

    this.eventBus.emit(DKGEvent.KC_PUBLISHED, {
      ...result,
      contextGraphId,
      tripleCount: allSkolemizedQuads.length,
    });
    return result;
  }

  async update(kaId: bigint, options: PublishOptions): Promise<PublishResult> {
    if (options.subGraphName) {
      throw new Error(
        'Updating sub-graph KCs is not yet supported. The update path does not resolve sub-graph data/private graphs. ' +
        'Publish a new KC instead, or remove and recreate the sub-graph.',
      );
    }
    const { contextGraphId, quads, privateQuads = [], operationCtx, onPhase } = options;
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
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(options.publishContextGraphId ?? contextGraphId);
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Descriptive SWM graph names are valid local/mock update scopes.
    }
    const localOnlyUpdate = this.chain.chainId === 'none';
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
    const dataGraph = this.graphManager.dataGraphUri(contextGraphId);

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:partition', 'start');
    const kaMap = skolemizeByEntity(quads);
    onPhase?.('prepare:partition', 'end');

    onPhase?.('prepare:manifest', 'start');
    const manifestEntries: KAManifestEntry[] = [];
    const entityPrivateMap = new Map<string, Quad[]>();

    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
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
    const allSkolemizedQuads = [...kaMap.values()].flat();
    const updatePrivateRoots = manifestEntries
      .map(m => m.privateMerkleRoot)
      .filter((r): r is Uint8Array => r != null);
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

    const storeUpdatedQuads = async (version?: MaterializedVersion): Promise<void> => {
      onPhase?.('store', 'start');

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
          const priorRes = await this.store.query(
            `SELECT DISTINCT ?root WHERE { GRAPH <${labelMetaForPriors}> { ?ka <${DKG_ONT}partOf> <${ualForPriors}> ; <${DKG_ONT}rootEntity> ?root } }`,
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
      for (const [rootEntity] of kaMap) rootsToPurge.add(rootEntity);
      for (const rootEntity of rootsToPurge) {
        await this.privateStore.deletePrivateTriples(contextGraphId, rootEntity, options.subGraphName);
      }
      for (const [rootEntity] of kaMap) {
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
        payloadByRoot: kaMap,
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
        ual: `did:dkg:${this.chain.chainId}/${publisherAddress}/${kaId}`,
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
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph || ''}> .`,
      )
      .join('\n');
    const updateByteSize = BigInt(new TextEncoder().encode(updateNquadsStr).length);

    if (!options.precomputedUpdateAttestation) {
      throw new Error(
        'Update rejected: on-chain update requires precomputedUpdateAttestation. ' +
        'Sign UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress) off-band and pass the seal in this call.',
      );
    }
    const updateSeal = options.precomputedUpdateAttestation;
    const effectiveAuthorAddress = updateSeal.authorAddress;
    const effectiveSchemeVersion = updateSeal.schemeVersion;
    {
      const expected = updateSeal.expectedNewMerkleRoot;
      if (expected.length !== kcMerkleRoot.length || !expected.every((b, i) => b === kcMerkleRoot[i])) {
        throw new Error(
          `precomputedUpdateAttestation.expectedNewMerkleRoot mismatch: seal expects ${ethers.hexlify(expected)} ` +
          `but update-time recompute yielded ${ethers.hexlify(kcMerkleRoot)}.`,
        );
      }
    }
    const v10ChainId = await this.chain.getEvmChainId?.();
    const v10KavAddress = await this.chain.getKnowledgeAssetsLifecycleAddress?.();
    if (v10ChainId === undefined || !v10KavAddress) {
      throw new Error(
        'V10 update requires getEvmChainId() and getKnowledgeAssetsLifecycleAddress() on the chain adapter.',
      );
    }
    const updateAuthorTyped = buildUpdateAuthorAttestationTypedData({
      chainId: v10ChainId,
      kav10Address: v10KavAddress,
      kaId: kaId,
      newMerkleRoot: kcMerkleRoot,
      authorAddress: effectiveAuthorAddress,
      schemeVersion: effectiveSchemeVersion,
    });
    {
      const sig = ethers.Signature.from({
        r: ethers.hexlify(updateSeal.signature.r),
        yParityAndS: ethers.hexlify(updateSeal.signature.vs),
      });
      const digest = ethers.TypedDataEncoder.hash(
        updateAuthorTyped.domain,
        updateAuthorTyped.types,
        updateAuthorTyped.message,
      );
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(effectiveAuthorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(digest, sig);
        if (recovered.toLowerCase() !== effectiveAuthorAddress.toLowerCase()) {
          throw new Error(
            `precomputedUpdateAttestation signer mismatch: recovers ${recovered} but claims ${effectiveAuthorAddress}.`,
          );
        }
      }
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
    const emitWriteAheadStart = (info?: { txHash?: string }) => {
      if (wroteAhead) return;
      wroteAhead = true;
      // Mirror the publish path (above): emit a balanced, hash-bearing
      // phase first so WAL listeners record the signed-but-not-yet-
      // broadcast update tx identity, then the generic
      // `chain:writeahead:start` for legacy consumers.
      if (info?.txHash) {
        const phase = `chain:txsigned:tx-${info.txHash}`;
        onPhase?.(phase, 'start');
        onPhase?.(phase, 'end');
      }
      onPhase?.('chain:writeahead', 'start');
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
          newByteSize: updateByteSize,
          mintAmount: 0n,
          burnTokenIds: [],
        });
        boundUpdateTokenAmount = digestFields.newTokenAmount;
        v10UpdateACKs = await v10UpdateACKProvider({
          kaId,
          // Pass the on-chain-resolved numeric cgId (decimal string) — NOT
          // the cleartext `contextGraphId` name — so the digest's TARGET id
          // matches the tx + the contract read.
          contextGraphId: digestFields.contextGraphId.toString(),
          preUpdateMerkleRootCount: digestFields.preUpdateMerkleRootCount,
          newMerkleRoot: kcMerkleRoot,
          newByteSize: updateByteSize,
          newTokenAmount: digestFields.newTokenAmount,
          mintAmount: digestFields.mintAmount,
          burnTokenIds: digestFields.burnTokenIds,
          newMerkleLeafCount: kcMerkleLeafCount,
          // Peers recompute newMerkleRoot from the updated quads. Send the
          // same serialized public N-Quads the byte-size was computed over
          // so the peer's `computeFlatKCRoot(parsed, [])` matches the
          // publisher's. Only valid when there are NO private merkle roots
          // mixed into `kcMerkleRoot` — otherwise the peer (which can't see
          // the private roots) would recompute a different root and decline.
          // In that case we omit stagingQuads and the peer falls back to
          // verifying against its SWM copy (same limitation as the publish
          // plaintext-inline path).
          stagingQuads: updatePrivateRoots.length === 0
            ? new TextEncoder().encode(updateNquadsStr)
            : undefined,
          swmGraphId: contextGraphId,
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
            newByteSize: updateByteSize,
            newMerkleLeafCount: kcMerkleLeafCount,
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
          const errorName = enrichEvmError(v10Err);
          const V10_DEFINITIVE_ERRORS = [
            'NotKnowledgeAssetOwner',
            'InvalidAuthorSignature',
            'InvalidAuthorSignature1271',
            'AuthorRequired',
            'KnowledgeAssetExpired',
            'CannotUpdateImmutableKnowledgeAsset',
            'ExceededKnowledgeAssetBatchSize',
          ];
          if (errorName && V10_DEFINITIVE_ERRORS.includes(errorName)) {
            this.log.warn(ctx, `V10 update rejected (${errorName}): ${v10Err instanceof Error ? v10Err.message : String(v10Err)}`);
            earlyReturn = {
              kaId,
              ual: await this.resolveKaUal(kaId),
              merkleRoot: kcMerkleRoot,
              kaManifest: manifestEntries,
              status: 'failed',
              publicQuads: allSkolemizedQuads,
            };
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
      return {
        kaId,
        ual: await this.resolveKaUal(kaId),
        merkleRoot: kcMerkleRoot,
        kaManifest: manifestEntries,
        status: 'failed',
        publicQuads: allSkolemizedQuads,
      };
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
        ual: await this.resolveKaUal(kaId),
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
    await storeUpdatedQuads(updateVersion);

    const ual = await this.resolveKaUal(kaId);

    // GH #842: promote the update payload into the per-cgId partition that the
    // Random Sampling prover reads (`extractV10KCFromStore`). Without this the
    // prover keeps extracting the stale pre-update KA from the original publish
    // promotion and every updated KA is permanently unprovable
    // (`data-corrupted` / leaf-count-mismatch). Best-effort: skip silently when
    // the on-chain cgId is unknown — RS behaviour is then unchanged (the KA
    // simply stays `kc-not-synced`), so this can never regress a publish.
    if (publisherContextGraphId !== undefined && publisherContextGraphId > 0n) {
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
          payloadByRoot: kaMap,
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
      const contextGraphs = await this.graphManager.listContextGraphs();
      let total = 0;

      // Build list of (ownershipKey, swmMetaGraphUri) pairs: root + sub-graph scoped
      const targets: Array<{ ownershipKey: string; swmMetaGraph: string }> = [];
      const allGraphs = await this.store.listGraphs();
      for (const cgId of contextGraphs) {
        targets.push({ ownershipKey: cgId, swmMetaGraph: this.graphManager.sharedMemoryMetaUri(cgId) });

        // Discover sub-graph SWM meta graphs: did:dkg:context-graph:{cgId}/{sgName}/_shared_memory_meta
        const sgPrefix = `${CG_PREFIX}${cgId}/`;
        for (const g of allGraphs) {
          if (g.startsWith(sgPrefix) && g.endsWith(SWM_META_SUFFIX)) {
            const middle = g.slice(sgPrefix.length, g.length - SWM_META_SUFFIX.length);
            if (middle && !middle.includes('/')) {
              targets.push({ ownershipKey: `${cgId}\0${middle}`, swmMetaGraph: g });
            }
          }
        }
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
      const allGraphs = await this.store.listGraphs();
      // GH #748 Codex round 6 (user report): enumerate `_shared_memory_meta`
      // graphs directly via `store.listGraphs()`. The earlier approach used
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

  async assertionCreate(contextGraphId: string, name: string, agentAddress: string, subGraphName?: string): Promise<string> {
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    await this.store.createGraph(graphUri);

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
      'http://www.w3.org/ns/prov#wasRevisionOf',
    ]);
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const preserved: Quad[] = [];
    const preserveRes = await this.store.query(
      `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleSubject}> ?p ?o } }`,
    );
    if (preserveRes.type === 'bindings') {
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

    const lifecycleQuads = generateAssertionCreatedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName,
      timestamp: new Date(),
    });
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
    await this.ensureSubGraphRegistered(contextGraphId, subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    const quads = input.map((t) => ({
      subject: t.subject, predicate: t.predicate, object: t.object, graph: graphUri,
    }));
    // Round 9 Bug 25: reject user-authored quads whose subject is in a
    // protocol-reserved URN namespace. See RESERVED_SUBJECT_PREFIXES above.
    rejectUserAuthoredProtocolMetadata(quads);
    await this.store.insert(quads);
  }

  async assertionQuery(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    return result.type === 'quads' ? result.quads : [];
  }

  /**
   * OT-RFC-43 §10.5.3 — `wm/pull-from`: seed a fresh WM draft from this file's
   * current SWM or VM state (the `git checkout origin/<branch>` equivalent).
   *
   * WM is the only writable surface; to edit content that already lives in SWM
   * or VM you pull it into a new WM draft, edit, then re-share / re-publish.
   * The file's entity set is read from the assertion seal (on the lifecycle
   * URN); the source layer's quads for those entities (+ their skolemized
   * children) are gathered and written into a fresh WM draft.
   *
   * `onConflict` applies only when the WM draft already holds content:
   *   - 'reject' (default): throw `WM_DRAFT_CONFLICT` — the caller decides.
   *   - 'replace': discard the open draft, then seed fresh (git force-checkout).
   */
  async assertionPullFrom(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    sourceLayer: 'swm' | 'vm',
    opts?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
  ): Promise<{ seeded: number; fromLayer: 'swm' | 'vm'; entities: number }> {
    DKGPublisher.validateOptionalSubGraph(opts?.subGraphName);
    const subGraphName = opts?.subGraphName;
    const wmGraph = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const sourceGraph = sourceLayer === 'swm'
      ? this.graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : this.graphManager.dataGraphUri(contextGraphId);

    // onConflict: refuse to clobber a dirty WM draft unless told to replace it.
    const draftProbe = await this.store.query(`ASK { GRAPH <${wmGraph}> { ?s ?p ?o } }`);
    const hasDraft = draftProbe.type === 'boolean' && draftProbe.value === true;
    if (hasDraft) {
      const onConflict = opts?.onConflict ?? 'reject';
      if (onConflict === 'reject') {
        throw Object.assign(
          new Error(`A WM draft already exists for "${name}" in context graph "${contextGraphId}"; pass onConflict:"replace" to overwrite it.`),
          { code: 'WM_DRAFT_CONFLICT' },
        );
      }
      await this.store.dropGraph(wmGraph); // 'replace' — git force-checkout
    }

    // Resolve the file's member entities from the seal (dual-read the predicate
    // rename: dkg:assertionRootEntity OR dkg:assertionEntity, OT-RFC-43 §10.1).
    const entityRes = await this.store.query(
      `SELECT DISTINCT ?e WHERE { GRAPH <${metaGraph}> {
         <${lifecycleSubject}> (<http://dkg.io/ontology/assertionRootEntity>|<http://dkg.io/ontology/assertionEntity>) ?e .
       } }`,
    );
    const entities = entityRes.type === 'bindings'
      ? [...new Set(entityRes.bindings.map((b) => b['e']).filter(Boolean) as string[])]
      : [];
    if (entities.length === 0) {
      throw new Error(
        `No sealed entity list for "${name}" in context graph "${contextGraphId}" — pull-from `
        + `requires a finalized assertion (its seal records the member entities).`,
      );
    }

    // Gather the source-layer quads scoped to the entity set + skolem children
    // (same filter the publish gather / RS prover use), minus trust/ownership
    // bookkeeping that never belongs in a working draft.
    const values = entities.map((e) => `<${e}>`).join(' ');
    const gather = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${sourceGraph}> {
         VALUES ?root { ${values} }
         ?s ?p ?o .
         FILTER(?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
       } }`,
    );
    const gathered = gather.type === 'quads'
      ? gather.quads.filter((q) => !isTrustLevelQuad(q) && q.predicate !== WORKSPACE_OWNER_PREDICATE)
      : [];

    // Open a fresh WM draft (clears stale lifecycle/seal) and seed it.
    await this.assertionCreate(contextGraphId, name, agentAddress, subGraphName);
    if (gathered.length > 0) {
      await this.assertionWrite(contextGraphId, name, agentAddress, gathered, subGraphName);
    }
    return { seeded: gathered.length, fromLayer: sourceLayer, entities: entities.length };
  }

  async assertionPromote(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: { entities?: string[] | 'all'; subGraphName?: string; publisherPeerId?: string; senderAgentAddress?: string },
  ): Promise<{ promotedCount: number; gossipMessage?: Uint8Array }> {
    await this.ensureSubGraphRegistered(contextGraphId, opts?.subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const swmGraphUri = this.graphManager.sharedMemoryUri(contextGraphId, opts?.subGraphName);

    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads' || result.quads.length === 0) {
      // Issue #864 — when the assertion data graph is empty, distinguish two
      // failure modes so the caller (and ultimately the UI) gets an
      // actionable signal instead of a silent "Promoted 0 triples":
      //
      //   a) genuine empty assertion (never imported, never written, or
      //      already discarded) → keep the legacy `{ promotedCount: 0 }`
      //      success-shape return so polling/retry paths keep working.
      //   b) `_meta` says structural extraction *completed* with a non-zero
      //      triple count → the data graph SHOULD hold content. Returning
      //      0 here silently leaves the user staring at "Promoted 0" with
      //      no recovery path; raise a typed error so the daemon route
      //      can map it to a 409 the UI knows to surface.
      //
      // Rows 18 (`dkg:extractionStatus`) and 19 (`dkg:structuralTripleCount`)
      // are stamped by the daemon's import-file flow on the data-graph URI
      // subject (NOT the lifecycle URN) — see
      // `packages/cli/src/daemon/routes/assertion.ts:metaQuads`. That makes
      // them a clean witness of "extraction landed", scoped to the same
      // graphUri we just CONSTRUCTed against. Lifecycle-URN rows from
      // `assertionCreate` are not consulted: they fire for empty-write
      // flows where promoting nothing is legitimate.
      await this.assertAssertionDataPersisted(contextGraphId, graphUri);
      return { promotedCount: 0 };
    }

    let quadsToPromote = result.quads;

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

    if (opts?.entities && opts.entities !== 'all') {
      const entitySet = new Set(opts.entities);
      const genidPrefixes = opts.entities.map((e) => `${e}/.well-known/genid/`);
      quadsToPromote = quadsToPromote.filter(
        (q) =>
          entitySet.has(q.subject) ||
          genidPrefixes.some((prefix) => q.subject.startsWith(prefix)),
      );
    }

    if (quadsToPromote.length === 0) return { promotedCount: 0 };

    const operationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Skolemize blank nodes so local SWM and gossip peers store identical data.
    const kaMap = skolemizeByEntity(quadsToPromote);
    if (kaMap.size === 0) {
      throw new Error(
        'Cannot promote assertion: no root entities found. ' +
        'Assertions must contain at least one named (non-blank-node) subject.',
      );
    }
    const normalizedQuads = [...kaMap.values()].flat();
    const rootEntities = [...kaMap.keys()];

    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, opts?.subGraphName);
    const ownershipKey = opts?.subGraphName ? `${contextGraphId}\0${opts.subGraphName}` : contextGraphId;
    const swmOwners = await this.sharedMemoryOwnersForPromotion(
      contextGraphId,
      opts?.subGraphName,
      ownershipKey,
      rootEntities,
    );
    const swmOwned = this.sharedMemoryOwnedEntities.get(ownershipKey) ?? new Map<string, string>();

    // Pre-encode gossip message and enforce size limit BEFORE any destructive
    // mutations, so oversized promotions are rejected cleanly while the
    // assertion is still intact in WM.
    let gossipMessage: Uint8Array | undefined;
    if (opts?.publisherPeerId) {
      const dataGraph = this.graphManager.dataGraphUri(contextGraphId);
      const nquadsStr = normalizedQuads
        .map(
          (q) =>
            `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`,
        )
        .join('\n');
      const manifestEntries = rootEntities.map((rootEntity) => ({
        rootEntity,
        privateMerkleRoot: undefined,
        privateTripleCount: 0,
      }));
      const timestampMs = Date.now();
      const encoded = encodeWorkspacePublishRequest({
        contextGraphId: contextGraphId,
        nquads: new TextEncoder().encode(nquadsStr),
        manifest: manifestEntries,
        publisherPeerId: opts.publisherPeerId,
        shareOperationId: operationId,
        timestampMs,
        operationId,
        subGraphName: opts.subGraphName,
      });

      // Wrap the plaintext publish-request in the encrypted envelope
      // when the CG requires it. Mirrors the `share()` and
      // `conditionalShare()` paths — without this, the receiver-side
      // check at `SharedMemoryHandler.handle` rejects the gossip
      // ("Sender Key encrypted workspace payload required for private
      // or agent-gated context graph"). Returns plaintext for public
      // CGs (resolver returns requiresEncryption=false).
      const wrapped = await this.encodeWorkspaceGossipPayload(
        contextGraphId,
        encoded,
        {
          localOnly: false,
          senderAgentAddress: opts.senderAgentAddress,
          operationId,
          shareOperationId: operationId,
          timestampMs,
          subGraphName: opts.subGraphName,
          publisherPeerId: opts.publisherPeerId,
        },
      );

      if (wrapped.length > DKG_GOSSIP_MAX_MESSAGE_BYTES) {
        throw new Error(
          `Promoted assertion too large for gossip (${formatBytesAsKb(wrapped.length)}, limit ${formatGossipLimit(DKG_GOSSIP_MAX_MESSAGE_BYTES)}). ` +
          `Promote fewer entities per call.`,
        );
      }
      gossipMessage = wrapped;
    }

    // Rule 4: reject roots owned by a different peer before any mutations.
    const skippedRoots = new Set<string>();
    for (const root of rootEntities) {
      const owner = swmOwners.get(root);
      if (!owner) continue;
      if (opts?.publisherPeerId) {
        if (owner !== opts.publisherPeerId) {
          throw new Error(
            `Cannot promote entity <${root}>: owned by peer ${owner}, not by caller ${opts.publisherPeerId}.`,
          );
        }
      } else {
        this.log.warn(createOperationContext('share'), `Skipping entity <${root}>: owned by peer ${owner} in SWM but no publisherPeerId provided to verify ownership.`);
        skippedRoots.add(root);
      }
    }

    // Filter out skipped roots so subsequent mutations don't touch foreign-owned data.
    const effectiveRoots = skippedRoots.size > 0
      ? rootEntities.filter(r => !skippedRoots.has(r))
      : rootEntities;
    const effectiveQuads = skippedRoots.size > 0
      ? normalizedQuads.filter(q => !skippedRoots.has(q.subject) && !skippedRoots.has(q.subject.split('/.well-known/genid/')[0]))
      : normalizedQuads;

    if (effectiveRoots.length === 0) {
      return { promotedCount: 0 };
    }

    // Delete-then-insert for existing SWM entities (upsert), matching
    // _shareImpl and SharedMemoryHandler so re-promotes replace stale triples.
    // Safe after the ownership check above — only self-owned or unowned roots remain.
    for (const root of effectiveRoots) {
      if (swmOwned.has(root)) {
        await this.store.deleteByPattern({ graph: swmGraphUri, subject: root });
        await this.store.deleteBySubjectPrefix(swmGraphUri, root + '/.well-known/genid/');
        await this.deleteMetaForRoot(swmMetaGraph, root);
      }
    }

    const swmQuads = effectiveQuads.map((q) => ({ ...q, graph: swmGraphUri }));
    await this.store.insert(swmQuads);

    // Delete promoted triples from assertion graph (only the effective, non-skipped roots)
    const effectivePromoteQuads = skippedRoots.size > 0
      ? quadsToPromote.filter(q => !skippedRoots.has(q.subject) && !skippedRoots.has(q.subject.split('/.well-known/genid/')[0]))
      : quadsToPromote;
    await this.store.delete(effectivePromoteQuads.map((q) => ({ ...q, graph: graphUri })));

    // Update the assertion's memory layer from WM → SWM in _meta
    const assertionMetaGraph = contextGraphMetaUri(contextGraphId);
    const DKG_MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';
    await this.store.deleteByPattern({
      graph: assertionMetaGraph,
      subject: graphUri,
      predicate: DKG_MEMORY_LAYER,
    });
    await this.store.insert([{
      subject: graphUri,
      predicate: DKG_MEMORY_LAYER,
      object: '"SWM"',
      graph: assertionMetaGraph,
    }]);

    // Record ShareTransition metadata in _shared_memory_meta (spec §8)
    const entities = [...new Set(effectiveQuads.map((q) => q.subject))];
    const shareTransition = generateShareTransitionMetadata({
      contextGraphId,
      operationId,
      agentAddress,
      assertionName: name,
      entities,
      timestamp: new Date(),
    });
    await this.store.insert(shareTransition);

    // Update assertion lifecycle record in _meta: created → promoted
    const promoted = generateAssertionPromotedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName: opts?.subGraphName,
      shareOperationId: operationId,
      rootEntities: effectiveRoots,
      timestamp: new Date(),
    });
    await this.store.delete(promoted.delete);
    await this.store.insert(promoted.insert);

    // Write WorkspaceOperation metadata + ownership quads, mirroring what
    // _shareImpl and the remote SharedMemoryHandler both produce, so the
    // promoting node and replicas converge on identical ownership state.
    if (opts?.publisherPeerId) {
      const operationTimestamp = new Date();
      await storeWorkspaceOperationPublicQuads({
        store: this.store,
        graphManager: this.graphManager,
        contextGraphId,
        shareOperationId: operationId,
        rootEntities: effectiveRoots,
        quads: swmQuads,
        publisherPeerId: opts.publisherPeerId,
        agentAddress,
        subGraphName: opts.subGraphName,
        timestamp: operationTimestamp,
        publicSnapshotStore: this.publicSnapshotStore,
      });

      if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
        this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
      }
      const liveOwned = this.sharedMemoryOwnedEntities.get(ownershipKey)!;
      const newOwnershipEntries: { rootEntity: string; creatorPeerId: string }[] = [];
      for (const r of effectiveRoots) {
        if (!liveOwned.has(r)) {
          newOwnershipEntries.push({ rootEntity: r, creatorPeerId: opts.publisherPeerId });
        }
      }
      if (newOwnershipEntries.length > 0) {
        for (const entry of newOwnershipEntries) {
          await this.store.deleteByPattern({
            graph: swmMetaGraph, subject: entry.rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
          });
        }
        await this.store.insert(generateOwnershipQuads(newOwnershipEntries, swmMetaGraph));
        for (const entry of newOwnershipEntries) {
          liveOwned.set(entry.rootEntity, entry.creatorPeerId);
        }
      }
    }

    return { promotedCount: swmQuads.length, gossipMessage };
  }

  async assertionDiscard(contextGraphId: string, name: string, agentAddress: string, subGraphName?: string): Promise<void> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
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
    });
    await this.store.delete(discarded.delete);
    await this.store.insert(discarded.insert);

    const metaGraph = contextGraphMetaUri(contextGraphId);
    await this.store.deleteByPattern({ subject: graphUri, graph: metaGraph });
    await this.store.dropGraph(graphUri);
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
        this.kaAllocator.reconcile(author, Number(chainMax));
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
