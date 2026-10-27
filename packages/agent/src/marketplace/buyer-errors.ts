/**
 * OT-RFC-27 buyer gateway errors and the spend-guard hook. Dependency-free at
 * runtime (type-only imports), so `gateway-domain.ts` can re-export it to the
 * daemon's key store and gateway routes without loading the agent runtime.
 * The daemon matches these by `err.name`, never `instanceof`.
 */
import type { RecountVerdict } from '@origintrail-official/dkg-marketplace';
import type { MarketplaceInvokeResult } from './buyer-service.js';

/**
 * A per-call spend hook (the gateway's key budget). `admit` runs once, after
 * routing and BEFORE the plan reservation / authorization signing — throwing
 * refuses the call, and the error propagates unchanged. `settle` runs exactly
 * once iff `admit` returned, with what is known about the charge.
 */
export interface MarketplaceSpendGuard {
  admit(worstCaseCostWei: bigint): void;
  settle(outcome: { costWei: bigint; servedUnits: bigint; delivery: 'served' | 'not-served' | 'ambiguous' }): void;
}

/** A spend guard refused the call (the key budget cannot cover its worst case). */
export class MarketplaceSpendRefusedError extends Error {
  constructor(
    readonly code: 'key_budget_exceeded',
    message: string,
    readonly remainingWei?: bigint,
  ) {
    super(message);
    this.name = 'MarketplaceSpendRefusedError';
  }
}

export type MarketplaceRequestErrorCode =
  | 'invalid_messages'
  | 'invalid_tools'
  | 'invalid_parameter'
  | 'unsupported_parameter'
  | 'invalid_model'
  | 'invalid_sparql';

/** The caller's request is malformed; raised before any quote, reservation or signature. */
export class MarketplaceRequestError extends Error {
  constructor(
    readonly code: MarketplaceRequestErrorCode,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = 'MarketplaceRequestError';
  }
}

/** Discovery found offers, but none serves `openai-chat/v1` for this model. */
export class MarketplaceModelNotFoundError extends Error {
  constructor(readonly model: string) {
    super(`marketplace: no chat offer serves model ${JSON.stringify(model)}`);
    this.name = 'MarketplaceModelNotFoundError';
  }
}

/**
 * The served result's tool calls fail the request's tool policy. The receipt
 * is valid, so the call IS charged: `costWei` is the receipt value.
 */
export class MarketplaceInvalidToolResponseError extends Error {
  constructor(
    message: string,
    readonly invoke: MarketplaceInvokeResult,
    readonly recount: RecountVerdict,
  ) {
    super(message);
    this.name = 'MarketplaceInvalidToolResponseError';
  }

  get costWei(): bigint {
    return this.invoke.costWei;
  }

  get servedUnits(): bigint {
    return this.invoke.servedUnits;
  }
}
