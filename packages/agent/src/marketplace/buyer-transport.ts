/**
 * OT-RFC-27 buyer wire calls: live quote probes and one authorized serve with
 * full receipt verification (split from `buyer-service.ts`, which keeps the
 * plan, meter and routing state).
 *
 * Serve/quote requests go over the messenger's request-owned send, never the
 * durable outbox, so a "failed" call can never be silently retried-and-served
 * later behind the meter's back. Receipt trust is resolved ON-CHAIN: the
 * receipt signer recovered from `sellerSig` must resolve (IdentityStorage) to
 * the AUTHORIZED `sellerIdentityId` — the offer's RDF-published
 * `sellerAddress` is an unauthenticated routing hint and is never trusted.
 */
import { ethers } from 'ethers';
import {
  MARKETPLACE_SERVE_VERSION,
  PROTOCOL_MARKETPLACE_QUOTE,
  PROTOCOL_MARKETPLACE_SERVE,
  decodeMarketplaceQuoteResponse,
  decodeMarketplaceServeResponse,
  encodeMarketplaceQuoteRequest,
  encodeMarketplaceServeRequest,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeReceiptDigest,
  eip191RecoverDigest,
  verifyReceiptAgainstAuthorization,
  type BoundedAuthorization,
  type MarketplaceOffer,
  type MarketplaceQuote,
  type QueryInferenceReceipt,
} from '@origintrail-official/dkg-marketplace';
import { rememberBounded } from '../bounded-map.js';
import type { MarketplaceLogger, MarketplaceMessenger } from './seller-service.js';

/**
 * What is KNOWN about delivery when an invoke fails — it decides how the
 * meter reservation resolves:
 *  - `not-served`: the seller provably did not serve (definitive non-delivery
 *    or an explicit refusal errorCode) → void immediately.
 *  - `served`: the seller responded ok (it holds a claimable receipt) but the
 *    result/receipt could not be trusted → settle pessimistically at the
 *    reserved worst case.
 *  - `ambiguous`: the request may or may not have reached the seller
 *    (timeout mid-flight) → hold the reservation until the authorization
 *    expiry passes, then void.
 */
export type MarketplaceDeliveryState = 'not-served' | 'served' | 'ambiguous';

/** The selected seller failed the call (transport, errorCode, or bad receipt). */
export class MarketplaceInvokeError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly delivery: MarketplaceDeliveryState = 'not-served',
  ) {
    super(`marketplace: invoke failed (${code}): ${detail}`);
    this.name = 'MarketplaceInvokeError';
  }
}

/**
 * Transport errors that PROVE the request never reached the seller (dial /
 * address-resolution failures happen before any bytes go out). Anything else
 * — timeouts, stream resets, unknown faults — is ambiguous: the seller may
 * have received, served and enqueued a claim while the response was lost.
 */
const DEFINITE_NON_DELIVERY_PATTERNS = [
  'no valid addresses',
  'all multiaddr dials failed',
  'no_reservation',
  'econnrefused',
  'protocol selection failed',
  'no route to', // in-process test router double
  'no handler for', // remote never registered the marketplace protocols
];

function isDefinitelyUndelivered(message: string): boolean {
  const lower = message.toLowerCase();
  return DEFINITE_NON_DELIVERY_PATTERNS.some((needle) => lower.includes(needle));
}

/** A verified, served call (the buyer service adds the recount verdict). */
export interface MarketplaceServedCall {
  /** Executor output parsed from the result JSON bytes. */
  result: unknown;
  resultBytes: Uint8Array;
  receipt: QueryInferenceReceipt;
  authorization: BoundedAuthorization;
  seller: { peerId: string; identityId: bigint; address: string };
  servedUnits: bigint;
  costWei: bigint;
}

export interface BuyerTransportDeps {
  messenger: MarketplaceMessenger;
  chain: ChainAdapter;
  log: MarketplaceLogger;
  quoteTimeoutMs?: number;
}

/** Bound on cached receipt-signer → identityId resolutions. */
const SIGNER_IDENTITY_CACHE_BOUND = 1_024;

export class BuyerTransport {
  readonly #deps: BuyerTransportDeps;
  /** Receipt signer address (lowercase) → resolved on-chain identityId. */
  readonly #signerIdentityCache = new Map<string, bigint>();

  constructor(deps: BuyerTransportDeps) {
    this.#deps = deps;
  }

  async probeQuote(offer: MarketplaceOffer): Promise<MarketplaceQuote | undefined> {
    try {
      // Request-owned: a quote probe must never park in the durable outbox
      // and get retried hours later against a long-gone routing decision.
      const sent = await this.#deps.messenger.sendRequestOwned(
        offer.sellerPeerId,
        PROTOCOL_MARKETPLACE_QUOTE,
        encodeMarketplaceQuoteRequest({ offeringId: ethers.getBytes(offer.offeringId) }),
        this.#deps.quoteTimeoutMs !== undefined ? { timeoutMs: this.#deps.quoteTimeoutMs } : undefined,
      );
      if (!sent.delivered) return undefined;
      const response = decodeMarketplaceQuoteResponse(sent.response);
      if (!response.available || !response.askPerUnitWei) {
        this.#deps.log.info(
          `[marketplace] quote declined by ${offer.sellerPeerId} for ${offer.offeringId}: ${response.declineCode ?? 'unavailable'}`,
        );
        return {
          offeringId: offer.offeringId,
          sellerIdentityId: offer.sellerIdentityId,
          available: false,
          askPerUnitWei: 0n,
        };
      }
      const capacity = response.capacityUnitsPerMin === undefined
        ? undefined
        : BigInt(response.capacityUnitsPerMin.toString());
      return {
        offeringId: offer.offeringId,
        sellerIdentityId: offer.sellerIdentityId,
        available: true,
        askPerUnitWei: BigInt(response.askPerUnitWei),
        ...(capacity !== undefined && capacity > 0n ? { capacityUnitsPerMin: capacity } : {}),
      };
    } catch (error) {
      this.#deps.log.warn(
        `[marketplace] quote probe to ${offer.sellerPeerId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** Probe up to `maxProbes` distinct (seller, offering) pairs that pass `eligible`. */
  async probeQuotes(
    offers: readonly MarketplaceOffer[],
    eligible: (offer: MarketplaceOffer) => boolean,
    maxProbes: number,
  ): Promise<MarketplaceQuote[]> {
    const probes: MarketplaceOffer[] = [];
    const seen = new Set<string>();
    for (const offer of offers) {
      if (!eligible(offer)) continue;
      const key = `${offer.sellerPeerId}:${offer.offeringId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      probes.push(offer);
      if (probes.length >= maxProbes) break;
    }
    const quotes = await Promise.all(probes.map(async (offer) => this.probeQuote(offer)));
    return quotes.filter((quote): quote is MarketplaceQuote => quote !== undefined);
  }

  /**
   * Serve one authorized call and verify its receipt. A throw that proves the
   * dial never reached the seller is `not-served`; a seller refusal is
   * `not-served`; a transport fault mid-flight is `ambiguous`; anything after
   * an ok response that cannot be trusted is `served` (a claim exists).
   */
  async serve(
    offer: MarketplaceOffer,
    authorization: BoundedAuthorization,
    payload: Record<string, unknown>,
    serveTimeoutMs: number | undefined,
  ): Promise<MarketplaceServedCall> {
    const request = encodeMarketplaceServeRequest({
      version: MARKETPLACE_SERVE_VERSION,
      buyer: ethers.getBytes(authorization.buyer),
      sellerIdentityId: authorization.sellerIdentityId.toString(),
      offeringId: ethers.getBytes(authorization.offeringId),
      callId: ethers.getBytes(authorization.callId),
      epoch: authorization.epoch,
      maxUnits: authorization.maxUnits,
      askPerUnitWei: authorization.askPerUnitWei.toString(),
      expiry: authorization.expiry,
      authSignature: ethers.getBytes(authorization.signature),
      payloadKind: offer.serviceType === 'query' ? 'query' : 'inference',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });
    let sent;
    try {
      sent = await this.#deps.messenger.sendRequestOwned(
        offer.sellerPeerId,
        PROTOCOL_MARKETPLACE_SERVE,
        request,
        serveTimeoutMs !== undefined ? { timeoutMs: serveTimeoutMs } : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitelyUndelivered(message)) {
        throw new MarketplaceInvokeError('NOT_DELIVERED', message, 'not-served');
      }
      throw new MarketplaceInvokeError('DELIVERY_UNKNOWN', `serve transport failed mid-flight: ${message}`, 'ambiguous');
    }
    if (!sent.delivered) {
      // Request-owned sends never queue; this is the in-flight dedup shape —
      // another attempt owns the wire, so the outcome is unknown here.
      throw new MarketplaceInvokeError('DELIVERY_UNKNOWN', sent.error ?? 'serve request state unknown', 'ambiguous');
    }
    const response = decodeMarketplaceServeResponse(sent.response);
    if (!response.ok) {
      // An explicit refusal: the seller rejected BEFORE serving — no claim exists.
      throw new MarketplaceInvokeError(
        response.errorCode ?? 'SELLER_ERROR', `seller ${offer.sellerPeerId} refused`, 'not-served',
      );
    }
    // From here on the seller HAS served (ok response): failures settle
    // pessimistically, because a claim for this authorization exists.
    if (
      !response.resultCommitment || response.resultCommitment.byteLength !== 32
      || !response.sellerSignature || response.sellerSignature.byteLength !== 65
      || !response.authDigest || response.authDigest.byteLength !== 32
      || !response.receiptValueWei || !response.result
    ) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'serve response is missing receipt fields', 'served');
    }
    const receipt: QueryInferenceReceipt = {
      authDigest: ethers.hexlify(response.authDigest),
      servedUnits: BigInt((response.servedUnits ?? 0).toString()),
      receiptValueWei: BigInt(response.receiptValueWei),
      resultCommitment: ethers.hexlify(response.resultCommitment),
      sellerSig: ethers.hexlify(response.sellerSignature),
    };
    if (receipt.authDigest !== authorization.authDigest) {
      throw new MarketplaceInvokeError('MALFORMED_RECEIPT', 'receipt settles a different authorization', 'served');
    }
    // Recover the receipt signer FIRST, then verify everything against the
    // recovered wallet and resolve its on-chain identity.
    let signerAddress: string;
    try {
      signerAddress = eip191RecoverDigest(computeReceiptDigest(receipt), receipt.sellerSig);
    } catch (error) {
      throw new MarketplaceInvokeError(
        'BAD_RECEIPT', `sellerSig unrecoverable: ${error instanceof Error ? error.message : String(error)}`, 'served',
      );
    }
    const verification = verifyReceiptAgainstAuthorization(receipt, authorization, {
      sellerAddress: signerAddress,
      resultBytes: response.result,
    });
    if (!verification.ok) {
      throw new MarketplaceInvokeError('BAD_RECEIPT', verification.errors.join('; '), 'served');
    }
    const signerIdentityId = await this.#resolveSignerIdentity(signerAddress);
    if (signerIdentityId !== authorization.sellerIdentityId) {
      throw new MarketplaceInvokeError(
        'BAD_RECEIPT',
        `receipt signer ${signerAddress} resolves to identity ${signerIdentityId}, `
        + `the authorization binds seller ${authorization.sellerIdentityId}`,
        'served',
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(response.result));
    } catch {
      throw new MarketplaceInvokeError('MALFORMED_RESULT', 'result bytes are not valid JSON', 'served');
    }
    return {
      result,
      resultBytes: response.result,
      receipt,
      authorization,
      seller: {
        peerId: offer.sellerPeerId,
        identityId: authorization.sellerIdentityId,
        // The RECOVERED, identity-verified signer — never the offer hint.
        address: signerAddress,
      },
      servedUnits: receipt.servedUnits,
      costWei: receipt.receiptValueWei,
    };
  }

  /**
   * Resolve the recovered receipt signer to its on-chain identityId
   * (`IdentityStorage.getIdentityId`). Fails CLOSED: without a trustworthy
   * resolution the receipt cannot be attributed to the authorized seller.
   */
  async #resolveSignerIdentity(signerAddress: string): Promise<bigint> {
    const cacheKey = signerAddress.toLowerCase();
    const cached = this.#signerIdentityCache.get(cacheKey);
    if (cached !== undefined && cached > 0n) return cached;
    if (typeof this.#deps.chain.getIdentityIdForAddress !== 'function') {
      throw new MarketplaceInvokeError(
        'UNVERIFIABLE_SELLER', 'chain adapter cannot resolve wallet identities', 'served',
      );
    }
    let identityId: bigint;
    try {
      identityId = await this.#deps.chain.getIdentityIdForAddress(signerAddress);
    } catch (error) {
      throw new MarketplaceInvokeError(
        'UNVERIFIABLE_SELLER',
        `identity lookup for receipt signer ${signerAddress} failed: ${error instanceof Error ? error.message : String(error)}`,
        'served',
      );
    }
    if (identityId > 0n) {
      rememberBounded(this.#signerIdentityCache, cacheKey, identityId, SIGNER_IDENTITY_CACHE_BOUND);
    }
    return identityId;
  }
}
