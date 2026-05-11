import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter, OnChainPublishResult, AddBatchToContextGraphParams } from '@origintrail-official/dkg-chain';
import { enrichEvmError } from '@origintrail-official/dkg-chain';
import type { EventBus, OperationContext } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, sha256, encodeWorkspacePublishRequest, contextGraphDataUri, contextGraphMetaUri, contextGraphAssertionUri, assertionLifecycleUri, contextGraphSubGraphUri, contextGraphSubGraphMetaUri, validateSubGraphName, isSafeIri, assertSafeIri, assertSafeRdfTerm, DKG_GOSSIP_MAX_MESSAGE_BYTES, type Ed25519Keypair, computePublishACKDigest, buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import type { Publisher, PublishOptions, PublishResult, KAManifestEntry, PhaseCallback } from './publisher.js';
import { autoPartition } from './auto-partition.js';
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
  generateTentativeMetadata,
  generateConfirmedFullMetadata,
  generateShareMetadata,
  generateOwnershipQuads,
  generateAuthorshipProof,
  generateShareTransitionMetadata,
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateAssertionPublishedMetadata,
  generateAssertionDiscardedMetadata,
  toHex,
  resolveUalByBatchId,
  updateMetaMerkleRoot,
  type KAMetadata,
} from './metadata.js';
import { storeWorkspaceOperationPublicQuads } from './workspace-resolution.js';
import { ethers } from 'ethers';

export { RESERVED_SUBJECT_PREFIXES, findReservedSubjectPrefix, isReservedSubject } from './reserved-subjects.js';

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
   * Additional EVM private keys whose identities can act as receiver signers.
   * If empty, only the primary publisherPrivateKey is used for self-signing.
   */
  additionalSignerKeys?: string[];
  /** Shared map of SWM-owned rootEntities per context graph: entity → creatorPeerId. Pass from agent so handler and publisher stay in sync. */
  sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
  /** Shared batch→context graph binding map. Pass to UpdateHandler so it uses trusted local bindings. */
  knownBatchContextGraphs?: Map<string, string>;
  /** Shared write lock map. Pass to SharedMemoryHandler so gossip writes serialize against CAS writes. */
  writeLocks?: Map<string, Promise<void>>;
}

interface PublisherAddressResolutionOptions {
  includeReservingPublisherProbe?: boolean;
  includeGenericSignMessageProbe?: boolean;
}

export class PublisherWalletRequiredError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires "publisherPrivateKey" or a non-zero "publisherAddress" ` +
      'backed by ChainAdapter.signMessageAs()/signMessage(). Publishing without a publisher signing key ' +
      'would produce unattributable or unverifiable publisher output.',
    );
    this.name = 'PublisherWalletRequiredError';
  }
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
}

/** @deprecated Use ShareOptions */
export type WriteToWorkspaceOptions = ShareOptions;

export interface ShareResult {
  shareOperationId: string;
  message: Uint8Array;
}

/** @deprecated Use ShareResult */
export type WriteToWorkspaceResult = ShareResult;

export interface CASCondition {
  subject: string;
  predicate: string;
  /**
   * Expected current object value as a SPARQL term (e.g. `"recruiting"`,
   * `"42"^^<http://www.w3.org/2001/XMLSchema#integer>`, `<http://example.org/>`).
   * `null` means the triple must not exist.
   */
  expectedValue: string | null;
}

export class StaleWriteError extends Error {
  readonly condition: CASCondition;
  readonly actualValue: string | null;
  constructor(condition: CASCondition, actualValue: string | null) {
    const exp = condition.expectedValue === null ? '<absent>' : `"${condition.expectedValue}"`;
    const act = actualValue === null ? '<absent>' : `"${actualValue}"`;
    super(`CAS failed: <${condition.subject}> <${condition.predicate}> expected ${exp}, found ${act}`);
    this.name = 'StaleWriteError';
    this.condition = condition;
    this.actualValue = actualValue;
  }
}

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
/**
 * Thrown when `publish()` receives a quad whose subject sits in the
 * protocol-reserved URN namespace (`urn:dkg:file:...`, etc.).
 *
 * @internal — exported for backwards compatibility with external
 * consumers that deep-imported this symbol before
 * `@origintrail-official/dkg-publisher` had an `exports` map.
 * New code should duck-type via `err.name === 'ReservedNamespaceError'`
 * (the pattern used by `packages/cli/src/daemon.ts`) since the wire
 * contract is the `.name` string, not the class identity.
 */
export class ReservedNamespaceError extends Error {
  readonly subject: string;
  readonly prefix: string;
  constructor(subject: string, prefix: string) {
    super(
      `Subject '${subject}' is in the reserved namespace '${prefix}*', which is protocol-reserved ` +
        `for daemon-generated file descriptors and extraction provenance per ` +
        `19_MARKDOWN_CONTENT_TYPE.md §10.2. Use a different URN for user-authored quads.`,
    );
    this.name = 'ReservedNamespaceError';
    this.subject = subject;
    this.prefix = prefix;
  }
}

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
  /** Additional wallets that can provide receiver signatures. */
  private readonly additionalSignerWallets: ethers.Wallet[] = [];
  private readonly log = new Logger('DKGPublisher');
  private readonly sessionId = Date.now().toString(36);
  private tentativeCounter = 0;
  readonly writeLocks: Map<string, Promise<void>>;

  constructor(config: DKGPublisherConfig) {
    this.store = config.store;
    this.chain = config.chain;
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

  /**
   * RFC-001 §9.x — public wrapper around `resolvePublisherAddress` that
   * `agent.assertionFinalize()` calls when no agent override was
   * supplied. Mirrors Phase 4 mode (a): the daemon's own publisher
   * EOA acts as author when the request is admin-scoped.
   *
   * Returns `undefined` when no publisher signer is configured
   * (tentative-only daemon); finalize must then fail because there's
   * no key to sign with.
   */
  async publisherFallbackAuthorAddress(): Promise<string | undefined> {
    return this.resolvePublisherAddress();
  }

  /**
   * RFC-001 §9.x — sign EIP-712 typed data with the publisher's own
   * wallet (publisherPrivateKey or chain adapter's signer). Used by
   * `agent.assertionFinalize()` when no agent override is supplied,
   * so that the seal can still be produced for admin-scoped
   * finalize requests.
   *
   * Returns the compact `(r, vs)` form expected by KAv10's
   * AuthorAttestation struct.
   */
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
      const kavAddressGetter = (this.chain as unknown as { getKnowledgeAssetsV10Address?: () => Promise<string> })
        .getKnowledgeAssetsV10Address;
      if (typeof chainIdGetter === 'function') await chainIdGetter.call(this.chain);
      if (typeof kavAddressGetter === 'function') await kavAddressGetter.call(this.chain);
    } catch {
      // V9-only or incompletely configured adapters stay off the V10 path.
    }
    return this.isChainV10Ready();
  }

  private async resolveKnownBatchPublisherAddress(
    contextGraphId: string,
    kcId: bigint,
    metaGraphUri = this.graphManager.metaGraphUri(contextGraphId),
  ): Promise<string | undefined> {
    try {
      const ual = await resolveUalByBatchId(
        this.store,
        metaGraphUri,
        kcId,
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
    rejectReservedSubjectPrefixes(quads);
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

    const kaMap = autoPartition(quads);
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

    const message = encodeWorkspacePublishRequest({
      contextGraphId: contextGraphId,
      nquads: new TextEncoder().encode(nquadsStr),
      manifest: manifestEntries.map((m) => ({
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount,
      })),
      publisherPeerId: options.publisherPeerId,
      workspaceOperationId: shareOperationId,
      timestampMs: Date.now(),
      operationId: ctx.operationId,
      casConditions,
      subGraphName: options.subGraphName,
    });

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
    const metaQuads = generateShareMetadata(
      {
        shareOperationId,
        contextGraphId,
        rootEntities,
        publisherPeerId: options.publisherPeerId,
        timestamp: new Date(),
      },
      swmMetaGraph,
    );
    await this.store.insert(metaQuads);
    await storeWorkspaceOperationPublicQuads({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId,
      shareOperationId,
      rootEntities,
      quads: normalized,
      publisherPeerId: options.publisherPeerId,
      subGraphName: options.subGraphName,
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
    rejectReservedSubjectPrefixes(quads);
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
    const quads: Quad[] =
      result.type === 'quads' ? result.quads : [];

    if (quads.length === 0) {
      throw new Error(`No quads in shared memory for context graph ${contextGraphId} matching selection`);
    }

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
      [INTERNAL_ORIGIN_TOKEN]: true,
    };
    const publishResult = await this.publish(internalPublishOptions);

    // Per-cgId data promotion: copy quads + KA meta from the default
    // `<NAME>/data` + `<NAME>/_meta` graphs into `<NAME>/context/<cgId>/data`
    // + `<NAME>/context/<cgId>/_meta`. The RS prover's `extractV10KCFromStore`
    // queries the per-cgId meta graph (kc-extractor.ts:154) to resolve a
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
      // via an internal call to ContextGraphs.registerKnowledgeCollection
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

        // Data promotion: always COPY public quads to the per-cgId data
        // graph (`<NAME>/context/<cgId>/data`) — RS prover's
        // `extractV10KCFromStore` reads triples from there
        // (`kc-extractor.ts` line ~225). On REMAP-flow publishes
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
          if (ctxGraphId) {
            await this.store.delete(storedQuads);
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

        this.log.info(ctx, `Promoted ${publishResult.kaManifest.length} KAs from default graph to context graph ${targetCgId}`);
      }
    }

    // SWM cleanup: ALWAYS remove published triples from SWM after chain confirmation.
    // Published triples must not linger in SWM — they live in LTM now.
    // clearSharedMemoryAfter controls only whether the REMAINING unpublished triples are also cleared.
    if (publishResult.status === 'confirmed') {
      const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, options?.subGraphName);
      const swmOwnershipKey = options?.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      const kaMap = autoPartition(quads);
      let ownerDeletedTotal = 0;
      for (const rootEntity of kaMap.keys()) {
        await this.store.deleteByPattern({ graph: swmGraph, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(swmGraph, rootEntity + '/.well-known/genid/');
        const ownerDeleted = await this.store.deleteByPattern({
          graph: swmMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
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
      rejectReservedSubjectPrefixes(quads);
      if (privateQuads.length > 0) rejectReservedSubjectPrefixes(privateQuads);
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
    // docstring. `hasAttributionOverride` must influence the EARLY on-chain
    // attempt gate too — otherwise `publisherSigner` and `tokenAmount`
    // never resolve when a daemon with persistent identity `0n` carries an
    // explicit override (including `0n` for mode (d) no-attribution),
    // and the late gate would then enter the chain branch with
    // `publisherSigner === undefined` and throw `PublisherWalletRequiredError`.
    // Self-ACK signing remains tied to `this.publisherNodeIdentityId > 0n`
    // below — the override controls on-chain attribution, not who signs.
    const hasAttributionOverride = options.publisherNodeIdentityIdOverride !== undefined;
    const willAttemptOnChainPublish =
      (this.publisherNodeIdentityId > 0n || hasAttributionOverride) &&
      publisherContextGraphId !== undefined;
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
    const kaMap = autoPartition(quads);
    onPhase?.('prepare:partition', 'end');

    const manifestEntries: KAManifestEntry[] = [];
    const kaMetadata: KAMetadata[] = [];

    onPhase?.('prepare:manifest', 'start');
    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );

      manifestEntries.push({
        tokenId: tokenCounter,
        rootEntity,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
        privateTripleCount: entityPrivateQuads.length,
      });

      kaMetadata.push({
        rootEntity,
        kcUal: '',
        tokenId: tokenCounter,
        publicTripleCount: publicQuads.length,
        privateTripleCount: entityPrivateQuads.length,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
      });

      tokenCounter++;
    }

    const allSkolemizedQuads = [...kaMap.values()].flat();
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
    const privateRoots = manifestEntries
      .map(m => m.privateMerkleRoot)
      .filter((r): r is Uint8Array => r != null);
    const kcMerkleRoot = computeFlatKCRoot(allSkolemizedQuads, privateRoots);
    const kcMerkleLeafCount = computeFlatKCMerkleLeafCountV10(allSkolemizedQuads, privateRoots);
    if (kcMerkleLeafCount > 0xffffffff) {
      throw new Error(`V10 merkleLeafCount exceeds uint32: ${kcMerkleLeafCount}`);
    }
    this.log.info(ctx, `Computed kcMerkleRoot (flat) over ${allSkolemizedQuads.length} triple hashes + ${privateRoots.length} private root(s), leafCount=${kcMerkleLeafCount}`);
    const kaCount = manifestEntries.length;
    onPhase?.('prepare:merkle', 'end');

    onPhase?.('prepare', 'end');
    onPhase?.('store', 'start');

    const dataGraph = options.targetGraphUri ?? this.graphManager.dataGraphUri(contextGraphId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store`);
    await this.store.insert(normalizedQuads);

    // Store private quads
    for (const [rootEntity] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(contextGraphId, rootEntity, entityPrivateQuads, options.subGraphName);
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
    const stagingQuads = isPublishFromSharedMemory
      ? undefined
      : new TextEncoder().encode(nquadsStr);

    // Pre-compute tokenAmount and epochs so they can be included in the
    // H5-prefixed publish ACK digest (incl. merkleLeafCount) — matches
    // `packages/core/src/crypto/ack.ts:computePublishACKDigest` and
    // `KnowledgeAssetsV10._executePublishCore`.
    const publishEpochs = 1;
    let precomputedTokenAmount = 0n;
    if (canAttemptOnChainPublish && typeof this.chain.getRequiredPublishTokenAmount === 'function') {
      try {
        precomputedTokenAmount = await this.chain.getRequiredPublishTokenAmount(publicByteSize, publishEpochs);
        if (precomputedTokenAmount <= 0n) {
          this.log.warn(ctx, `getRequiredPublishTokenAmount returned ${precomputedTokenAmount} for byteSize=${publicByteSize} — using 1n as minimum`);
          precomputedTokenAmount = 1n;
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
    // reject them here BEFORE burning CPU on ACK collection, self-sign
    // digests, or on-chain tx construction, so the caller sees the real
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

    let v10ACKs: Array<{ peerId: string; signatureR: Uint8Array; signatureVS: Uint8Array; nodeIdentityId: bigint }> | undefined;
    if (options.v10ACKProvider && !hasPrivateData) {
      onPhase?.('collect_v10_acks', 'start');
      try {
        const rootEntities = manifestEntries.map(m => m.rootEntity);
        v10ACKs = await options.v10ACKProvider(
          kcMerkleRoot, v10CgDomain, kaCount, rootEntities, publicByteSize, stagingQuads,
          publishEpochs, precomputedTokenAmount,
          swmGraphId, options.subGraphName,
          kcMerkleLeafCount,
        );
        this.log.info(ctx, `V10: Collected ${v10ACKs.length} core node ACKs`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `V10 ACK collection failed — will attempt self-signed ACK fallback: ${msg}`);
      } finally {
        onPhase?.('collect_v10_acks', 'end');
      }
    } else if (options.v10ACKProvider && hasPrivateData) {
      this.log.info(ctx, `V10 ACK collection skipped: publish contains private quads (${privateRoots.length} private roots)`);
    }

    // Resolve the target CG id bigint once for the whole V10 block so the
    // self-sign ACK digest (below) and the publisher digest (in the chain-
    // submit block) see the same value. Non-numeric domains resolve to 0n
    // here — the V10 contract rejects `contextGraphId == 0` with
    // `ZeroContextGraphId`, so the authoritative fail-loud lives at the EVM
    // adapter boundary (`evm-adapter.ts:createKnowledgeAssetsV10` pre-tx
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

    // Numeric EVM chainId + kav10Address are needed by BOTH the self-sign ACK
    // digest and the publisher digest (H5 prefix). Fetch them once; the
    // adapter field `this.chain.chainId` is a namespaced string like
    // `evm:31337` and is not directly parseable with `BigInt()`. Wrap in
    // try/catch so non-V10-capable adapters (e.g. `NoChainAdapter`, whose
    // stubs throw) do not crash the publish path — they simply leave
    // both values undefined, the self-sign fallback stays skipped, and
    // the publish goes tentative.
    let v10ChainId: bigint | undefined;
    let v10KavAddress: string | undefined;
    try {
      v10ChainId = await this.chain.getEvmChainId();
      v10KavAddress = await this.chain.getKnowledgeAssetsV10Address();
    } catch {
      v10ChainId = undefined;
      v10KavAddress = undefined;
    }

    // Self-sign ACK as last resort: single-node mode (no provider), or when
    // ACK collection was skipped for private data, or when collection failed.
    // On networks requiring > 1 signature, a single self-signed ACK will be
    // rejected on-chain by minimumRequiredSignatures — this is intentional:
    // the contract is the ultimate gatekeeper.
    if (
      (!v10ACKs || v10ACKs.length === 0) &&
      this.publisherNodeIdentityId > 0n &&
      v10ChainId !== undefined &&
      v10KavAddress !== undefined
    ) {
      if (publisherSigner) {
        const reason = !options.v10ACKProvider ? 'no v10ACKProvider (single-node mode)' : 'ACK collection failed/skipped';
        this.log.info(ctx, `Self-signing ACK — ${reason}`);
        const ackDigest = computePublishACKDigest(
          v10ChainId,
          v10KavAddress,
          v10CgId,
          kcMerkleRoot,
          BigInt(kaCount),
          publicByteSize,
          BigInt(publishEpochs),
          precomputedTokenAmount,
          BigInt(kcMerkleLeafCount),
        );
        try {
          const ackSig = ethers.Signature.from(
            await publisherSigner.signMessage(ackDigest),
          );
          v10ACKs = [{
            peerId: 'self',
            signatureR: ethers.getBytes(ackSig.r),
            signatureVS: ethers.getBytes(ackSig.yParityAndS),
            nodeIdentityId: this.publisherNodeIdentityId,
          }];
        } catch (err) {
          this.log.warn(
            ctx,
            `Self-sign ACK skipped: publisher signer failed (${err instanceof Error ? err.message : String(err)})`,
          );
          v10ACKs = [];
        }
      } else {
        this.log.warn(ctx, 'Self-sign ACK skipped: publisher signing key is unavailable');
      }
    }

    onPhase?.('chain', 'start');

    let onChainResult: OnChainPublishResult | undefined;
    let status: 'tentative' | 'confirmed' = 'tentative';
    const tentativeSeq = ++this.tentativeCounter;
    // RFC-001 §3.5 publication identifier. Stable across tentative and
    // confirmed states for this publish so the `dkg:Publication` subject
    // emitted in metadata stays the same after on-chain confirmation.
    const publishOperationId = `${this.sessionId}-${tentativeSeq}`;
    let ual = `did:dkg:${this.chain.chainId}/${publisherAddress}/t${publishOperationId}`;

    // Resolve the on-chain attribution target from the per-call override
    // (computed above) or fall back to the daemon's persistent identity.
    // `0n` is a VALID explicit override value (mode (d) "no attribution"
    // — contract validates this case) and must NOT be confused with
    // "override absent". The daemon's own identity is still used elsewhere
    // (ACK self-signing, signer resolution); this only affects the
    // on-chain `PublishParams.publisherNodeIdentityId`.
    const attributionIdentityId: bigint = hasAttributionOverride
      ? options.publisherNodeIdentityIdOverride!
      : this.publisherNodeIdentityId;
    let usedV10Path = false;

    // Gate: skip on-chain only when there's no usable attribution AND no
    // explicit override. With an explicit override (including `0n`), we
    // proceed on-chain; the contract validates non-zero values name a
    // real sharding-table node and accepts `0n` as no-attribution.
    if (!hasAttributionOverride && this.publisherNodeIdentityId === 0n) {
      this.log.warn(ctx, `Identity not set (0) — skipping on-chain publish`);
    } else if (publisherContextGraphId === undefined) {
      this.log.warn(ctx, `No positive on-chain context graph id resolved from "${v10CgDomain}" — skipping on-chain publish`);
    } else if (!chainV10Ready) {
      this.log.warn(ctx, 'Chain adapter is not V10-ready — skipping on-chain publish');
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
      // `kcId: 0` (which the daemon previously had to special-case).
      //
      // Missing-seal — `precomputedAttestation === undefined` — is
      // intentionally NOT hoisted. The publisher's contract historically
      // permits no-seal publishes (they fall through to tentative);
      // breaking that surface in this PR would invalidate ~120 publisher
      // unit tests that exercise transport, ownership, and lifecycle
      // mechanics without caring about author attribution. Production
      // call sites (agent.publish, /api/shared-memory/publish) always
      // mint a seal at the agent layer — see Phase 4 wiring; no
      // user-facing path can reach the publisher without a seal.
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
        this.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, publicByteSize=${publicByteSize}, tokenAmount=${tokenAmount})`);

        if (!v10ACKs || v10ACKs.length === 0) {
          throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
        }
        if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) {
          throw new Error(
            'Chain adapter is not V10-ready (isV10Ready() returned false or is missing). ' +
            'Publish is routed through KnowledgeAssetsV10.publish, which requires ' +
            'the adapter to expose createKnowledgeAssetsV10, getEvmChainId, and ' +
            'getKnowledgeAssetsV10Address — use an EVM adapter pointed at a chain where ' +
            'KnowledgeAssetsV10 is deployed.',
          );
        }
        if (v10ChainId === undefined || v10KavAddress === undefined) {
          throw new Error(
            'V10 publish requires the chain adapter to expose getEvmChainId() and ' +
            'getKnowledgeAssetsV10Address(); neither was resolved. The adapter is not V10-capable.',
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
        try {
          onChainResult = await this.chain.createKnowledgeAssetsV10!({
            publishOperationId,
            contextGraphId: v10CgId,
            publisherAddress: publisherSigner.address,
            merkleRoot: kcMerkleRoot,
            knowledgeAssetsAmount: kaCount,
            byteSize: publicByteSize,
            epochs: 1,
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

        // V9 UAL: did:dkg:{chainId}/{publisherAddress}/{firstKAId}
        ual = `did:dkg:${this.chain.chainId}/${onChainResult.publisherAddress}/${onChainResult.startKAId}`;

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
        await this.store.insert(confirmedQuads);

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
        this.log.warn(ctx, `On-chain tx failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (status === 'tentative') {
      // ual already set to the tentative form above; no reassignment needed
      for (const km of kaMetadata) {
        km.kcUal = ual;
      }
      // RFC-001 §3.5: emit `dkg:authoredBy` triple even on tentative
      // publishes so a publish that never reaches the chain still carries
      // its self-claimed author identity locally. The on-chain
      // `KnowledgeBatch.authorAddress` is canonical only once the publish
      // confirms; until then this is a self-claim. `publisherSigner` may be
      // undefined (no-chain / no-key path); skip the field in that case so
      // the publication subject is not emitted with a missing author.
      let tentativeQuads = generateTentativeMetadata(
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
          // Tentative path runs OUTSIDE the on-chain success branch
          // where `effectiveAuthorAddress` is computed, so resolve
          // again here. RFC-001 §9.x — author identity is carried by
          // the precomputedAttestation; fall back to publisherSigner
          // for non-V10 / mock-chain publishes that legitimately have
          // no seal.
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
        tentativeQuads = tentativeQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
        );
      }
      await this.store.insert(tentativeQuads);
      this.log.info(ctx, `Stored as tentative: UAL=${ual}`);
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
      kcId: onChainResult?.batchId ?? 0n,
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

  async update(kcId: bigint, options: PublishOptions): Promise<PublishResult> {
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
      rejectReservedSubjectPrefixes(quads);
      if (privateQuads.length > 0) rejectReservedSubjectPrefixes(privateQuads);
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
          await this.chain.getLatestMerkleRootPublisher(kcId),
        );
      } catch {
        // Adapter-managed updates can still let the adapter resolve the
        // original publisher while submitting the transaction.
      }
    }
    if (!resolvedPublisherAddress && !localOnlyUpdate) {
      resolvedPublisherAddress = await this.resolveKnownBatchPublisherAddress(
        contextGraphId,
        kcId,
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
    this.log.info(ctx, `Updating kcId=${kcId} with ${quads.length} triples`);
    const dataGraph = this.graphManager.dataGraphUri(contextGraphId);

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:partition', 'start');
    const kaMap = autoPartition(quads);
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

    const storeUpdatedQuads = async (): Promise<void> => {
      onPhase?.('store', 'start');
      for (const [rootEntity, publicQuads] of kaMap) {
        await this.store.deleteByPattern({ graph: dataGraph, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(dataGraph, rootEntity + '/.well-known/genid/');
        await this.privateStore.deletePrivateTriples(contextGraphId, rootEntity, options.subGraphName);

        const normalized = publicQuads.map((q) => ({ ...q, graph: dataGraph }));
        await this.store.insert(normalized);

        const entityPrivateQuads = entityPrivateMap.get(rootEntity) ?? [];
        if (entityPrivateQuads.length > 0) {
          await this.privateStore.storePrivateTriples(contextGraphId, rootEntity, entityPrivateQuads, options.subGraphName);
        }
      }

      try {
        await updateMetaMerkleRoot(this.store, this.graphManager, contextGraphId, kcId, kcMerkleRoot);
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to sync _meta merkleRoot for kcId=${kcId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      onPhase?.('store', 'end');
    };

    if (localOnlyUpdate) {
      this.log.warn(ctx, 'No chain configured — applying update locally and returning tentative result');
      await storeUpdatedQuads();
      const result: PublishResult = {
        kcId,
        ual: `did:dkg:${this.chain.chainId}/${publisherAddress}/${kcId}`,
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

    // P-1 review (iter-2): `chain:writeahead:start` fires from inside
    // the V10 adapter via `onBroadcast` — i.e. AFTER allowance +
    // `approve()`, RIGHT BEFORE the real `updateDirect` broadcast.
    // This keeps the WAL boundary precise (listeners only record
    // recovery state when a concrete update tx is imminent) while the
    // outer try/finally still guarantees balanced `:start`/`:end`
    // when the adapter throws after invoking `onBroadcast`. The V9
    // fallback path (`updateKnowledgeAssets`) does not yet support
    // the hook — it retains the coarse phase boundary that brackets
    // the whole adapter call. See the equivalent marker in the
    // publish path above for the full rationale.
    let txResult: { success: boolean; hash: string; blockNumber?: number; publisherAddress?: string };
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
    try {
      if (typeof this.chain.updateKnowledgeCollectionV10 === 'function') {
        try {
          txResult = await this.chain.updateKnowledgeCollectionV10({
            kcId,
            newMerkleRoot: kcMerkleRoot,
            newByteSize: updateByteSize,
            newMerkleLeafCount: kcMerkleLeafCount,
            mintAmount: 0,
            publisherAddress,
            v10Origin: true,
            onBroadcast: emitWriteAheadStart,
          });
        } catch (v10Err) {
          const errorName = enrichEvmError(v10Err);
          const V10_DEFINITIVE_ERRORS = [
            'NotBatchPublisher', 'KnowledgeCollectionExpired',
            'CannotUpdateImmutableKnowledgeCollection', 'ExceededKnowledgeCollectionMaxSize',
          ];
          if (errorName && V10_DEFINITIVE_ERRORS.includes(errorName)) {
            this.log.warn(ctx, `V10 update rejected (${errorName}): ${v10Err instanceof Error ? v10Err.message : String(v10Err)}`);
            const rejectedPublisherAddress = publisherAddress ?? this.publisherAddress;
            if (!rejectedPublisherAddress) throw v10Err;
            earlyReturn = {
              kcId,
              ual: `did:dkg:${this.chain.chainId}/${rejectedPublisherAddress}/${kcId}`,
              merkleRoot: kcMerkleRoot,
              kaManifest: manifestEntries,
              status: 'failed',
              publicQuads: allSkolemizedQuads,
            };
            txResult = { success: false, hash: '' };
          } else if (typeof this.chain.updateKnowledgeAssets === 'function') {
            this.log.info(ctx, `V10 update failed (${errorName ?? 'unknown'}), trying V9 path: ${v10Err instanceof Error ? v10Err.message : String(v10Err)}`);
            // Codex PR #241 iter-6: The V9 `updateKnowledgeAssets()`
            // adapter path has NO `onBroadcast` hook, so we cannot emit
            // a true "tx signed, about to broadcast" WAL checkpoint
            // here. Previously we emitted `chain:writeahead:start`
            // unconditionally before the adapter call, but that
            // re-introduced exactly the false-positive WAL boundary
            // this PR is removing: preflight/estimateGas can throw
            // before any tx hits the wire, leaving listeners with a
            // checkpoint for a publish that never broadcast. Safer to
            // skip the phase entirely on V9 — callers relying on WAL
            // semantics must upgrade to a V10 adapter that provides
            // `onBroadcast`.
            try {
              txResult = await this.chain.updateKnowledgeAssets({
                batchId: kcId,
                newMerkleRoot: kcMerkleRoot,
                newPublicByteSize: updateByteSize,
                publisherAddress,
              });
            } catch (v9Err) {
              enrichEvmError(v9Err);
              throw v9Err;
            }
          } else {
            throw v10Err;
          }
        }
      } else if (typeof this.chain.updateKnowledgeAssets === 'function') {
        // Codex PR #241 iter-6: same rationale as the V9 fallback above
        // — no `onBroadcast` hook means no sound WAL boundary, so we
        // skip the phase on this legacy V9-only path.
        txResult = await this.chain.updateKnowledgeAssets({
          batchId: kcId,
          newMerkleRoot: kcMerkleRoot,
          newPublicByteSize: updateByteSize,
          publisherAddress,
        });
      } else {
        throw new Error('Chain adapter does not support updates (no V10 or V9 update method available)');
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
      let failedPublisherAddress = coercePublisherAddress(txResult.publisherAddress) ??
        publisherAddress;
      if (!failedPublisherAddress && typeof this.chain.getLatestMerkleRootPublisher === 'function') {
        try {
          failedPublisherAddress = coercePublisherAddress(
            await this.chain.getLatestMerkleRootPublisher(kcId),
          );
        } catch {
          // Fall through to the clear fail-loud path below.
        }
      }
      failedPublisherAddress ??= await this.resolveKnownBatchPublisherAddress(
        contextGraphId,
        kcId,
        options.targetMetaGraphUri,
      );
      if (!failedPublisherAddress) {
        failedPublisherAddress = this.localTentativePublisherAddress();
        this.log.warn(
          ctx,
          'Chain adapter returned a failed update without publisherAddress, and neither ' +
          'chain state nor local metadata resolved the publisher. Returning the failed ' +
          'update status with a local tentative UAL placeholder.',
        );
      }
      onPhase?.('chain:submit', 'end');
      onPhase?.('chain', 'end');
      return {
        kcId,
        ual: `did:dkg:${this.chain.chainId}/${failedPublisherAddress}/${kcId}`,
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
          await this.chain.getLatestMerkleRootPublisher(kcId),
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
      const tentativePublisherAddress = publisherAddress ?? this.localTentativePublisherAddress();
      this.log.warn(
        ctx,
        'Chain adapter returned a successful update without publisherAddress, and neither ' +
        'getLatestMerkleRootPublisher() nor the tx result resolved a chain publisher. ' +
        'Applying local data update as tentative instead of confirming unproven attribution.',
      );
      await storeUpdatedQuads();
      const result: PublishResult = {
        kcId,
        ual: `did:dkg:${this.chain.chainId}/${tentativePublisherAddress}/${kcId}`,
        merkleRoot: kcMerkleRoot,
        kaManifest: manifestEntries,
        status: 'tentative',
        publicQuads: allSkolemizedQuads,
      };
      this.eventBus.emit(DKGEvent.KA_UPDATED, result);
      return result;
    }

    await storeUpdatedQuads();

    const result: PublishResult = {
      kcId,
      ual: `did:dkg:${this.chain.chainId}/${effectivePublisherAddress}/${kcId}`,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status: 'confirmed',
      publicQuads: allSkolemizedQuads,
      onChainResult: {
        batchId: kcId,
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

  autoPartition(quads: Quad[]): KAManifestEntry[] {
    const kaMap = autoPartition(quads);
    let tokenId = 1n;
    return [...kaMap.keys()].map((rootEntity) => ({
      tokenId: tokenId++,
      rootEntity,
    }));
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
    const result = await this.store.query(
      `SELECT ?entity ?creator WHERE { GRAPH <${swmMetaGraph}> { ?entity <${DKG}workspaceOwner> ?creator } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return 0;

    const opsResult = await this.store.query(
      `SELECT ?op ?peer ?root WHERE { GRAPH <${swmMetaGraph}> { ?op <${PROV}wasAttributedTo> ?peer . ?op <${DKG}rootEntity> ?root } }`,
    );
    const validatedOwners = new Map<string, Set<string>>();
    if (opsResult.type === 'bindings') {
      for (const row of opsResult.bindings) {
        const root = row['root'];
        const peer = row['peer'];
        if (!root || !peer) continue;
        const peerStr = peer.startsWith('"')
          ? peer.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
          : peer;
        if (!validatedOwners.has(root)) validatedOwners.set(root, new Set());
        validatedOwners.get(root)!.add(peerStr);
      }
    }

    if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
      this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
    }
    const ownedMap = this.sharedMemoryOwnedEntities.get(ownershipKey)!;
    let count = 0;
    for (const row of result.bindings) {
      const entity = row['entity'];
      const creator = row['creator'];
      if (!entity || !creator) continue;
      const creatorStr = creator.startsWith('"')
        ? creator.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
        : creator;

      const validPeers = validatedOwners.get(entity);
      if (!validPeers || !validPeers.has(creatorStr)) {
        this.log.warn(
          createOperationContext('reconstruct'),
          `Skipping unvalidated ownership: entity=${entity} creator=${creatorStr}`,
        );
        continue;
      }

      if (ownedMap.has(entity)) {
        const existing = ownedMap.get(entity)!;
        if (existing !== creatorStr) {
          this.log.warn(
            createOperationContext('reconstruct'),
            `Conflicting ownership for ${entity}: "${existing}" vs "${creatorStr}"; keeping alphabetically first`,
          );
          if (creatorStr < existing) ownedMap.set(entity, creatorStr);
        }
        continue;
      }

      ownedMap.set(entity, creatorStr);
      count++;
    }
    return count;
  }

  /** @deprecated Use reconstructSharedMemoryOwnership */
  async reconstructWorkspaceOwnership(): Promise<number> {
    return this.reconstructSharedMemoryOwnership();
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?op WHERE { GRAPH <${metaGraph}> { ?op <${DKG}rootEntity> <${rootEntity}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;

      await this.store.delete([{
        subject: op, predicate: `${DKG}rootEntity`, object: rootEntity, graph: metaGraph,
      }]);

      const remaining = await this.store.query(
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> <${DKG}rootEntity> ?r } }`,
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
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const staleEvents = await this.store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o . FILTER(STR(?s) = "${lifecycleSubject}" || STRSTARTS(STR(?s), "${lifecycleSubject}/")) } }`,
    );
    if (staleEvents.type === 'bindings') {
      for (const row of staleEvents.bindings) {
        const subj = row['s'];
        if (subj) await this.store.deleteByPattern({ graph: metaGraph, subject: subj });
      }
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
    rejectReservedSubjectPrefixes(quads);
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

  async assertionPromote(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: { entities?: string[] | 'all'; subGraphName?: string; publisherPeerId?: string },
  ): Promise<{ promotedCount: number; gossipMessage?: Uint8Array }> {
    await this.ensureSubGraphRegistered(contextGraphId, opts?.subGraphName);
    const graphUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const swmGraphUri = this.graphManager.sharedMemoryUri(contextGraphId, opts?.subGraphName);

    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads' || result.quads.length === 0) return { promotedCount: 0 };

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
    // Without this filter, `autoPartition` below would treat
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
    // 3 tried blank-node subjects but an `autoPartition` audit showed
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
    quadsToPromote = quadsToPromote.filter((q) => !isReservedSubject(q.subject));

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
    const kaMap = autoPartition(quadsToPromote);
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
      const encoded = encodeWorkspacePublishRequest({
        contextGraphId: contextGraphId,
        nquads: new TextEncoder().encode(nquadsStr),
        manifest: manifestEntries,
        publisherPeerId: opts.publisherPeerId,
        workspaceOperationId: operationId,
        timestampMs: Date.now(),
        operationId,
        subGraphName: opts.subGraphName,
      });

      if (encoded.length > DKG_GOSSIP_MAX_MESSAGE_BYTES) {
        throw new Error(
          `Promoted assertion too large for gossip (${formatBytesAsKb(encoded.length)}, limit ${formatGossipLimit(DKG_GOSSIP_MAX_MESSAGE_BYTES)}). ` +
          `Promote fewer entities per call.`,
        );
      }
      gossipMessage = encoded;
    }

    // Rule 4: reject roots owned by a different peer before any mutations.
    const skippedRoots = new Set<string>();
    for (const root of rootEntities) {
      const owner = swmOwned.get(root);
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
      const metaQuads = generateShareMetadata(
        { shareOperationId: operationId, contextGraphId, rootEntities: effectiveRoots, publisherPeerId: opts.publisherPeerId, timestamp: new Date() },
        swmMetaGraph,
      );
      await this.store.insert(metaQuads);
      await storeWorkspaceOperationPublicQuads({
        store: this.store,
        graphManager: this.graphManager,
        contextGraphId,
        shareOperationId: operationId,
        rootEntities: effectiveRoots,
        quads: swmQuads,
        publisherPeerId: opts.publisherPeerId,
        subGraphName: opts.subGraphName,
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
