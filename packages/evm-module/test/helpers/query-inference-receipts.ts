// The stack the query/inference receipt suites (OT-RFC-27) run on, and the
// helpers they share: QueryInferenceSettlement on the real account and
// staking stacks, with wallet and Conviction Account subscriptions, Core Node
// sellers and session keys that sign requests. Each suite wraps the deploy in
// a fixture function of its own, so loadFixture keeps a snapshot per suite,
// and its beforeEach builds the helpers from that fixture.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers } from 'ethers';

import { DAY, Domain, TRAC } from './conviction-service';
import {
  Receipt,
  ReceiptGroup,
  ReceiptItem,
  ServiceRequest,
  SettlementStack,
  createNode,
  deploySettlementStack,
  fullReceipt,
  itemOf,
  requestDigestOf,
  scoreNode,
  signCompact,
} from './query-inference';

export const SELLER_STAKE = 500_000n * TRAC; // a tenth of the 5M cap: S = sqrt(0.1)
export const PRICE = 10n ** 9n;
export const CAP = 10n ** 12n; // the budgets' price cap

export const deployReceiptsStack = deploySettlementStack;

export type ReceiptsStack = SettlementStack;
export type Seller = { identityId: bigint; operational: SignerWithAddress; admin: SignerWithAddress };

/**
 * What the helpers read: the fixture and the EIP-712 domain of requests; `key`
 * is the buyer's session key.
 */
export type ReceiptsContext = { f: ReceiptsStack; domain: Domain; key: ethers.HDNodeWallet };

export type ReceiptsHelpers = ReturnType<typeof receiptsHelpers>;

export function receiptsHelpers({ f, domain, key }: ReceiptsContext) {
  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);

  async function seller(index: number, stake: bigint): Promise<Seller> {
    const operational = f.accounts[index];
    const admin = f.accounts[index + 1];
    const identityId = await createNode({ ...f, operational, admin, stake });
    return { identityId, operational, admin };
  }

  /** A batch from `by`, given a node score in the current epoch first, as a batch needs one. */
  const submit = async (by: Seller, groups: ReceiptGroup[]) => {
    const epoch = await epochNow();
    if ((await f.RSS.getNodeEpochScore(epoch, by.identityId)) === 0n) await scoreNode(f.RSS, epoch, by.identityId);
    return f.QS.connect(by.operational).submitReceiptBatch(groups);
  };
  const accept = async (by: Seller, groups: ReceiptGroup[]) => (await (await submit(by, groups)).wait())!;

  /**
   * A batch from `by` in the block at `timestamp`, given a node score in that
   * block's epoch first if it has none, so the score's own transactions take
   * earlier blocks. `submit` reads the epoch of the latest block, so after a
   * block time set ahead it would score in the block meant for the batch, or in
   * the epoch before the batch's.
   */
  const submitAt = async (timestamp: bigint, by: Seller, groups: ReceiptGroup[]) => {
    const epoch = await f.Chronos.epochAtTimestamp(timestamp);
    if ((await f.RSS.getNodeEpochScore(epoch, by.identityId)) === 0n) await scoreNode(f.RSS, epoch, by.identityId);
    await time.setNextBlockTimestamp(timestamp);
    return f.QS.connect(by.operational).submitReceiptBatch(groups);
  };
  const acceptAt = async (timestamp: bigint, by: Seller, groups: ReceiptGroup[]) =>
    (await (await submitAt(timestamp, by, groups)).wait())!;

  /** One request for `by` on a subscription's budget, with `overrides`, and its full receipt. */
  const requestFor = async (
    subscriptionId: string,
    budgetIndex: number,
    by: Seller,
    overrides: Partial<ServiceRequest> = {},
  ): Promise<ServiceRequest> => {
    const b = await f.SSS.getBudget(subscriptionId, budgetIndex);
    const issuedAt = overrides.issuedAt ?? (await latest());
    return {
      subscriptionId,
      serviceId: b.serviceId,
      seller: by.identityId,
      nonce: 100n,
      pricePerUnit: PRICE,
      maxUnits: 1_000n,
      maxValueWei: 1_000n * PRICE,
      issuedAt,
      expiry: issuedAt + DAY,
      ...overrides,
    };
  };

  /** An item claiming `r`, signed by `wallet`, with `receipt` overrides. */
  const itemFor = (r: ServiceRequest, receipt: Partial<Receipt> = {}, wallet = key): ReceiptItem =>
    itemOf(r, fullReceipt(r, receipt), signCompact(wallet, requestDigestOf(domain, r)));

  return { latest, epochNow, epochStart, seller, submit, accept, submitAt, acceptAt, requestFor, itemFor };
}
