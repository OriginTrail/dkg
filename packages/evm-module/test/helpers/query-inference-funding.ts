// The stack the subscription funding suites of the query/inference pool
// (OT-RFC-27) run on, and the helpers they share: QueryInferenceStorage,
// ServiceSubscriptionsStorage, ServiceSubscriptions and
// ServiceSubscriptionsWallet registered in the Hub, on the real account
// stack. Each suite wraps the deploy in a fixture function of its own, so
// loadFixture keeps a snapshot per suite, and its beforeEach builds the helpers
// from that fixture.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';

import { deployAccountStack } from './account-stack';
import {
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  budget,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
} from './conviction-service';

export const COMMITTED = 100_000n * TRAC + 11n; // the 30 % tier
export const COMMITTED_TIER_BPS = 3_000n; // that tier's discount, in basis points

export async function deployFundingStack() {
  const stack = await deployAccountStack();
  const { QIS, SSS, SS, SSW } = await registerServiceContracts(stack.Hub, { wallet: true });
  return { ...stack, QIS, SSS, SS, SSW: SSW! };
}

export type FundingStack = Awaited<ReturnType<typeof deployFundingStack>>;

/** What the helpers read: the fixture, the account owner and the buyer added by default. */
export type FundingContext = { f: FundingStack; owner: SignerWithAddress; buyer: SignerWithAddress };

export type FundingHelpers = ReturnType<typeof fundingHelpers>;

export function fundingHelpers({ f, owner, buyer }: FundingContext) {
  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);

  /** An opted-in account of `owner` with `buyer` added, under a per-subscription limit. */
  const openAccount = async (opts: { limit?: bigint; buyer?: SignerWithAddress; committed?: bigint } = {}) => {
    const committed = opts.committed ?? COMMITTED;
    await f.Token.mint(owner.address, committed);
    await f.Token.connect(owner).approve(await f.NFT.getAddress(), committed);
    await (await f.NFT.connect(owner).createAccount(committed, 0)).wait();
    const accountId = await f.NFT.totalSupply();
    await f.SS.connect(owner).setServiceSpending(accountId, true);
    await addBuyer(accountId, opts.buyer ?? buyer, opts.limit ?? 1_000n * TRAC);
    return accountId;
  };

  const addBuyer = async (accountId: bigint, buyer: SignerWithAddress, limit: bigint) => {
    const terms: Terms = {
      accountId,
      buyer: buyer.address,
      maxCostPerEpoch: limit,
      expiresAt: (await latest()) + 400n * DAY,
      nonce: await f.SSS.grantNonce(accountId),
    };
    await f.SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer, f.SS, terms));
    return terms;
  };

  const caFund = async (accountId: bigint, epoch: bigint, value: bigint, sender: SignerWithAddress = buyer) => {
    const r = requestOf(accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, value)] });
    const receipt = (await (await f.SS.connect(sender).fundFromAccount(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, epoch), receipt, r };
  };

  return { latest, epochNow, epochStart, openAccount, addBuyer, caFund };
}
