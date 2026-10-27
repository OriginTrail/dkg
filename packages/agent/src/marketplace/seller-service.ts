/**
 * OT-RFC-27 marketplace seller runtime: answers live quotes, verifies and
 * serves buyer-authorized calls over `PROTOCOL_MARKETPLACE_SERVE`, meters with
 * the shared deterministic schedules, signs QueryInferenceReceipts with the
 * node's operational wallet, and batches receipt claims for on-chain
 * settlement through `chain.marketplaceSubmitReceiptBatch`.
 *
 * Fault philosophy mirrors the contract: every objective fault is rejected
 * BEFORE execution (version, field shapes, wrong seller, expiry against CHAIN
 * time plus a batching-window margin, settlement window, replay, signature
 * against the buyer's registered session key, and bucket funding/headroom —
 * `UNDERFUNDED` refuses service a bucket can never pay for), and the response
 * carries a machine-readable `errorCode` instead of receipt fields. The
 * per-`authDigest` replay guard is marked consumed at admission — a failed
 * execution keeps the authorization burned (fail closed; the buyer voids its
 * reservation and signs a fresh callId). With a `stateDir`, the replay guard
 * and the unsubmitted claims persist across restarts, and claim submission
 * requeues on transient faults / bisects on reverts instead of dropping
 * honest receipts.
 *
 * The service is deliberately agent-agnostic: it takes the messenger's
 * reliable register/send surface, a `ChainAdapter`, an EIP-191 receipt signer
 * (MUST be the operational wallet that submits batches — the contract resolves
 * the seller identity from the submitting `msg.sender`), and executors. The
 * `DKGAgent` mixin wires the production instances; unit tests construct it
 * directly against `MockChainAdapter` + an in-process messenger pair.
 */
import { ethers } from 'ethers';
import {
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_QUOTE,
  PROTOCOL_MARKETPLACE_SERVE,
  decodeMarketplaceQuoteRequest,
  decodeMarketplaceServeRequest,
  encodeMarketplaceQuoteResponse,
  encodeMarketplaceServeResponse,
} from '@origintrail-official/dkg-core';
import { isChainRpcTransportError, type ChainAdapter, type MarketplaceBucket } from '@origintrail-official/dkg-chain';
import {
  ReceiptBatcher,
  buildReceipt,
  computeAuthDigest,
  eip191RecoverDigest,
  type Eip191Signer,
  type MarketplaceOffer,
  type MarketplaceServiceType,
  type MarketplaceUnit,
  type ReceiptBatch,
  type ReceiptBatcherPolicy,
  type ReceiptClaimInput,
} from '@origintrail-official/dkg-marketplace';
import { rememberBounded } from '../bounded-map.js';
import type { MarketplaceExecutor } from './executors.js';
import { MarketplaceExecutionError } from './executors.js';
import { createChainClock, type ChainClock } from './chain-clock.js';
import { MarketplaceSellerStateStore } from './seller-state-store.js';
import type { ReliableSendResult, SendReliableOpts, ThrowingReliableSendResult } from '../p2p/messenger.js';

/** The reliable-messenger slice the marketplace services use (structurally `Messenger`). */
export interface MarketplaceMessenger {
  register(
    protocolId: string,
    handler: (payload: Uint8Array, fromPeerId: string) => Promise<Uint8Array>,
  ): void;
  sendReliable(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: SendReliableOpts,
  ): Promise<ReliableSendResult>;
  /**
   * Reliable framing WITHOUT the durable background-retry outbox: the request
   * either completes on the wire or throws to the caller, never getting
   * re-sent later behind the caller's back. The buyer's quote/serve calls use
   * this — a serve that the outbox silently retried after the buyer already
   * voided its reservation would be served and claimed with nothing metered.
   */
  sendRequestOwned(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: SendReliableOpts,
  ): Promise<ThrowingReliableSendResult>;
}

/** Context-free logger slice; the agent mixin binds it onto `Logger` + ctx. */
export interface MarketplaceLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** One configured offering with its resolved executor. */
export interface MarketplaceSellerOffering {
  offeringLocalId: string;
  /** bytes32 hex — `offeringIdFor(offeringLocalId)`; the wire/digest key. */
  offeringId: string;
  serviceType: MarketplaceServiceType;
  modelId?: string;
  unit: MarketplaceUnit;
  /** Current ask, wei per unit (uint96). */
  askPerUnitWei: bigint;
  capacityUnitsPerMin?: bigint;
  /** Unix seconds after which the published offer is stale. */
  expiresAt?: number;
  executor: MarketplaceExecutor;
  /** Published offer extensions (chat connectors, metering pin, model facts, query schedule, access). */
  apiShape?: MarketplaceOffer['apiShape'];
  toolTransport?: MarketplaceOffer['toolTransport'];
  metering?: MarketplaceOffer['metering'];
  model?: MarketplaceOffer['model'];
  queryCost?: MarketplaceOffer['queryCost'];
  access?: MarketplaceOffer['access'];
  /**
   * Lowercase buyer funding addresses this offering serves exclusively
   * (`access: 'restricted'`); never published. Checked AFTER the
   * authorization signature verifies, so it is no membership oracle.
   */
  allowedBuyers?: ReadonlySet<string>;
}

export interface MarketplaceSellerDeps {
  messenger: MarketplaceMessenger;
  chain: ChainAdapter;
  /**
   * EIP-191 signer for receipt digests — the operational wallet whose
   * `marketplaceSubmitReceiptBatch` transactions settle these receipts.
   */
  receiptSigner: Eip191Signer;
  /** Address of `receiptSigner`, published on offers for buyer-side verification. */
  receiptSignerAddress: string;
  log: MarketplaceLogger;
  /** Injectable ms wall clock (batcher delay trigger + cache TTLs). */
  now?: () => number;
  batching?: Partial<ReceiptBatcherPolicy>;
  /** Cached buyer session keys go stale after this long. */
  sessionKeyCacheTtlMs?: number;
  /** Cached buyer funding buckets go stale after this long. Default 15s. */
  bucketCacheTtlMs?: number;
  /**
   * Durable state home (replay guard + pending claims), usually
   * `<dataDir>/marketplace`. Omitted → in-memory only (tests / dataless
   * nodes): a restart forfeits pending receipts and forgets burned
   * authorizations (the contract's replay guard still backstops).
   */
  stateDir?: string;
  /**
   * The agent's receipt flush-timer cadence; feeds the authorization expiry
   * safety margin so a claim admitted now cannot expire inside the batching
   * window (flush interval + batcher maxDelay + a submit allowance).
   */
  flushIntervalMs?: number;
  /** Explicit expiry safety margin override (seconds). */
  expiryMarginSeconds?: number;
}

export interface MarketplaceFlushResult {
  batches: number;
  claims: number;
  /** Claims dropped because the chain REVERTED them (objective faults). */
  failedClaims: number;
  /** Claims put back in the batcher after a transient submission failure. */
  requeuedClaims: number;
  errors: string[];
}

const DEFAULT_BATCHING: ReceiptBatcherPolicy = {
  maxBatchSize: 100,
  maxDelayMs: 15_000,
  // 1 TRAC of unsubmitted per-buyer exposure forces an immediate submit.
  maxBuyerExposureWei: 10n ** 18n,
};

const SESSION_KEY_CACHE_TTL_MS = 60_000;
const BUCKET_CACHE_TTL_MS = 15_000;
const REPLAY_GUARD_BOUND = 100_000;
/** Per-buyer cache bounds (H): a stranger spray cannot grow these unbounded. */
const SESSION_KEY_CACHE_BOUND = 4_096;
const BUCKET_CACHE_BOUND = 4_096;
/** Submission allowance on top of the batching window (tx build + mine time). */
const SUBMIT_ALLOWANCE_SECONDS = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Transient vs revert classification for `submitReceiptBatch` failures.
 * Transport faults (RPC down/timeout/queue-full) and anything unrecognized
 * requeue the claims — dropping on an unknown error would forfeit real
 * receipts. Only an actual on-chain revert (ethers `CALL_EXCEPTION`, an
 * `execution reverted` message, or the mock adapter's revert shape) drops —
 * and then only after bisection has isolated the poisoned claim.
 */
function isBatchRevert(error: unknown): boolean {
  if (isChainRpcTransportError(error)) return false;
  if ((error as { code?: unknown })?.code === 'CALL_EXCEPTION') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|reverted with custom error/i.test(message);
}

/** uint64 wire fields decode to safe-integer numbers; normalize to bigint. */
function wireUint64ToBigint(value: number | bigint | { toString(): string }): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(value.toString());
}

/** Structured serve rejection carrying the wire `errorCode`. */
class ServeRejection extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = 'ServeRejection';
  }
}

export class MarketplaceSellerService {
  readonly #deps: MarketplaceSellerDeps;
  readonly #now: () => number;
  readonly #batcher: ReceiptBatcher;
  readonly #sessionKeyCacheTtlMs: number;
  readonly #bucketCacheTtlMs: number;
  /** offeringId (bytes32 hex, lowercase) → offering. */
  #offerings = new Map<string, MarketplaceSellerOffering>();
  /** Configured offerings whose connector is not mounted (quote → CONNECTOR_UNAVAILABLE). */
  #unavailable = new Set<string>();
  /** Locally consumed authDigests (bounded; the contract is the durable guard). */
  readonly #consumedAuth = new Map<string, true>();
  /** buyer (lowercase) → cached registered session key (bounded). */
  readonly #sessionKeyCache = new Map<string, { key: string; fetchedAtMs: number }>();
  /** `${buyer}|${epoch}` → cached funding bucket (bounded, short TTL). */
  readonly #bucketCache = new Map<string, { bucket: MarketplaceBucket; fetchedAtMs: number }>();
  readonly #stateStore: MarketplaceSellerStateStore | undefined;
  /**
   * True when no persisted replay state could be restored (no state dir, or
   * an empty/unreadable file): a local replay-cache miss then also consults
   * the contract's `consumedAuth` view, so a restart without durable state
   * cannot double-serve an authorization that already settled on-chain.
   */
  readonly #coldReplayCache: boolean;
  /** Authorization must outlive the batching window by this many seconds. */
  readonly #expiryMarginSeconds: bigint;
  readonly #chainClock: ChainClock;
  #identityId: bigint | undefined;
  #digestContext: { chainId: bigint; marketplaceAddress: string } | undefined;
  #registered = false;
  #submittedClaims = 0;

  constructor(deps: MarketplaceSellerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    const batching: ReceiptBatcherPolicy = { ...DEFAULT_BATCHING, ...deps.batching };
    this.#batcher = new ReceiptBatcher(batching, this.#now);
    this.#sessionKeyCacheTtlMs = deps.sessionKeyCacheTtlMs ?? SESSION_KEY_CACHE_TTL_MS;
    this.#bucketCacheTtlMs = deps.bucketCacheTtlMs ?? BUCKET_CACHE_TTL_MS;
    this.#expiryMarginSeconds = BigInt(
      deps.expiryMarginSeconds
      ?? Math.ceil(((deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS) + batching.maxDelayMs) / 1000)
        + SUBMIT_ALLOWANCE_SECONDS,
    );
    this.#chainClock = createChainClock({
      chain: deps.chain,
      localNowSeconds: () => Math.floor(this.#now() / 1000),
      warn: (message) => deps.log.warn(message),
    });

    // Durable state: reload burned authorizations and unsubmitted claims so a
    // restart neither double-serves nor forfeits receipts. Restored claims are
    // requeued as immediately due — the first flush tick resubmits them.
    if (deps.stateDir) {
      this.#stateStore = new MarketplaceSellerStateStore(
        deps.stateDir, REPLAY_GUARD_BOUND, (message) => deps.log.warn(message),
      );
      const digests = this.#stateStore.loadConsumedAuth();
      for (const digest of digests) rememberBounded(this.#consumedAuth, digest, true, REPLAY_GUARD_BOUND);
      const restored = this.#stateStore.loadPendingClaims();
      if (restored.length > 0) {
        this.#batcher.requeue(restored, { dueImmediately: true });
        deps.log.info(`[marketplace] restored ${restored.length} unsubmitted receipt claim(s) for resubmission`);
      }
      this.#coldReplayCache = digests.length === 0;
    } else {
      this.#coldReplayCache = true;
    }
  }

  /**
   * Replace the served offering set (keyed by offeringId). `unavailable`
   * lists offeringIds that are configured but not servable (a connector
   * still mounting or failed): quotes decline `CONNECTOR_UNAVAILABLE`, serves
   * answer `UNKNOWN_OFFERING`.
   */
  setOfferings(offerings: readonly MarketplaceSellerOffering[], opts: { unavailable?: Iterable<string> } = {}): void {
    const next = new Map<string, MarketplaceSellerOffering>();
    for (const offering of offerings) {
      next.set(offering.offeringId.toLowerCase(), offering);
    }
    this.#offerings = next;
    this.#unavailable = new Set([...(opts.unavailable ?? [])].map((id) => id.toLowerCase()));
  }

  listOfferings(): MarketplaceSellerOffering[] {
    return [...this.#offerings.values()];
  }

  /** Register the quote + serve protocol handlers on the messenger substrate. */
  registerProtocolHandlers(): void {
    if (this.#registered) return;
    this.#registered = true;
    this.#deps.messenger.register(PROTOCOL_MARKETPLACE_QUOTE, async (payload) => this.handleQuote(payload));
    this.#deps.messenger.register(PROTOCOL_MARKETPLACE_SERVE, async (payload, fromPeerId) =>
      this.handleServe(payload, fromPeerId));
  }

  async handleQuote(payload: Uint8Array): Promise<Uint8Array> {
    let offeringId: string;
    try {
      offeringId = ethers.hexlify(decodeMarketplaceQuoteRequest(payload).offeringId).toLowerCase();
    } catch {
      return encodeMarketplaceQuoteResponse({ available: false, declineCode: 'MALFORMED_REQUEST' });
    }
    const offering = this.#offerings.get(offeringId);
    if (!offering) {
      const declineCode = this.#unavailable.has(offeringId) ? 'CONNECTOR_UNAVAILABLE' : 'UNKNOWN_OFFERING';
      return encodeMarketplaceQuoteResponse({ available: false, declineCode });
    }
    return encodeMarketplaceQuoteResponse({
      available: true,
      askPerUnitWei: offering.askPerUnitWei.toString(),
      capacityUnitsPerMin: offering.capacityUnitsPerMin ?? 0n,
    });
  }

  async handleServe(payload: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    try {
      return await this.#serve(payload);
    } catch (error) {
      if (error instanceof ServeRejection) {
        this.#deps.log.warn(`[marketplace] serve from ${fromPeerId} rejected (${error.code}): ${error.message}`);
        return encodeMarketplaceServeResponse({ ok: false, errorCode: error.code });
      }
      this.#deps.log.warn(
        `[marketplace] serve from ${fromPeerId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return encodeMarketplaceServeResponse({ ok: false, errorCode: 'EXECUTION_FAILED' });
    }
  }

  async #serve(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeMarketplaceServeRequest(payload);
    if (request.version !== MARKETPLACE_SERVE_VERSION) {
      throw new ServeRejection('UNSUPPORTED_VERSION', `serve version ${request.version}`);
    }
    if (
      request.buyer.byteLength !== 20
      || request.offeringId.byteLength !== 32
      || request.callId.byteLength !== 32
      || request.authSignature.byteLength !== 65
    ) {
      throw new ServeRejection('MALFORMED_REQUEST', 'bad field byte lengths');
    }

    const offeringId = ethers.hexlify(request.offeringId).toLowerCase();
    const offering = this.#offerings.get(offeringId);
    if (!offering) throw new ServeRejection('UNKNOWN_OFFERING', offeringId);
    if (request.payloadKind !== offering.executor.kind) {
      throw new ServeRejection('WRONG_PAYLOAD_KIND', `${request.payloadKind} on a ${offering.executor.kind} offering`);
    }

    const identityId = await this.#resolveIdentityId();
    let sellerIdentityId: bigint;
    try {
      sellerIdentityId = BigInt(request.sellerIdentityId);
    } catch {
      throw new ServeRejection('MALFORMED_REQUEST', `bad sellerIdentityId: ${request.sellerIdentityId}`);
    }
    if (sellerIdentityId !== identityId) {
      throw new ServeRejection('WRONG_SELLER', `authorized ${sellerIdentityId}, this node is ${identityId}`);
    }

    let askPerUnitWei: bigint;
    try {
      askPerUnitWei = BigInt(request.askPerUnitWei);
    } catch {
      throw new ServeRejection('MALFORMED_REQUEST', `bad askPerUnitWei: ${request.askPerUnitWei}`);
    }
    // The authorization must carry at least the current ask — a stale cheaper
    // quote is refused rather than served below price.
    if (askPerUnitWei < offering.askPerUnitWei) {
      throw new ServeRejection('BAD_ASK', `authorized ${askPerUnitWei}, current ask ${offering.askPerUnitWei}`);
    }

    const maxUnits = wireUint64ToBigint(request.maxUnits);
    if (maxUnits <= 0n) throw new ServeRejection('MALFORMED_REQUEST', 'maxUnits must be positive');
    const expiry = wireUint64ToBigint(request.expiry);
    // CHAIN time — the clock the contract checks expiry against (wall-clock
    // fallback when the adapter has no latest-block read).
    const nowSeconds = await this.#chainClock.nowSeconds();
    if (nowSeconds > expiry) throw new ServeRejection('EXPIRED', `expiry ${expiry}, now ${nowSeconds}`);
    // The claim must survive the whole batching window (flush interval +
    // batcher maxDelay + a submit allowance) or it expires INSIDE the batcher
    // and poisons its submission — refuse up front instead.
    if (expiry - nowSeconds < this.#expiryMarginSeconds) {
      throw new ServeRejection(
        'STALE_AUTHORIZATION',
        `expiry ${expiry} leaves ${expiry - nowSeconds}s, below the ${this.#expiryMarginSeconds}s batching margin`,
      );
    }

    const epoch = wireUint64ToBigint(request.epoch);
    const currentEpoch = (await this.#deps.chain.getCurrentEpoch?.()) ?? 0n;
    if (currentEpoch > epoch) {
      throw new ServeRejection('SETTLEMENT_CLOSED', `epoch ${epoch}, current ${currentEpoch}`);
    }

    const buyer = ethers.getAddress(ethers.hexlify(request.buyer));
    const { chainId, marketplaceAddress } = await this.#resolveDigestContext();
    const authDigest = computeAuthDigest({
      chainId,
      marketplaceAddress,
      buyer,
      sellerIdentityId: identityId,
      offeringId,
      callId: ethers.hexlify(request.callId),
      epoch,
      maxUnits,
      askPerUnitWei,
      expiry,
    });

    // Replay guard — burned at admission, so a failed execution cannot be
    // retried under the same single-use authorization (fail closed). With a
    // COLD local cache (restart without durable state) the contract's own
    // `consumedAuth` view is consulted too, so an already-settled
    // authorization cannot be double-served into a doomed batch.
    if (this.#consumedAuth.has(authDigest)) {
      throw new ServeRejection('REPLAYED_CALL_ID', authDigest);
    }
    if (this.#coldReplayCache && typeof this.#deps.chain.marketplaceIsAuthConsumed === 'function') {
      const consumedOnChain = await this.#deps.chain.marketplaceIsAuthConsumed(authDigest).catch((error: unknown) => {
        // Transport fault: proceed on the local guard — the contract still
        // rejects a true replay at submission (and bisection isolates it).
        this.#deps.log.warn(
          `[marketplace] consumedAuth pre-check failed (serving on the local guard): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      });
      if (consumedOnChain) throw new ServeRejection('REPLAYED_CALL_ID', `${authDigest} already consumed on-chain`);
    }
    rememberBounded(this.#consumedAuth, authDigest, true, REPLAY_GUARD_BOUND);
    this.#stateStore?.appendConsumedAuth(authDigest);

    // Funding/headroom admission (UNDERFUNDED): a 1-wei bucket must not buy
    // unbounded service, and a claim the bucket can never pay would poison
    // receipt batches later. Headroom = funded − on-chain totalClaimed (every
    // seller) − this node's own unsubmitted exposure; the worst case of THIS
    // call must fit. Checked before the signature: an unfunded buyer has no
    // registered session key either, and the bucket read is cached/bounded
    // exactly like the session-key read.
    await this.#assertBucketHeadroom(buyer, epoch, maxUnits * askPerUnitWei);

    const authSignature = ethers.hexlify(request.authSignature);
    await this.#verifyAuthSignature(buyer, authDigest, authSignature);
    // Restricted offerings: checked only AFTER the signature verified, so an
    // unauthenticated prober cannot test addresses against the private list.
    if (offering.allowedBuyers && offering.allowedBuyers.size > 0 && !offering.allowedBuyers.has(buyer.toLowerCase())) {
      throw new ServeRejection('BUYER_NOT_ALLOWED', `buyer ${buyer} is not on this offering's allow list`);
    }

    let execution;
    try {
      execution = await offering.executor.execute(request.payload, { maxUnits });
    } catch (error) {
      if (error instanceof MarketplaceExecutionError) {
        throw new ServeRejection(error.code, error.message);
      }
      throw error;
    }
    if (execution.unitsServed <= 0n) {
      throw new ServeRejection('EMPTY_RESULT', 'executor served zero units');
    }
    if (execution.unitsServed > maxUnits) {
      throw new ServeRejection('OVER_MAX_UNITS', `${execution.unitsServed} > ${maxUnits}`);
    }

    const receipt = await buildReceipt({
      authDigest,
      servedUnits: execution.unitsServed,
      askPerUnitWei,
      resultBytes: execution.resultBytes,
      signer: this.#deps.receiptSigner,
    });

    const claim: ReceiptClaimInput = {
      buyer,
      epoch,
      offeringId,
      callId: ethers.hexlify(request.callId),
      maxUnits,
      askPerUnitWei,
      expiry,
      servedUnits: receipt.servedUnits,
      resultCommitment: receipt.resultCommitment,
      authSignature,
    };
    this.#batcher.add(claim);
    this.#persistPendingClaims();
    // Opportunistic flush for size/exposure triggers — detached so chain
    // submission latency never sits on the serve response path, and
    // `#submitBatches` never rejects (failures are logged + counted).
    void this.#submitBatches(this.#batcher.collectDue());

    return encodeMarketplaceServeResponse({
      ok: true,
      servedUnits: receipt.servedUnits,
      receiptValueWei: receipt.receiptValueWei.toString(),
      resultCommitment: ethers.getBytes(receipt.resultCommitment),
      sellerSignature: ethers.getBytes(receipt.sellerSig),
      result: execution.resultBytes,
      authDigest: ethers.getBytes(authDigest),
    });
  }

  async #resolveIdentityId(): Promise<bigint> {
    if (this.#identityId !== undefined && this.#identityId > 0n) return this.#identityId;
    this.#identityId = await this.#deps.chain.getIdentityId();
    if (this.#identityId <= 0n) {
      throw new ServeRejection('SELLER_NOT_READY', 'seller node has no on-chain identity');
    }
    return this.#identityId;
  }

  async #resolveDigestContext(): Promise<{ chainId: bigint; marketplaceAddress: string }> {
    if (this.#digestContext) return this.#digestContext;
    const { chain } = this.#deps;
    if (chain.supportsMarketplace?.() !== true || typeof chain.marketplaceGetAddress !== 'function') {
      throw new ServeRejection('SELLER_NOT_READY', 'chain adapter does not support the marketplace');
    }
    const chainId = await chain.getEvmChainId();
    const marketplaceAddress = await chain.marketplaceGetAddress();
    this.#digestContext = { chainId, marketplaceAddress };
    return this.#digestContext;
  }

  async #verifyAuthSignature(buyer: string, authDigest: string, authSignature: string): Promise<void> {
    let recovered: string;
    try {
      recovered = eip191RecoverDigest(authDigest, authSignature);
    } catch {
      throw new ServeRejection('BAD_AUTH', 'authorization signature unrecoverable');
    }
    let sessionKey = await this.#activeSessionKey(buyer, false);
    if (sessionKey.toLowerCase() !== recovered.toLowerCase()) {
      // The buyer may have rotated its key since we cached it — refresh once.
      sessionKey = await this.#activeSessionKey(buyer, true);
    }
    if (sessionKey === ethers.ZeroAddress || sessionKey.toLowerCase() !== recovered.toLowerCase()) {
      throw new ServeRejection('BAD_AUTH', `signature recovers ${recovered}, registered key ${sessionKey}`);
    }
  }

  async #activeSessionKey(buyer: string, forceRefresh: boolean): Promise<string> {
    const cacheKey = buyer.toLowerCase();
    const cached = this.#sessionKeyCache.get(cacheKey);
    if (!forceRefresh && cached && this.#now() - cached.fetchedAtMs < this.#sessionKeyCacheTtlMs) {
      return cached.key;
    }
    if (typeof this.#deps.chain.marketplaceGetActiveSessionKey !== 'function') {
      throw new ServeRejection('SELLER_NOT_READY', 'chain adapter cannot read session keys');
    }
    const key = await this.#deps.chain.marketplaceGetActiveSessionKey(buyer);
    rememberBounded(this.#sessionKeyCache, cacheKey, { key, fetchedAtMs: this.#now() }, SESSION_KEY_CACHE_BOUND);
    return key;
  }

  /** The buyer's funding bucket, cached briefly (same pattern as session keys). */
  async #bucketFor(buyer: string, epoch: bigint): Promise<MarketplaceBucket> {
    const cacheKey = `${buyer.toLowerCase()}|${epoch}`;
    const cached = this.#bucketCache.get(cacheKey);
    if (cached && this.#now() - cached.fetchedAtMs < this.#bucketCacheTtlMs) {
      return cached.bucket;
    }
    if (typeof this.#deps.chain.marketplaceGetBucket !== 'function') {
      throw new ServeRejection('SELLER_NOT_READY', 'chain adapter cannot read funding buckets');
    }
    const bucket = await this.#deps.chain.marketplaceGetBucket(buyer, epoch);
    rememberBounded(this.#bucketCache, cacheKey, { bucket, fetchedAtMs: this.#now() }, BUCKET_CACHE_BOUND);
    return bucket;
  }

  /** UNDERFUNDED admission: refuse when the bucket cannot pay this call. */
  async #assertBucketHeadroom(buyer: string, epoch: bigint, worstCaseWei: bigint): Promise<void> {
    const bucket = await this.#bucketFor(buyer, epoch);
    if (bucket.funded === 0n) {
      throw new ServeRejection('UNDERFUNDED', `bucket (${buyer}, ${epoch}) holds no funding`);
    }
    const unsubmittedWei = this.#batcher.pendingExposureWei(buyer, epoch);
    const headroomWei = bucket.funded - bucket.totalClaimed - unsubmittedWei;
    if (worstCaseWei > headroomWei) {
      throw new ServeRejection(
        'UNDERFUNDED',
        `worst case ${worstCaseWei} wei exceeds bucket headroom ${headroomWei} `
        + `(funded ${bucket.funded}, claimed ${bucket.totalClaimed}, unsubmitted ${unsubmittedWei})`,
      );
    }
  }

  #persistPendingClaims(): void {
    this.#stateStore?.savePendingClaims(this.#batcher.pendingClaims());
  }

  /** Flush timer / settle-rail entry point. `all` drains regardless of triggers. */
  async flushReceipts(opts: { all?: boolean } = {}): Promise<MarketplaceFlushResult> {
    const batches = opts.all ? this.#batcher.drainAll() : this.#batcher.collectDue();
    return this.#submitBatches(batches);
  }

  async #submitBatches(batches: ReceiptBatch[]): Promise<MarketplaceFlushResult> {
    const result: MarketplaceFlushResult = { batches: 0, claims: 0, failedClaims: 0, requeuedClaims: 0, errors: [] };
    for (const batch of batches) {
      await this.#submitClaims(batch.epoch, batch.claims, batch.trigger, result);
    }
    if (batches.length > 0) this.#persistPendingClaims();
    return result;
  }

  /**
   * Submit one drained batch with failure isolation. Transient faults
   * (transport/estimation) REQUEUE the claims — the batcher's fresh delay
   * window is the retry backoff and nothing is forfeited. An on-chain revert
   * voids the whole submission atomically, so a reverted multi-claim batch is
   * BISECTED (split and resubmitted in halves, at most ~2·log₂(n) extra
   * submissions) until the poisoned claim is isolated; only that single claim
   * is dropped, honest receipts around it still settle.
   */
  async #submitClaims(
    epoch: bigint,
    claims: ReceiptClaimInput[],
    trigger: ReceiptBatch['trigger'],
    result: MarketplaceFlushResult,
  ): Promise<void> {
    const queue: ReceiptClaimInput[][] = [claims];
    while (queue.length > 0) {
      const current = queue.shift()!;
      try {
        if (typeof this.#deps.chain.marketplaceSubmitReceiptBatch !== 'function') {
          throw new Error('chain adapter cannot submit receipt batches');
        }
        await this.#deps.chain.marketplaceSubmitReceiptBatch(current);
        result.batches += 1;
        result.claims += current.length;
        this.#submittedClaims += current.length;
        this.#deps.log.info(
          `[marketplace] submitted receipt batch: epoch=${epoch} claims=${current.length} trigger=${trigger}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isBatchRevert(error)) {
          this.#batcher.requeue(current);
          result.requeuedClaims += current.length;
          result.errors.push(message);
          this.#deps.log.warn(
            `[marketplace] receipt batch submission failed transiently (requeued ${current.length} claim(s)): ${message}`,
          );
        } else if (current.length === 1) {
          result.failedClaims += 1;
          result.errors.push(message);
          this.#deps.log.warn(
            `[marketplace] dropping reverted receipt claim (callId ${current[0].callId}): ${message}`,
          );
        } else {
          const mid = Math.ceil(current.length / 2);
          queue.unshift(current.slice(0, mid), current.slice(mid));
          this.#deps.log.warn(
            `[marketplace] receipt batch of ${current.length} reverted — bisecting to isolate the poisoned claim: ${message}`,
          );
        }
      }
    }
  }

  pendingReceiptCount(): number {
    return this.#batcher.pendingCount();
  }

  status(): { offerings: number; pendingReceipts: number; submittedClaims: number } {
    return {
      offerings: this.#offerings.size,
      pendingReceipts: this.#batcher.pendingCount(),
      submittedClaims: this.#submittedClaims,
    };
  }
}
