// The stack the query/inference receipt suites (OT-RFC-27) run on, and the
// helpers they share: QueryInferenceSettlement on the real account and
// staking stacks, with wallet and Conviction Account periods, Core Node
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
  signCompact,
} from './query-inference';

export const SELLER_STAKE = 500_000n * TRAC; // a tenth of the 5M cap: S = sqrt(0.1)
export const ASK = 10n ** 9n;
export const CAP = 10n ** 12n; // the buckets' price cap

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

  const submit = (by: Seller, groups: ReceiptGroup[]) => f.QS.connect(by.operational).submitReceiptBatch(groups);
  const accept = async (by: Seller, groups: ReceiptGroup[]) => (await (await submit(by, groups)).wait())!;

  /** One request for `by` on a period's bucket, with `overrides`, and its full receipt. */
  const requestFor = async (
    subscriptionId: string,
    bucketIndex: number,
    by: Seller,
    overrides: Partial<ServiceRequest> = {},
  ): Promise<ServiceRequest> => {
    const b = await f.CSS.getBucket(subscriptionId, bucketIndex);
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
  const itemFor = (r: ServiceRequest, receipt: Partial<Receipt> = {}, wallet = key): ReceiptItem =>
    itemOf(r, fullReceipt(r, receipt), signCompact(wallet, requestDigestOf(domain, r)));

  return { latest, epochNow, epochStart, seller, submit, accept, requestFor, itemFor };
}
