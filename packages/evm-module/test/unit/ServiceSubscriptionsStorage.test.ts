// ServiceSubscriptionsStorage: the policy-free state store for Conviction
// Account service spending (OT-RFC-27).
//
// Covers:
//   - the gates: every mutator is onlyContracts (a Hub-registered contract or
//     the Hub owner), every parameter setter is onlyHub (the Hub, through
//     forwardCall, or the Hub owner), and the two never admit each other's
//     callers;
//   - the parameters: defaults and bounds;
//   - the mutators' semantics: the opt-in and the owner who made it,
//     grant listing and usage reset, the end a replaced grant
//     keeps, limit updates that keep everything but the two limits, the subscription
//     count, subscription records, each written once and never with a start of 0,
//     and top-ups of a recorded subscription at its budget indexes;
//   - the narrow setters, one field each, and the views beside them: round
//     trips of each, with the other fields left as they were, and the rules
//     of the subscription records kept (no record created, none left reading as
//     absent, and budgets only for a recorded subscription);
//   - the compiler's storage layout against the documented one: the mapping
//     slots of 1.1.0, with the label slots held empty, and the ends of
//     replaced grants last;
//   - no label state, label view or schedule cut-over is left (1.2.0).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ServiceSubscriptionsStorage, Hub } from '../../typechain';

const DAY = 86_400n;
const TRAC = 10n ** 18n;
const MAX_UINT96 = (1n << 96n) - 1n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  SSS: ServiceSubscriptionsStorage;
  owner: SignerWithAddress;
  logic: SignerWithAddress;
  stranger: SignerWithAddress;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['Hub']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  const Factory = await hre.ethers.getContractFactory('ServiceSubscriptionsStorage');
  const SSS = (await Factory.deploy(await Hub.getAddress())) as unknown as ServiceSubscriptionsStorage;
  await SSS.waitForDeployment();
  await Hub.setContractAddress('ServiceSubscriptionsStorage', await SSS.getAddress());
  // A Hub-registered contract stands in for the logic contracts: the Hub's
  // contract set is all `onlyContracts` checks.
  await Hub.setContractAddress('ServiceLogicStandIn', accounts[1].address);
  await Hub.forwardCall(await SSS.getAddress(), SSS.interface.encodeFunctionData('initialize'));

  return { accounts, Hub, SSS, owner: accounts[0], logic: accounts[1], stranger: accounts[2] };
}

const ACCOUNT_OWNER = ethers.getAddress('0x00000000000000000000000000000000000000c3');

const buyerTerms = (overrides: Record<string, bigint | string> = {}) => ({
  maxCostPerEpoch: 25n * TRAC,
  grantedAt: 1_000n,
  expiresAt: 4_000_000_000n,
  revokedAt: 0n,
  nonce: 0n,
  owner: ACCOUNT_OWNER,
  ...overrides,
});

const limitsOf = (overrides: Record<string, bigint> = {}) => ({
  maxCostPerEpoch: 40n * TRAC,
  expiresAt: 4_100_000_000n,
  ...overrides,
});

const BUYER = ethers.getAddress('0x00000000000000000000000000000000000000a1');
const SESSION_KEY = ethers.getAddress('0x00000000000000000000000000000000000000b2');

const subscriptionRecord = (accountId: bigint, overrides: Record<string, bigint | string> = {}) => ({
  accountId,
  buyer: BUYER,
  grantNonce: 4n,
  sessionKey: SESSION_KEY,
  epoch: 41n,
  planDigest: ethers.id('plan-1'),
  startsAt: 1_700_000_000n,
  endsAt: 1_700_000_000n + 30n * DAY,
  fundedEpoch: 42n,
  fundedWindow: 3n,
  discountBps: 3_000n,
  budgetCount: 3n,
  value: 10n * TRAC,
  cost: 7n * TRAC,
  spentFromWindow: 7n * TRAC,
  spentFromTopUp: 0n,
  ...overrides,
});

const budgetOf = (label: string, serviceClass: bigint, value: bigint, maxPrice: bigint) => ({
  serviceId: ethers.id(label),
  serviceClass,
  value,
  maxPricePerUnit: maxPrice,
});

const topUpOf = (overrides: Record<string, bigint> = {}) => ({
  value: TRAC,
  cost: TRAC,
  spentFromWindow: 0n,
  spentFromTopUp: 0n,
  ...overrides,
});

/** A struct read back from the contract, as a plain object. */
const plain = (r: unknown) => (r as ethers.Result).toObject();

describe('@unit ServiceSubscriptionsStorage', () => {
  let Hub: Hub;
  let SSS: ServiceSubscriptionsStorage;
  let owner: SignerWithAddress;
  let logic: SignerWithAddress;
  let stranger: SignerWithAddress;
  let accounts: SignerWithAddress[];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, SSS, owner, logic, stranger } = await loadFixture(deployFixture));
  });

  describe('metadata and initialization', () => {
    it('is named ServiceSubscriptionsStorage, version 1.2.0, with the two service classes', async () => {
      expect(await SSS.name()).to.equal('ServiceSubscriptionsStorage');
      expect(await SSS.version()).to.equal('1.2.0');
      expect(await SSS.CLASS_INFERENCE()).to.equal(1n);
      expect(await SSS.CLASS_QUERY()).to.equal(2n);
      expect(await SSS.hub()).to.equal(await Hub.getAddress());
    });

    it('initialize seeds the default', async () => {
      expect(await SSS.maxBudgetsPerSubscription()).to.equal(16n);
    });

    it('holds no label state, no label view and no schedule cut-over', () => {
      for (const gone of [
        'exactScheduleFrom',
        'setExactScheduleFrom',
        'serviceSpent',
        'increaseServiceSpent',
        'baseLabel',
        'topUpLabel',
        'labelCursor',
        'epochServiceLabel',
        'accountServiceLabelTotal',
        'addBaseLabel',
        'addTopUpLabel',
        'setLabelCursor',
        'serviceLabel',
        'accountLabel',
      ]) {
        expect(SSS.interface.getFunction(gone), gone).to.equal(null);
      }
      for (const gone of ['ExactScheduleFromSet']) expect(SSS.interface.getEvent(gone), gone).to.equal(null);
      for (const gone of ['ExactScheduleFromAlreadySet']) expect(SSS.interface.getError(gone), gone).to.equal(null);
    });

    it('initialize is idempotent: a tuned parameter survives a re-initialization', async () => {
      await SSS.setMaxBudgetsPerSubscription(7n);
      await Hub.forwardCall(await SSS.getAddress(), SSS.interface.encodeFunctionData('initialize'));
      expect(await SSS.maxBudgetsPerSubscription()).to.equal(7n);
    });

    it('initialize is onlyHub: a Hub contract and a stranger are refused', async () => {
      for (const caller of [logic, stranger]) {
        await expect(SSS.connect(caller).initialize())
          .to.be.revertedWithCustomError(SSS, 'UnauthorizedAccess')
          .withArgs('Only Hub');
      }
    });
  });

  describe('parameter setters (onlyHub)', () => {
    const setters: Array<[string, unknown[]]> = [['setMaxBudgetsPerSubscription', [8n]]];

    for (const [setter, args] of setters) {
      it(`${setter} refuses a Hub contract and a stranger, and admits the Hub owner and Hub.forwardCall`, async () => {
        for (const caller of [logic, stranger]) {
          await expect(
            (SSS.connect(caller) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](...args),
          )
            .to.be.revertedWithCustomError(SSS, 'UnauthorizedAccess')
            .withArgs('Only Hub');
        }
        // The Hub owner may call directly; the Hub reaches it through forwardCall.
        await (SSS.connect(owner) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[setter](
          ...args,
        );
        await Hub.forwardCall(await SSS.getAddress(), SSS.interface.encodeFunctionData(setter, args));
      });
    }

    it('Hub.forwardCall reaches the setters only once the storage is registered in the Hub', async () => {
      const Factory = await hre.ethers.getContractFactory('ServiceSubscriptionsStorage');
      const unregistered = await Factory.deploy(await Hub.getAddress());
      await unregistered.waitForDeployment();
      const data = SSS.interface.encodeFunctionData('setMaxBudgetsPerSubscription', [4n]);

      await expect(Hub.forwardCall(await unregistered.getAddress(), data))
        .to.be.revertedWithCustomError(Hub, 'InvalidTargetContract')
        .withArgs(await unregistered.getAddress());

      await expect(Hub.forwardCall(await SSS.getAddress(), data))
        .to.emit(SSS, 'MaxBudgetsPerSubscriptionSet')
        .withArgs(16n, 4n);
      expect(await SSS.maxBudgetsPerSubscription()).to.equal(4n);
    });

    it('setMaxBudgetsPerSubscription accepts 1 to 32 and emits the old and new values', async () => {
      for (const bad of [0n, 33n]) {
        await expect(SSS.setMaxBudgetsPerSubscription(bad))
          .to.be.revertedWithCustomError(SSS, 'InvalidParameter')
          .withArgs('maxBudgetsPerSubscription');
      }
      await expect(SSS.setMaxBudgetsPerSubscription(1n)).to.emit(SSS, 'MaxBudgetsPerSubscriptionSet').withArgs(16n, 1n);
      await expect(SSS.setMaxBudgetsPerSubscription(32n)).to.emit(SSS, 'MaxBudgetsPerSubscriptionSet').withArgs(1n, 32n);
      expect(await SSS.maxBudgetsPerSubscription()).to.equal(32n);
    });

  });

  describe('mutator gates (onlyContracts)', () => {
    // Each call takes a salt so the two passing callers write distinct records.
    const buyer = BUYER;
    const mutators: Array<[string, (c: ServiceSubscriptionsStorage, salt: bigint) => Promise<unknown>]> = [
      ['setServiceSpending', (c, s) => c.setServiceSpending(s, { enabledAt: 1_000n, owner: ACCOUNT_OWNER })],
      ['consumeGrantNonce', (c, s) => c.consumeGrantNonce(s)],
      ['setGrant', (c, s) => c.setGrant(s, buyer, buyerTerms())],
      ['setGrantRevokedAt', (c, s) => c.setGrantRevokedAt(s, buyer, 2_000n)],
      ['setBuyerLimits', (c, s) => c.setBuyerLimits(s, buyer, limitsOf())],
      ['recordUsage', (c, s) => c.recordUsage(s, buyer)],
      [
        'createSubscription',
        (c, s) =>
          c.createSubscription(ethers.toBeHex(s, 32), subscriptionRecord(s), [
            budgetOf('model-a', 1n, 10n * TRAC, 1_000n),
          ]),
      ],
      [
        'applyTopUp',
        async (c, s) => {
          const id = ethers.toBeHex(1_000n + s, 32);
          await SSS.connect(logic).createSubscription(id, subscriptionRecord(s), [budgetOf('m', 1n, 1n, 1n)]);
          return c.applyTopUp(id, topUpOf(), ethers.id('plan-2'), [1n], []);
        },
      ],
      ['setGrantRecord', (c, s) => c.setGrantRecord(s, buyer, buyerTerms())],
      ['setReplacedGrantEnd', (c, s) => c.setReplacedGrantEnd(s, buyer, 0n, 5_000n)],
      ['listBuyer', (c, s) => c.listBuyer(s, buyer)],
      ['setUsage', (c, s) => c.setUsage(s, buyer, { subscriptions: 3n })],
      [
        'setSubscription',
        async (c, s) => {
          const id = ethers.toBeHex(2_000n + s, 32);
          await SSS.connect(logic).createSubscription(id, subscriptionRecord(s), []);
          return c.setSubscription(id, subscriptionRecord(s, { cost: 1n }));
        },
      ],
      [
        'setBudget',
        async (c, s) => {
          const id = ethers.toBeHex(3_000n + s, 32);
          await SSS.connect(logic).createSubscription(id, subscriptionRecord(s), [budgetOf('m', 1n, 1n, 1n)]);
          return c.setBudget(id, 0n, budgetOf('n', 2n, 2n, 2n));
        },
      ],
      [
        'appendBudget',
        async (c, s) => {
          const id = ethers.toBeHex(4_000n + s, 32);
          await SSS.connect(logic).createSubscription(id, subscriptionRecord(s), []);
          return c.appendBudget(id, budgetOf('n', 2n, 2n, 2n));
        },
      ],
      [
        'appendAccountSubscription',
        async (c, s) => {
          const id = ethers.toBeHex(5_000n + s, 32);
          await SSS.connect(logic).createSubscription(id, subscriptionRecord(s), []);
          return c.appendAccountSubscription(s + 100n, id);
        },
      ],
    ];

    it('the list below covers every state-changing function except initialize and the parameter setters', () => {
      const parameterFunctions = ['initialize', 'setMaxBudgetsPerSubscription'];
      const stateChanging: string[] = [];
      SSS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable' && !parameterFunctions.includes(f.name)) stateChanging.push(f.name);
      });
      expect(stateChanging.sort()).to.deep.equal(mutators.map(([n]) => n).sort());
    });

    for (const [name, call] of mutators) {
      it(`${name} refuses a caller outside the Hub, and admits a Hub contract and the Hub owner`, async () => {
        await expect(call(SSS.connect(stranger), 1n))
          .to.be.revertedWithCustomError(SSS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
        await call(SSS.connect(logic), 2n);
        await call(SSS.connect(owner), 3n);
      });
    }
  });

  describe('opt-in and grant nonce', () => {
    it('setServiceSpending records the switch time and the owner who switched it, and 0 switches it off', async () => {
      expect(plain(await SSS.getServiceSpending(7n))).to.deep.equal({ enabledAt: 0n, owner: ethers.ZeroAddress });
      await SSS.connect(logic).setServiceSpending(7n, { enabledAt: 1_234n, owner: ACCOUNT_OWNER });
      expect(plain(await SSS.getServiceSpending(7n))).to.deep.equal({ enabledAt: 1_234n, owner: ACCOUNT_OWNER });
      expect((await SSS.getServiceSpending(8n)).enabledAt).to.equal(0n);
      await SSS.connect(logic).setServiceSpending(7n, { enabledAt: 0n, owner: ethers.ZeroAddress });
      expect(plain(await SSS.getServiceSpending(7n))).to.deep.equal({ enabledAt: 0n, owner: ethers.ZeroAddress });
    });

    it('consumeGrantNonce returns the current nonce and advances it, per account', async () => {
      expect(await SSS.connect(logic).consumeGrantNonce.staticCall(7n)).to.equal(0n);
      await SSS.connect(logic).consumeGrantNonce(7n);
      expect(await SSS.grantNonce(7n)).to.equal(1n);
      expect(await SSS.connect(logic).consumeGrantNonce.staticCall(7n)).to.equal(1n);
      await SSS.connect(logic).consumeGrantNonce(7n);
      expect(await SSS.grantNonce(7n)).to.equal(2n);
      expect(await SSS.grantNonce(8n)).to.equal(0n);
    });
  });

  describe('grants and usage', () => {
    const accountId = 7n;

    it('setGrant stores the terms, lists a buyer once, and resets its usage', async () => {
      const [a, b] = [accounts[10].address, accounts[11].address];
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ nonce: 0n }));
      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal(buyerTerms({ nonce: 0n }));
      expect(await SSS.buyerCount(accountId)).to.equal(1n);
      expect(await SSS.buyerAt(accountId, 0n)).to.equal(a);

      await SSS.connect(logic).recordUsage(accountId, a);
      expect((await SSS.getUsage(accountId, a)).subscriptions).to.equal(1n);

      // Re-adding the same buyer: new terms, the list unchanged, usage from zero.
      const renewed = buyerTerms({ grantedAt: 5_000n, maxCostPerEpoch: 2_000n * TRAC, nonce: 1n });
      await SSS.connect(logic).setGrant(accountId, a, renewed);
      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal(renewed);
      expect(await SSS.buyerCount(accountId)).to.equal(1n);
      expect(plain(await SSS.getUsage(accountId, a))).to.deep.equal({ subscriptions: 0n });

      // A second buyer is appended after the first; another account's list is separate.
      await SSS.connect(logic).setGrant(accountId, b, buyerTerms({ nonce: 2n }));
      expect(await SSS.buyerCount(accountId)).to.equal(2n);
      expect(await SSS.buyerAt(accountId, 1n)).to.equal(b);
      expect(await SSS.buyerCount(accountId + 1n)).to.equal(0n);
    });

    it('grantEnd reads the current grant as it stands, and a replaced one as it ended', async () => {
      const [a, b] = [accounts[10].address, accounts[11].address];
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(0n);

      // The current grant: its expiry, or its revocation if sooner.
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 5_000n, nonce: 0n }));
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(5_000n);
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, 4_000n);
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(4_000n);

      // A new grant keeps the end of the one it replaces.
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 9_000n, nonce: 2n }));
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(4_000n);
      expect(await SSS.grantEnd(accountId, a, 2n)).to.equal(9_000n);

      // Changes to the current one move only its own end; a revocation after
      // its expiry leaves the expiry.
      await SSS.connect(logic).setBuyerLimits(accountId, a, limitsOf({ expiresAt: 8_000n }));
      expect(await SSS.grantEnd(accountId, a, 2n)).to.equal(8_000n);
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, 8_500n);
      expect(await SSS.grantEnd(accountId, a, 2n)).to.equal(8_000n);
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(4_000n);

      // Replaced unrevoked, a grant keeps its expiry.
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, 0n);
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 12_000n, nonce: 3n }));
      expect(await SSS.grantEnd(accountId, a, 2n)).to.equal(8_000n);
      expect(await SSS.grantEnd(accountId, a, 3n)).to.equal(12_000n);

      // A nonce no grant to the buyer consumed, and another key or account, read 0.
      expect(await SSS.grantEnd(accountId, a, 1n)).to.equal(0n);
      expect(await SSS.grantEnd(accountId, b, 0n)).to.equal(0n);
      expect(await SSS.grantEnd(accountId + 1n, a, 0n)).to.equal(0n);
    });

    it('setGrantRevokedAt writes only the revocation time', async () => {
      const a = accounts[10].address;
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ nonce: 3n }));
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, 9_999n);
      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal(
        buyerTerms({ nonce: 3n, revokedAt: 9_999n }),
      );
    });

    it('setBuyerLimits writes only the two limits and keeps the usage, grantedAt, revokedAt, nonce and list', async () => {
      const [a, b] = [accounts[10].address, accounts[11].address];
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ grantedAt: 1_111n, nonce: 4n }));
      await SSS.connect(logic).setGrant(accountId, b, buyerTerms({ nonce: 5n }));
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, 2_222n);
      await SSS.connect(logic).recordUsage(accountId, a);
      await SSS.connect(logic).recordUsage(accountId, a);
      const usageBefore = plain(await SSS.getUsage(accountId, a));

      const limits = limitsOf();
      await SSS.connect(logic).setBuyerLimits(accountId, a, limits);

      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal({
        ...limits,
        grantedAt: 1_111n,
        revokedAt: 2_222n,
        nonce: 4n,
        owner: ACCOUNT_OWNER,
      });
      expect(plain(await SSS.getUsage(accountId, a))).to.deep.equal(usageBefore);
      expect(usageBefore).to.deep.equal({ subscriptions: 2n });
      expect(await SSS.buyerCount(accountId)).to.equal(2n);
      expect(await SSS.buyerAt(accountId, 0n)).to.equal(a);
      expect(await SSS.buyerAt(accountId, 1n)).to.equal(b);
      // The other buyer is untouched.
      expect(plain(await SSS.getGrant(accountId, b))).to.deep.equal(buyerTerms({ nonce: 5n }));
    });

    it('recordUsage counts the subscriptions of a buyer, per account', async () => {
      const a = accounts[10].address;
      for (let i = 1n; i <= 3n; i++) {
        await SSS.connect(logic).recordUsage(accountId, a);
        expect(plain(await SSS.getUsage(accountId, a))).to.deep.equal({ subscriptions: i });
      }
      expect((await SSS.getUsage(accountId + 1n, a)).subscriptions).to.equal(0n);
      expect((await SSS.getUsage(accountId, accounts[11].address)).subscriptions).to.equal(0n);
    });

    it('isGrantActive needs a grant, no revocation, and a block time before expiry', async () => {
      const a = accounts[10].address;
      expect(await SSS.isGrantActive(accountId, a)).to.equal(false);

      const now = BigInt(await time.latest());
      const expiresAt = now + 1_000n;
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ grantedAt: now, expiresAt }));
      expect(await SSS.isGrantActive(accountId, a)).to.equal(true);

      await time.increaseTo(expiresAt);
      expect(await SSS.isGrantActive(accountId, a)).to.equal(false);

      const later = BigInt(await time.latest());
      await SSS.connect(logic).setGrant(
        accountId,
        a,
        buyerTerms({ grantedAt: later, expiresAt: later + 1_000n }),
      );
      expect(await SSS.isGrantActive(accountId, a)).to.equal(true);
      await SSS.connect(logic).setGrantRevokedAt(accountId, a, later + 1n);
      expect(await SSS.isGrantActive(accountId, a)).to.equal(false);
    });
  });

  describe('subscription records', () => {
    it('createSubscription stores the record and its budgets in the given order, and appends to the account list', async () => {
      const id = ethers.id('subscription-1');
      const record = subscriptionRecord(7n);
      const budgets = [
        budgetOf('model-b', 1n, 6n * TRAC, 2_000n),
        budgetOf('model-a', 1n, 3n * TRAC, 1_000n),
        budgetOf('graph-q', 2n, 1n * TRAC, 50n),
      ];
      expect(await SSS.subscriptionExists(id)).to.equal(false);

      await SSS.connect(logic).createSubscription(id, record, budgets);

      expect(await SSS.subscriptionExists(id)).to.equal(true);
      expect(plain(await SSS.getSubscription(id))).to.deep.equal(record);
      expect((await SSS.getBudgets(id)).map(plain)).to.deep.equal(budgets);
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(1n);
      expect(await SSS.accountSubscriptionAt(7n, 0n)).to.equal(id);
    });

    it('createSubscription reverts SubscriptionExists for an id already recorded', async () => {
      const id = ethers.id('subscription-1');
      await SSS.connect(logic).createSubscription(id, subscriptionRecord(7n), [budgetOf('m', 1n, 1n, 1n)]);
      await expect(
        SSS.connect(logic).createSubscription(id, subscriptionRecord(8n), [budgetOf('m', 1n, 1n, 1n)]),
      )
        .to.be.revertedWithCustomError(SSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(1n);
      expect(await SSS.accountSubscriptionCount(8n)).to.equal(0n);
      expect(await SSS.getBudgets(id)).to.have.length(1);
    });

    it('createSubscription reverts ZeroSubscriptionStart for a record with no start, which would read as absent, and stores nothing', async () => {
      const id = ethers.id('subscription-1');
      for (const caller of [logic, owner]) {
        await expect(
          SSS.connect(caller).createSubscription(id, subscriptionRecord(7n, { startsAt: 0n }), [
            budgetOf('m', 1n, 1n, 1n),
          ]),
        )
          .to.be.revertedWithCustomError(SSS, 'ZeroSubscriptionStart')
          .withArgs(id);
      }
      expect(await SSS.subscriptionExists(id)).to.equal(false);
      expect(await SSS.getBudgets(id)).to.have.length(0);
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(0n);
    });

    it('createSubscription reverts SubscriptionExists for an id that holds budgets but no record', async () => {
      // No mutator leaves an id in this state any more; plant it at the
      // documented layout (`_budgets` is slot 14) to prove the second guard.
      const id = ethers.id('subscription-1');
      const lengthSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [id, 14n]));
      await hre.network.provider.send('hardhat_setStorageAt', [
        await SSS.getAddress(),
        lengthSlot,
        ethers.toBeHex(1n, 32),
      ]);
      expect(await SSS.getBudgets(id)).to.have.length(1);
      expect(await SSS.subscriptionExists(id)).to.equal(false);

      await expect(SSS.connect(logic).createSubscription(id, subscriptionRecord(7n), [budgetOf('m', 1n, 1n, 1n)]))
        .to.be.revertedWithCustomError(SSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await SSS.subscriptionExists(id)).to.equal(false);
      expect(await SSS.getBudgets(id)).to.have.length(1);
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(0n);
    });

    it('keeps each account list in funding order, separate from other accounts', async () => {
      const [p1, p2, q1] = [ethers.id('p1'), ethers.id('p2'), ethers.id('q1')];
      await SSS.connect(logic).createSubscription(p1, subscriptionRecord(7n), [budgetOf('m', 1n, 1n, 1n)]);
      await SSS.connect(logic).createSubscription(q1, subscriptionRecord(8n), [budgetOf('m', 2n, 1n, 1n)]);
      await SSS.connect(logic).createSubscription(p2, subscriptionRecord(7n), [budgetOf('m', 1n, 1n, 1n)]);
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(2n);
      expect(await SSS.accountSubscriptionAt(7n, 0n)).to.equal(p1);
      expect(await SSS.accountSubscriptionAt(7n, 1n)).to.equal(p2);
      expect(await SSS.accountSubscriptionCount(8n)).to.equal(1n);
      expect(await SSS.accountSubscriptionAt(8n, 0n)).to.equal(q1);
    });

    it('an unknown id reads as an empty record with no budgets', async () => {
      const id = ethers.id('never-funded');
      expect(await SSS.subscriptionExists(id)).to.equal(false);
      expect((await SSS.getSubscription(id)).startsAt).to.equal(0n);
      expect(await SSS.getBudgets(id)).to.have.length(0);
    });

    it('getBudget reads one budget by its index, and reverts past the budget count', async () => {
      const id = ethers.id('subscription-1');
      const budgets = [budgetOf('model-b', 1n, 6n * TRAC, 2_000n), budgetOf('graph-q', 2n, 1n * TRAC, 50n)];
      await SSS.connect(logic).createSubscription(id, subscriptionRecord(7n), budgets);
      expect(plain(await SSS.getBudget(id, 0n))).to.deep.equal(budgets[0]);
      expect(plain(await SSS.getBudget(id, 1n))).to.deep.equal(budgets[1]);
      await expect(SSS.getBudget(id, 2n)).to.be.revertedWithPanic(0x32);
      await expect(SSS.getBudget(ethers.id('never-funded'), 0n)).to.be.revertedWithPanic(0x32);
    });
  });

  describe('top-ups', () => {
    const id = ethers.id('subscription-1');
    const stored = () => [
      budgetOf('model-a', 1n, 6n * TRAC, 2_000n),
      budgetOf('model-b', 1n, 3n * TRAC, 1_000n),
      budgetOf('graph-q', 2n, 1n * TRAC, 50n),
    ];

    beforeEach(async () => {
      await SSS.connect(logic).createSubscription(id, subscriptionRecord(7n), stored());
    });

    it('applyTopUp adds to the stored budgets by index, appends new ones, and adds to the value, cost and spends', async () => {
      const appended = [budgetOf('model-c', 2n, 4n * TRAC, 70n)];
      await SSS.connect(logic).applyTopUp(
        id,
        topUpOf({ value: 7n * TRAC, cost: 5n * TRAC, spentFromWindow: 4n * TRAC, spentFromTopUp: TRAC }),
        ethers.id('plan-2'),
        [2n * TRAC, 0n, TRAC],
        appended,
      );

      const before = stored();
      expect((await SSS.getBudgets(id)).map(plain)).to.deep.equal([
        { ...before[0], value: 8n * TRAC },
        before[1],
        { ...before[2], value: 2n * TRAC },
        appended[0],
      ]);
      expect(plain(await SSS.getSubscription(id))).to.deep.equal(
        subscriptionRecord(7n, {
          planDigest: ethers.id('plan-2'),
          budgetCount: 4n,
          value: 17n * TRAC,
          cost: 12n * TRAC,
          spentFromWindow: 11n * TRAC,
          spentFromTopUp: TRAC,
        }),
      );
      // The account's list holds the subscription once, as before.
      expect(await SSS.accountSubscriptionCount(7n)).to.equal(1n);
    });

    it('fewer entries than budgets leave the rest as they are, and no appended budget keeps the count', async () => {
      await SSS.connect(logic).applyTopUp(id, topUpOf({ value: TRAC, cost: TRAC }), ethers.id('plan-3'), [TRAC], []);
      expect((await SSS.getBudgets(id))[0].value).to.equal(7n * TRAC);
      expect((await SSS.getSubscription(id)).budgetCount).to.equal(3n);
    });

    it('refuses an id with no record, and more entries than the subscription has budgets', async () => {
      const unknown = ethers.id('never-funded');
      await expect(SSS.connect(logic).applyTopUp(unknown, topUpOf(), ethers.id('p'), [], [budgetOf('m', 1n, 1n, 1n)]))
        .to.be.revertedWithCustomError(SSS, 'SubscriptionNotFound')
        .withArgs(unknown);
      expect(await SSS.getBudgets(unknown)).to.have.length(0);

      await expect(SSS.connect(logic).applyTopUp(id, topUpOf(), ethers.id('p'), [1n, 1n, 1n, 1n], []))
        .to.be.revertedWithCustomError(SSS, 'BudgetTopUpOutOfRange')
        .withArgs(id, 4n, 3n);
    });

    it('reverts on overflow instead of wrapping', async () => {
      await expect(
        SSS.connect(logic).applyTopUp(id, topUpOf(), ethers.id('p'), [MAX_UINT96], []),
      ).to.be.revertedWithPanic(0x11);
      await expect(
        SSS.connect(logic).applyTopUp(id, topUpOf({ value: MAX_UINT96 }), ethers.id('p'), [], []),
      ).to.be.revertedWithPanic(0x11);
    });
  });

  describe('narrow setters and the views beside them', () => {
    const accountId = 7n;
    const a = BUYER;
    const b = ethers.getAddress('0x00000000000000000000000000000000000000a2');
    const OTHER_OWNER = ethers.getAddress('0x00000000000000000000000000000000000000c4');

    it('every new view reads empty for keys never written', async () => {
      expect(await SSS.isBuyerListed(accountId, a)).to.equal(false);
      expect(await SSS.replacedGrantEnd(accountId, a, 0n)).to.equal(0n);
      expect(await SSS.storedBudgetCount(ethers.id('never-recorded'))).to.equal(0n);
    });

    it('setGrantRecord stores the grant alone: no end is kept for the one it overwrites, nothing is listed, and the usage stays', async () => {
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 5_000n, nonce: 0n }));
      await SSS.connect(logic).recordUsage(accountId, a);
      const next = buyerTerms({ grantedAt: 2_000n, expiresAt: 9_000n, revokedAt: 8_000n, nonce: 3n, owner: OTHER_OWNER });
      await SSS.connect(logic).setGrantRecord(accountId, a, next);
      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal(next);
      expect(await SSS.replacedGrantEnd(accountId, a, 0n)).to.equal(0n);
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(0n);
      expect(await SSS.grantEnd(accountId, a, 3n)).to.equal(8_000n);
      expect((await SSS.getUsage(accountId, a)).subscriptions).to.equal(1n);

      // A key never listed stays unlisted.
      await SSS.connect(logic).setGrantRecord(accountId, b, next);
      expect(await SSS.isBuyerListed(accountId, b)).to.equal(false);
      expect(await SSS.buyerCount(accountId)).to.equal(1n);
    });

    it('setReplacedGrantEnd sets the end kept for a nonce: replacedGrantEnd reads it as stored, grantEnd once another grant is current', async () => {
      // setGrant keeps the end of the grant it replaces, and the view reads it.
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 5_000n, nonce: 0n }));
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms({ expiresAt: 9_000n, nonce: 2n }));
      expect(await SSS.replacedGrantEnd(accountId, a, 0n)).to.equal(5_000n);

      // Set alone, for the replaced nonce and for the current one.
      await SSS.connect(logic).setReplacedGrantEnd(accountId, a, 0n, 4_500n);
      await SSS.connect(logic).setReplacedGrantEnd(accountId, a, 2n, 7_000n);
      expect(await SSS.replacedGrantEnd(accountId, a, 0n)).to.equal(4_500n);
      expect(await SSS.grantEnd(accountId, a, 0n)).to.equal(4_500n);
      // The current grant's end is its own terms'; the stored value waits for its replacement.
      expect(await SSS.replacedGrantEnd(accountId, a, 2n)).to.equal(7_000n);
      expect(await SSS.grantEnd(accountId, a, 2n)).to.equal(9_000n);

      // Nothing else moves.
      expect(plain(await SSS.getGrant(accountId, a))).to.deep.equal(buyerTerms({ expiresAt: 9_000n, nonce: 2n }));
      expect(await SSS.replacedGrantEnd(accountId, b, 0n)).to.equal(0n);
      expect(await SSS.replacedGrantEnd(accountId + 1n, a, 0n)).to.equal(0n);
    });

    it('listBuyer lists a buyer once, in order, as setGrant lists it, and isBuyerListed reads the listing', async () => {
      await SSS.connect(logic).listBuyer(accountId, a);
      await SSS.connect(logic).listBuyer(accountId, a);
      await SSS.connect(logic).setGrant(accountId, b, buyerTerms());
      await SSS.connect(logic).listBuyer(accountId, b);
      expect(await SSS.buyerCount(accountId)).to.equal(2n);
      expect([await SSS.buyerAt(accountId, 0n), await SSS.buyerAt(accountId, 1n)]).to.deep.equal([a, b]);
      expect([await SSS.isBuyerListed(accountId, a), await SSS.isBuyerListed(accountId, b)]).to.deep.equal([
        true,
        true,
      ]);
      expect(await SSS.isBuyerListed(accountId + 1n, a)).to.equal(false);
      // A listing stores no grant.
      expect((await SSS.getGrant(accountId, a)).grantedAt).to.equal(0n);
    });

    it('setUsage sets the subscription count, which recordUsage adds to and setGrant resets', async () => {
      await SSS.connect(logic).setUsage(accountId, a, { subscriptions: 41n });
      expect((await SSS.getUsage(accountId, a)).subscriptions).to.equal(41n);
      await SSS.connect(logic).recordUsage(accountId, a);
      expect((await SSS.getUsage(accountId, a)).subscriptions).to.equal(42n);
      expect((await SSS.getUsage(accountId, b)).subscriptions).to.equal(0n);
      await SSS.connect(logic).setGrant(accountId, a, buyerTerms());
      expect((await SSS.getUsage(accountId, a)).subscriptions).to.equal(0n);
    });

    describe('of a recorded subscription', () => {
      const id = ethers.id('recorded-subscription');
      const unknown = ethers.id('never-recorded');
      const budgets = [budgetOf('model-a', 1n, 10n * TRAC, 1_000n), budgetOf('query-b', 2n, 4n * TRAC, 50n)];

      beforeEach(async () => {
        await SSS.connect(logic).createSubscription(id, subscriptionRecord(accountId, { budgetCount: 2n }), budgets);
      });

      it('setSubscription overwrites the record alone, and refuses an id with no record and a start of 0', async () => {
        const next = subscriptionRecord(accountId, {
          sessionKey: ethers.getAddress('0x00000000000000000000000000000000000000b3'),
          cost: 9n * TRAC,
          budgetCount: 2n,
        });
        await SSS.connect(logic).setSubscription(id, next);
        expect(plain(await SSS.getSubscription(id))).to.deep.equal(next);
        expect((await SSS.getBudgets(id)).map(plain)).to.deep.equal(budgets);
        expect(await SSS.accountSubscriptionCount(accountId)).to.equal(1n);

        // No record is created, and none is left reading as absent.
        await expect(SSS.connect(logic).setSubscription(unknown, next))
          .to.be.revertedWithCustomError(SSS, 'SubscriptionNotFound')
          .withArgs(unknown);
        expect(await SSS.subscriptionExists(unknown)).to.equal(false);
        await expect(SSS.connect(logic).setSubscription(id, { ...next, startsAt: 0n }))
          .to.be.revertedWithCustomError(SSS, 'ZeroSubscriptionStart')
          .withArgs(id);
        expect(plain(await SSS.getSubscription(id))).to.deep.equal(next);
        // The id is still written once.
        await expect(SSS.connect(logic).createSubscription(id, next, []))
          .to.be.revertedWithCustomError(SSS, 'SubscriptionExists')
          .withArgs(id);
      });

      it('setBudget overwrites a stored budget and appendBudget appends one, each alone, and storedBudgetCount counts them; both refuse an id with no record', async () => {
        const replaced = budgetOf('model-c', 1n, 7n * TRAC, 900n);
        await SSS.connect(logic).setBudget(id, 1n, replaced);
        expect(plain(await SSS.getBudget(id, 1n))).to.deep.equal(replaced);
        expect(plain(await SSS.getBudget(id, 0n))).to.deep.equal(budgets[0]);
        await expect(SSS.connect(logic).setBudget(id, 2n, replaced)).to.be.revertedWithPanic(0x32);

        const extra = budgetOf('model-d', 2n, TRAC, 10n);
        await SSS.connect(logic).appendBudget(id, extra);
        expect(await SSS.storedBudgetCount(id)).to.equal(3n);
        expect((await SSS.getBudgets(id)).map(plain)).to.deep.equal([budgets[0], replaced, extra]);
        // The record's own count, which setSubscription sets, is left as it was.
        expect((await SSS.getSubscription(id)).budgetCount).to.equal(2n);

        for (const call of [SSS.connect(logic).setBudget(unknown, 0n, extra), SSS.connect(logic).appendBudget(unknown, extra)]) {
          await expect(call).to.be.revertedWithCustomError(SSS, 'SubscriptionNotFound').withArgs(unknown);
        }
        expect(await SSS.storedBudgetCount(unknown)).to.equal(0n);
        // The refused writes left no budget under the id, so it is recorded afresh.
        await expect(SSS.connect(logic).createSubscription(unknown, subscriptionRecord(accountId), [extra])).to.not.be
          .reverted;
      });

      it('appendAccountSubscription lists a recorded id under an account, after the ones listed, and refuses an id with no record', async () => {
        await SSS.connect(logic).appendAccountSubscription(accountId + 1n, id);
        await SSS.connect(logic).appendAccountSubscription(accountId, id);
        expect(await SSS.accountSubscriptionCount(accountId + 1n)).to.equal(1n);
        expect(await SSS.accountSubscriptionAt(accountId + 1n, 0n)).to.equal(id);
        expect(await SSS.accountSubscriptionCount(accountId)).to.equal(2n);
        expect([await SSS.accountSubscriptionAt(accountId, 0n), await SSS.accountSubscriptionAt(accountId, 1n)]).to.deep.equal([
          id,
          id,
        ]);
        await expect(SSS.connect(logic).appendAccountSubscription(accountId, unknown))
          .to.be.revertedWithCustomError(SSS, 'SubscriptionNotFound')
          .withArgs(unknown);
        expect(await SSS.accountSubscriptionCount(accountId)).to.equal(2n);
      });
    });
  });

  describe('storage layout', () => {
    type LayoutEntry = { label: string; slot: string; offset: number; type: string };
    type LayoutType = { label: string; numberOfBytes: string; members?: LayoutEntry[] };
    type StorageLayout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };

    it('matches the documented layout: slot 0 packs the hub with the budget bound, the mappings keep slots 1 to 6 and 13 to 15, and slot 16 the ends of replaced grants', async () => {
      const sourceName = 'contracts/storage/ServiceSubscriptionsStorage.sol';
      const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:ServiceSubscriptionsStorage`);
      const output = buildInfo?.output.contracts[sourceName]?.ServiceSubscriptionsStorage as
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
        ['0', 20, 'maxBudgetsPerSubscription', 'uint8'],
        ['1', 0, '_serviceSpending', 'mapping(uint256 => struct ServiceSubscriptionsStorage.ServiceSpending)'],
        ['2', 0, 'grantNonce', 'mapping(uint256 => uint64)'],
        [
          '3',
          0,
          '_grants',
          'mapping(uint256 => mapping(address => struct ServiceSubscriptionsStorage.BuyerGrant))',
        ],
        ['4', 0, '_usage', 'mapping(uint256 => mapping(address => struct ServiceSubscriptionsStorage.Usage))'],
        ['5', 0, '_buyers', 'mapping(uint256 => address[])'],
        ['6', 0, '_listed', 'mapping(uint256 => mapping(address => bool))'],
        // Slots 7 to 12 held the 1.1.0 labels; they stay empty.
        ['7', 0, '_retiredLabelSlots', 'uint256[6]'],
        ['13', 0, '_subscriptions', 'mapping(bytes32 => struct ServiceSubscriptionsStorage.Subscription)'],
        ['14', 0, '_budgets', 'mapping(bytes32 => struct ServiceSubscriptionsStorage.ServiceBudget[])'],
        ['15', 0, '_accountSubscriptions', 'mapping(uint256 => bytes32[])'],
        [
          '16',
          0,
          '_replacedGrantEnd',
          'mapping(uint256 => mapping(address => mapping(uint64 => uint40)))',
        ],
      ]);

      // A subscription record takes 7 slots: the nonce of its grant shares the
      // buyer's, and its epoch the session key's.
      const subscription = Object.values(layout!.types).find(
        (t) => t.label === 'struct ServiceSubscriptionsStorage.Subscription',
      )!;
      expect(subscription.numberOfBytes).to.equal(String(7 * 32));
      const member = (label: string) => subscription.members!.find((m) => m.label === label)!;
      expect([member('buyer').slot, member('buyer').offset]).to.deep.equal(['1', 0]);
      expect([member('grantNonce').slot, member('grantNonce').offset]).to.deep.equal(['1', 20]);
      expect(member('sessionKey').slot).to.equal('2');

      // Slot 0 uses 21 of its 32 bytes, and the retired slots are 6 words.
      const maxBudgets = layout!.storage.find((s) => s.label === 'maxBudgetsPerSubscription')!;
      expect(maxBudgets.offset + Number(layout!.types[maxBudgets.type].numberOfBytes)).to.equal(21);
      const retired = layout!.storage.find((s) => s.label === '_retiredLabelSlots')!;
      expect(layout!.types[retired.type].numberOfBytes).to.equal(String(6 * 32));

      // An BuyerGrant takes 2 slots, its consenting owner beside its nonce in
      // the second; an opt-in and a Usage take 1 each.
      const structOf = (label: string) =>
        Object.values(layout!.types).find((t) => t.label === `struct ServiceSubscriptionsStorage.${label}`)!;
      expect(structOf('BuyerGrant').numberOfBytes).to.equal('64');
      expect(
        structOf('BuyerGrant').members!.filter((m) => ['nonce', 'owner'].includes(m.label)).map((m) => [m.label, m.slot, m.offset]),
      ).to.deep.equal([
        ['nonce', '1', 0],
        ['owner', '1', 8],
      ]);
      expect(structOf('ServiceSpending').numberOfBytes).to.equal('32');
      expect(structOf('Usage').numberOfBytes).to.equal('32');
    });
  });
});
