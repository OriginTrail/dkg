// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27) on the mock adapter.
 *
 * An in-memory model of `ServiceSubscriptions` and `ConvictionServiceStorage`
 * over the mock's Publishing Conviction accounts: the base class of
 * `MockChainAdapter`, which provides the accounts. Each method refuses what the contracts
 * refuse, in the contracts' order, by throwing the `ConvictionServiceRevertError`
 * the EVM adapter throws, with the same name and arguments (by their ABI
 * names). Offline mode therefore answers as a chain would.
 *
 * The model:
 *   - Time. The mock has no chain clock, so service spending keeps its own:
 *     the wall clock when first read, then moved only by
 *     `advanceMockConvictionServiceTime` or `configureMockConvictionService`.
 *     An account enters the model the first time a service-spending call
 *     reads it, created at the start of that epoch (epochs are
 *     `floor(now / epochLengthSeconds)`), so each billing window is one epoch,
 *     and it expires `lockDurationEpochs` epochs later.
 *   - Allowance. A window's base allowance is `committedTRAC / lock`, less the
 *     service draws in that window (the mock's publishes draw nothing), and the
 *     top-up buffer is the account's less the service draws on it.
 *   - Labels. The account's scheduled emission is its window budget in each
 *     of its lock epochs (the `committed mod lock` dust in the last), and a
 *     funding labels its window part as base label and its top-up part as
 *     top-up label, both in the funding epoch. A window draws at most its
 *     budget, so a base label never exceeds the schedule, and an epoch's
 *     `pool` is the modeled emission: the accounts' schedules plus their
 *     top-up labels. The contracts' schedule basis and nearest-first placement
 *     are outside the mock's parity, as settlement is for the Publishing
 *     Conviction mock (the evm-module label tests cover them), so the mock
 *     never refuses `LabelCapacityExceeded`.
 *   - Consent is verified as the contract verifies an EOA's: the signature
 *     must recover to the party, with a low `s`. The mock has no ERC-1271
 *     wallets.
 *   - The buyer key is the mock signer unless configured, and it signs
 *     consents only with a configured wallet.
 */

import { ethers } from 'ethers';
import type { TxResult } from './chain-adapter.js';
import {
  SERVICE_ASSIGNMENT_TYPES,
  assignmentCapsArg,
  assignmentTermsArg,
  consentSignatureArg,
  convictionServiceDomain,
  fundingRequestArg,
  requireAccountId,
  requireAddress,
  requireBytes32,
  requireLabelRange,
  requirePeriodPage,
  serviceAssignmentDigest,
  serviceSubscriptionIdOf,
  type CaAssignment,
  type CaAssignmentCaps,
  type CaAssignmentTerms,
  type CaContracts,
  type CaEip712Domain,
  type CaEpochLabel,
  type CaFundingRequest,
  type CaPeriod,
  type CaPeriodFunding,
  type CaServiceStatus,
  type CaWindowAllowance,
  type ConvictionServiceAdapter,
} from './conviction-service.js';
import {
  ConvictionServiceInputError,
  ConvictionServiceRevertError,
  ConvictionServiceUnavailableError,
} from './conviction-service-errors.js';

/** The mock's Publishing Conviction account record (`MockChainAdapter.convictionAccounts`). */
export interface MockConvictionAccountRecord {
  owner: string;
  committedTRAC: bigint;
  topUpBuffer: bigint;
  lockDurationEpochs: number;
  /** Discount tier (bps) fixed at creation, mirrors the contract. */
  discountBps: number;
  /** Monotonic mock epoch captured at creation (no chronos in mock). */
  createdAtEpoch: number;
  /** OT-RFC-51 designated node identityId this PCA funds (0n = none). */
  primaryNode: bigint;
  agents: Set<string>;
}

/** Fixed addresses the mock reports for the service contracts. */
export const MOCK_SERVICE_SUBSCRIPTIONS_ADDRESS = ethers.getAddress('0x' + '5e'.repeat(20));
export const MOCK_CONVICTION_SERVICE_STORAGE_ADDRESS = ethers.getAddress('0x' + '5c'.repeat(20));
export const MOCK_PUBLISHING_CONVICTION_ADDRESS = ethers.getAddress('0x' + '9c'.repeat(20));

export interface MockConvictionServiceOptions {
  /** `false`: the chain has no service contracts. */
  available?: boolean;
  /** The clock, unix seconds. */
  now?: number;
  /** Seconds per epoch and per billing window. Default one day. */
  epochLengthSeconds?: number;
  /** The schedule cut-over; 0 = unset. Default 1: set, before every account. */
  exactScheduleFrom?: number;
  /** `ParametersStorage.protocolTreasury()`; any but the zero address pauses service spending. */
  protocolTreasury?: string;
  maxPeriodSeconds?: number;
  maxBucketsPerPeriod?: number;
  /**
   * The buyer key: a wallet, which also signs consents; an address; or `null`
   * for a configured key the node cannot sign for.
   */
  buyer?: ethers.Wallet | string | null;
}

interface MockAssignment extends CaAssignmentCaps {
  assignedAt: number;
  revokedAt: number;
  nonce: bigint;
}

interface MockUsage { totalCost: bigint; windowCost: bigint; window: number; periods: number }

interface MockServiceAccount {
  createdAt: number;
  enabledAt: number;
  nonce: bigint;
  /** Checksummed, in first-assignment order, each once. */
  assignees: string[];
  /** By lower-case assignee. */
  assignments: Map<string, MockAssignment>;
  usage: Map<string, MockUsage>;
  windowSpent: Map<number, bigint>;
  topUpDrawn: bigint;
  baseLabels: Map<number, bigint>;
  topUpLabels: Map<number, bigint>;
  labelCursor: number;
  labelTotal: bigint;
  subscriptions: string[];
}

interface MockServiceState {
  available: boolean;
  now: number;
  epochLengthSeconds: number;
  exactScheduleFrom: number;
  protocolTreasury: string;
  maxPeriodSeconds: number;
  maxBucketsPerPeriod: number;
  buyer: { address: string | null; wallet?: ethers.Wallet } | undefined;
  accounts: Map<bigint, MockServiceAccount>;
  fundings: Map<string, { tx: TxResult; logIndex: number; period: CaPeriod }>;
  epochServiceLabels: Map<number, bigint>;
}

const UINT96_MAX = (1n << 96n) - 1n;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const BPS = 10_000n;

function revert(name: string, args: Record<string, unknown> = {}): ConvictionServiceRevertError {
  return new ConvictionServiceRevertError(name, args);
}

/** The contract's EOA consent check: 65-byte `(r, s, v)` or 64-byte `(r, vs)`, low `s`, recovering to `party`. */
function isValidEoaConsent(party: string, digest: string, signature: string): boolean {
  const bytes = ethers.getBytes(signature);
  if (bytes.length !== 65 && bytes.length !== 64) return false;
  let s = BigInt(ethers.hexlify(bytes.slice(32, 64)));
  if (bytes.length === 64) s &= (1n << 255n) - 1n;
  // ecrecover takes only v 27 or 28; the contract does not normalize 0 or 1.
  if (s > SECP256K1_HALF_N || (bytes.length === 65 && bytes[64] !== 27 && bytes[64] !== 28)) return false;
  try {
    return ethers.recoverAddress(digest, signature) === ethers.getAddress(party);
  } catch {
    return false;
  }
}

/** The contract's caps rules (`_validateCaps`), in its order. */
function validateCaps(c: CaAssignmentCaps, maxPeriodSeconds: number, now: number): void {
  const reason = c.maxCostPerPeriod === 0n ? 'maxCostPerPeriod'
    : c.maxInferenceCostPerPeriod > c.maxCostPerPeriod ? 'maxInferenceCostPerPeriod'
      : c.maxQueryCostPerPeriod > c.maxCostPerPeriod ? 'maxQueryCostPerPeriod'
        : c.maxInferenceCostPerPeriod === 0n && c.maxQueryCostPerPeriod === 0n ? 'classCaps'
          : c.maxTotalCost < c.maxCostPerPeriod ? 'maxTotalCost'
            : c.maxCostPerWindow !== 0n && c.maxCostPerWindow < c.maxCostPerPeriod ? 'maxCostPerWindow'
              : c.maxPeriodSeconds === 0 || c.maxPeriodSeconds > maxPeriodSeconds ? 'maxPeriodSeconds'
                : c.expiresAt <= now ? 'expiresAt'
                  : null;
  if (reason) throw revert('InvalidAssignmentTerms', { reason });
}

const capsOf = (a: CaAssignmentCaps): CaAssignmentCaps => ({
  maxCostPerPeriod: a.maxCostPerPeriod,
  maxInferenceCostPerPeriod: a.maxInferenceCostPerPeriod,
  maxQueryCostPerPeriod: a.maxQueryCostPerPeriod,
  maxCostPerWindow: a.maxCostPerWindow,
  maxTotalCost: a.maxTotalCost,
  maxPeriodSeconds: a.maxPeriodSeconds,
  expiresAt: a.expiresAt,
});

export abstract class MockConvictionServiceMethods implements ConvictionServiceAdapter {
  // What `MockChainAdapter` provides: its signer, its Publishing Conviction
  // accounts and its transaction results.
  abstract readonly signerAddress: string;
  protected abstract readonly convictionAccounts: Map<bigint, MockConvictionAccountRecord>;
  protected abstract txResult(success: boolean): TxResult;

  private mockServiceState?: MockServiceState;

  /** Set the model's parameters, clock or buyer key (tests and offline mode). */
  configureMockConvictionService(options: MockConvictionServiceOptions): void {
    const s = this.mockServiceStateOf();
    if (options.available !== undefined) s.available = options.available;
    if (options.now !== undefined) s.now = options.now;
    if (options.epochLengthSeconds !== undefined) s.epochLengthSeconds = options.epochLengthSeconds;
    if (options.exactScheduleFrom !== undefined) s.exactScheduleFrom = options.exactScheduleFrom;
    if (options.protocolTreasury !== undefined) s.protocolTreasury = requireAddress(options.protocolTreasury, 'protocolTreasury');
    if (options.maxPeriodSeconds !== undefined) s.maxPeriodSeconds = options.maxPeriodSeconds;
    if (options.maxBucketsPerPeriod !== undefined) s.maxBucketsPerPeriod = options.maxBucketsPerPeriod;
    if (options.buyer === null) s.buyer = { address: null };
    else if (typeof options.buyer === 'string') s.buyer = { address: requireAddress(options.buyer, 'buyer') };
    else if (options.buyer) s.buyer = { address: options.buyer.address, wallet: options.buyer };
  }

  /** Move the model's clock forward. */
  advanceMockConvictionServiceTime(seconds: number): void {
    this.mockServiceStateOf().now += seconds;
  }

  async getConvictionServiceContracts(): Promise<CaContracts | null> {
    if (!this.mockServiceStateOf().available) return null;
    return {
      serviceSubscriptions: MOCK_SERVICE_SUBSCRIPTIONS_ADDRESS,
      convictionServiceStorage: MOCK_CONVICTION_SERVICE_STORAGE_ADDRESS,
      publishingConviction: MOCK_PUBLISHING_CONVICTION_ADDRESS,
      logicVersion: '10.1.0',
      domain: this.mockServiceDomain(),
    };
  }

  async getConvictionServiceStatus(accountId: bigint, _opts?: { fresh?: boolean }): Promise<CaServiceStatus | null> {
    requireAccountId(accountId);
    const s = this.mockServiceAvailable();
    const entry = this.mockServiceAccount(accountId);
    if (!entry) return null;
    const { pca, ca } = entry;
    const [firstEpoch, lastEpoch] = this.mockServiceSpan(ca, pca);
    let capacity = 0n;
    if (s.exactScheduleFrom !== 0) {
      for (let e = Math.max(ca.labelCursor, this.mockServiceEpoch(), firstEpoch); e <= lastEpoch; e++) {
        const free = this.mockServiceScheduled(ca, pca, e) - (ca.baseLabels.get(e) ?? 0n);
        if (free > 0n) capacity += free;
      }
    }
    const assignments = ca.assignees.map((a) => this.mockServiceAssignmentOf(ca, a));
    return {
      accountId,
      owner: ethers.getAddress(pca.owner),
      logicVersion: '10.1.0',
      serviceSpendingEnabledAt: ca.enabledAt,
      discountBps: pca.discountBps,
      lockDurationEpochs: pca.lockDurationEpochs,
      expiresAtTimestamp: this.mockServiceExpiresAt(ca, pca),
      window: this.mockServiceAllowance(ca, pca),
      schedule: { exact: s.exactScheduleFrom !== 0 && ca.createdAt >= s.exactScheduleFrom, firstEpoch, lastEpoch },
      labels: { total: ca.labelTotal, cursor: ca.labelCursor, remainingBaseCapacity: capacity },
      assignments: { count: assignments.length, active: assignments.filter((a) => a.active).length },
      treasuryWired: s.protocolTreasury !== ethers.ZeroAddress,
    };
  }

  async getConvictionServiceWindowAllowance(accountId: bigint): Promise<CaWindowAllowance | null> {
    requireAccountId(accountId);
    this.mockServiceAvailable();
    const entry = this.mockServiceAccount(accountId);
    return entry ? this.mockServiceAllowance(entry.ca, entry.pca) : null;
  }

  async getConvictionServiceAssignmentNonce(accountId: bigint): Promise<bigint> {
    requireAccountId(accountId);
    return this.mockServiceAvailable().accounts.get(accountId)?.nonce ?? 0n;
  }

  async setConvictionServiceSpending(accountId: bigint, enabled: boolean): Promise<TxResult> {
    requireAccountId(accountId);
    if (typeof enabled !== 'boolean') throw new ConvictionServiceInputError('enabled must be a boolean');
    const s = this.mockServiceAvailable();
    const { pca, ca } = this.mockServiceOwned(accountId);
    if (enabled) {
      if (s.exactScheduleFrom === 0) throw revert('ExactScheduleFromUnset');
      if (s.protocolTreasury !== ethers.ZeroAddress) {
        throw revert('ServiceFundingPausedTreasuryWired', { treasury: s.protocolTreasury });
      }
      this.mockServiceRequireUnexpired(accountId, ca, pca);
      if (ca.enabledAt !== 0) throw revert('ServiceSpendingUnchanged', { accountId, enabled: true });
      ca.enabledAt = s.now;
    } else {
      if (ca.enabledAt === 0) throw revert('ServiceSpendingUnchanged', { accountId, enabled: false });
      ca.enabledAt = 0;
    }
    return this.txResult(true);
  }

  async signConvictionServiceConsent(terms: CaAssignmentTerms): Promise<{ digest: string; signature: string }> {
    const message = assignmentTermsArg(terms);
    const buyer = this.mockServiceBuyer();
    if (message.assignee !== buyer.address) {
      throw new ConvictionServiceInputError(`terms.assignee ${message.assignee} is not this node's buyer key ${buyer.address}`);
    }
    this.mockServiceAvailable();
    if (!buyer.wallet) {
      throw new ConvictionServiceUnavailableError(
        `The mock buyer key ${buyer.address} has no signing key: configure one with configureMockConvictionService({ buyer: wallet }).`,
      );
    }
    const domain = this.mockServiceDomain();
    const signature = await buyer.wallet.signTypedData(domain, SERVICE_ASSIGNMENT_TYPES, message);
    return { digest: serviceAssignmentDigest(domain, terms), signature };
  }

  async assignConvictionServiceBuyer(
    terms: CaAssignmentTerms,
    signatures: { owner?: string; assignee?: string },
    sendAs: 'owner' | 'assignee',
  ): Promise<TxResult & { digest: string }> {
    const t = assignmentTermsArg(terms);
    if (sendAs !== 'owner' && sendAs !== 'assignee') {
      throw new ConvictionServiceInputError("sendAs must be 'owner' or 'assignee'");
    }
    const sender = sendAs === 'owner' ? ethers.getAddress(this.signerAddress) : this.mockServiceBuyer().address;
    const s = this.mockServiceAvailable();
    const entry = this.mockServiceAccount(t.accountId);
    const owner = entry ? ethers.getAddress(entry.pca.owner) : null;
    const ownerSignature = consentSignatureArg(owner, sender, signatures.owner);
    const assigneeSignature = consentSignatureArg(t.assignee, sender, signatures.assignee);

    if (!entry || entry.ca.enabledAt === 0) throw revert('ServiceSpendingDisabled', { accountId: t.accountId });
    const { ca } = entry;
    if (t.assignee === ethers.ZeroAddress) throw revert('InvalidAssignmentTerms', { reason: 'assignee' });
    validateCaps(t, s.maxPeriodSeconds, s.now);
    if (t.nonce !== ca.nonce) {
      throw revert('InvalidAssignmentNonce', { accountId: t.accountId, expected: ca.nonce, provided: t.nonce });
    }
    const digest = serviceAssignmentDigest(this.mockServiceDomain(), t);
    this.mockServiceRequireConsent(owner!, sender, digest, ownerSignature);
    this.mockServiceRequireConsent(t.assignee, sender, digest, assigneeSignature);

    const key = t.assignee.toLowerCase();
    if (!ca.assignments.has(key)) ca.assignees.push(t.assignee);
    ca.assignments.set(key, { ...capsOf(t), assignedAt: s.now, revokedAt: 0, nonce: ca.nonce });
    ca.usage.delete(key);
    ca.nonce += 1n;
    return { ...this.txResult(true), digest };
  }

  async revokeConvictionServiceBuyer(accountId: bigint, assignee: string): Promise<TxResult & { nextNonce: bigint }> {
    requireAccountId(accountId);
    const who = requireAddress(assignee, 'assignee');
    const s = this.mockServiceAvailable();
    const { ca } = this.mockServiceOwned(accountId);
    const a = ca.assignments.get(who.toLowerCase());
    if (!a) throw revert('NotAssigned', { accountId, assignee: who });
    if (a.revokedAt !== 0) throw revert('AssignmentRevoked', { accountId, assignee: who });
    a.revokedAt = s.now;
    ca.nonce += 1n;
    return { ...this.txResult(true), nextNonce: ca.nonce };
  }

  async updateConvictionServiceCaps(accountId: bigint, assignee: string, caps: CaAssignmentCaps): Promise<TxResult> {
    requireAccountId(accountId);
    const who = requireAddress(assignee, 'assignee');
    const c = assignmentCapsArg(caps);
    const s = this.mockServiceAvailable();
    const { ca } = this.mockServiceOwned(accountId);
    const a = this.mockServiceLiveAssignment(accountId, ca, who);
    validateCaps(c, s.maxPeriodSeconds, s.now);
    const current = capsOf(a);
    if ((Object.keys(current) as Array<keyof CaAssignmentCaps>).every((k) => current[k] === c[k])) {
      throw revert('CapsUnchanged', { accountId, assignee: who });
    }
    Object.assign(a, c);
    return this.txResult(true);
  }

  async advanceConvictionServiceNonce(accountId: bigint): Promise<TxResult & { nextNonce: bigint }> {
    requireAccountId(accountId);
    this.mockServiceAvailable();
    const { ca } = this.mockServiceOwned(accountId);
    ca.nonce += 1n;
    return { ...this.txResult(true), nextNonce: ca.nonce };
  }

  async listConvictionServiceAssignments(accountId: bigint): Promise<Array<{ assignee: string } & CaAssignment>> {
    requireAccountId(accountId);
    const ca = this.mockServiceAvailable().accounts.get(accountId);
    return ca ? ca.assignees.map((a) => this.mockServiceAssignmentOf(ca, a)) : [];
  }

  async listConvictionServiceAccountsByAssignee(
    assignee: string,
  ): Promise<Array<{ accountId: bigint; assignee: string } & CaAssignment>> {
    const who = requireAddress(assignee, 'assignee');
    const accounts = [...this.mockServiceAvailable().accounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return accounts
      .filter(([, ca]) => ca.assignments.has(who.toLowerCase()))
      .map(([accountId, ca]) => ({ accountId, ...this.mockServiceAssignmentOf(ca, who) }));
  }

  async getConvictionServiceLabels(accountId: bigint, fromEpoch: number, toEpoch: number): Promise<CaEpochLabel[]> {
    requireLabelRange(fromEpoch, toEpoch);
    requireAccountId(accountId);
    const s = this.mockServiceAvailable();
    const entry = this.mockServiceAccount(accountId);
    if (!entry) throw revert('UnknownAccount', { accountId });
    const out: CaEpochLabel[] = [];
    for (let epoch = fromEpoch; epoch <= toEpoch; epoch++) {
      out.push({
        epoch,
        scheduled: s.exactScheduleFrom === 0 ? 0n : this.mockServiceScheduled(entry.ca, entry.pca, epoch),
        baseLabel: entry.ca.baseLabels.get(epoch) ?? 0n,
        topUpLabel: entry.ca.topUpLabels.get(epoch) ?? 0n,
        serviceLabel: s.epochServiceLabels.get(epoch) ?? 0n,
        pool: this.mockServicePool(epoch),
      });
    }
    return out;
  }

  async fundServicePeriodFromConviction(req: CaFundingRequest): Promise<CaPeriodFunding> {
    const r = fundingRequestArg(req);
    const buyer = this.mockServiceBuyer().address;
    const subscriptionId = serviceSubscriptionIdOf(buyer, r.periodId);
    const s = this.mockServiceAvailable();
    const prior = s.fundings.get(subscriptionId);
    if (prior) {
      return { ...prior.tx, subscriptionId, cost: prior.period.cost, logIndex: prior.logIndex, existing: true, period: prior.period };
    }
    // 1. The opt-in and a live assignment.
    const entry = this.mockServiceAccount(r.accountId);
    if (!entry || entry.ca.enabledAt === 0) throw revert('ServiceSpendingDisabled', { accountId: r.accountId });
    const { pca, ca } = entry;
    const a = this.mockServiceLiveAssignment(r.accountId, ca, buyer);
    // 2. The buckets, and the value per class.
    if (r.buckets.length === 0 || r.buckets.length > s.maxBucketsPerPeriod) {
      throw revert('InvalidFundingRequest', { reason: 'bucketCount' });
    }
    let inference = 0n;
    let query = 0n;
    r.buckets.forEach((b, i) => {
      if (i > 0 && BigInt(b.bucketId) <= BigInt(r.buckets[i - 1]!.bucketId)) throw revert('InvalidFundingRequest', { reason: 'bucketOrder' });
      if (b.serviceClass === 1) inference += b.value;
      else if (b.serviceClass === 2) query += b.value;
      else throw revert('InvalidFundingRequest', { reason: 'serviceClass' });
      if (b.value === 0n) throw revert('InvalidFundingRequest', { reason: 'bucketValue' });
      if (b.maxAskWeiPerUnit === 0n) throw revert('InvalidFundingRequest', { reason: 'maxAskWeiPerUnit' });
    });
    // 3. The period length; 4. the value.
    if (r.periodSeconds === 0 || r.periodSeconds > Math.min(s.maxPeriodSeconds, a.maxPeriodSeconds)) {
      throw revert('InvalidFundingRequest', { reason: 'periodSeconds' });
    }
    const value = inference + query;
    if (value > UINT96_MAX) throw revert('InvalidFundingRequest', { reason: 'value' });
    // 6. The cost at the account's tier, with the 1-wei floor; 7. the caps.
    const kept = BPS - BigInt(pca.discountBps);
    let cost = (value * kept) / BPS;
    if (cost === 0n) cost = 1n;
    if (cost > a.maxCostPerPeriod) {
      throw revert('CapExceeded', { cap: 'maxCostPerPeriod', limit: a.maxCostPerPeriod, attempted: cost });
    }
    for (const [cap, classValue, limit] of [
      ['maxInferenceCostPerPeriod', inference, a.maxInferenceCostPerPeriod],
      ['maxQueryCostPerPeriod', query, a.maxQueryCostPerPeriod],
    ] as const) {
      const classCost = (classValue * kept) / BPS;
      if (classValue > 0n && (limit === 0n || classCost > limit)) throw revert('CapExceeded', { cap, limit, attempted: classCost });
    }
    const window = this.mockServiceWindow(ca);
    const usage = ca.usage.get(buyer.toLowerCase()) ?? { totalCost: 0n, windowCost: 0n, window: 0, periods: 0 };
    const windowCost = (usage.window === window ? usage.windowCost : 0n) + cost;
    if (a.maxCostPerWindow !== 0n && windowCost > a.maxCostPerWindow) {
      throw revert('CapExceeded', { cap: 'maxCostPerWindow', limit: a.maxCostPerWindow, attempted: windowCost });
    }
    if (usage.totalCost + cost > a.maxTotalCost) {
      throw revert('CapExceeded', { cap: 'maxTotalCost', limit: a.maxTotalCost, attempted: usage.totalCost + cost });
    }
    // 8. The draw: `PublishingConviction.coverServiceCost`.
    if (s.protocolTreasury !== ethers.ZeroAddress) {
      throw revert('ServiceFundingPausedTreasuryWired', { treasury: s.protocolTreasury });
    }
    this.mockServiceRequireUnexpired(r.accountId, ca, pca);
    const epoch = this.mockServiceEpoch();
    const allowance = this.mockServiceAllowance(ca, pca);
    const windowRemaining = allowance.baseRemaining;
    let drawnFromWindow = cost;
    let drawnFromTopUp = 0n;
    if (cost > windowRemaining) {
      drawnFromWindow = windowRemaining;
      drawnFromTopUp = cost - windowRemaining;
      if (drawnFromTopUp > allowance.topUpBuffer) {
        throw revert('InsufficientAllowance', {
          accountId: r.accountId, epoch: BigInt(epoch), required: cost, available: windowRemaining + allowance.topUpBuffer,
        });
      }
    }
    // The writes: allowance, labels, usage and the period record.
    ca.windowSpent.set(window, (ca.windowSpent.get(window) ?? 0n) + drawnFromWindow);
    ca.topUpDrawn += drawnFromTopUp;
    if (drawnFromWindow > 0n) ca.baseLabels.set(epoch, (ca.baseLabels.get(epoch) ?? 0n) + drawnFromWindow);
    if (drawnFromTopUp > 0n) ca.topUpLabels.set(epoch, (ca.topUpLabels.get(epoch) ?? 0n) + drawnFromTopUp);
    ca.labelCursor = Math.max(ca.labelCursor, epoch);
    ca.labelTotal += cost;
    s.epochServiceLabels.set(epoch, (s.epochServiceLabels.get(epoch) ?? 0n) + cost);
    ca.usage.set(buyer.toLowerCase(), {
      totalCost: usage.totalCost + cost, windowCost, window, periods: usage.periods + 1,
    });
    const period: CaPeriod = {
      subscriptionId,
      accountId: r.accountId,
      assignee: buyer,
      sessionKey: r.sessionKey,
      periodId: r.periodId,
      planDigest: r.planDigest,
      periodStart: s.now,
      periodEnd: s.now + r.periodSeconds,
      fundedEpoch: epoch,
      fundedWindow: window,
      discountBps: pca.discountBps,
      value,
      cost,
      drawnFromWindow,
      drawnFromTopUp,
      buckets: r.buckets.map((b) => ({ ...b })),
    };
    ca.subscriptions.push(subscriptionId);
    // The contract logs ServiceCostCovered, then one ServiceEmissionLabelled per
    // drawn part, then PeriodFunded.
    const logIndex = 1 + (drawnFromWindow > 0n ? 1 : 0) + (drawnFromTopUp > 0n ? 1 : 0);
    const tx = this.txResult(true);
    s.fundings.set(subscriptionId, { tx, logIndex, period });
    return { ...tx, subscriptionId, cost, logIndex, existing: false, period };
  }

  async getServicePeriod(subscriptionId: string): Promise<CaPeriod | null> {
    const id = requireBytes32(subscriptionId, 'subscriptionId');
    return this.mockServiceAvailable().fundings.get(id)?.period ?? null;
  }

  async listServicePeriods(accountId: bigint, offset: number, limit: number): Promise<{ total: number; periods: CaPeriod[] }> {
    requireAccountId(accountId);
    requirePeriodPage(offset, limit);
    const s = this.mockServiceAvailable();
    const ids = s.accounts.get(accountId)?.subscriptions ?? [];
    return { total: ids.length, periods: ids.slice(offset, offset + limit).map((id) => s.fundings.get(id)!.period) };
  }

  getConvictionServiceBuyerAddress(): string | null {
    const buyer = this.mockServiceStateOf().buyer;
    return buyer === undefined ? ethers.getAddress(this.signerAddress) : buyer.address;
  }

  // ---------------------------------------------------------------- model

  protected mockServiceStateOf(): MockServiceState {
    this.mockServiceState ??= {
      available: true,
      now: Math.floor(Date.now() / 1000),
      epochLengthSeconds: 86_400,
      exactScheduleFrom: 1,
      protocolTreasury: ethers.ZeroAddress,
      maxPeriodSeconds: 31 * 86_400,
      maxBucketsPerPeriod: 16,
      buyer: undefined,
      accounts: new Map(),
      fundings: new Map(),
      epochServiceLabels: new Map(),
    };
    return this.mockServiceState;
  }

  protected mockServiceAvailable(): MockServiceState {
    const s = this.mockServiceStateOf();
    if (!s.available) throw new ConvictionServiceUnavailableError();
    return s;
  }

  /** The mock's chain id (`getEvmChainId`) and service contract. */
  protected mockServiceDomain(): CaEip712Domain {
    return convictionServiceDomain(31337, MOCK_SERVICE_SUBSCRIPTIONS_ADDRESS);
  }

  protected mockServiceBuyer(): { address: string; wallet?: ethers.Wallet } {
    const buyer = this.mockServiceStateOf().buyer ?? { address: ethers.getAddress(this.signerAddress) };
    if (buyer.address === null) {
      throw new ConvictionServiceUnavailableError('The configured buyer key is not one of this node\'s wallets, so the node cannot sign for it.');
    }
    return { address: buyer.address, wallet: buyer.wallet };
  }

  /** The account and its service state, entering the model now; `null` when the mock has no such account. */
  protected mockServiceAccount(accountId: bigint): { pca: MockConvictionAccountRecord; ca: MockServiceAccount } | null {
    const pca = this.convictionAccounts.get(accountId);
    if (!pca) return null;
    const s = this.mockServiceStateOf();
    let ca = s.accounts.get(accountId);
    if (!ca) {
      ca = {
        createdAt: Math.floor(s.now / s.epochLengthSeconds) * s.epochLengthSeconds, enabledAt: 0, nonce: 0n, assignees: [], assignments: new Map(), usage: new Map(),
        windowSpent: new Map(), topUpDrawn: 0n, baseLabels: new Map(), topUpLabels: new Map(),
        labelCursor: 0, labelTotal: 0n, subscriptions: [],
      };
      s.accounts.set(accountId, ca);
    }
    return { pca, ca };
  }

  /** The contract's `_requireOwner`: `ownerOf` reverts for an unminted id. */
  protected mockServiceOwned(accountId: bigint): { pca: MockConvictionAccountRecord; ca: MockServiceAccount } {
    const entry = this.mockServiceAccount(accountId);
    if (!entry) throw revert('ERC721NonexistentToken', { tokenId: accountId });
    const caller = ethers.getAddress(this.signerAddress);
    if (ethers.getAddress(entry.pca.owner) !== caller) throw revert('NotAccountOwner', { accountId, caller });
    return entry;
  }

  /** The contract's `_liveAssignment`. */
  protected mockServiceLiveAssignment(accountId: bigint, ca: MockServiceAccount, assignee: string): MockAssignment {
    const a = ca.assignments.get(assignee.toLowerCase());
    if (!a) throw revert('NotAssigned', { accountId, assignee });
    if (a.revokedAt !== 0) throw revert('AssignmentRevoked', { accountId, assignee });
    if (this.mockServiceStateOf().now >= a.expiresAt) throw revert('AssignmentExpired', { accountId, assignee });
    return a;
  }

  /** The contract's `_requireConsent`, for an EOA party. */
  protected mockServiceRequireConsent(party: string, sender: string, digest: string, signature: string): void {
    if (party === sender) {
      if (signature !== '0x') throw revert('InvalidConsentSignature', { party });
      return;
    }
    if (signature === '0x') throw revert('ConsentMissing', { party });
    if (!isValidEoaConsent(party, digest, signature)) throw revert('InvalidConsentSignature', { party });
  }

  protected mockServiceRequireUnexpired(accountId: bigint, ca: MockServiceAccount, pca: MockConvictionAccountRecord): void {
    const expiresAt = this.mockServiceExpiresAt(ca, pca);
    if (this.mockServiceStateOf().now >= expiresAt) {
      throw revert('AccountExpired', {
        accountId, expiresAtEpoch: BigInt(Math.floor(expiresAt / this.mockServiceStateOf().epochLengthSeconds)),
      });
    }
  }

  protected mockServiceEpoch(): number {
    const s = this.mockServiceStateOf();
    return Math.floor(s.now / s.epochLengthSeconds);
  }

  protected mockServiceExpiresAt(ca: MockServiceAccount, pca: MockConvictionAccountRecord): number {
    return ca.createdAt + pca.lockDurationEpochs * this.mockServiceStateOf().epochLengthSeconds;
  }

  /** The billing window of the clock, uncapped, as the contracts compute it for a draw. */
  protected mockServiceWindow(ca: MockServiceAccount): number {
    const s = this.mockServiceStateOf();
    return s.now <= ca.createdAt ? 0 : Math.floor((s.now - ca.createdAt) / s.epochLengthSeconds);
  }

  protected mockServiceAllowance(ca: MockServiceAccount, pca: MockConvictionAccountRecord): CaWindowAllowance {
    const window = Math.min(this.mockServiceWindow(ca), pca.lockDurationEpochs);
    const expired = this.mockServiceStateOf().now >= this.mockServiceExpiresAt(ca, pca);
    const baseAllowance = pca.committedTRAC / BigInt(pca.lockDurationEpochs);
    const spent = ca.windowSpent.get(window) ?? 0n;
    return {
      index: window,
      baseAllowance,
      baseRemaining: expired || spent >= baseAllowance ? 0n : baseAllowance - spent,
      topUpBuffer: pca.topUpBuffer - ca.topUpDrawn,
      expired,
    };
  }

  /** The mock's emission span: the account's lock epochs from its creation epoch. */
  protected mockServiceSpan(ca: MockServiceAccount, pca: MockConvictionAccountRecord): [number, number] {
    const first = Math.floor(ca.createdAt / this.mockServiceStateOf().epochLengthSeconds);
    return [first, first + pca.lockDurationEpochs - 1];
  }

  /** The mock's scheduled emission: the window budget in each lock epoch, the `committed mod lock` dust in the last. */
  protected mockServiceScheduled(ca: MockServiceAccount, pca: MockConvictionAccountRecord, epoch: number): bigint {
    const [first, last] = this.mockServiceSpan(ca, pca);
    if (epoch < first || epoch > last) return 0n;
    const lock = BigInt(pca.lockDurationEpochs);
    const budget = pca.committedTRAC / lock;
    return epoch === last ? budget + (pca.committedTRAC - budget * lock) : budget;
  }

  /** The modeled staker emission of `epoch`: every modeled account's schedule and top-up labels. */
  protected mockServicePool(epoch: number): bigint {
    let pool = 0n;
    for (const [accountId, ca] of this.mockServiceStateOf().accounts) {
      const pca = this.convictionAccounts.get(accountId);
      if (pca) pool += this.mockServiceScheduled(ca, pca, epoch) + (ca.topUpLabels.get(epoch) ?? 0n);
    }
    return pool;
  }

  protected mockServiceAssignmentOf(ca: MockServiceAccount, assignee: string): { assignee: string } & CaAssignment {
    const key = assignee.toLowerCase();
    const a = ca.assignments.get(key)!;
    const now = this.mockServiceStateOf().now;
    return {
      assignee,
      ...capsOf(a),
      assignedAt: a.assignedAt,
      revokedAt: a.revokedAt,
      nonce: a.nonce,
      active: a.revokedAt === 0 && now < a.expiresAt,
      usage: { ...(ca.usage.get(key) ?? { totalCost: 0n, windowCost: 0n, window: 0, periods: 0 }) },
    };
  }
}
