// Gas of plan-period funding (OT-RFC-27) on the real account stack: wallet
// fundings and top-ups, and a Conviction Account top-up. Each case is measured
// and printed for review; none has a target yet, so the test holds each
// transaction to succeeding only. The Conviction Account fundings themselves
// are measured, against their targets, in conviction-service.gas.test.ts.
//
// "First" is the first such transaction on a fresh chain, so every slot it
// writes goes from zero to non-zero: the period record, its bucket, account
// 0's period list and the epoch's due amount. "Another" is a second buyer key's
// period for the same epoch, whose list and due amount already exist.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  TRAC,
  Terms,
  bucket,
  registerServiceContracts,
  requestOf,
  setExactScheduleFrom,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from '../helpers/conviction-service';

async function deployFixture() {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { CSS, SS, SSW } = await registerServiceContracts(Hub, { wallet: true });
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    CSS,
    SS,
    SSW: SSW!,
  };
}

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

describe('@gas Plan-period funding', () => {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let NFT: DKGPublishingConvictionNFT;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let SSW: ServiceSubscriptionsWallet;
  const measured: Array<[string, bigint]> = [];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, Token, Chronos: ChronosContract, NFT, CSS, SS, SSW } = await loadFixture(
      deployFixture,
    ));
  });

  after(() => {
    console.table(measured.map(([name, gas]) => ({ case: name, gas: Number(gas) })));
  });

  const record = (name: string, receipt: ContractTransactionReceipt) => measured.push([name, receipt.gasUsed]);

  const allow = async (who: SignerWithAddress, amount: bigint) =>
    Token.connect(who).approve(await SSW.getAddress(), amount);

  const walletFund = async (buyer: SignerWithAddress, buckets = [bucket(0, CLASS_INFERENCE, 10n * TRAC)]) => {
    const epoch = await ChronosContract.getCurrentEpoch();
    await allow(buyer, buckets.reduce((a, b) => a + b.value, 0n));
    const receipt = (await (await SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { buckets }))).wait())!;
    return { receipt, subscriptionId: subscriptionIdOf(buyer.address, epoch) };
  };

  it('fundFromWallet, one bucket: the first, and another buyer key for the same epoch', async () => {
    record('fundFromWallet, one bucket, first', (await walletFund(accounts[21])).receipt);
    record('fundFromWallet, one bucket, another buyer key', (await walletFund(accounts[22])).receipt);
  });

  it('fundFromWallet, four buckets', async () => {
    const buckets = [0, 1, 2, 3].map((i) => bucket(i, i % 2 === 0 ? CLASS_INFERENCE : CLASS_QUERY, 5n * TRAC));
    await walletFund(accounts[22]);
    record('fundFromWallet, four buckets, another buyer key', (await walletFund(accounts[21], buckets)).receipt);
  });

  it('topUpFromWallet: one stored bucket, and one new bucket', async () => {
    const buyer = accounts[21];
    const { subscriptionId } = await walletFund(buyer);
    await allow(buyer, 10n * TRAC);
    const topUp = (await (
      await SSW.connect(buyer).topUpFromWallet(subscriptionId, [bucket(0, CLASS_INFERENCE, 5n * TRAC)], ethers.id('p2'))
    ).wait())!;
    record('topUpFromWallet, one stored bucket', topUp);
    const upgrade = (await (
      await SSW.connect(buyer).topUpFromWallet(subscriptionId, [bucket(5, CLASS_QUERY, 5n * TRAC)], ethers.id('p3'))
    ).wait())!;
    record('topUpFromWallet, one new bucket', upgrade);
  });

  it('topUpFromConviction, one stored bucket, base only', async () => {
    const owner = accounts[20];
    const buyer = accounts[21];
    await setExactScheduleFrom(HubContract, CSS);
    const committed = 100_000n * TRAC + 11n;
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    await NFT.connect(owner).createAccount(committed, 0);
    const accountId = await NFT.totalSupply();
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms: Terms = {
      accountId,
      assignee: buyer.address,
      maxCostPerPeriod: 50_000n * TRAC,
      expiresAt: BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp) + 400n * DAY,
      nonce: await CSS.assignmentNonce(accountId),
    };
    await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms));
    const epoch = await ChronosContract.getCurrentEpoch();
    await SS.connect(buyer).fundFromConviction(requestOf(accountId, epoch));
    const receipt = (await (
      await SS.connect(buyer).topUpFromConviction(
        subscriptionIdOf(buyer.address, epoch),
        [bucket(0, CLASS_INFERENCE, 5n * TRAC)],
        ethers.id('p2'),
      )
    ).wait())!;
    record('topUpFromConviction, one stored bucket, base only', receipt);
  });
});
