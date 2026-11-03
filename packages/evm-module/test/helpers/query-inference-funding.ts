// The stack the plan-period funding suites of the query/inference pool
// (OT-RFC-27) run on, and the helpers they share: QueryInferenceStorage,
// ConvictionServiceStorage, ServiceSubscriptions and
// ServiceSubscriptionsWallet registered in the Hub, on the real account
// stack. Each suite wraps the deploy in a fixture function of its own, so
// loadFixture keeps a snapshot per suite, and its beforeEach fills the
// context its helpers read.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  PublishingConviction,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  bucket,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
} from './conviction-service';

export const COMMITTED = 100_000n * TRAC + 11n; // the 30 % tier
export const COMMITTED_TIER_BPS = 3_000n; // that tier's discount, in basis points

export type FundingStack = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Params: ParametersStorage;
  Vault: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  QIS: QueryInferenceStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
  SSW: ServiceSubscriptionsWallet;
};

export async function deployFundingStack(): Promise<FundingStack> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS, SSW } = await registerServiceContracts(Hub, { wallet: true });
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    QIS,
    CSS,
    SS,
    SSW: SSW!,
  };
}

/**
 * What the helpers read, which a suite's beforeEach sets for each test: the
 * fixture, the account owner and the buyer key assigned by default.
 */
export type FundingContext = { f: FundingStack; owner: SignerWithAddress; buyer: SignerWithAddress };

export function fundingHelpers(ctx: FundingContext) {
  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => ctx.f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => ctx.f.Chronos.timestampForEpoch(e);

  /** An opted-in account of `owner` with `assignee` assigned, under a per-period limit. */
  const openAccount = async (opts: { limit?: bigint; assignee?: SignerWithAddress; committed?: bigint } = {}) => {
    const committed = opts.committed ?? COMMITTED;
    await ctx.f.Token.mint(ctx.owner.address, committed);
    await ctx.f.Token.connect(ctx.owner).approve(await ctx.f.NFT.getAddress(), committed);
    await (await ctx.f.NFT.connect(ctx.owner).createAccount(committed, 0)).wait();
    const accountId = await ctx.f.NFT.totalSupply();
    await ctx.f.SS.connect(ctx.owner).setServiceSpending(accountId, true);
    await assign(accountId, opts.assignee ?? ctx.buyer, opts.limit ?? 1_000n * TRAC);
    return accountId;
  };

  const assign = async (accountId: bigint, assignee: SignerWithAddress, limit: bigint) => {
    const terms: Terms = {
      accountId,
      assignee: assignee.address,
      maxCostPerPeriod: limit,
      expiresAt: (await latest()) + 400n * DAY,
      nonce: await ctx.f.CSS.assignmentNonce(accountId),
    };
    await ctx.f.SS.connect(ctx.owner).assign(terms, '0x', await signTerms(assignee, ctx.f.SS, terms));
    return terms;
  };

  const caFund = async (accountId: bigint, epoch: bigint, value: bigint, sender: SignerWithAddress = ctx.buyer) => {
    const r = requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, value)] });
    const receipt = (await (await ctx.f.SS.connect(sender).fundFromConviction(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, epoch), receipt, r };
  };

  return { latest, epochNow, epochStart, openAccount, assign, caFund };
}
