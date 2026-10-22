// ConvictionServiceStorage: the policy-free state store for Conviction
// Account service spending (OT-RFC-27).
//
// Covers:
//   - the gates: every mutator is onlyContracts (a Hub-registered contract or
//     the Hub owner), every parameter setter is onlyHub (the Hub, through
//     forwardCall, or the Hub owner), and the two never admit each other's
//     callers;
//   - the parameters: defaults, bounds, and a cut-over set once and never in
//     the future;
//   - the mutators' semantics: assignment listing and usage reset, cap
//     updates that keep everything but the seven limits, the usage window
//     roll-over, label totals, and period records;
//   - the compiler's storage layout against the documented one.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ConvictionServiceStorage, Hub } from '../../typechain';

const DAY = 86_400n;
const TRAC = 10n ** 18n;
const MAX_UINT96 = (1n << 96n) - 1n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  CSS: ConvictionServiceStorage;
  owner: SignerWithAddress;
  logic: SignerWithAddress;
  stranger: SignerWithAddress;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['Hub']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  const Factory = await hre.ethers.getContractFactory('ConvictionServiceStorage');
  const CSS = (await Factory.deploy(await Hub.getAddress())) as unknown as ConvictionServiceStorage;
  await CSS.waitForDeployment();
  await Hub.setContractAddress('ConvictionServiceStorage', await CSS.getAddress());
  // A Hub-registered contract stands in for the logic contracts: the Hub's
  // contract set is all `onlyContracts` checks.
  await Hub.setContractAddress('ServiceLogicStandIn', accounts[1].address);
  await Hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData('initialize'));

  return { accounts, Hub, CSS, owner: accounts[0], logic: accounts[1], stranger: accounts[2] };
}

const assignmentTerms = (overrides: Record<string, bigint> = {}) => ({
  maxCostPerPeriod: 25n * TRAC,
  maxInferenceCostPerPeriod: 20n * TRAC,
  maxQueryCostPerPeriod: 5n * TRAC,
  maxCostPerWindow: 100n * TRAC,
  maxTotalCost: 1_000n * TRAC,
  maxPeriodSeconds: 31n * DAY,
  assignedAt: 1_000n,
  expiresAt: 4_000_000_000n,
  revokedAt: 0n,
  nonce: 0n,
  ...overrides,
});

const capsOf = (overrides: Record<string, bigint> = {}) => ({
  maxCostPerPeriod: 40n * TRAC,
  maxInferenceCostPerPeriod: 40n * TRAC,
  maxQueryCostPerPeriod: 0n,
  maxCostPerWindow: 0n,
  maxTotalCost: 400n * TRAC,
  maxPeriodSeconds: 7n * DAY,
  expiresAt: 4_100_000_000n,
  ...overrides,
});

const ASSIGNEE = ethers.getAddress('0x00000000000000000000000000000000000000a1');
const SESSION_KEY = ethers.getAddress('0x00000000000000000000000000000000000000b2');

const subscriptionRecord = (accountId: bigint, overrides: Record<string, bigint | string> = {}) => ({
  accountId,
  assignee: ASSIGNEE,
  sessionKey: SESSION_KEY,
  periodId: ethers.id('period-1'),
  planDigest: ethers.id('plan-1'),
  periodStart: 1_700_000_000n,
  periodEnd: 1_700_000_000n + 30n * DAY,
  fundedEpoch: 42n,
  fundedWindow: 3n,
  discountBps: 3_000n,
  bucketCount: 3n,
  value: 10n * TRAC,
  cost: 7n * TRAC,
  drawnFromWindow: 7n * TRAC,
  drawnFromTopUp: 0n,
  ...overrides,
});

const bucketOf = (label: string, serviceClass: bigint, value: bigint, maxAsk: bigint) => ({
  bucketId: ethers.id(label),
  serviceClass,
  value,
  maxAskWeiPerUnit: maxAsk,
});

/** A struct read back from the contract, as a plain object. */
const plain = (r: unknown) => (r as ethers.Result).toObject();

describe('@unit ConvictionServiceStorage', () => {
  let Hub: Hub;
  let CSS: ConvictionServiceStorage;
  let owner: SignerWithAddress;
  let logic: SignerWithAddress;
  let stranger: SignerWithAddress;
  let accounts: SignerWithAddress[];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, CSS, owner, logic, stranger } = await loadFixture(deployFixture));
  });

  describe('metadata and initialization', () => {
    it('is named ConvictionServiceStorage, version 1.0.0, with the two service classes', async () => {
      expect(await CSS.name()).to.equal('ConvictionServiceStorage');
      expect(await CSS.version()).to.equal('1.0.0');
      expect(await CSS.CLASS_INFERENCE()).to.equal(1n);
      expect(await CSS.CLASS_QUERY()).to.equal(2n);
      expect(await CSS.hub()).to.equal(await Hub.getAddress());
    });

    it('initialize seeds the defaults and leaves the cut-over unset', async () => {
      expect(await CSS.maxPeriodSeconds()).to.equal(31n * DAY);
      expect(await CSS.maxBucketsPerPeriod()).to.equal(16n);
      expect(await CSS.exactScheduleFrom()).to.equal(0n);
    });

    it('initialize is idempotent: a tuned parameter survives a re-initialization', async () => {
      await CSS.setMaxPeriodSeconds(7n * DAY);
      await Hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData('initialize'));
      expect(await CSS.maxPeriodSeconds()).to.equal(7n * DAY);
      expect(await CSS.maxBucketsPerPeriod()).to.equal(16n);
    });

    it('initialize is onlyHub: a Hub contract and a stranger are refused', async () => {
      for (const caller of [logic, stranger]) {
        await expect(CSS.connect(caller).initialize())
          .to.be.revertedWithCustomError(CSS, 'UnauthorizedAccess')
          .withArgs('Only Hub');
      }
    });
  });

  describe('parameter setters (onlyHub)', () => {
    const setters: Array<[string, unknown[]]> = [
      ['setMaxPeriodSeconds', [7n * DAY]],
      ['setMaxBucketsPerPeriod', [8n]],
      ['setExactScheduleFrom', [1n]],
    ];

    for (const [setter, args] of setters) {
      it(`${setter} refuses a Hub contract and a stranger, and admits the Hub owner and Hub.forwardCall`, async () => {
        for (const caller of [logic, stranger]) {
          await expect(
            (CSS.connect(caller) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](...args),
          )
            .to.be.revertedWithCustomError(CSS, 'UnauthorizedAccess')
            .withArgs('Only Hub');
        }
        // The Hub owner may call directly; the Hub reaches it through forwardCall.
        await (CSS.connect(owner) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](
          ...args,
        );
        if (setter !== 'setExactScheduleFrom') {
          await Hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData(setter, args));
        }
      });
    }

    it('Hub.forwardCall reaches the setters only once the storage is registered in the Hub', async () => {
      const Factory = await hre.ethers.getContractFactory('ConvictionServiceStorage');
      const unregistered = await Factory.deploy(await Hub.getAddress());
      await unregistered.waitForDeployment();
      const data = CSS.interface.encodeFunctionData('setMaxBucketsPerPeriod', [4n]);

      await expect(Hub.forwardCall(await unregistered.getAddress(), data))
        .to.be.revertedWithCustomError(Hub, 'InvalidTargetContract')
        .withArgs(await unregistered.getAddress());

      await expect(Hub.forwardCall(await CSS.getAddress(), data))
        .to.emit(CSS, 'MaxBucketsPerPeriodSet')
        .withArgs(16n, 4n);
      expect(await CSS.maxBucketsPerPeriod()).to.equal(4n);
    });

    it('setMaxPeriodSeconds accepts 1 day to 366 days and emits the old and new values', async () => {
      await expect(CSS.setMaxPeriodSeconds(DAY - 1n))
        .to.be.revertedWithCustomError(CSS, 'InvalidParameter')
        .withArgs('maxPeriodSeconds');
      await expect(CSS.setMaxPeriodSeconds(366n * DAY + 1n))
        .to.be.revertedWithCustomError(CSS, 'InvalidParameter')
        .withArgs('maxPeriodSeconds');

      await expect(CSS.setMaxPeriodSeconds(DAY)).to.emit(CSS, 'MaxPeriodSecondsSet').withArgs(31n * DAY, DAY);
      await expect(CSS.setMaxPeriodSeconds(366n * DAY))
        .to.emit(CSS, 'MaxPeriodSecondsSet')
        .withArgs(DAY, 366n * DAY);
      expect(await CSS.maxPeriodSeconds()).to.equal(366n * DAY);
    });

    it('setMaxBucketsPerPeriod accepts 1 to 32 and emits the old and new values', async () => {
      for (const bad of [0n, 33n]) {
        await expect(CSS.setMaxBucketsPerPeriod(bad))
          .to.be.revertedWithCustomError(CSS, 'InvalidParameter')
          .withArgs('maxBucketsPerPeriod');
      }
      await expect(CSS.setMaxBucketsPerPeriod(1n)).to.emit(CSS, 'MaxBucketsPerPeriodSet').withArgs(16n, 1n);
      await expect(CSS.setMaxBucketsPerPeriod(32n)).to.emit(CSS, 'MaxBucketsPerPeriodSet').withArgs(1n, 32n);
      expect(await CSS.maxBucketsPerPeriod()).to.equal(32n);
    });

    it('setExactScheduleFrom refuses 0 and a future time, accepts the block time, and is set once', async () => {
      await expect(CSS.setExactScheduleFrom(0n))
        .to.be.revertedWithCustomError(CSS, 'InvalidParameter')
        .withArgs('exactScheduleFrom');

      const now = BigInt(await time.latest());
      await time.setNextBlockTimestamp(now + 10n);
      await expect(CSS.setExactScheduleFrom(now + 11n))
        .to.be.revertedWithCustomError(CSS, 'InvalidParameter')
        .withArgs('exactScheduleFrom');

      await time.setNextBlockTimestamp(now + 20n);
      await expect(CSS.setExactScheduleFrom(now + 20n)).to.emit(CSS, 'ExactScheduleFromSet').withArgs(now + 20n);
      expect(await CSS.exactScheduleFrom()).to.equal(now + 20n);

      // Set once: neither an earlier nor a later valid time replaces it.
      for (const again of [now, now + 20n]) {
        await expect(CSS.setExactScheduleFrom(again))
          .to.be.revertedWithCustomError(CSS, 'ExactScheduleFromAlreadySet')
          .withArgs(now + 20n);
      }
    });

    it('setExactScheduleFrom through Hub.forwardCall sets a past cut-over', async () => {
      const past = BigInt(await time.latest()) - 3_600n;
      await expect(
        Hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData('setExactScheduleFrom', [past])),
      )
        .to.emit(CSS, 'ExactScheduleFromSet')
        .withArgs(past);
      expect(await CSS.exactScheduleFrom()).to.equal(past);
    });
  });

  describe('mutator gates (onlyContracts)', () => {
    // Each call takes a salt so the two passing callers write distinct records.
    const assignee = ASSIGNEE;
    const mutators: Array<[string, (c: ConvictionServiceStorage, salt: bigint) => Promise<unknown>]> = [
      ['setServiceSpendingEnabledAt', (c, s) => c.setServiceSpendingEnabledAt(s, 1_000n)],
      ['consumeAssignmentNonce', (c, s) => c.consumeAssignmentNonce(s)],
      ['setAssignment', (c, s) => c.setAssignment(s, assignee, assignmentTerms())],
      ['setAssignmentRevokedAt', (c, s) => c.setAssignmentRevokedAt(s, assignee, 2_000n)],
      ['setAssignmentCaps', (c, s) => c.setAssignmentCaps(s, assignee, capsOf())],
      ['recordUsage', (c, s) => c.recordUsage(s, assignee, 0n, 5n)],
      ['increaseServiceSpent', (c, s) => c.increaseServiceSpent(s, 0n, 5n)],
      ['addBaseLabel', (c, s) => c.addBaseLabel(s, 10n, 5n)],
      ['addTopUpLabel', (c, s) => c.addTopUpLabel(s, 10n, 5n)],
      ['setLabelCursor', (c, s) => c.setLabelCursor(s, 10n)],
      [
        'createSubscription',
        (c, s) =>
          c.createSubscription(ethers.toBeHex(s, 32), subscriptionRecord(s), [
            bucketOf('model-a', 1n, 10n * TRAC, 1_000n),
          ]),
      ],
    ];

    it('the list below covers every state-changing function except initialize and the parameter setters', () => {
      const parameterFunctions = ['initialize', 'setExactScheduleFrom', 'setMaxPeriodSeconds', 'setMaxBucketsPerPeriod'];
      const stateChanging: string[] = [];
      CSS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && !parameterFunctions.includes(f.name)) stateChanging.push(f.name);
      });
      expect(stateChanging.sort()).to.deep.equal(mutators.map(([n]) => n).sort());
    });

    for (const [name, call] of mutators) {
      it(`${name} refuses a caller outside the Hub, and admits a Hub contract and the Hub owner`, async () => {
        await expect(call(CSS.connect(stranger), 1n))
          .to.be.revertedWithCustomError(CSS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
        await call(CSS.connect(logic), 2n);
        await call(CSS.connect(owner), 3n);
      });
    }
  });

  describe('opt-in and assignment nonce', () => {
    it('setServiceSpendingEnabledAt records the switch time, and 0 switches it off', async () => {
      await CSS.connect(logic).setServiceSpendingEnabledAt(7n, 1_234n);
      expect(await CSS.serviceSpendingEnabledAt(7n)).to.equal(1_234n);
      await CSS.connect(logic).setServiceSpendingEnabledAt(7n, 0n);
      expect(await CSS.serviceSpendingEnabledAt(7n)).to.equal(0n);
    });

    it('consumeAssignmentNonce returns the current nonce and advances it, per account', async () => {
      expect(await CSS.connect(logic).consumeAssignmentNonce.staticCall(7n)).to.equal(0n);
      await CSS.connect(logic).consumeAssignmentNonce(7n);
      expect(await CSS.assignmentNonce(7n)).to.equal(1n);
      expect(await CSS.connect(logic).consumeAssignmentNonce.staticCall(7n)).to.equal(1n);
      await CSS.connect(logic).consumeAssignmentNonce(7n);
      expect(await CSS.assignmentNonce(7n)).to.equal(2n);
      expect(await CSS.assignmentNonce(8n)).to.equal(0n);
    });
  });

  describe('assignments and usage', () => {
    const accountId = 7n;

    it('setAssignment stores the terms, lists an assignee once, and resets its usage', async () => {
      const [a, b] = [accounts[10].address, accounts[11].address];
      await CSS.connect(logic).setAssignment(accountId, a, assignmentTerms({ nonce: 0n }));
      expect(plain(await CSS.getAssignment(accountId, a))).to.deep.equal(assignmentTerms({ nonce: 0n }));
      expect(await CSS.assigneeCount(accountId)).to.equal(1n);
      expect(await CSS.assigneeAt(accountId, 0n)).to.equal(a);

      await CSS.connect(logic).recordUsage(accountId, a, 2n, 9n * TRAC);
      expect((await CSS.getUsage(accountId, a)).totalCost).to.equal(9n * TRAC);

      // Re-assigning the same key: new terms, the list unchanged, usage from zero.
      const renewed = assignmentTerms({ assignedAt: 5_000n, maxTotalCost: 2_000n * TRAC, nonce: 1n });
      await CSS.connect(logic).setAssignment(accountId, a, renewed);
      expect(plain(await CSS.getAssignment(accountId, a))).to.deep.equal(renewed);
      expect(await CSS.assigneeCount(accountId)).to.equal(1n);
      expect(plain(await CSS.getUsage(accountId, a))).to.deep.equal({
        totalCost: 0n,
        windowCost: 0n,
        window: 0n,
        periods: 0n,
      });

      // A second key is appended after the first; another account's list is separate.
      await CSS.connect(logic).setAssignment(accountId, b, assignmentTerms({ nonce: 2n }));
      expect(await CSS.assigneeCount(accountId)).to.equal(2n);
      expect(await CSS.assigneeAt(accountId, 1n)).to.equal(b);
      expect(await CSS.assigneeCount(accountId + 1n)).to.equal(0n);
    });

    it('setAssignmentRevokedAt writes only the revocation time', async () => {
      const a = accounts[10].address;
      await CSS.connect(logic).setAssignment(accountId, a, assignmentTerms({ nonce: 3n }));
      await CSS.connect(logic).setAssignmentRevokedAt(accountId, a, 9_999n);
      expect(plain(await CSS.getAssignment(accountId, a))).to.deep.equal(
        assignmentTerms({ nonce: 3n, revokedAt: 9_999n }),
      );
    });

    it('setAssignmentCaps writes only the seven limits and keeps the usage, assignedAt, revokedAt, nonce and list', async () => {
      const [a, b] = [accounts[10].address, accounts[11].address];
      await CSS.connect(logic).setAssignment(accountId, a, assignmentTerms({ assignedAt: 1_111n, nonce: 4n }));
      await CSS.connect(logic).setAssignment(accountId, b, assignmentTerms({ nonce: 5n }));
      await CSS.connect(logic).setAssignmentRevokedAt(accountId, a, 2_222n);
      await CSS.connect(logic).recordUsage(accountId, a, 6n, 3n * TRAC);
      await CSS.connect(logic).recordUsage(accountId, a, 6n, 2n * TRAC);
      const usageBefore = plain(await CSS.getUsage(accountId, a));

      const caps = capsOf();
      await CSS.connect(logic).setAssignmentCaps(accountId, a, caps);

      expect(plain(await CSS.getAssignment(accountId, a))).to.deep.equal({
        ...caps,
        assignedAt: 1_111n,
        revokedAt: 2_222n,
        nonce: 4n,
      });
      expect(plain(await CSS.getUsage(accountId, a))).to.deep.equal(usageBefore);
      expect(usageBefore).to.deep.equal({ totalCost: 5n * TRAC, windowCost: 5n * TRAC, window: 6n, periods: 2n });
      expect(await CSS.assigneeCount(accountId)).to.equal(2n);
      expect(await CSS.assigneeAt(accountId, 0n)).to.equal(a);
      expect(await CSS.assigneeAt(accountId, 1n)).to.equal(b);
      // The other assignee is untouched.
      expect(plain(await CSS.getAssignment(accountId, b))).to.deep.equal(assignmentTerms({ nonce: 5n }));
    });

    it('recordUsage accumulates within a window and restarts the window cost in any other window', async () => {
      const a = accounts[10].address;
      const steps: Array<[bigint, bigint, Record<string, bigint>]> = [
        [3n, 10n, { totalCost: 10n, windowCost: 10n, window: 3n, periods: 1n }],
        [3n, 5n, { totalCost: 15n, windowCost: 15n, window: 3n, periods: 2n }],
        [4n, 7n, { totalCost: 22n, windowCost: 7n, window: 4n, periods: 3n }],
        // Any window other than the last one counted starts from zero again.
        [3n, 1n, { totalCost: 23n, windowCost: 1n, window: 3n, periods: 4n }],
      ];
      for (const [window, cost, expected] of steps) {
        await CSS.connect(logic).recordUsage(accountId, a, window, cost);
        expect(plain(await CSS.getUsage(accountId, a))).to.deep.equal(expected);
      }
    });

    it('isAssignmentActive needs an assignment, no revocation, and a block time before expiry', async () => {
      const a = accounts[10].address;
      expect(await CSS.isAssignmentActive(accountId, a)).to.equal(false);

      const now = BigInt(await time.latest());
      const expiresAt = now + 1_000n;
      await CSS.connect(logic).setAssignment(accountId, a, assignmentTerms({ assignedAt: now, expiresAt }));
      expect(await CSS.isAssignmentActive(accountId, a)).to.equal(true);

      await time.increaseTo(expiresAt);
      expect(await CSS.isAssignmentActive(accountId, a)).to.equal(false);

      const later = BigInt(await time.latest());
      await CSS.connect(logic).setAssignment(
        accountId,
        a,
        assignmentTerms({ assignedAt: later, expiresAt: later + 1_000n }),
      );
      expect(await CSS.isAssignmentActive(accountId, a)).to.equal(true);
      await CSS.connect(logic).setAssignmentRevokedAt(accountId, a, later + 1n);
      expect(await CSS.isAssignmentActive(accountId, a)).to.equal(false);
    });
  });

  describe('service spend and labels', () => {
    it('increaseServiceSpent accumulates per account and window', async () => {
      await CSS.connect(logic).increaseServiceSpent(1n, 2n, 5n);
      await CSS.connect(logic).increaseServiceSpent(1n, 2n, 6n);
      await CSS.connect(logic).increaseServiceSpent(1n, 3n, 7n);
      expect(await CSS.serviceSpent(1n, 2n)).to.equal(11n);
      expect(await CSS.serviceSpent(1n, 3n)).to.equal(7n);
      expect(await CSS.serviceSpent(2n, 2n)).to.equal(0n);
    });

    it('label adds update their own mapping, the epoch total and the account total', async () => {
      await CSS.connect(logic).addBaseLabel(1n, 10n, 5n);
      await CSS.connect(logic).addTopUpLabel(1n, 10n, 3n);
      await CSS.connect(logic).addBaseLabel(2n, 10n, 7n);
      await CSS.connect(logic).addTopUpLabel(1n, 11n, 4n);
      await CSS.connect(logic).addBaseLabel(1n, 10n, 1n);

      expect(await CSS.baseLabel(1n, 10n)).to.equal(6n);
      expect(await CSS.topUpLabel(1n, 10n)).to.equal(3n);
      expect(await CSS.accountLabel(1n, 10n)).to.deep.equal([6n, 3n]);
      expect(await CSS.accountLabel(1n, 11n)).to.deep.equal([0n, 4n]);
      expect(await CSS.accountLabel(2n, 10n)).to.deep.equal([7n, 0n]);

      expect(await CSS.serviceLabel(10n)).to.equal(16n);
      expect(await CSS.epochServiceLabel(10n)).to.equal(16n);
      expect(await CSS.serviceLabel(11n)).to.equal(4n);
      expect(await CSS.serviceLabel(12n)).to.equal(0n);

      expect(await CSS.accountServiceLabelTotal(1n)).to.equal(13n);
      expect(await CSS.accountServiceLabelTotal(2n)).to.equal(7n);
    });

    it('label adds revert on overflow instead of wrapping', async () => {
      await CSS.connect(logic).addBaseLabel(1n, 20n, MAX_UINT96);
      // A second account's label in the same epoch overflows the epoch total.
      await expect(CSS.connect(logic).addTopUpLabel(2n, 20n, 1n)).to.be.revertedWithPanic(0x11);
      // The same account's total overflows too, in another epoch.
      await expect(CSS.connect(logic).addBaseLabel(1n, 21n, 1n)).to.be.revertedWithPanic(0x11);
      expect(await CSS.serviceLabel(20n)).to.equal(MAX_UINT96);
    });

    it('setLabelCursor records the cursor per account', async () => {
      await CSS.connect(logic).setLabelCursor(1n, 33n);
      expect(await CSS.labelCursor(1n)).to.equal(33n);
      expect(await CSS.labelCursor(2n)).to.equal(0n);
    });
  });

  describe('period records', () => {
    it('createSubscription stores the record and its buckets in the given order, and appends to the account list', async () => {
      const id = ethers.id('subscription-1');
      const record = subscriptionRecord(7n);
      const buckets = [
        bucketOf('model-b', 1n, 6n * TRAC, 2_000n),
        bucketOf('model-a', 1n, 3n * TRAC, 1_000n),
        bucketOf('graph-q', 2n, 1n * TRAC, 50n),
      ];
      expect(await CSS.subscriptionExists(id)).to.equal(false);

      await CSS.connect(logic).createSubscription(id, record, buckets);

      expect(await CSS.subscriptionExists(id)).to.equal(true);
      expect(plain(await CSS.getSubscription(id))).to.deep.equal(record);
      expect((await CSS.getBuckets(id)).map(plain)).to.deep.equal(buckets);
      expect(await CSS.accountSubscriptionCount(7n)).to.equal(1n);
      expect(await CSS.accountSubscriptionAt(7n, 0n)).to.equal(id);
    });

    it('createSubscription reverts SubscriptionExists for an id already recorded', async () => {
      const id = ethers.id('subscription-1');
      await CSS.connect(logic).createSubscription(id, subscriptionRecord(7n), [bucketOf('m', 1n, 1n, 1n)]);
      await expect(
        CSS.connect(logic).createSubscription(id, subscriptionRecord(8n), [bucketOf('m', 1n, 1n, 1n)]),
      )
        .to.be.revertedWithCustomError(CSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await CSS.accountSubscriptionCount(7n)).to.equal(1n);
      expect(await CSS.accountSubscriptionCount(8n)).to.equal(0n);
      expect(await CSS.getBuckets(id)).to.have.length(1);
    });

    it('keeps each account list in funding order, separate from other accounts', async () => {
      const [p1, p2, q1] = [ethers.id('p1'), ethers.id('p2'), ethers.id('q1')];
      await CSS.connect(logic).createSubscription(p1, subscriptionRecord(7n), [bucketOf('m', 1n, 1n, 1n)]);
      await CSS.connect(logic).createSubscription(q1, subscriptionRecord(8n), [bucketOf('m', 2n, 1n, 1n)]);
      await CSS.connect(logic).createSubscription(p2, subscriptionRecord(7n), [bucketOf('m', 1n, 1n, 1n)]);
      expect(await CSS.accountSubscriptionCount(7n)).to.equal(2n);
      expect(await CSS.accountSubscriptionAt(7n, 0n)).to.equal(p1);
      expect(await CSS.accountSubscriptionAt(7n, 1n)).to.equal(p2);
      expect(await CSS.accountSubscriptionCount(8n)).to.equal(1n);
      expect(await CSS.accountSubscriptionAt(8n, 0n)).to.equal(q1);
    });

    it('an unknown id reads as an empty record with no buckets', async () => {
      const id = ethers.id('never-funded');
      expect(await CSS.subscriptionExists(id)).to.equal(false);
      expect((await CSS.getSubscription(id)).periodStart).to.equal(0n);
      expect(await CSS.getBuckets(id)).to.have.length(0);
    });
  });

  describe('storage layout', () => {
    type LayoutEntry = { label: string; slot: string; offset: number; type: string };
    type LayoutType = { label: string; numberOfBytes: string; members?: LayoutEntry[] };
    type StorageLayout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };

    it('matches the documented layout: slot 0 packs the hub with the three parameters, slots 1 to 15 the mappings', async () => {
      const sourceName = 'contracts/storage/ConvictionServiceStorage.sol';
      const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:ConvictionServiceStorage`);
      const output = buildInfo?.output.contracts[sourceName]?.ConvictionServiceStorage as
        | { storageLayout?: StorageLayout }
        | undefined;
      const layout = output?.storageLayout;
      expect(
        layout,
        'the build info has no storageLayout: hardhat-deploy normally adds it to the solc output selection',
      ).to.not.equal(undefined);

      const rows = layout!.storage.map((s) => [s.slot, s.offset, s.label, layout!.types[s.type].label]);
      expect(rows).to.deep.equal([
        ['0', 0, 'hub', 'contract Hub'],
        ['0', 20, 'exactScheduleFrom', 'uint40'],
        ['0', 25, 'maxPeriodSeconds', 'uint32'],
        ['0', 29, 'maxBucketsPerPeriod', 'uint8'],
        ['1', 0, 'serviceSpendingEnabledAt', 'mapping(uint256 => uint40)'],
        ['2', 0, 'assignmentNonce', 'mapping(uint256 => uint64)'],
        [
          '3',
          0,
          '_assignments',
          'mapping(uint256 => mapping(address => struct ConvictionServiceStorage.Assignment))',
        ],
        ['4', 0, '_usage', 'mapping(uint256 => mapping(address => struct ConvictionServiceStorage.Usage))'],
        ['5', 0, '_assignees', 'mapping(uint256 => address[])'],
        ['6', 0, '_listed', 'mapping(uint256 => mapping(address => bool))'],
        ['7', 0, 'serviceSpent', 'mapping(uint256 => mapping(uint40 => uint96))'],
        ['8', 0, 'baseLabel', 'mapping(uint256 => mapping(uint256 => uint96))'],
        ['9', 0, 'topUpLabel', 'mapping(uint256 => mapping(uint256 => uint96))'],
        ['10', 0, 'labelCursor', 'mapping(uint256 => uint256)'],
        ['11', 0, 'epochServiceLabel', 'mapping(uint256 => uint96)'],
        ['12', 0, 'accountServiceLabelTotal', 'mapping(uint256 => uint96)'],
        ['13', 0, '_subscriptions', 'mapping(bytes32 => struct ConvictionServiceStorage.Subscription)'],
        ['14', 0, '_buckets', 'mapping(bytes32 => struct ConvictionServiceStorage.Bucket[])'],
        ['15', 0, '_accountSubscriptions', 'mapping(uint256 => bytes32[])'],
      ]);

      // Slot 0 uses 30 of its 32 bytes.
      const maxBuckets = layout!.storage.find((s) => s.label === 'maxBucketsPerPeriod')!;
      expect(maxBuckets.offset + Number(layout!.types[maxBuckets.type].numberOfBytes)).to.equal(30);

      // An Assignment takes 4 slots and a Usage 2.
      const structBytes = (label: string) =>
        Object.values(layout!.types).find((t) => t.label === `struct ConvictionServiceStorage.${label}`)!
          .numberOfBytes;
      expect(structBytes('Assignment')).to.equal('128');
      expect(structBytes('Usage')).to.equal('64');
    });
  });
});
