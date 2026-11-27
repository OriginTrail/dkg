// Gas of subscription funding (OT-RFC-27) on the real account stack: wallet
// fundings and top-ups, and a Conviction Account top-up. Each case is measured
// and printed for review; none has a target yet, so the test holds each
// transaction to succeeding only. The Conviction Account fundings themselves
// are measured, against their targets, in conviction-service.gas.test.ts.
//
// "First" is the first such transaction on a fresh chain, so every slot it
// writes goes from zero to non-zero: the subscription record, its budget, account
// 0's subscription list and the epoch's due amount. "Another" is a second buyer's
// subscription for the same epoch, whose list and due amount already exist.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ServiceSubscriptionsStorage,
  DKGPublishingConvictionNFT,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../../typechain';
import { deployAccountStack } from '../helpers/account-stack';
import {
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  TRAC,
  Terms,
  budget,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from '../helpers/conviction-service';

async function deployFixture() {
  const stack = await deployAccountStack();
  const { SSS, SS, SSW } = await registerServiceContracts(stack.Hub, { wallet: true });
  return { ...stack, SSS, SS, SSW: SSW! };
}

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

describe('@gas Subscription funding', () => {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let accounts: SignerWithAddress[];
  let Token: Token;
  let ChronosContract: Chronos;
  let NFT: DKGPublishingConvictionNFT;
  let SSS: ServiceSubscriptionsStorage;
  let SS: ServiceSubscriptions;
  let SSW: ServiceSubscriptionsWallet;
  const measured: Array<[string, bigint]> = [];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Token, Chronos: ChronosContract, NFT, SSS, SS, SSW } = await loadFixture(deployFixture));
  });

  after(() => {
    console.table(measured.map(([name, gas]) => ({ case: name, gas: Number(gas) })));
  });

  const record = (name: string, receipt: ContractTransactionReceipt) => measured.push([name, receipt.gasUsed]);

  const allow = async (who: SignerWithAddress, amount: bigint) =>
    Token.connect(who).approve(await SSW.getAddress(), amount);

  const walletFund = async (buyer: SignerWithAddress, budgets = [budget(0, CLASS_INFERENCE, 10n * TRAC)]) => {
    const epoch = await ChronosContract.getCurrentEpoch();
    await allow(buyer, budgets.reduce((a, b) => a + b.value, 0n));
    const receipt = (await (await SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { budgets }))).wait())!;
    return { receipt, subscriptionId: subscriptionIdOf(buyer.address, epoch) };
  };

  it('fundFromWallet, one budget: the first, and another buyer for the same epoch', async () => {
    record('fundFromWallet, one budget, first', (await walletFund(accounts[21])).receipt);
    record('fundFromWallet, one budget, another buyer', (await walletFund(accounts[22])).receipt);
  });

  it('fundFromWallet, four budgets', async () => {
    const budgets = [0, 1, 2, 3].map((i) => budget(i, i % 2 === 0 ? CLASS_INFERENCE : CLASS_QUERY, 5n * TRAC));
    await walletFund(accounts[22]);
    record('fundFromWallet, four budgets, another buyer', (await walletFund(accounts[21], budgets)).receipt);
  });

  it('topUpFromWallet: one stored budget, and one new budget', async () => {
    const buyer = accounts[21];
    const { subscriptionId } = await walletFund(buyer);
    await allow(buyer, 10n * TRAC);
    const topUp = (await (
      await SSW.connect(buyer).topUpFromWallet(subscriptionId, [budget(0, CLASS_INFERENCE, 5n * TRAC)], ethers.id('p2'))
    ).wait())!;
    record('topUpFromWallet, one stored budget', topUp);
    const upgrade = (await (
      await SSW.connect(buyer).topUpFromWallet(subscriptionId, [budget(5, CLASS_QUERY, 5n * TRAC)], ethers.id('p3'))
    ).wait())!;
    record('topUpFromWallet, one new budget', upgrade);
  });

  it('topUpFromAccount, one stored budget, base only', async () => {
    const owner = accounts[20];
    const buyer = accounts[21];
    const committed = 100_000n * TRAC + 11n;
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    await NFT.connect(owner).createAccount(committed, 0);
    const accountId = await NFT.totalSupply();
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms: Terms = {
      accountId,
      buyer: buyer.address,
      maxCostPerEpoch: 50_000n * TRAC,
      expiresAt: BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp) + 400n * DAY,
      nonce: await SSS.grantNonce(accountId),
    };
    await SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer, SS, terms));
    const epoch = await ChronosContract.getCurrentEpoch();
    await SS.connect(buyer).fundFromAccount(requestOf(accountId, epoch));
    const receipt = (await (
      await SS.connect(buyer).topUpFromAccount(
        subscriptionIdOf(buyer.address, epoch),
        [budget(0, CLASS_INFERENCE, 5n * TRAC)],
        ethers.id('p2'),
      )
    ).wait())!;
    record('topUpFromAccount, one stored budget, base only', receipt);
  });
});
