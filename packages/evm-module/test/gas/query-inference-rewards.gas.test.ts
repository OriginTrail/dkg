// Gas of a StakingV10 claim per claimed epoch, with and without the
// query/inference pool (OT-RFC-27), on the development deploy of the staking,
// account and plan-period stacks. Every case claims the same position over 1
// and over 4 epochs; in each epoch the node proves, takes the publishing
// pool and, with the pool, finalizes receipt value from a wallet-funded
// period. The claim is the first on the node in each epoch, so it splits off
// the operator fee there.
//
// The cases:
//   - no pool: the Hub holds no settlement, so StakingV10 wires none;
//   - pool not active: the settlement is wired, its activation epoch unset;
//   - pool, closed by the claim: the claim's ensureClosed closes the epochs;
//   - pool, closed before: closeEpochs closed them, so the claim only reads.
// "per epoch" is the cost of each epoch past the first: (4 epochs − 1 epoch) / 3.
// None has a target; each is held to succeeding within the test network's
// per-transaction gas.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  Profile,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  RandomSamplingStorage,
  ServiceSubscriptionsWallet,
  StakingV10,
  Token,
} from '../../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  Domain,
  TRAC,
  bucket,
  subscriptionIdOf,
  walletRequestOf,
} from '../helpers/conviction-service';
import { SCALE18, hardhatWallet, queryInferenceDomain, signedItems } from '../helpers/query-inference';

const UNIT_ASK = 10n ** 15n;
const TX_GAS_LIMIT = 15_000_000n; // hardhat.node.config.ts, networks.hardhat.gas

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  await hre.deployments.fixture([...ACCOUNT_STACK_TAGS, 'ServiceSubscriptions', 'QueryInferenceSettlement']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const at = async <T>(name: string) => (await hre.ethers.getContractAt(name, await Hub.getContractAddress(name))) as T;
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    CSS: await at<ConvictionServiceStorage>('ConvictionServiceStorage'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
  };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;
type Mode = 'no pool' | 'pool not active' | 'pool, closed by the claim' | 'pool, closed before';

describe('@gas StakingV10 claims with and without the query/inference pool', function () {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let f: Fixture;
  let domain: Domain;
  const key = hardhatWallet(60);
  const measured = new Map<Mode, [bigint, bigint]>();

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
  });

  after(() => {
    console.table(
      [...measured.entries()].map(([mode, [one, four]]) => ({
        case: mode,
        '1 epoch': Number(one),
        '4 epochs': Number(four),
        'per epoch': Number((four - one) / 3n),
      })),
    );
  });

  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));
  const latest = async () => BigInt(await time.latest());
  const toEpoch = async (e: bigint) => time.increaseTo(await f.Chronos.timestampForEpoch(e));

  const delegate = async (staker: SignerWithAddress, identityId: bigint, amount: bigint) => {
    await f.Token.mint(staker.address, amount);
    await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), amount);
    await f.StakingNFT.connect(staker).createConviction(identityId, amount, 0n);
    return f.StakingNFT.nextTokenId();
  };

  /** Claim one position over `epochs` epochs in `mode`; returns the claim's gas. */
  const claimGas = async (mode: Mode, epochs: bigint): Promise<bigint> => {
    if (mode === 'no pool') {
      await f.Hub.removeContractByName('QueryInferenceSettlement');
      await forward(f.StakingV10, 'initialize');
      expect(await f.StakingV10.queryInferenceSettlement()).to.equal(hre.ethers.ZeroAddress);
    } else if (mode === 'pool not active') {
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      for (const c of [f.QS, f.StakingV10]) await forward(c, 'initialize');
      expect(await fresh.activationEpoch()).to.equal(0n);
    }
    const withPool = mode === 'pool, closed by the claim' || mode === 'pool, closed before';

    const [operational, admin, delegator, buyer] = [f.accounts[30], f.accounts[31], f.accounts[10], f.accounts[20]];
    const label = 'gas seller';
    const receipt = await (
      await f.Profile.connect(operational).createProfile(
        admin.address,
        [],
        label,
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label)),
        1_000n,
      )
    ).wait();
    const node = BigInt(receipt!.logs[0].topics[1]);
    await delegate(operational, node, 1_250_000n * TRAC);
    const tokenId = await delegate(delegator, node, 250_000n * TRAC);

    const a = await f.Chronos.getCurrentEpoch();
    for (let e = a; e < a + epochs; e++) {
      if (withPool) {
        await f.Token.mint(buyer.address, 40n * TRAC);
        await f.Token.connect(buyer).approve(await f.SSW.getAddress(), 40n * TRAC);
        await f.SSW.connect(buyer).fundFromWallet(
          walletRequestOf(e, { buckets: [bucket(0, CLASS_INFERENCE, 40n * TRAC, UNIT_ASK)], sessionKey: key.address }),
        );
        const p = subscriptionIdOf(buyer.address, e);
        const { items } = signedItems({
          domain,
          wallet: key,
          subscriptionId: p,
          bucketId: (await f.CSS.getBucket(p, 0n)).bucketId,
          seller: node,
          count: 1,
          units: (8n * TRAC) / UNIT_ASK,
          ask: UNIT_ASK,
          issuedAt: await latest(),
        });
        await f.QS.connect(operational).submitReceiptBatch([{ subscriptionId: p, bucketIndex: 0n, items }]);
        await time.increaseTo(
          (await f.Chronos.timestampForEpoch(e + 1n)) + (await f.QIS.receiptGraceSecondsAt(e)) + 1n,
        );
      } else {
        await toEpoch(e + 1n);
      }
      // Epoch e + 1: proofs, the publishing pool, and the period's value finalized.
      const score = 100n * TRAC;
      await f.RSS.addToNodeEpochScore(e + 1n, node, score);
      await f.RSS.addToAllNodesEpochScore(e + 1n, score);
      await f.RSS.setNodeEpochScorePerStake(e + 1n, node, (score * SCALE18) / (await f.Vault.getNodeEffectiveStake(node)));
      await f.EpochStorage.addTokensToEpochRange(1, e + 1n, e + 1n, 500n * TRAC);
      await f.Token.mint(await f.Vault.getAddress(), 500n * TRAC);
      if (withPool) {
        await f.QS.finalizeClaims([{ subscriptionId: subscriptionIdOf(buyer.address, e), bucketIndex: 0n, seller: node }]);
      }
    }
    await toEpoch(a + epochs + 1n);
    if (mode === 'pool, closed before') await f.QS.closeEpochs(255n);

    const tx = await f.StakingNFT.connect(delegator).claim(tokenId);
    const gas = (await tx.wait())!.gasUsed;
    expect(gas).to.be.lessThan(TX_GAS_LIMIT);
    if (withPool) {
      expect(await f.QIS.closedThrough()).to.equal(a + epochs);
      expect(await f.QS.queryInferenceGross(a + epochs, node)).to.equal(40n * TRAC);
    }
    expect((await f.Vault.getPosition(tokenId)).lastClaimedEpoch).to.equal(a + epochs);
    return gas;
  };

  for (const mode of ['no pool', 'pool not active', 'pool, closed by the claim', 'pool, closed before'] as Mode[]) {
    it(`claims over 1 and 4 epochs: ${mode}`, async () => {
      const one = await claimGas(mode, 1n);
      f = await loadFixture(deployFixture);
      domain = await queryInferenceDomain(f.QIS);
      const four = await claimGas(mode, 4n);
      measured.set(mode, [one, four]);
    });
  }
});
