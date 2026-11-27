// The stack the Conviction Account service suites (OT-RFC-27) run on, and the
// helpers they share: QueryInferenceStorage, ServiceSubscriptionsStorage and
// ServiceSubscriptions registered in the Hub, on the real account stack, with
// KnowledgeAssetsLifecycle and the context graphs for the publishing cases. Each
// suite wraps the deploy in a fixture function of its own, so loadFixture keeps
// a snapshot per suite, and its beforeEach builds the helpers from that fixture.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import { ContextGraphs, ContextGraphStorage, KnowledgeAssetsLifecycle } from '../../typechain';
import { blockTime, deployAccountStack, poolCredits, poolsOver } from './account-stack';
import {
  CLASS_INFERENCE,
  DAY,
  Request,
  TRAC,
  Terms,
  budget,
  registerServiceContracts,
  requestOf,
  signTerms,
} from './conviction-service';

// The 30 % tier, with `committed mod lock` dust.
export const COMMITTED = 100_000n * TRAC + 11n;

export async function deployServiceStack() {
  const stack = await deployAccountStack();
  const { QIS, SSS, SS } = await registerServiceContracts(stack.Hub);
  return {
    ...stack,
    QIS,
    SSS,
    SS,
    KAL: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
  };
}

export type ServiceStack = Awaited<ReturnType<typeof deployServiceStack>>;

/**
 * What the helpers read: the fixture, the account owner and the buyer
 * added by default, the epoch length and the lock of an account.
 */
export type ServiceContext = {
  f: ServiceStack;
  owner: SignerWithAddress;
  buyer: SignerWithAddress;
  epLen: bigint;
  lock: bigint;
};

export type ServiceHelpers = ReturnType<typeof serviceHelpers>;

export function serviceHelpers({ f, owner, buyer, epLen, lock }: ServiceContext) {
  const latest = async () => BigInt(await time.latest());
  const createAccountFor = async (holder: SignerWithAddress = owner, committed: bigint = COMMITTED) => {
    await f.Token.mint(holder.address, committed);
    await f.Token.connect(holder).approve(await f.NFT.getAddress(), committed);
    const receipt = (await (await f.NFT.connect(holder).createAccount(committed, 0)).wait())!;
    return { accountId: await f.NFT.totalSupply(), createdAt: await blockTime(receipt) };
  };

  const topUp = async (accountId: bigint, amount: bigint, holder: SignerWithAddress = owner) => {
    await f.Token.mint(holder.address, amount);
    await f.Token.connect(holder).approve(await f.NFT.getAddress(), amount);
    await f.NFT.connect(holder).topUp(accountId, amount);
  };

  const termsFor = async (accountId: bigint, buyer: string, overrides: Partial<Terms> = {}): Promise<Terms> => ({
    accountId,
    buyer,
    maxCostPerEpoch: 1_000n * TRAC,
    expiresAt: (await latest()) + 400n * DAY,
    nonce: await f.SSS.grantNonce(accountId),
    ...overrides,
  });

  /** An opted-in account of `holder` with `buyer` added by the holder, which sends. */
  const openAccount = async (
    opts: { committed?: bigint; limits?: Partial<Terms>; holder?: SignerWithAddress; buyer?: SignerWithAddress } = {},
  ) => {
    const holder = opts.holder ?? owner;
    const who = opts.buyer ?? buyer;
    const { accountId, createdAt } = await createAccountFor(holder, opts.committed ?? COMMITTED);
    await f.SS.connect(holder).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId, who.address, opts.limits);
    await f.SS.connect(holder).addBuyer(terms, '0x', await signTerms(who, f.SS, terms));
    return { accountId, createdAt, terms };
  };

  const addBuyerAs = async (terms: Terms, buyer: SignerWithAddress, sender: SignerWithAddress = owner) =>
    f.SS.connect(sender).addBuyer(terms, '0x', await signTerms(buyer, f.SS, terms));

  const fund = async (r: Request, sender: SignerWithAddress = buyer) => {
    const [subscriptionId, cost] = await f.SS.connect(sender).fundFromAccount.staticCall(r);
    const receipt = (await (await f.SS.connect(sender).fundFromAccount(r)).wait())!;
    return { subscriptionId, cost, receipt };
  };

  /** The current epoch, and the next one: the two a subscription may be funded for. */
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochNext = async () => (await epochNow()) + 1n;

  /** A one-budget inference request, for the current epoch unless `overrides.epoch` names another. */
  const inference = async (accountId: bigint, value: bigint, overrides: Partial<Request> = {}) =>
    requestOf(accountId, overrides.epoch ?? (await epochNow()), {
      budgets: [budget(0, CLASS_INFERENCE, value)],
      ...overrides,
    });

  const impersonate = async (address: string) => {
    await hre.network.provider.send('hardhat_setBalance', [address, '0x1000000000000000000']);
    return hre.ethers.getImpersonatedSigner(address);
  };

  /** A struct read back from a contract, as a plain object. */
  const plain = (r: unknown) => (r as Result).toObject();

  /** The staker-shard ranges a receipt credited, as [start, end, amount]. */
  const creditedRanges = (receipt: ContractTransactionReceipt) => poolCredits(f.ES, receipt);

  /** The epochs a scheduled account's emission spans, from its first window's close. */
  const spanOf = async (createdAt: bigint) => {
    const first = await f.Chronos.epochAtTimestamp(createdAt + epLen);
    return { first, last: first + 2n * lock - 1n };
  };

  const poolSnapshot = (from: bigint, to: bigint) => poolsOver(f.ES, from, to);

  /** Everything a refused funding must leave as it was. */
  const fundingState = async (accountId: bigint, buyer: string, window: bigint) => {
    const u = await f.SSS.getUsage(accountId, buyer);
    const now = await f.Chronos.getCurrentEpoch();
    return {
      windowSpent: await f.PCS.windowSpent(accountId, window),
      topUpBalance: await f.PCS.topUpBalance(accountId),
      funded: [await f.QIS.accountFunding(now), await f.QIS.accountFunding(now + 1n)],
      usage: [u.subscriptions],
      subscriptions: await f.SSS.accountSubscriptionCount(accountId),
    };
  };

  return {
    latest,
    createAccountFor,
    topUp,
    termsFor,
    openAccount,
    addBuyerAs,
    fund,
    epochNow,
    epochNext,
    inference,
    impersonate,
    plain,
    creditedRanges,
    spanOf,
    poolSnapshot,
    fundingState,
  };
}
