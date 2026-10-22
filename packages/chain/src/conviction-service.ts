// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27): the chain-adapter surface.
 *
 * The owner of a Publishing Conviction Account switches service spending on
 * (`ServiceSubscriptions.setServiceSpending`) and assigns a buyer key bounded
 * plan-funding authority, with that key's consent over one EIP-712
 * `ServiceAssignment` digest (`assign`). The buyer key then funds one plan
 * period per transaction from the account's allowance (`fundFromConviction`).
 * The cost is drawn as a publish draws it, the current billing window first
 * and then the top-up buffer, at the account's discount tier, and it is
 * labelled against the account's own scheduled staker emission. No TRAC moves.
 *
 * This module holds what both adapters share: the types, the optional
 * `ChainAdapter` methods, the EIP-712 typed data and the argument of each
 * contract call. `evm-adapter-conviction-service.ts` implements the methods
 * against the contracts, `mock-adapter-conviction-service.ts` in memory.
 * Amounts are TRAC wei, times are unix seconds.
 */
import { ethers } from 'ethers';
import type { TxResult } from './chain-adapter.js';
import { ConvictionServiceInputError } from './conviction-service-errors.js';

export const CA_EIP712_DOMAIN_NAME = 'DKGConvictionServices';
export const CA_EIP712_DOMAIN_VERSION = '1';

/** `ConvictionServiceStorage.CLASS_INFERENCE`: units are tokens. */
export const CA_SERVICE_CLASS_INFERENCE = 1;
/** `ConvictionServiceStorage.CLASS_QUERY`: units are query units. */
export const CA_SERVICE_CLASS_QUERY = 2;
export type CaServiceClass = typeof CA_SERVICE_CLASS_INFERENCE | typeof CA_SERVICE_CLASS_QUERY;

/** Most epochs one `getConvictionServiceLabels` read covers. */
export const CA_LABELS_MAX_EPOCHS = 120;
/** Most periods one `listServicePeriods` page holds. */
export const CA_PERIODS_MAX_LIMIT = 100;

/** The EIP-712 domain the owner and the assignee consent under. */
export interface CaEip712Domain {
  name: typeof CA_EIP712_DOMAIN_NAME;
  version: typeof CA_EIP712_DOMAIN_VERSION;
  chainId: number;
  /** The `ServiceSubscriptions` contract. */
  verifyingContract: string;
}

/** Addresses and the consent domain, for signing away from the node. */
export interface CaContracts {
  serviceSubscriptions: string;
  convictionServiceStorage: string;
  publishingConviction: string;
  /** `PublishingConviction.version()`; service spending needs 10.1.0 or later. */
  logicVersion: string;
  domain: CaEip712Domain;
}

/**
 * The terms both parties consent to: the EIP-712 `ServiceAssignment` message.
 * Every cap is in cost, TRAC wei drawn from the account's allowance after its
 * discount. A class cap of 0 refuses that class; `maxCostPerWindow` 0 means no
 * per-window cap; `nonce` is the account's current assignment nonce.
 */
export interface CaAssignmentTerms {
  accountId: bigint;
  assignee: string;
  maxCostPerPeriod: bigint;
  maxInferenceCostPerPeriod: bigint;
  maxQueryCostPerPeriod: bigint;
  maxCostPerWindow: bigint;
  maxTotalCost: bigint;
  maxPeriodSeconds: number;
  expiresAt: number;
  nonce: bigint;
}

/** The seven limits of an assignment, which the owner can change alone. */
export type CaAssignmentCaps = Pick<CaAssignmentTerms,
  'maxCostPerPeriod' | 'maxInferenceCostPerPeriod' | 'maxQueryCostPerPeriod' | 'maxCostPerWindow' |
  'maxTotalCost' | 'maxPeriodSeconds' | 'expiresAt'>;

/** What an assignee has drawn since its assignment, counted against its caps. */
export interface CaAssignmentUsage {
  totalCost: bigint;
  /** Drawn in billing window `window`; 0 again once another window starts. */
  windowCost: bigint;
  window: number;
  periods: number;
}

/** A stored assignment: its current caps (the owner may have changed them), times and usage. */
export interface CaAssignment extends Omit<CaAssignmentTerms, 'accountId' | 'nonce'> {
  assignedAt: number;
  /** 0 = not revoked. */
  revokedAt: number;
  /** The account nonce this assignment consumed. */
  nonce: bigint;
  /** Assigned, not revoked and not expired at the chain's current time. */
  active: boolean;
  usage: CaAssignmentUsage;
}

/** One service bucket of a funding request or a funded period. */
export interface CaBucket {
  bucketId: string;
  serviceClass: CaServiceClass;
  /** The funded value before the discount. */
  value: bigint;
  /** The buyer's price cap per unit. */
  maxAskWeiPerUnit: bigint;
}

/** A buyer key's request to fund one plan period. */
export interface CaFundingRequest {
  accountId: bigint;
  /** Chosen by the buyer, unique per buyer key: the period's idempotency key. */
  periodId: string;
  /** The buyer's request-signing key; the zero address when none. */
  sessionKey: string;
  periodSeconds: number;
  /** The buyer's commitment to its plan, opaque to the contracts. */
  planDigest: string;
  /** 1 to `maxBucketsPerPeriod` buckets, in strictly increasing `bucketId` order. */
  buckets: CaBucket[];
}

/** A funded plan period, as `ConvictionServiceStorage` records it. */
export interface CaPeriod {
  subscriptionId: string;
  accountId: bigint;
  assignee: string;
  sessionKey: string;
  periodId: string;
  planDigest: string;
  periodStart: number;
  periodEnd: number;
  fundedEpoch: number;
  fundedWindow: number;
  discountBps: number;
  value: bigint;
  cost: bigint;
  drawnFromWindow: bigint;
  drawnFromTopUp: bigint;
  buckets: CaBucket[];
}

/** `ServiceSubscriptions.currentWindowAllowance`, with the window's base allowance. */
export interface CaWindowAllowance {
  /** The billing window that contains the chain's current time, capped at the lock. */
  index: number;
  baseAllowance: bigint;
  /** Not yet drawn from the window, by publishing or services; 0 once expired. */
  baseRemaining: bigint;
  topUpBuffer: bigint;
  expired: boolean;
}

export interface CaServiceStatus {
  accountId: bigint;
  owner: string;
  logicVersion: string;
  /** When the owner switched service spending on; 0 = off. */
  serviceSpendingEnabledAt: number;
  discountBps: number;
  lockDurationEpochs: number;
  expiresAtTimestamp: number;
  window: CaWindowAllowance;
  /**
   * `exact`: the account was created at or after the chain's schedule cut-over,
   * so its labels count against an exactly reproducible schedule. False while
   * the cut-over is unset, when service spending cannot be switched on.
   */
  schedule: { exact: boolean; firstEpoch: number; lastEpoch: number };
  /** `remainingBaseCapacity` is 0 while the schedule cut-over is unset. */
  labels: { total: bigint; cursor: number; remainingBaseCapacity: bigint };
  assignments: { count: number; active: number };
  /** A protocol treasury is wired, which pauses service spending. */
  treasuryWired: boolean;
}

/**
 * One epoch of labels. `scheduled` is the account's scheduled staker emission
 * in the epoch (0 while the schedule cut-over is unset). `baseLabel` and
 * `topUpLabel` are the account's labels; `serviceLabel` and `pool` are the
 * epoch's, over all accounts: `serviceLabel(epoch)` and
 * `EpochStorage.getEpochPool(1, epoch)`.
 */
export interface CaEpochLabel {
  epoch: number;
  scheduled: bigint;
  baseLabel: bigint;
  topUpLabel: bigint;
  serviceLabel: bigint;
  pool: bigint;
}

/**
 * A period funding. With `existing: true` the period was already funded under
 * this buyer key and `periodId`, nothing was sent, and the transaction fields
 * and `logIndex` are those of the original funding's `PeriodFunded` log.
 */
export interface CaPeriodFunding extends TxResult {
  subscriptionId: string;
  cost: bigint;
  /** Index of the `PeriodFunded` log in its block. */
  logIndex: number;
  existing: boolean;
  /** The funded period, from the receipt (or the stored record when `existing`). */
  period: CaPeriod;
}

/**
 * The service-spending methods of `ChainAdapter`. All are optional: an adapter
 * without them has no service contracts. Reverts surface as
 * `ConvictionServiceRevertError`, classified by `kind`; a chain whose Hub
 * lacks the service contracts throws `ConvictionServiceUnavailableError`.
 */
export interface ConvictionServiceAdapter {
  /** The addresses and consent domain, or `null` when the Hub lacks the service contracts. */
  getConvictionServiceContracts?(): Promise<CaContracts | null>;
  /**
   * The account's service-spending status, read from the chain on every call
   * (`fresh` is accepted for callers that state it), or `null` for an unknown account.
   */
  getConvictionServiceStatus?(accountId: bigint, opts?: { fresh?: boolean }): Promise<CaServiceStatus | null>;
  /** `ServiceSubscriptions.currentWindowAllowance`, or `null` for an unknown account. */
  getConvictionServiceWindowAllowance?(accountId: bigint): Promise<CaWindowAllowance | null>;
  /** The nonce the account's next assignment must carry. */
  getConvictionServiceAssignmentNonce?(accountId: bigint): Promise<bigint>;

  /** Owner: switch service spending on or off. */
  setConvictionServiceSpending?(accountId: bigint, enabled: boolean): Promise<TxResult>;
  /**
   * The buyer key's EIP-712 consent to `terms`. Sends nothing. Refuses terms
   * whose `assignee` is not the buyer key.
   */
  signConvictionServiceConsent?(terms: CaAssignmentTerms): Promise<{ digest: string; signature: string }>;
  /**
   * Submit an assignment, sent by the owner wallet or by the buyer key. A party
   * that sends the transaction consents by sending it, so its signature is
   * dropped; every other party's signature must be given.
   */
  assignConvictionServiceBuyer?(
    terms: CaAssignmentTerms,
    signatures: { owner?: string; assignee?: string },
    sendAs: 'owner' | 'assignee',
  ): Promise<TxResult & { digest: string }>;
  /** Owner: revoke an assignment. Also advances the assignment nonce. */
  revokeConvictionServiceBuyer?(accountId: bigint, assignee: string): Promise<TxResult & { nextNonce: bigint }>;
  /** Owner: replace a live assignment's caps; its usage and nonce are kept. */
  updateConvictionServiceCaps?(accountId: bigint, assignee: string, caps: CaAssignmentCaps): Promise<TxResult>;
  /** Owner: advance the assignment nonce, so terms signed and not yet submitted no longer assign. */
  advanceConvictionServiceNonce?(accountId: bigint): Promise<TxResult & { nextNonce: bigint }>;

  /** Every assignee ever assigned on the account, in assignment order, with its assignment. */
  listConvictionServiceAssignments?(accountId: bigint): Promise<Array<{ assignee: string } & CaAssignment>>;
  /** Labels per epoch, `fromEpoch` to `toEpoch` inclusive, at most `CA_LABELS_MAX_EPOCHS` epochs. */
  getConvictionServiceLabels?(accountId: bigint, fromEpoch: number, toEpoch: number): Promise<CaEpochLabel[]>;

  /**
   * Buyer key: fund one plan period. A `periodId` this buyer key already funded
   * is answered from the chain with `existing: true` and nothing is sent, so a
   * retried request never funds twice.
   */
  fundServicePeriodFromConviction?(req: CaFundingRequest): Promise<CaPeriodFunding>;
  /** A funded period, or `null` when `subscriptionId` funded none. */
  getServicePeriod?(subscriptionId: string): Promise<CaPeriod | null>;
  /** The account's periods in funding order, `limit` (at most `CA_PERIODS_MAX_LIMIT`) from `offset`. */
  listServicePeriods?(accountId: bigint, offset: number, limit: number): Promise<{ total: number; periods: CaPeriod[] }>;
  /** The key that consents and funds as the assignee, or `null` when the node cannot sign for it. */
  getConvictionServiceBuyerAddress?(): string | null;
}

/** EIP-712 types of `ServiceSubscriptions.SERVICE_ASSIGNMENT_TYPEHASH`, field for field. */
export const SERVICE_ASSIGNMENT_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  ServiceAssignment: [
    { name: 'accountId', type: 'uint256' },
    { name: 'assignee', type: 'address' },
    { name: 'maxCostPerPeriod', type: 'uint96' },
    { name: 'maxInferenceCostPerPeriod', type: 'uint96' },
    { name: 'maxQueryCostPerPeriod', type: 'uint96' },
    { name: 'maxCostPerWindow', type: 'uint96' },
    { name: 'maxTotalCost', type: 'uint96' },
    { name: 'maxPeriodSeconds', type: 'uint32' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'uint64' },
  ],
};

/** The domain of a `ServiceSubscriptions` deployment. */
export function convictionServiceDomain(chainId: number | bigint, verifyingContract: string): CaEip712Domain {
  return {
    name: CA_EIP712_DOMAIN_NAME,
    version: CA_EIP712_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: requireAddress(verifyingContract, 'verifyingContract'),
  };
}

/** `ServiceSubscriptions.hashAssignment(terms)`: the digest both parties consent to. */
export function serviceAssignmentDigest(domain: CaEip712Domain, terms: CaAssignmentTerms): string {
  return ethers.TypedDataEncoder.hash(domain, SERVICE_ASSIGNMENT_TYPES, assignmentTermsArg(terms));
}

/** `ServiceSubscriptions.subscriptionIdOf`: `keccak256(abi.encode(assignee, periodId))`. */
export function serviceSubscriptionIdOf(assignee: string, periodId: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes32'],
    [requireAddress(assignee, 'assignee'), requireBytes32(periodId, 'periodId')],
  ));
}

const UINT96_MAX = (1n << 96n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** The `AssignmentTerms` argument of `assign` and `hashAssignment`, validated. */
export function assignmentTermsArg(terms: CaAssignmentTerms): {
  accountId: bigint; assignee: string;
  maxCostPerPeriod: bigint; maxInferenceCostPerPeriod: bigint; maxQueryCostPerPeriod: bigint;
  maxCostPerWindow: bigint; maxTotalCost: bigint; maxPeriodSeconds: number; expiresAt: number; nonce: bigint;
} {
  return {
    accountId: requireUint(terms.accountId, UINT256_MAX, 'accountId'),
    assignee: requireAddress(terms.assignee, 'assignee'),
    ...assignmentCapsArg(terms),
    nonce: requireUint(terms.nonce, UINT64_MAX, 'nonce'),
  };
}

/** The `AssignmentCaps` argument of `updateAssignmentCaps`, validated. */
export function assignmentCapsArg(caps: CaAssignmentCaps): CaAssignmentCaps {
  return {
    maxCostPerPeriod: requireUint(caps.maxCostPerPeriod, UINT96_MAX, 'maxCostPerPeriod'),
    maxInferenceCostPerPeriod: requireUint(caps.maxInferenceCostPerPeriod, UINT96_MAX, 'maxInferenceCostPerPeriod'),
    maxQueryCostPerPeriod: requireUint(caps.maxQueryCostPerPeriod, UINT96_MAX, 'maxQueryCostPerPeriod'),
    maxCostPerWindow: requireUint(caps.maxCostPerWindow, UINT96_MAX, 'maxCostPerWindow'),
    maxTotalCost: requireUint(caps.maxTotalCost, UINT96_MAX, 'maxTotalCost'),
    maxPeriodSeconds: requireSafeUint(caps.maxPeriodSeconds, 0xffff_ffff, 'maxPeriodSeconds'),
    expiresAt: requireSafeUint(caps.expiresAt, 0xff_ffff_ffff, 'expiresAt'),
  };
}

/** The `FundingRequest` argument of `fundFromConviction`, validated. */
export function fundingRequestArg(req: CaFundingRequest): CaFundingRequest {
  if (!Array.isArray(req.buckets)) throw new ConvictionServiceInputError('buckets must be an array');
  return {
    accountId: requireUint(req.accountId, UINT256_MAX, 'accountId'),
    periodId: requireBytes32(req.periodId, 'periodId'),
    sessionKey: requireAddress(req.sessionKey, 'sessionKey'),
    periodSeconds: requireSafeUint(req.periodSeconds, 0xffff_ffff, 'periodSeconds'),
    planDigest: requireBytes32(req.planDigest, 'planDigest'),
    buckets: req.buckets.map((bucket, i) => ({
      bucketId: requireBytes32(bucket.bucketId, `buckets[${i}].bucketId`),
      // A class other than 1 or 2 is left to the contract, which refuses it.
      serviceClass: requireSafeUint(bucket.serviceClass, 0xff, `buckets[${i}].serviceClass`) as CaServiceClass,
      value: requireUint(bucket.value, UINT96_MAX, `buckets[${i}].value`),
      maxAskWeiPerUnit: requireUint(bucket.maxAskWeiPerUnit, UINT96_MAX, `buckets[${i}].maxAskWeiPerUnit`),
    })),
  };
}

/** A Conviction Account id, or a `ConvictionServiceInputError`. */
export function requireAccountId(accountId: unknown): bigint {
  return requireUint(accountId, UINT256_MAX, 'accountId');
}

/** The epoch range of one labels read: inclusive, at most `CA_LABELS_MAX_EPOCHS` epochs. */
export function requireLabelRange(fromEpoch: unknown, toEpoch: unknown): { fromEpoch: number; toEpoch: number } {
  if (!Number.isSafeInteger(fromEpoch) || !Number.isSafeInteger(toEpoch)
    || (fromEpoch as number) < 0 || (toEpoch as number) < (fromEpoch as number)
    || (toEpoch as number) - (fromEpoch as number) + 1 > CA_LABELS_MAX_EPOCHS) {
    throw new ConvictionServiceInputError(
      `fromEpoch and toEpoch must be integers with 0 <= fromEpoch <= toEpoch, covering at most ${CA_LABELS_MAX_EPOCHS} epochs`,
    );
  }
  return { fromEpoch: fromEpoch as number, toEpoch: toEpoch as number };
}

/** One page of a periods read. */
export function requirePeriodPage(offset: unknown, limit: unknown): { offset: number; limit: number } {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > CA_PERIODS_MAX_LIMIT) {
    throw new ConvictionServiceInputError(
      `offset must be an integer >= 0 and limit an integer from 1 to ${CA_PERIODS_MAX_LIMIT}`,
    );
  }
  return { offset: offset as number, limit: limit as number };
}

/**
 * The signature `assign` takes for `party`. A party that sends the transaction
 * consents by sending it, and the contract refuses a signature from it, so it
 * is empty; for any other party it is `given`, or empty when not given, which
 * the contract refuses as `ConsentMissing`. `party` is `null` when it is not
 * known (an account the chain cannot find), and `given` is then passed on.
 */
export function consentSignatureArg(party: string | null, sender: string, given: string | undefined): string {
  if (party !== null && party.toLowerCase() === sender.toLowerCase()) return '0x';
  if (given === undefined || given === '' || given === '0x') return '0x';
  if (typeof given !== 'string' || !ethers.isHexString(given) || given.length % 2 !== 0) {
    throw new ConvictionServiceInputError('consent signatures must be 0x-prefixed hex bytes');
  }
  return given.toLowerCase();
}

/** The checksummed address, or a `ConvictionServiceInputError`. */
export function requireAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ethers.isAddress(value)) {
    throw new ConvictionServiceInputError(`${field} must be a 20-byte hex address`);
  }
  return ethers.getAddress(value);
}

/** The lower-case 32-byte hex string, or a `ConvictionServiceInputError`. */
export function requireBytes32(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ethers.isHexString(value, 32)) {
    throw new ConvictionServiceInputError(`${field} must be a 32-byte 0x-prefixed hex string`);
  }
  return value.toLowerCase();
}

function requireUint(value: unknown, max: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > max) {
    throw new ConvictionServiceInputError(`${field} must be a bigint from 0 to ${max}`);
  }
  return value;
}

function requireSafeUint(value: unknown, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ConvictionServiceInputError(`${field} must be an integer from 0 to ${max}`);
  }
  return value;
}
