// Per-account conservation of a Conviction Account over a whole lock
// (OT-RFC-27, PublishingConviction 10.2.0, ServiceSubscriptions 1.2.0), as a
// property test: seeded random sequences of publishes, plan-period fundings
// and their top-ups, account top-ups, settles and time jumps, through the
// lock's end and its final sweep.
//
// Only the account under test books anything in a run, so every credit of the
// run's transactions is its own. At the end:
//
//   staker-pool credits + conviction due + fees == committed + top-ups
//
// where the staker-pool credits are EpochStorage's shard-1 credits (publishing
// draws, window bookings and the top-up tail), the conviction due is
// QueryInferenceStorage's ledger over the run's epochs, and the fees are the
// treasury shard's credits plus the TRAC the treasury received. The vault keeps
// everything but those received fees. For an account an older build created,
// what that build had already booked for its windows counts on the left.
//
// Along the way, while the lock is live, the booking cursor stays at the
// current window, below the lock, so the account always pays at use time.
//
// The runs: services and publishing with no treasury (two seeds); publishing
// only, with a treasury wired, so every fee term is live; services and
// publishing until a treasury is wired halfway through the lock, after which
// services stop and every booking carries its fee; and an account a build
// older than 10.0.8 created, with a window already spent.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  QueryInferenceStorage,
  ServiceSubscriptions,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  bucket,
  costOf,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
  valueFor,
  writeLegacyAccount,
} from './helpers/conviction-service';

const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;
const BUYER_KEYS = 6;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  Vault: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  QIS: QueryInferenceStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS } = await registerServiceContracts(Hub);
  await Hub.setContractAddress('KnowledgeAssetsLifecycle', accounts[5].address);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    QIS,
    CSS,
    SS,
  };
}

/** A small seeded PRNG (mulberry32), so every sequence replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pseudo-random amount in [0, max), with arbitrary low digits. */
const fractionOf = (rand: () => number, max: bigint): bigint =>
  max <= 0n ? 0n : (max * BigInt(Math.floor(rand() * 1_000_000_007))) / 1_000_000_007n;

type Run = {
  seed: number;
  services: boolean;
  treasury: boolean;
  /** Wire the treasury once half the lock has passed. */
  midway?: boolean;
  legacy: boolean;
};

describe('@integration Conviction Account conservation over a whole lock (PublishingConviction 10.2.0)', function () {
  let f: Fixture;
  let epLen: bigint;
  let lock: bigint;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    epLen = await f.Chronos.epochLength();
    lock = await f.Params.publishingConvictionEpochs();
  });

  const runs: Run[] = [
    { seed: 1, services: true, treasury: false, legacy: false },
    { seed: 2, services: true, treasury: false, legacy: false },
    { seed: 3, services: false, treasury: true, legacy: false },
    { seed: 5, services: true, treasury: false, midway: true, legacy: false },
    { seed: 4, services: true, treasury: false, legacy: true },
  ];

  for (const run of runs) {
    const what = [
      run.services ? 'publishing and services' : 'publishing only',
      run.treasury ? 'with a treasury wired' : run.midway ? 'a treasury wired halfway' : 'no treasury',
      run.legacy ? 'an account an older build created' : 'a new account',
    ].join(', ');

    it(`seed ${run.seed}: ${what}`, async () => {
      const rand = prng(run.seed);
      const owner = f.accounts[20];
      const agent = f.accounts[21];
      const kal = f.accounts[5];
      const treasury = f.accounts[9];
      const buyers = f.accounts.slice(40, 40 + BUYER_KEYS);
      const receipts: ContractTransactionReceipt[] = [];
      const send = async (tx: Promise<ContractTransactionResponse>) => {
        const receipt = (await (await tx).wait())!;
        receipts.push(receipt);
        return receipt;
      };

      if (run.treasury) await f.Params.setProtocolTreasury(treasury.address);
      let treasuryLive = run.treasury;
      const treasuryBefore = await f.Token.balanceOf(treasury.address);
      const vaultBefore = await f.Token.balanceOf(await f.Vault.getAddress());
      const startEpoch = await f.Chronos.getCurrentEpoch();

      // The account: committed at a random tier, with arbitrary low digits.
      const committed = 20_000n * TRAC + fractionOf(rand, 280_000n * TRAC);
      let accountId: bigint;
      let alreadyBooked = 0n;
      let fundedByRun = committed;
      if (run.legacy) {
        // Created by a build older than 10.0.8 half a window ago, with part of
        // window 0 spent and booked by that build; its TRAC is in the vault.
        accountId = 9_000n;
        await time.increase(2n * epLen);
        const spent0 = fractionOf(rand, committed / lock);
        await writeLegacyAccount({
          pcs: f.PCS,
          nft: f.NFT,
          chronosEpochAt: (ts) => f.Chronos.epochAtTimestamp(ts),
          accountId,
          owner: owner.address,
          committed,
          createdAt: BigInt(await time.latest()) - epLen / 2n,
          lock,
          epLen,
          discountBps: 3_000n,
          spent: new Map([[0n, spent0]]),
        });
        alreadyBooked = spent0;
        fundedByRun = 0n;
        await f.Token.mint(await f.Vault.getAddress(), committed);
      } else {
        await f.Token.mint(owner.address, committed);
        await f.Token.connect(owner).approve(await f.NFT.getAddress(), committed);
        await send(f.NFT.connect(owner).createAccount(committed, 0));
        accountId = await f.NFT.totalSupply();
      }
      await f.NFT.connect(owner).registerAgent(accountId, agent.address);
      const acct = await f.PCS.getAccount(accountId);
      const bps = acct.discountBps;

      const assigned = new Set<string>();
      const funded = new Map<string, bigint>(); // `${buyer}:${epoch}` => epoch
      if (run.services) await f.SS.connect(owner).setServiceSpending(accountId, true);
      const assign = async (buyer: SignerWithAddress) => {
        if (assigned.has(buyer.address)) return;
        const terms: Terms = {
          accountId,
          assignee: buyer.address,
          maxCostPerPeriod: 1n << 95n,
          expiresAt: BigInt(await time.latest()) + 900n * DAY,
          nonce: await f.CSS.assignmentNonce(accountId),
        };
        await f.SS.connect(owner).assign(terms, '0x', await signTerms(buyer, f.SS, terms));
        assigned.add(buyer.address);
      };

      let topUps = 0n;
      const counts = { publishes: 0, fundings: 0, periodTopUps: 0, accountTopUps: 0, settles: 0 };

      while (BigInt(await time.latest()) + 2n < acct.expiresAtTimestamp) {
        const [window, baseRemaining, topUpBuffer] = await f.SS.currentWindowAllowance(accountId);
        const available = baseRemaining + topUpBuffer;
        const action = rand();
        if (run.midway && !treasuryLive && window >= lock / 2n) {
          await f.Params.setProtocolTreasury(treasury.address);
          treasuryLive = true;
        }
        const services = run.services && !treasuryLive;

        if (action < 0.3 && available > 0n) {
          // A publish of up to what is left, over a random KA lifetime.
          const cost = 1n + fractionOf(rand, available);
          await send(
            f.NFT.connect(kal).coverPublishingCost(
              agent.address,
              valueFor(cost, bps),
              await f.Chronos.getCurrentEpoch(),
              1n + BigInt(Math.floor(rand() * Number(lock))),
            ),
          );
          counts.publishes++;
        } else if (action < 0.55 && services && available > 0n) {
          // A plan period of the current epoch or the next, by a buyer key
          // that has not funded it yet.
          const now = await f.Chronos.getCurrentEpoch();
          const epoch = rand() < 0.7 ? now : now + 1n;
          const buyer = buyers.find((b) => !funded.has(`${b.address}:${epoch}`));
          if (buyer) {
            await assign(buyer);
            const cost = 1n + fractionOf(rand, available);
            await send(
              f.SS.connect(buyer).fundFromConviction(
                requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, valueFor(cost, bps))] }),
              ),
            );
            funded.set(`${buyer.address}:${epoch}`, epoch);
            counts.fundings++;
          }
        } else if (action < 0.65 && services && available > 0n) {
          // A top-up of a period that has not ended.
          const now = await f.Chronos.getCurrentEpoch();
          const open = [...funded.entries()].find(([, e]) => e >= now);
          if (open) {
            const [key, epoch] = open;
            const buyer = buyers.find((b) => key.startsWith(b.address))!;
            const cost = 1n + fractionOf(rand, available);
            await send(
              f.SS.connect(buyer).topUpFromConviction(
                subscriptionIdOf(buyer.address, epoch),
                [bucket(0, CLASS_INFERENCE, valueFor(cost, bps))],
                hre.ethers.id(`plan-${counts.periodTopUps}`),
              ),
            );
            counts.periodTopUps++;
          }
        } else if (action < 0.75) {
          const amount = 1n + fractionOf(rand, 3_000n * TRAC);
          await f.Token.mint(owner.address, amount);
          await f.Token.connect(owner).approve(await f.NFT.getAddress(), amount);
          await send(f.NFT.connect(owner).topUp(accountId, amount));
          topUps += amount;
          counts.accountTopUps++;
        } else if (action < 0.82) {
          await send(f.PC['settle(uint256)'](accountId));
          counts.settles++;
        } else {
          // A time jump: within the window, across one or two windows, or
          // further, so bookings come on time and late.
          const jump = rand() < 0.15 ? epLen * BigInt(2 + Math.floor(rand() * 2)) : fractionOf(rand, epLen);
          const to = BigInt(await time.latest()) + jump;
          if (to + 2n < acct.expiresAtTimestamp) await time.increaseTo(to);
          else break;
        }

        // While live, the cursor never passes the current window.
        const cursor = (await f.PCS.getAccount(accountId)).lastSettledWindow;
        expect(cursor <= window && cursor < lock, `cursor ${cursor} in window ${window}`).to.equal(true);
      }

      // The end of the lock: the final sweep books the windows left and the
      // top-up tail; a second settle is a no-op.
      await time.increaseTo(acct.expiresAtTimestamp + 1n);
      await send(f.PC['settle(uint256)'](accountId));
      const after = await f.PCS.getAccount(accountId);
      expect([after.lastSettledWindow, after.fullySwept]).to.deep.equal([lock, true]);
      expect(await f.PCS.topUpBalance(accountId)).to.equal(0n);
      const noop = await send(f.PC['settle(uint256)'](accountId));
      expect(noop.logs).to.have.length(0);

      // The tally of the run's transactions.
      const esAddress = (await f.ES.getAddress()).toLowerCase();
      let staker = 0n;
      let treasuryShard = 0n;
      for (const receipt of receipts) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== esAddress) continue;
          const parsed = f.ES.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name !== 'TokensAddedToEpochRange') continue;
          if (parsed.args.shardId === STAKER_SHARD_ID) staker += parsed.args.tokenAmount;
          else if (parsed.args.shardId === TREASURY_SHARD_ID) treasuryShard += parsed.args.tokenAmount;
        }
      }
      let due = 0n;
      const endEpoch = (await f.Chronos.getCurrentEpoch()) + 2n;
      for (let e = startEpoch; e <= endEpoch; e++) due += await f.QIS.convictionDue(e);
      const received = (await f.Token.balanceOf(treasury.address)) - treasuryBefore;

      expect(staker + due + treasuryShard + received + alreadyBooked).to.equal(committed + topUps);
      // The vault keeps every wei but the fees the treasury received.
      expect((await f.Token.balanceOf(await f.Vault.getAddress())) - vaultBefore).to.equal(
        (run.legacy ? committed : fundedByRun) + topUps - received,
      );
      if (run.treasury) {
        expect(treasuryShard > 0n && received > 0n).to.equal(true);
        expect(due).to.equal(0n);
      } else if (run.midway) {
        expect(treasuryShard > 0n && received > 0n && due > 0n).to.equal(true);
      } else {
        expect(treasuryShard + received).to.equal(0n);
      }
      if (run.services) expect(due > 0n && counts.fundings > 2).to.equal(true);
      // The run exercised every kind of step.
      expect(counts.publishes > 2 && counts.accountTopUps > 0 && counts.settles > 0, JSON.stringify(counts)).to.equal(
        true,
      );
      // Sanity of the tier: the costs above were discounted.
      expect(costOf(10_000n, bps)).to.equal((10_000n * (10_000n - bps)) / 10_000n);
    });
  }
});
