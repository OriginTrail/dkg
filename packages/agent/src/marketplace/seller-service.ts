/**
 * OT-RFC-27 marketplace seller runtime: answers live quotes, verifies and
 * serves buyer-authorized calls over `PROTOCOL_MARKETPLACE_SERVE`, meters with
 * the shared deterministic schedules, signs QueryInferenceReceipts with the
 * node's operational wallet, and batches receipt claims for on-chain
 * settlement through `chain.marketplaceSubmitReceiptBatch`.
 *
 * Fault philosophy mirrors the contract: every objective fault is rejected
 * BEFORE execution (version, field shapes, wrong seller, expiry, settlement
 * window, replay, signature against the buyer's registered session key), and
 * the response carries a machine-readable `errorCode` instead of receipt
 * fields. The per-`authDigest` replay guard is marked consumed at admission —
 * a failed execution keeps the authorization burned (fail closed; the buyer
 * voids its reservation and signs a fresh callId).
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
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ReceiptBatcher,
  buildReceipt,
  computeAuthDigest,
  eip191RecoverDigest,
  type Eip191Signer,
  type MarketplaceServiceType,
  type MarketplaceUnit,
  type ReceiptBatch,
  type ReceiptBatcherPolicy,
  type ReceiptClaimInput,
} from '@origintrail-official/dkg-marketplace';
import { rememberBounded } from '../bounded-map.js';
import type { MarketplaceExecutor } from './executors.js';
import { MarketplaceExecutionError } from './executors.js';
import type { ReliableSendResult, SendReliableOpts } from '../p2p/messenger.js';

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
  /** Injectable ms wall clock (expiry checks + batcher delay trigger). */
  now?: () => number;
  batching?: Partial<ReceiptBatcherPolicy>;
  /** Cached buyer session keys go stale after this long. */
  sessionKeyCacheTtlMs?: number;
}

export interface MarketplaceFlushResult {
  batches: number;
  claims: number;
  /** Claims dropped because their batch submission reverted/failed. */
  failedClaims: number;
  errors: string[];
}

const DEFAULT_BATCHING: ReceiptBatcherPolicy = {
  maxBatchSize: 100,
  maxDelayMs: 15_000,
  // 1 TRAC of unsubmitted per-buyer exposure forces an immediate submit.
  maxBuyerExposureWei: 10n ** 18n,
};

const SESSION_KEY_CACHE_TTL_MS = 60_000;
const REPLAY_GUARD_BOUND = 100_000;

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
  /** offeringId (bytes32 hex, lowercase) → offering. */
  #offerings = new Map<string, MarketplaceSellerOffering>();
  /** Locally consumed authDigests (bounded; the contract is the durable guard). */
  readonly #consumedAuth = new Map<string, true>();
  /** buyer (lowercase) → cached registered session key. */
  readonly #sessionKeyCache = new Map<string, { key: string; fetchedAtMs: number }>();
  #identityId: bigint | undefined;
  #digestContext: { chainId: bigint; marketplaceAddress: string } | undefined;
  #registered = false;
  #submittedClaims = 0;

  constructor(deps: MarketplaceSellerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#batcher = new ReceiptBatcher({ ...DEFAULT_BATCHING, ...deps.batching }, this.#now);
    this.#sessionKeyCacheTtlMs = deps.sessionKeyCacheTtlMs ?? SESSION_KEY_CACHE_TTL_MS;
  }

  /** Replace the served offering set (keyed by offeringId). */
  setOfferings(offerings: readonly MarketplaceSellerOffering[]): void {
    const next = new Map<string, MarketplaceSellerOffering>();
    for (const offering of offerings) {
      next.set(offering.offeringId.toLowerCase(), offering);
    }
    this.#offerings = next;
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
      return encodeMarketplaceQuoteResponse({ available: false, declineCode: 'UNKNOWN_OFFERING' });
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
    const nowSeconds = BigInt(Math.floor(this.#now() / 1000));
    if (nowSeconds > expiry) throw new ServeRejection('EXPIRED', `expiry ${expiry}, now ${nowSeconds}`);

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
    // retried under the same single-use authorization (fail closed).
    if (this.#consumedAuth.has(authDigest)) {
      throw new ServeRejection('REPLAYED_CALL_ID', authDigest);
    }
    rememberBounded(this.#consumedAuth, authDigest, true, REPLAY_GUARD_BOUND);

    const authSignature = ethers.hexlify(request.authSignature);
    await this.#verifyAuthSignature(buyer, authDigest, authSignature);

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
    this.#sessionKeyCache.set(cacheKey, { key, fetchedAtMs: this.#now() });
    return key;
  }

  /** Flush timer / settle-rail entry point. `all` drains regardless of triggers. */
  async flushReceipts(opts: { all?: boolean } = {}): Promise<MarketplaceFlushResult> {
    const batches = opts.all ? this.#batcher.drainAll() : this.#batcher.collectDue();
    return this.#submitBatches(batches);
  }

  async #submitBatches(batches: ReceiptBatch[]): Promise<MarketplaceFlushResult> {
    const result: MarketplaceFlushResult = { batches: 0, claims: 0, failedClaims: 0, errors: [] };
    for (const batch of batches) {
      try {
        if (typeof this.#deps.chain.marketplaceSubmitReceiptBatch !== 'function') {
          throw new Error('chain adapter cannot submit receipt batches');
        }
        await this.#deps.chain.marketplaceSubmitReceiptBatch(batch.claims);
        result.batches += 1;
        result.claims += batch.claims.length;
        this.#submittedClaims += batch.claims.length;
        this.#deps.log.info(
          `[marketplace] submitted receipt batch: epoch=${batch.epoch} claims=${batch.claims.length} trigger=${batch.trigger}`,
        );
      } catch (error) {
        // Prototype behaviour: any objective fault reverts the WHOLE batch
        // on-chain, so a poisoned batch is dropped (not retried) with a loud
        // warning rather than wedging the flush loop forever.
        const message = error instanceof Error ? error.message : String(error);
        result.failedClaims += batch.claims.length;
        result.errors.push(message);
        this.#deps.log.warn(
          `[marketplace] receipt batch submission failed (dropping ${batch.claims.length} claim(s)): ${message}`,
        );
      }
    }
    return result;
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
