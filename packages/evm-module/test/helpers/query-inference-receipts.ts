// The stack the query/inference receipt suites (OT-RFC-27) run on, and the
// helpers they share: QueryInferenceSettlement on the real account and
// staking stacks, with wallet and Conviction Account periods, Core Node
// sellers and session keys that sign requests. Each suite wraps the deploy in
// a fixture function of its own, so loadFixture keeps a snapshot per suite,
// and its beforeEach fills the context its helpers read.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../../typechain';
import { ACCOUNT_STACK_TAGS, DAY, Domain, TRAC, registerServiceContracts } from './conviction-service';
import {
  Receipt,
  ReceiptGroup,
  ReceiptItem,
  ServiceRequest,
  createNode,
  fullReceipt,
  itemOf,
  requestDigestOf,
  signCompact,
} from './query-inference';

export const SELLER_STAKE = 500_000n * TRAC; // a tenth of the 5M cap: S = sqrt(0.1)
export const ASK = 10n ** 9n;
export const CAP = 10n ** 12n; // the buckets' price cap

export async function deployReceiptsStack() {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS, SSW, QS } = await registerServiceContracts(Hub, { wallet: true, settlement: true });
  return {
    accounts: await hre.ethers.getSigners(),
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    QIS,
    CSS,
    SS,
    SSW: SSW!,
    QS: QS!,
  };
}

export type ReceiptsStack = Awaited<ReturnType<typeof deployReceiptsStack>>;
export type Seller = { identityId: bigint; operational: SignerWithAddress; admin: SignerWithAddress };

/**
 * What the helpers read, which a suite's beforeEach sets for each test: the
 * fixture and the EIP-712 domain of requests; `key` is the buyer's session
 * key.
 */
export type ReceiptsContext = { f: ReceiptsStack; domain: Domain; key: ethers.HDNodeWallet };

export function receiptsHelpers(ctx: ReceiptsContext) {
  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => ctx.f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => ctx.f.Chronos.timestampForEpoch(e);

  async function seller(index: number, stake: bigint): Promise<Seller> {
    const operational = ctx.f.accounts[index];
    const admin = ctx.f.accounts[index + 1];
    const identityId = await createNode({ ...ctx.f, operational, admin, stake });
    return { identityId, operational, admin };
  }

  const submit = (by: Seller, groups: ReceiptGroup[]) => ctx.f.QS.connect(by.operational).submitReceiptBatch(groups);
  const accept = async (by: Seller, groups: ReceiptGroup[]) => (await (await submit(by, groups)).wait())!;

  /** One request for `by` on a period's bucket, with `overrides`, and its full receipt. */
  const requestFor = async (
    subscriptionId: string,
    bucketIndex: number,
    by: Seller,
    overrides: Partial<ServiceRequest> = {},
  ): Promise<ServiceRequest> => {
    const b = await ctx.f.CSS.getBucket(subscriptionId, bucketIndex);
    const issuedAt = overrides.issuedAt ?? (await latest());
    return {
      subscriptionId,
      bucketId: b.bucketId,
      seller: by.identityId,
      nonce: 100n,
      acceptedAskWeiPerUnit: ASK,
      maxUnits: 1_000n,
      maxValueWei: 1_000n * ASK,
      issuedAt,
      expiry: issuedAt + DAY,
      ...overrides,
    };
  };

  /** An item claiming `r`, signed by `wallet`, with `receipt` overrides. */
  const itemFor = (r: ServiceRequest, receipt: Partial<Receipt> = {}, wallet = ctx.key): ReceiptItem =>
    itemOf(r, fullReceipt(r, receipt), signCompact(wallet, requestDigestOf(ctx.domain, r)));

  return { latest, epochNow, epochStart, seller, submit, accept, requestFor, itemFor };
}
