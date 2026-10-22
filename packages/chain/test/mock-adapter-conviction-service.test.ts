/**
 * MockChainAdapter — Conviction Account service spending (OT-RFC-27). The
 * mock's in-memory model of `ServiceSubscriptions` and
 * `ConvictionServiceStorage` must refuse what the contracts refuse, in their
 * order, with the same typed errors the EVM adapter throws: the same revert
 * names, and arguments under the names the vendored ABIs give them. Offline
 * mode then answers as a chain would.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { MOCK_SERVICE_SUBSCRIPTIONS_ADDRESS } from '../src/mock-adapter-conviction-service.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  SERVICE_ASSIGNMENT_TYPES,
  serviceAssignmentDigest,
  serviceSubscriptionIdOf,
  type CaAssignmentTerms,
  type CaBucket,
  type CaFundingRequest,
} from '../src/conviction-service.js';
import {
  ConvictionServiceInputError,
  ConvictionServiceRevertError,
  ConvictionServiceUnavailableError,
} from '../src/conviction-service-errors.js';

const OWNER = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BUYER = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = new ethers.Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const TRAC = 10n ** 18n;
const DAY = 86_400;
const T0 = 20_000 * DAY; // the start of mock epoch 20000
const COMMITTED = 1_200_000n * TRAC; // 7,500 bps; 100,000 TRAC per window
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const bytes32 = (n: number): string => ethers.toBeHex(n, 32);

/** Every revert the mock throws in this file, to check its arguments against the ABIs. */
const thrown: ConvictionServiceRevertError[] = [];

async function reverts(promise: Promise<unknown>, name: string, args?: Record<string, unknown>): Promise<void> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err, `expected ${name}`).toBeInstanceOf(ConvictionServiceRevertError);
  const revert = err as ConvictionServiceRevertError;
  thrown.push(revert);
  expect(revert.revertName).toBe(name);
  if (args) expect(revert.args).toEqual(args);
}

let mock: MockChainAdapter;
let accountId: bigint;
let terms: CaAssignmentTerms;

function termsFor(over: Partial<CaAssignmentTerms> = {}): CaAssignmentTerms {
  return {
    accountId,
    assignee: BUYER.address,
    maxCostPerPeriod: 25n * TRAC,
    maxInferenceCostPerPeriod: 25n * TRAC,
    maxQueryCostPerPeriod: 0n,
    maxCostPerWindow: 100n * TRAC,
    maxTotalCost: 1000n * TRAC,
    maxPeriodSeconds: 31 * DAY,
    expiresAt: T0 + 60 * DAY,
    nonce: 0n,
    ...over,
  };
}

function bucket(id: number, over: Partial<CaBucket> = {}): CaBucket {
  return { bucketId: bytes32(id), serviceClass: 1, value: 40n * TRAC, maxAskWeiPerUnit: 1_000n, ...over };
}

function request(over: Partial<CaFundingRequest> = {}): CaFundingRequest {
  return {
    accountId,
    periodId: bytes32(0xa1),
    sessionKey: ethers.ZeroAddress,
    periodSeconds: 30 * DAY,
    planDigest: bytes32(0xd1),
    buckets: [bucket(1)],
    ...over,
  };
}

async function ownerSignature(t: CaAssignmentTerms, wallet = OWNER): Promise<string> {
  const { domain } = (await mock.getConvictionServiceContracts())!;
  return wallet.signTypedData(domain, SERVICE_ASSIGNMENT_TYPES, { ...t });
}

/** Opt the account in and assign the buyer key with its consent, sent by the owner. */
async function assigned(t = terms): Promise<void> {
  await mock.setConvictionServiceSpending(accountId, true);
  const { signature } = await mock.signConvictionServiceConsent(t);
  await mock.assignConvictionServiceBuyer(t, { assignee: signature }, 'owner');
}

beforeEach(async () => {
  mock = new MockChainAdapter('mock:31337', OWNER.address);
  ({ accountId } = await mock.createPublishingConvictionAccount(COMMITTED));
  mock.configureMockConvictionService({ now: T0, buyer: BUYER });
  terms = termsFor();
});

describe('contracts and availability', () => {
  it('reports the contracts and the consent domain the mock verifies against', async () => {
    const contracts = (await mock.getConvictionServiceContracts())!;
    expect(contracts.logicVersion).toBe('10.1.0');
    expect(contracts.domain).toEqual({
      name: 'DKGConvictionServices', version: '1', chainId: 31337, verifyingContract: MOCK_SERVICE_SUBSCRIPTIONS_ADDRESS,
    });
  });

  it('behaves as a chain without the service contracts when configured so', async () => {
    mock.configureMockConvictionService({ available: false });
    expect(await mock.getConvictionServiceContracts()).toBeNull();
    for (const call of [
      () => mock.getConvictionServiceStatus(accountId),
      () => mock.setConvictionServiceSpending(accountId, true),
      () => mock.fundServicePeriodFromConviction(request()),
      () => mock.listServicePeriods(accountId, 0, 10),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    }
  });
});

describe('setConvictionServiceSpending', () => {
  it('refuses as the contract does, in its order', async () => {
    await reverts(mock.setConvictionServiceSpending(99n, true), 'ERC721NonexistentToken', { tokenId: 99n });
    const foreign = mock.seedConvictionAccount(OTHER.address);
    await reverts(mock.setConvictionServiceSpending(foreign, true), 'NotAccountOwner', {
      accountId: foreign, caller: OWNER.address,
    });
    // The cut-over is checked before the treasury, the treasury before expiry.
    mock.configureMockConvictionService({ exactScheduleFrom: 0, protocolTreasury: OTHER.address });
    await reverts(mock.setConvictionServiceSpending(accountId, true), 'ExactScheduleFromUnset', {});
    mock.configureMockConvictionService({ exactScheduleFrom: 1 });
    await reverts(mock.setConvictionServiceSpending(accountId, true), 'ServiceFundingPausedTreasuryWired', {
      treasury: OTHER.address,
    });
    mock.configureMockConvictionService({ protocolTreasury: ethers.ZeroAddress });
    await reverts(mock.setConvictionServiceSpending(accountId, false), 'ServiceSpendingUnchanged', { accountId, enabled: false });
    await mock.setConvictionServiceSpending(accountId, true);
    await reverts(mock.setConvictionServiceSpending(accountId, true), 'ServiceSpendingUnchanged', { accountId, enabled: true });
  });

  it('switches on with the time, off to 0, and refuses an expired account', async () => {
    await mock.setConvictionServiceSpending(accountId, true);
    expect((await mock.getConvictionServiceStatus(accountId))!.serviceSpendingEnabledAt).toBe(T0);
    await mock.setConvictionServiceSpending(accountId, false);
    expect((await mock.getConvictionServiceStatus(accountId))!.serviceSpendingEnabledAt).toBe(0);
    mock.advanceMockConvictionServiceTime(12 * DAY);
    await reverts(mock.setConvictionServiceSpending(accountId, true), 'AccountExpired', {
      accountId, expiresAtEpoch: BigInt(20_000 + 12),
    });
  });
});

describe('assignConvictionServiceBuyer', () => {
  it('refuses before the opt-in, then invalid terms in the contract\'s order', async () => {
    await reverts(mock.assignConvictionServiceBuyer(terms, {}, 'owner'), 'ServiceSpendingDisabled', { accountId });
    await mock.setConvictionServiceSpending(accountId, true);
    await reverts(mock.assignConvictionServiceBuyer(termsFor({ assignee: ethers.ZeroAddress }), {}, 'owner'),
      'InvalidAssignmentTerms', { reason: 'assignee' });
    const invalid: Array<[Partial<CaAssignmentTerms>, string]> = [
      [{ maxCostPerPeriod: 0n, maxInferenceCostPerPeriod: 0n }, 'maxCostPerPeriod'],
      [{ maxInferenceCostPerPeriod: 26n * TRAC }, 'maxInferenceCostPerPeriod'],
      [{ maxQueryCostPerPeriod: 26n * TRAC }, 'maxQueryCostPerPeriod'],
      [{ maxInferenceCostPerPeriod: 0n }, 'classCaps'],
      [{ maxTotalCost: 24n * TRAC }, 'maxTotalCost'],
      [{ maxCostPerWindow: 24n * TRAC }, 'maxCostPerWindow'],
      [{ maxPeriodSeconds: 0 }, 'maxPeriodSeconds'],
      [{ maxPeriodSeconds: 31 * DAY + 1 }, 'maxPeriodSeconds'],
      [{ expiresAt: T0 }, 'expiresAt'],
    ];
    for (const [over, reason] of invalid) {
      await reverts(mock.assignConvictionServiceBuyer(termsFor(over), {}, 'owner'), 'InvalidAssignmentTerms', { reason });
    }
    await reverts(mock.assignConvictionServiceBuyer(termsFor({ nonce: 1n }), {}, 'owner'), 'InvalidAssignmentNonce', {
      accountId, expected: 0n, provided: 1n,
    });
  });

  it('verifies the consent of each party that does not send', async () => {
    await mock.setConvictionServiceSpending(accountId, true);
    await reverts(mock.assignConvictionServiceBuyer(terms, {}, 'owner'), 'ConsentMissing', { party: BUYER.address });
    const { signature } = await mock.signConvictionServiceConsent(terms);
    const sig = ethers.Signature.from(signature);
    const highS = ethers.concat([sig.r, ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32), ethers.toBeHex(sig.v === 27 ? 28 : 27, 1)]);
    const zeroV = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v - 27, 1)]);
    const otherTerms = await mock.signConvictionServiceConsent(termsFor({ maxTotalCost: 999n * TRAC }));
    const byOther = await OTHER.signTypedData((await mock.getConvictionServiceContracts())!.domain, SERVICE_ASSIGNMENT_TYPES, { ...terms });
    for (const bad of [highS, zeroV, otherTerms.signature, byOther, '0x1234']) {
      await reverts(mock.assignConvictionServiceBuyer(terms, { assignee: bad }, 'owner'), 'InvalidConsentSignature', {
        party: BUYER.address,
      });
    }
    // The 64-byte (r, vs) form of the same signature is consent.
    await mock.assignConvictionServiceBuyer(terms, { assignee: ethers.concat([sig.r, sig.yParityAndS]) }, 'owner');
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!.active).toBe(true);
  });

  it('assigns with the consent of both parties, from either side, and drops the sender\'s signature', async () => {
    await mock.setConvictionServiceSpending(accountId, true);
    // Sent by the buyer key with the owner's signature; a signature of its own is dropped.
    const result = await mock.assignConvictionServiceBuyer(terms, { owner: await ownerSignature(terms), assignee: '0xdead' }, 'assignee');
    expect(result.digest).toBe(serviceAssignmentDigest((await mock.getConvictionServiceContracts())!.domain, terms));
    expect(await mock.getConvictionServiceAssignmentNonce(accountId)).toBe(1n);
    const [a] = await mock.listConvictionServiceAssignments(accountId);
    expect(a).toMatchObject({ assignee: BUYER.address, assignedAt: T0, revokedAt: 0, nonce: 0n, active: true });
    // A signed owner consent from another key is refused.
    const next = termsFor({ nonce: 1n });
    await reverts(mock.assignConvictionServiceBuyer(next, { owner: await ownerSignature(next, OTHER) }, 'assignee'),
      'InvalidConsentSignature', { party: OWNER.address });
  });

  it('starts the usage from zero on a new assignment of the same assignee', async () => {
    await assigned();
    await mock.fundServicePeriodFromConviction(request());
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!.usage.periods).toBe(1);
    const { signature } = await mock.signConvictionServiceConsent(termsFor({ nonce: 1n }));
    await mock.assignConvictionServiceBuyer(termsFor({ nonce: 1n }), { assignee: signature }, 'owner');
    const listed = await mock.listConvictionServiceAssignments(accountId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.usage).toEqual({ totalCost: 0n, windowCost: 0n, window: 0, periods: 0 });
  });
});

describe('revoke, caps and nonce', () => {
  it('revokes once, advancing the nonce, so terms signed before no longer assign', async () => {
    await mock.setConvictionServiceSpending(accountId, true);
    await reverts(mock.revokeConvictionServiceBuyer(accountId, BUYER.address), 'NotAssigned', { accountId, assignee: BUYER.address });
    const { signature } = await mock.signConvictionServiceConsent(terms);
    await mock.assignConvictionServiceBuyer(terms, { assignee: signature }, 'owner');
    const pending = termsFor({ nonce: 1n });
    const pendingSig = (await mock.signConvictionServiceConsent(pending)).signature;
    expect((await mock.revokeConvictionServiceBuyer(accountId, BUYER.address)).nextNonce).toBe(2n);
    await reverts(mock.revokeConvictionServiceBuyer(accountId, BUYER.address), 'AssignmentRevoked', { accountId, assignee: BUYER.address });
    await reverts(mock.assignConvictionServiceBuyer(pending, { assignee: pendingSig }, 'owner'), 'InvalidAssignmentNonce', {
      accountId, expected: 2n, provided: 1n,
    });
    await reverts(mock.fundServicePeriodFromConviction(request()), 'AssignmentRevoked', { accountId, assignee: BUYER.address });
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!).toMatchObject({ active: false, revokedAt: T0 });
  });

  it('updates the caps of a live assignment and keeps its usage and nonce', async () => {
    await assigned();
    await mock.fundServicePeriodFromConviction(request());
    await reverts(mock.updateConvictionServiceCaps(accountId, OTHER.address, terms), 'NotAssigned', { accountId, assignee: OTHER.address });
    await reverts(mock.updateConvictionServiceCaps(accountId, BUYER.address, termsFor({ maxCostPerWindow: 1n })),
      'InvalidAssignmentTerms', { reason: 'maxCostPerWindow' });
    await reverts(mock.updateConvictionServiceCaps(accountId, BUYER.address, terms), 'CapsUnchanged', { accountId, assignee: BUYER.address });
    // Tightened below the usage: allowed, and it refuses every funding it bounds.
    const tight = termsFor({ maxCostPerPeriod: 5n * TRAC, maxInferenceCostPerPeriod: 5n * TRAC, maxTotalCost: 5n * TRAC });
    await mock.updateConvictionServiceCaps(accountId, BUYER.address, tight);
    const [a] = await mock.listConvictionServiceAssignments(accountId);
    expect(a).toMatchObject({ maxTotalCost: 5n * TRAC, nonce: 0n, usage: { totalCost: 10n * TRAC, periods: 1 } });
    expect(await mock.getConvictionServiceAssignmentNonce(accountId)).toBe(1n);
    await reverts(mock.fundServicePeriodFromConviction(request({ periodId: bytes32(0xa2), buckets: [bucket(1, { value: 4n * TRAC })] })),
      'CapExceeded', { cap: 'maxTotalCost', limit: 5n * TRAC, attempted: 11n * TRAC });
    // An expired assignment is renewed only by a new assignment.
    mock.advanceMockConvictionServiceTime(60 * DAY);
    await reverts(mock.updateConvictionServiceCaps(accountId, BUYER.address, termsFor({ expiresAt: T0 + 90 * DAY })),
      'AssignmentExpired', { accountId, assignee: BUYER.address });
  });

  it('refuses owner actions to anyone but the owner', async () => {
    const foreign = mock.seedConvictionAccount(OTHER.address);
    const caller = OWNER.address;
    await reverts(mock.revokeConvictionServiceBuyer(foreign, BUYER.address), 'NotAccountOwner', { accountId: foreign, caller });
    await reverts(mock.updateConvictionServiceCaps(foreign, BUYER.address, terms), 'NotAccountOwner', { accountId: foreign, caller });
    await reverts(mock.advanceConvictionServiceNonce(foreign), 'NotAccountOwner', { accountId: foreign, caller });
    expect((await mock.advanceConvictionServiceNonce(accountId)).nextNonce).toBe(1n);
  });
});

describe('fundServicePeriodFromConviction', () => {
  it('refuses before the opt-in and without a live assignment', async () => {
    await reverts(mock.fundServicePeriodFromConviction(request()), 'ServiceSpendingDisabled', { accountId });
    await mock.setConvictionServiceSpending(accountId, true);
    await reverts(mock.fundServicePeriodFromConviction(request()), 'NotAssigned', { accountId, assignee: BUYER.address });
    const { signature } = await mock.signConvictionServiceConsent(terms);
    await mock.assignConvictionServiceBuyer(terms, { assignee: signature }, 'owner');
    mock.advanceMockConvictionServiceTime(60 * DAY);
    await reverts(mock.fundServicePeriodFromConviction(request()), 'AssignmentExpired', { accountId, assignee: BUYER.address });
  });

  it('refuses invalid buckets and periods in the contract\'s order', async () => {
    await assigned();
    const invalid: Array<[Partial<CaFundingRequest>, string]> = [
      [{ buckets: [] }, 'bucketCount'],
      [{ buckets: Array.from({ length: 17 }, (_, i) => bucket(i + 1)) }, 'bucketCount'],
      [{ buckets: [bucket(2), bucket(2)] }, 'bucketOrder'],
      [{ buckets: [bucket(2), bucket(1, { serviceClass: 3 as 1 })] }, 'bucketOrder'],
      [{ buckets: [bucket(1, { serviceClass: 3 as 1, value: 0n })] }, 'serviceClass'],
      [{ buckets: [bucket(1, { value: 0n, maxAskWeiPerUnit: 0n })] }, 'bucketValue'],
      [{ buckets: [bucket(1, { maxAskWeiPerUnit: 0n })] }, 'maxAskWeiPerUnit'],
      [{ periodSeconds: 0 }, 'periodSeconds'],
      [{ periodSeconds: 31 * DAY + 1 }, 'periodSeconds'],
      [{ buckets: [bucket(1, { value: (1n << 96n) - 1n }), bucket(2, { value: 1n })] }, 'value'],
    ];
    for (const [over, reason] of invalid) {
      await reverts(mock.fundServicePeriodFromConviction(request(over)), 'InvalidFundingRequest', { reason });
    }
    // The assignment's own longest period binds below the chain's.
    await mock.updateConvictionServiceCaps(accountId, BUYER.address, termsFor({ maxPeriodSeconds: 7 * DAY }));
    await reverts(mock.fundServicePeriodFromConviction(request({ periodSeconds: 8 * DAY })), 'InvalidFundingRequest', {
      reason: 'periodSeconds',
    });
  });

  it('refuses each cap with its limit and the attempted cost', async () => {
    await assigned();
    await reverts(mock.fundServicePeriodFromConviction(request({ buckets: [bucket(1, { value: 104n * TRAC })] })), 'CapExceeded', {
      cap: 'maxCostPerPeriod', limit: 25n * TRAC, attempted: 26n * TRAC,
    });
    // A class with cap 0 is not allowed, even for a bucket the discount prices at 0.
    await reverts(mock.fundServicePeriodFromConviction(request({ buckets: [bucket(1, { serviceClass: 2, value: 3n })] })), 'CapExceeded', {
      cap: 'maxQueryCostPerPeriod', limit: 0n, attempted: 0n,
    });
    await mock.updateConvictionServiceCaps(accountId, BUYER.address, termsFor({ maxInferenceCostPerPeriod: 5n * TRAC }));
    await reverts(mock.fundServicePeriodFromConviction(request()), 'CapExceeded', {
      cap: 'maxInferenceCostPerPeriod', limit: 5n * TRAC, attempted: 10n * TRAC,
    });
    await mock.updateConvictionServiceCaps(accountId, BUYER.address, termsFor({ maxCostPerWindow: 25n * TRAC }));
    await mock.fundServicePeriodFromConviction(request({ periodId: bytes32(1) }));
    await mock.fundServicePeriodFromConviction(request({ periodId: bytes32(2) }));
    await reverts(mock.fundServicePeriodFromConviction(request({ periodId: bytes32(3) })), 'CapExceeded', {
      cap: 'maxCostPerWindow', limit: 25n * TRAC, attempted: 30n * TRAC,
    });
    // The next window counts from 0 again.
    mock.advanceMockConvictionServiceTime(DAY);
    await mock.fundServicePeriodFromConviction(request({ periodId: bytes32(3) }));
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!.usage).toEqual({
      totalCost: 30n * TRAC, windowCost: 10n * TRAC, window: 1, periods: 3,
    });
  });

  it('draws the window first, then the top-up buffer, and refuses what neither covers', async () => {
    const small = await mock.createPublishingConvictionAccount(1_200n * TRAC); // 0 bps, 100 TRAC per window
    accountId = small.accountId;
    const t = termsFor({ maxCostPerPeriod: 200n * TRAC, maxInferenceCostPerPeriod: 200n * TRAC, maxCostPerWindow: 0n });
    await assigned(t);
    const first = await mock.fundServicePeriodFromConviction(request({ buckets: [bucket(1, { value: 90n * TRAC })] }));
    expect(first.period).toMatchObject({ cost: 90n * TRAC, drawnFromWindow: 90n * TRAC, drawnFromTopUp: 0n, discountBps: 0 });
    await reverts(mock.fundServicePeriodFromConviction(request({ periodId: bytes32(2), buckets: [bucket(1, { value: 20n * TRAC })] })),
      'InsufficientAllowance', { accountId, epoch: 20_000n, required: 20n * TRAC, available: 10n * TRAC });
    await mock.topUpPublishingConvictionAccount(accountId, 50n * TRAC);
    const second = await mock.fundServicePeriodFromConviction(request({ periodId: bytes32(2), buckets: [bucket(1, { value: 20n * TRAC })] }));
    expect(second.period).toMatchObject({ drawnFromWindow: 10n * TRAC, drawnFromTopUp: 10n * TRAC });
    expect(second.logIndex).toBe(3); // ServiceCostCovered, two labels, then PeriodFunded
    expect(await mock.getConvictionServiceWindowAllowance(accountId)).toEqual({
      index: 0, baseAllowance: 100n * TRAC, baseRemaining: 0n, topUpBuffer: 40n * TRAC, expired: false,
    });
  });

  it('refuses while a treasury is wired, after the caps, and once the account has expired', async () => {
    await assigned(termsFor({ expiresAt: T0 + 30 * DAY }));
    mock.configureMockConvictionService({ protocolTreasury: OTHER.address });
    await reverts(mock.fundServicePeriodFromConviction(request({ buckets: [bucket(1, { value: 104n * TRAC })] })), 'CapExceeded');
    await reverts(mock.fundServicePeriodFromConviction(request()), 'ServiceFundingPausedTreasuryWired', { treasury: OTHER.address });
    mock.configureMockConvictionService({ protocolTreasury: ethers.ZeroAddress });
    mock.advanceMockConvictionServiceTime(12 * DAY);
    await reverts(mock.fundServicePeriodFromConviction(request()), 'AccountExpired', { accountId, expiresAtEpoch: 20_012n });
  });

  it('records the period, and answers a repeated period id with it and sends nothing', async () => {
    await assigned();
    const funded = await mock.fundServicePeriodFromConviction(request());
    const subscriptionId = serviceSubscriptionIdOf(BUYER.address, bytes32(0xa1));
    expect(funded).toMatchObject({ subscriptionId, cost: 10n * TRAC, logIndex: 2, existing: false, success: true });
    expect(funded.period).toMatchObject({
      accountId, assignee: BUYER.address, periodStart: T0, periodEnd: T0 + 30 * DAY, fundedEpoch: 20_000,
      fundedWindow: 0, discountBps: 7500, value: 40n * TRAC, cost: 10n * TRAC, drawnFromWindow: 10n * TRAC, drawnFromTopUp: 0n,
    });
    mock.advanceMockConvictionServiceTime(DAY);
    const again = await mock.fundServicePeriodFromConviction(request());
    expect(again).toEqual({ ...funded, existing: true });
    expect(await mock.getServicePeriod(subscriptionId)).toEqual(funded.period);
    expect(await mock.listServicePeriods(accountId, 0, 10)).toEqual({ total: 1, periods: [funded.period] });
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!.usage.periods).toBe(1);
    expect(await mock.getServicePeriod(bytes32(0xff))).toBeNull();
  });
});

describe('status and labels', () => {
  it('reports the status, labels and assignments of a funded account', async () => {
    await assigned();
    await mock.fundServicePeriodFromConviction(request());
    const status = (await mock.getConvictionServiceStatus(accountId))!;
    expect(status).toMatchObject({
      accountId, owner: OWNER.address, serviceSpendingEnabledAt: T0, discountBps: 7500, lockDurationEpochs: 12,
      expiresAtTimestamp: T0 + 12 * DAY, schedule: { exact: true, firstEpoch: 20_000, lastEpoch: 20_011 },
      labels: { total: 10n * TRAC, cursor: 20_000 }, assignments: { count: 1, active: 1 }, treasuryWired: false,
    });
    expect(status.window).toEqual({
      index: 0, baseAllowance: 100_000n * TRAC, baseRemaining: 99_990n * TRAC, topUpBuffer: 0n, expired: false,
    });
    expect(status.labels.remainingBaseCapacity).toBe(COMMITTED - 10n * TRAC);
    expect(await mock.getConvictionServiceStatus(99n)).toBeNull();

    const labels = await mock.getConvictionServiceLabels(accountId, 19_999, 20_012);
    expect(labels.reduce((sum, l) => sum + l.scheduled, 0n)).toBe(COMMITTED);
    expect(labels.find((l) => l.epoch === 20_000)).toMatchObject({ baseLabel: 10n * TRAC, topUpLabel: 0n, serviceLabel: 10n * TRAC });
    for (const l of labels) {
      expect(l.baseLabel <= l.scheduled).toBe(true);
      expect(l.serviceLabel <= l.pool).toBe(true);
    }
    await reverts(mock.getConvictionServiceLabels(99n, 0, 0), 'UnknownAccount', { accountId: 99n });
    await expect(mock.getConvictionServiceLabels(accountId, 0, 120)).rejects.toBeInstanceOf(ConvictionServiceInputError);
  });

  it('reports no schedule before the cut-over is set', async () => {
    mock.configureMockConvictionService({ exactScheduleFrom: 0 });
    const status = (await mock.getConvictionServiceStatus(accountId))!;
    expect(status.schedule.exact).toBe(false);
    expect(status.labels.remainingBaseCapacity).toBe(0n);
    expect((await mock.getConvictionServiceLabels(accountId, 20_000, 20_000))[0]!.scheduled).toBe(0n);
  });
});

describe('the buyer key', () => {
  it('signs only its own consent, and only with a configured wallet', async () => {
    await expect(mock.signConvictionServiceConsent(termsFor({ assignee: OTHER.address }))).rejects.toBeInstanceOf(ConvictionServiceInputError);
    mock.configureMockConvictionService({ buyer: BUYER.address });
    await expect(mock.signConvictionServiceConsent(terms)).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    mock.configureMockConvictionService({ buyer: null });
    expect(mock.getConvictionServiceBuyerAddress()).toBeNull();
    await expect(mock.fundServicePeriodFromConviction(request())).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    expect(new MockChainAdapter('mock:31337', OWNER.address).getConvictionServiceBuyerAddress()).toBe(OWNER.address);
  });

  it('consents by sending when the owner wallet is the buyer key', async () => {
    mock = new MockChainAdapter('mock:31337', OWNER.address);
    ({ accountId } = await mock.createPublishingConvictionAccount(COMMITTED));
    mock.configureMockConvictionService({ now: T0, buyer: OWNER });
    const own = termsFor({ assignee: OWNER.address });
    await mock.setConvictionServiceSpending(accountId, true);
    await mock.assignConvictionServiceBuyer(own, { owner: '0xdead', assignee: '0xbeef' }, 'owner');
    expect((await mock.listConvictionServiceAssignments(accountId))[0]!.assignee).toBe(OWNER.address);
  });
});

describe('error arguments', () => {
  it('names every argument of every revert the mock threw as the vendored ABIs do', () => {
    const fragments = new Map<string, string[]>();
    for (const abi of ['ServiceSubscriptions', 'ConvictionServiceStorage', 'PublishingConvictionStorage', 'DKGPublishingConvictionNFT']) {
      for (const entry of loadAbi(abi) as Array<{ type: string; name?: string; inputs?: Array<{ name: string }> }>) {
        if (entry.type === 'error' && !fragments.has(entry.name!)) fragments.set(entry.name!, entry.inputs!.map((i) => i.name));
      }
    }
    expect(thrown.length).toBeGreaterThan(40);
    for (const err of thrown) {
      expect(fragments.has(err.revertName), err.revertName).toBe(true);
      expect(Object.keys(err.args), err.revertName).toEqual(fragments.get(err.revertName));
      for (const value of Object.values(err.args)) expect(['bigint', 'string', 'boolean']).toContain(typeof value);
    }
  });
});
