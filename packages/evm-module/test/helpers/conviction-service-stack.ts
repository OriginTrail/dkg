// The stack the Conviction Account service suites (OT-RFC-27) run on, and the
// helpers they share: QueryInferenceStorage, ConvictionServiceStorage and
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
  bucket,
  registerServiceContracts,
  requestOf,
  signTerms,
} from './conviction-service';

// The 30 % tier, with `committed mod lock` dust.
export const COMMITTED = 100_000n * TRAC + 11n;

export async function deployServiceStack() {
  const stack = await deployAccountStack();
  const { QIS, CSS, SS } = await registerServiceContracts(stack.Hub);
  return {
    ...stack,
    QIS,
    CSS,
    SS,
    KAL: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
  };
}

export type ServiceStack = Awaited<ReturnType<typeof deployServiceStack>>;

/**
 * What the helpers read: the fixture, the account owner and the buyer key
 * assigned by default, the epoch length and the lock of an account.
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

  const termsFor = async (accountId: bigint, assignee: string, overrides: Partial<Terms> = {}): Promise<Terms> => ({
    accountId,
    assignee,
    maxCostPerPeriod: 1_000n * TRAC,
    expiresAt: (await latest()) + 400n * DAY,
    nonce: await f.CSS.assignmentNonce(accountId),
    ...overrides,
  });

  /** An opted-in account of `holder` with `assignee` assigned by the holder, which sends. */
  const openAccount = async (
    opts: { committed?: bigint; caps?: Partial<Terms>; holder?: SignerWithAddress; assignee?: SignerWithAddress } = {},
  ) => {
    const holder = opts.holder ?? owner;
    const assignee = opts.assignee ?? buyer;
    const { accountId, createdAt } = await createAccountFor(holder, opts.committed ?? COMMITTED);
    await f.SS.connect(holder).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId, assignee.address, opts.caps);
    await f.SS.connect(holder).assign(terms, '0x', await signTerms(assignee, f.SS, terms));
    return { accountId, createdAt, terms };
  };

  const assignAs = async (terms: Terms, assignee: SignerWithAddress, sender: SignerWithAddress = owner) =>
    f.SS.connect(sender).assign(terms, '0x', await signTerms(assignee, f.SS, terms));

  const fund = async (r: Request, sender: SignerWithAddress = buyer) => {
    const [subscriptionId, cost] = await f.SS.connect(sender).fundFromConviction.staticCall(r);
    const receipt = (await (await f.SS.connect(sender).fundFromConviction(r)).wait())!;
    return { subscriptionId, cost, receipt };
  };

  /** The current epoch, and the next one: the two a period may be funded for. */
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochNext = async () => (await epochNow()) + 1n;

  /** A one-bucket inference request, for the current epoch unless `overrides.epoch` names another. */
  const inference = async (accountId: bigint, value: bigint, overrides: Partial<Request> = {}) =>
    requestOf(accountId, overrides.epoch ?? (await epochNow()), {
      buckets: [bucket(0, CLASS_INFERENCE, value)],
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
  const fundingState = async (accountId: bigint, assignee: string, window: bigint) => {
    const u = await f.CSS.getUsage(accountId, assignee);
    const now = await f.Chronos.getCurrentEpoch();
    return {
      windowSpent: await f.PCS.windowSpent(accountId, window),
      topUpBalance: await f.PCS.topUpBalance(accountId),
      funded: [await f.QIS.convictionFunding(now), await f.QIS.convictionFunding(now + 1n)],
      usage: [u.periods],
      periods: await f.CSS.accountSubscriptionCount(accountId),
    };
  };

  return {
    latest,
    createAccountFor,
    topUp,
    termsFor,
    openAccount,
    assignAs,
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
