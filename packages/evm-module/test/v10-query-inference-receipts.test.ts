// Receipt batches of the query/inference pool (OT-RFC-27), end to end:
// QueryInferenceSettlement on the real account and staking stacks, with
// wallet and Conviction Account periods, Core Node sellers and session keys
// that sign requests.
//
// Groups:
//   - a happy batch of several groups: the claims per bucket and seller, the
//     bucket totals, the nonce bits, the stake factor captured once, and the
//     events with their receipt digests;
//   - the Core Node gate: a profile with no place in the sharding table, an
//     admin key, and an address that is no node's;
//   - the objective faults F1 to F8 of OT-RFC-27, one by one, each reverting
//     the whole batch with its group, its item and its code, high s included;
//   - the group checks: an unknown period or bucket, an empty group, the
//     batch deadline, and a Conviction Account period's earlier deadline;
//   - the nonce bitmap's words, and the bounds of a batch, the pause and
//     activation.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ethers, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  RandomSamplingStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  StakingV10,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  Bucket,
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  Domain,
  TRAC,
  bucket,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import {
  Fault,
  Receipt,
  ReceiptGroup,
  ReceiptItem,
  SCALE18,
  SECP256K1_HALF_N,
  SECP256K1_N,
  ServiceRequest,
  createNode,
  digestOfDigests,
  fullReceipt,
  hardhatWallet,
  itemOf,
  openConvictionAccount,
  queryInferenceDomain,
  receiptDigestOf,
  requestDigestOf,
  signCompact,
  signedItems,
  stakeFactorOf,
  stakeOn,
} from './helpers/query-inference';

const SELLER_STAKE = 500_000n * TRAC; // a tenth of the 5M cap: S = sqrt(0.1)
const ASK = 10n ** 9n;
const CAP = 10n ** 12n; // the buckets' price cap

async function deployFixture() {
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

type Fixture = Awaited<ReturnType<typeof deployFixture>>;
type Seller = { identityId: bigint; operational: SignerWithAddress; admin: SignerWithAddress };

describe('@integration Receipt batches of the query/inference pool', function () {
  let f: Fixture;
  let Token: Token;
  let ChronosContract: Chronos;
  let QIS: QueryInferenceStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let SSW: ServiceSubscriptionsWallet;
  let QS: QueryInferenceSettlement;
  let domain: Domain;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let owner: SignerWithAddress;
  let s1: Seller;
  let s2: Seller;
  const key = hardhatWallet(60); // the buyer's session key
  const otherKey = hardhatWallet(61);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    ({ Token, Chronos: ChronosContract, QIS, CSS, SS, SSW, QS } = f);
    domain = await queryInferenceDomain(QIS);
    owner = f.accounts[20];
    buyer = f.accounts[21];
    buyer2 = f.accounts[22];
    s1 = await seller(40, SELLER_STAKE);
    s2 = await seller(42, SELLER_STAKE);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => ChronosContract.getCurrentEpoch();
  const epochStart = async (e: bigint) => ChronosContract.timestampForEpoch(e);
  const plain = (r: unknown) => (r as Result).toObject();
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  async function seller(index: number, stake: bigint): Promise<Seller> {
    const operational = f.accounts[index];
    const admin = f.accounts[index + 1];
    const identityId = await createNode({ ...f, operational, admin, stake });
    return { identityId, operational, admin };
  }

  const eventsOf = (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const out: Result[] = [];
    for (const log of receipt.logs) {
      const parsed = (() => {
        try {
          return contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })();
      if (parsed?.name === name) out.push(parsed.args);
    }
    return out;
  };

  /** Fund a wallet period of `epoch` for `who`, signed for by `sessionKey`. */
  const walletFund = async (
    who: SignerWithAddress,
    epoch: bigint,
    buckets: Bucket[],
    sessionKey: string = key.address,
  ): Promise<string> => {
    const value = buckets.reduce((a, b) => a + b.value, 0n);
    await Token.mint(who.address, value);
    await Token.connect(who).approve(await SSW.getAddress(), value);
    await SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { buckets, sessionKey }));
    return subscriptionIdOf(who.address, epoch);
  };

  const submit = (by: Seller, groups: ReceiptGroup[]) => QS.connect(by.operational).submitReceiptBatch(groups);
  const accept = async (by: Seller, groups: ReceiptGroup[]) => (await (await submit(by, groups)).wait())!;

  /** `count` signed items of a period's bucket for `by`, from nonce `firstNonce`, issued now. */
  const items = async (
    subscriptionId: string,
    bucketIndex: number,
    by: Seller,
    count: number,
    opts: { firstNonce?: bigint; units?: bigint; ask?: bigint; issuedAt?: bigint; wallet?: ethers.HDNodeWallet } = {},
  ) => {
    const b = await CSS.getBucket(subscriptionId, bucketIndex);
    return signedItems({
      domain,
      wallet: opts.wallet ?? key,
      subscriptionId,
      bucketId: b.bucketId,
      seller: by.identityId,
      firstNonce: opts.firstNonce,
      count,
      units: opts.units,
      ask: opts.ask ?? ASK,
      issuedAt: opts.issuedAt ?? (await latest()),
    });
  };

  /** One request for `by` on a period's bucket, with `overrides`, and its full receipt. */
  const requestFor = async (
    subscriptionId: string,
    bucketIndex: number,
    by: Seller,
    overrides: Partial<ServiceRequest> = {},
  ): Promise<ServiceRequest> => {
    const b = await CSS.getBucket(subscriptionId, bucketIndex);
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

  // -------------------------------------------------------------------------
  // A happy batch
  // -------------------------------------------------------------------------

  describe('a happy batch', () => {
    let a: string;
    let b: string;

    beforeEach(async () => {
      const now = await epochNow();
      a = await walletFund(buyer, now, [
        bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP),
        bucket(1, CLASS_QUERY, 5n * TRAC, CAP),
      ]);
      b = await walletFund(buyer2, now, [bucket(3, CLASS_INFERENCE, 8n * TRAC, CAP)], otherKey.address);
    });

    it('claims several groups at once: per bucket and seller, the bucket totals, the nonce bits, and the events', async () => {
      const g0 = await items(a, 0, s1, 3, { units: 700n });
      const g1 = await items(a, 1, s1, 2, { firstNonce: 3n, units: 1_100n, ask: 2n * ASK });
      const g2 = await items(b, 0, s1, 4, { units: 5n, ask: CAP, wallet: otherKey });
      const groups: ReceiptGroup[] = [
        { subscriptionId: a, bucketIndex: 0n, items: g0.items },
        { subscriptionId: a, bucketIndex: 1n, items: g1.items },
        { subscriptionId: b, bucketIndex: 0n, items: g2.items },
      ];
      const s18 = await QS.stakeFactor(s1.identityId);
      expect(s18).to.equal(stakeFactorOf(SELLER_STAKE, await f.Params.maximumStake()));

      const returned = await QS.connect(s1.operational).submitReceiptBatch.staticCall(groups);
      const receipt = await accept(s1, groups);

      const values = [3n * 700n * ASK, 2n * 1_100n * 2n * ASK, 4n * 5n * CAP];
      const weighted = values.map((v) => (v * s18) / SCALE18);
      expect(plain(await QIS.getSellerClaim(a, 0n, s1.identityId))).to.deep.equal({
        claimed: values[0],
        weighted: weighted[0],
        finalized: false,
      });
      expect(plain(await QIS.getSellerClaim(a, 1n, s1.identityId))).to.deep.equal({
        claimed: values[1],
        weighted: weighted[1],
        finalized: false,
      });
      expect(plain(await QIS.getSellerClaim(b, 0n, s1.identityId))).to.deep.equal({
        claimed: values[2],
        weighted: weighted[2],
        finalized: false,
      });
      expect(await QIS.bucketClaimed(a, 0n)).to.equal(values[0]);
      expect(await QIS.bucketClaimed(a, 1n)).to.equal(values[1]);
      expect(await QIS.bucketClaimed(b, 0n)).to.equal(values[2]);

      // One nonce space per period and seller, across its buckets: nonces 0 to 4 of a.
      expect(await QIS.nonceWord(a, s1.identityId, 0n)).to.equal(0b11111n);
      expect(await QIS.nonceWord(b, s1.identityId, 0n)).to.equal(0b1111n);
      expect(await QIS.nonceWord(a, s2.identityId, 0n)).to.equal(0n);

      // The receipt digests, per group and for the batch.
      const digests = [g0, g1, g2].map((g) =>
        g.requests.map((r, i) => receiptDigestOf(domain, requestDigestOf(domain, r), g.receipts[i])),
      );
      const claimed = eventsOf(receipt, QS, 'ReceiptsClaimed');
      expect(
        claimed.map((e) => [e.subscriptionId, e.bucketIndex, e.seller, e.itemCount, e.value, e.stakeFactor18, e.groupDigest]),
      ).to.deep.equal([
        [a, 0n, s1.identityId, 3n, values[0], s18, digestOfDigests(digests[0])],
        [a, 1n, s1.identityId, 2n, values[1], s18, digestOfDigests(digests[1])],
        [b, 0n, s1.identityId, 4n, values[2], s18, digestOfDigests(digests[2])],
      ]);
      const batchDigest = digestOfDigests(digests.flat());
      expect(returned).to.equal(batchDigest);
      const [accepted] = eventsOf(receipt, QS, 'ReceiptBatchAccepted');
      expect([accepted.seller, accepted.batchDigest, accepted.itemCount, accepted.value, accepted.stakeFactor18]).to.deep.equal([
        s1.identityId,
        batchDigest,
        9n,
        values[0] + values[1] + values[2],
        s18,
      ]);

      // No TRAC moves.
      const tokenAddress = (await Token.getAddress()).toLowerCase();
      expect(receipt.logs.filter((l) => l.address.toLowerCase() === tokenAddress)).to.have.length(0);
    });

    it('later batches add to the totals, another seller claims the same bucket apart, and a claim above the funded value is accepted', async () => {
      const first = await items(a, 0, s1, 2, { units: 1_000n });
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: first.items }]);
      const second = await items(a, 0, s1, 3, { firstNonce: 2n, units: 1_000n });
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: second.items }]);
      const other = await items(a, 0, s2, 2, { units: 1_000n });
      await accept(s2, [{ subscriptionId: a, bucketIndex: 0n, items: other.items }]);

      expect((await QIS.getSellerClaim(a, 0n, s1.identityId)).claimed).to.equal(5n * 1_000n * ASK);
      expect((await QIS.getSellerClaim(a, 0n, s2.identityId)).claimed).to.equal(2n * 1_000n * ASK);
      expect(await QIS.bucketClaimed(a, 0n)).to.equal(7n * 1_000n * ASK);
      expect(await QIS.nonceWord(a, s1.identityId, 0n)).to.equal(0b11111n);
      expect(await QIS.nonceWord(a, s2.identityId, 0n)).to.equal(0b11n);

      // The bucket funded 10 TRAC; claims of 30 TRAC more are still accepted.
      const big = await items(a, 0, s2, 3, { firstNonce: 2n, units: 10n ** 10n, ask: 10n ** 9n });
      await accept(s2, [{ subscriptionId: a, bucketIndex: 0n, items: big.items }]);
      expect(await QIS.bucketClaimed(a, 0n)).to.equal(7n * 1_000n * ASK + 30n * TRAC);
    });

    it('the stake factor is captured once per batch and never revised: a later stake change moves only later batches', async () => {
      const cap = await f.Params.maximumStake();
      const first = await items(a, 0, s1, 1);
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: first.items }]);
      const before = await QIS.getSellerClaim(a, 0n, s1.identityId);
      const v = 1_000n * ASK;
      expect(before.weighted).to.equal((v * stakeFactorOf(SELLER_STAKE, cap)) / SCALE18);

      await stakeOn({ ...f, operational: s1.operational }, s1.identityId, 2n * SELLER_STAKE);
      expect((await QIS.getSellerClaim(a, 0n, s1.identityId)).weighted).to.equal(before.weighted);
      const second = await items(a, 0, s1, 1, { firstNonce: 1n });
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: second.items }]);
      expect((await QIS.getSellerClaim(a, 0n, s1.identityId)).weighted).to.equal(
        before.weighted + (v * stakeFactorOf(3n * SELLER_STAKE, cap)) / SCALE18,
      );
    });

    it('a seller with a profile and a place in the table but no stake factor claims with a weight of 0', async () => {
      // A challenge snapshot of 0 caps the factor at 0, as for proofs.
      await f.RSS.setNodeChallengeStakeSnapshot(s1.identityId, 0n);
      const g = await items(a, 0, s1, 2);
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]);
      expect(plain(await QIS.getSellerClaim(a, 0n, s1.identityId))).to.deep.equal({
        claimed: 2n * 1_000n * ASK,
        weighted: 0n,
        finalized: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // The Core Node gate
  // -------------------------------------------------------------------------

  describe('the Core Node gate', () => {
    let a: string;
    beforeEach(async () => {
      a = await walletFund(buyer, await epochNow(), [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it('a node with a profile but no place in the sharding table is refused', async () => {
      const minimum = await f.Params.minimumStake();
      const unstaked = await seller(44, 0n);
      const below = await seller(46, minimum - 1n);
      for (const s of [unstaked, below]) {
        const g = await items(a, 0, s, 1);
        await expect(submit(s, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]))
          .to.be.revertedWithCustomError(QS, 'NodeNotInShardingTable')
          .withArgs(s.identityId);
      }
    });

    it("the node's admin key is refused, as an address that is no node's key", async () => {
      const g = await items(a, 0, s1, 1);
      for (const sender of [s1.admin, buyer, f.accounts[50]]) {
        await expect(QS.connect(sender).submitReceiptBatch([{ subscriptionId: a, bucketIndex: 0n, items: g.items }]))
          .to.be.revertedWithCustomError(QS, 'ProfileDoesntExist')
          .withArgs(0n);
      }
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]);
    });
  });

  // -------------------------------------------------------------------------
  // The faults of OT-RFC-27
  // -------------------------------------------------------------------------

  describe('the faults, one by one', () => {
    let a: string;
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await epochNow();
      a = await walletFund(buyer, epoch, [
        bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP),
        bucket(1, CLASS_QUERY, 10n * TRAC, CAP),
      ]);
    });

    /**
     * A batch of two good groups, then `bad` as the third item of the second
     * group. Asserts it reverts with that position and `fault`, and that
     * nothing was written: all or nothing.
     */
    const expectFault = async (bad: ReceiptItem, fault: bigint) => {
      const good0 = await items(a, 0, s1, 2);
      const good1 = await items(a, 1, s1, 2, { firstNonce: 2n });
      const groups: ReceiptGroup[] = [
        { subscriptionId: a, bucketIndex: 0n, items: good0.items },
        { subscriptionId: a, bucketIndex: 1n, items: [...good1.items, bad] },
      ];
      const before = [
        await QIS.nonceWord(a, s1.identityId, 0n),
        await QIS.bucketClaimed(a, 0n),
        await QIS.bucketClaimed(a, 1n),
        plain(await QIS.getSellerClaim(a, 0n, s1.identityId)),
      ];
      await expect(submit(s1, groups)).to.be.revertedWithCustomError(QS, 'ReceiptFault').withArgs(1n, 2n, fault);
      expect([
        await QIS.nonceWord(a, s1.identityId, 0n),
        await QIS.bucketClaimed(a, 0n),
        await QIS.bucketClaimed(a, 1n),
        plain(await QIS.getSellerClaim(a, 0n, s1.identityId)),
      ]).to.deep.equal(before);
    };

    it('F1, an invalid signature: another key, a malformed signature, or a high s', async () => {
      const r = await requestFor(a, 1, s1);
      await expectFault(itemFor(r, {}, otherKey), Fault.BadSignature);
      await expectFault({ ...itemFor(r), sigR: ethers.ZeroHash }, Fault.BadSignature);
      await expectFault({ ...itemFor(r), sigVS: ethers.toBeHex(SECP256K1_N - 1n, 32) }, Fault.BadSignature);
    });

    it('F1: the high-s form of a signature is refused, and its low-s twin from the same signer accepted', async () => {
      // A compact signature has 255 bits of s, so the high-s twin of a real
      // key's signature almost never fits. Recover instead the signer of a
      // chosen high s, and fund a period whose session key is that signer.
      const now = await epochNow();
      const b = await CSS.getBucket(a, 0n);
      const r: ServiceRequest = {
        subscriptionId: subscriptionIdOf(buyer2.address, now),
        bucketId: b.bucketId,
        seller: s1.identityId,
        nonce: 0n,
        acceptedAskWeiPerUnit: ASK,
        maxUnits: 10n,
        maxValueWei: 10n * ASK,
        issuedAt: (await latest()) + 10n,
        expiry: (await latest()) + DAY,
      };
      const digest = requestDigestOf(domain, r);
      const sigR = signCompact(key, ethers.id('any digest')).sigR; // any valid x-coordinate
      const highS = SECP256K1_HALF_N + 1n;
      expect(highS < 1n << 255n).to.equal(true);
      const signer = ethers.getAddress(
        ethers.dataSlice(
          await hre.ethers.provider.call({
            to: '0x0000000000000000000000000000000000000001',
            data: ethers.AbiCoder.defaultAbiCoder().encode(
              ['bytes32', 'uint8', 'bytes32', 'uint256'],
              [digest, 27, sigR, highS],
            ),
          }),
          12,
        ),
      );
      await walletFund(buyer2, now, [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)], signer);
      const receipt = fullReceipt(r);
      const high = itemOf(r, receipt, { sigR, sigVS: ethers.toBeHex(highS, 32) });
      const low = itemOf(r, receipt, { sigR, sigVS: ethers.toBeHex((1n << 255n) | (SECP256K1_N - highS), 32) });

      await expect(submit(s1, [{ subscriptionId: r.subscriptionId, bucketIndex: 0n, items: [high] }]))
        .to.be.revertedWithCustomError(QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.BadSignature);
      await accept(s1, [{ subscriptionId: r.subscriptionId, bucketIndex: 0n, items: [low] }]);
      expect(await QIS.bucketClaimed(r.subscriptionId, 0n)).to.equal(10n * ASK);
    });

    it('F2, the wrong seller, period or bucket: the contract fills them in, so the signature fails', async () => {
      // Signed for seller 2, sent by seller 1.
      await expectFault(itemFor(await requestFor(a, 1, s2)), Fault.BadSignature);
      // Signed for bucket 0, claimed in bucket 1.
      await expectFault(itemFor(await requestFor(a, 0, s1)), Fault.BadSignature);
      // Signed for another period of the same session key, claimed in this one.
      const other = await walletFund(buyer2, epoch, [bucket(1, CLASS_QUERY, 10n * TRAC, CAP)]);
      expect((await CSS.getBucket(other, 0n)).bucketId).to.equal((await CSS.getBucket(a, 1n)).bucketId);
      await expectFault(itemFor(await requestFor(other, 0, s1)), Fault.BadSignature);
      // The same request, claimed where it was signed for, is accepted.
      await accept(s1, [{ subscriptionId: other, bucketIndex: 0n, items: [itemFor(await requestFor(other, 0, s1))] }]);
    });

    it('F3, an inactive Conviction Account assignment: a request issued at or after its revocation, or its expiry', async () => {
      const expiresAt = (await epochStart(epoch + 1n)) - 1_000n;
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
        expiresAt,
      });
      const r0 = requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address });
      await SS.connect(buyer2).fundFromConviction(r0);
      const p = subscriptionIdOf(buyer2.address, epoch);

      // Issued before the revocation: accepted, also after it.
      const before = await requestFor(p, 0, s1, { nonce: 0n });
      await SS.connect(owner).revoke(accountId, buyer2.address);
      const revokedAt = (await CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      expect(before.issuedAt).to.be.lessThan(revokedAt);
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [itemFor(before)] }]);

      const at = itemFor(await requestFor(p, 0, s1, { nonce: 1n, issuedAt: revokedAt }));
      await expect(submit(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [at] }]))
        .to.be.revertedWithCustomError(QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveAssignment);

      // A new assignment clears the revocation; its expiry, inside the period, then ends it.
      const terms = {
        accountId,
        assignee: buyer2.address,
        maxCostPerPeriod: 1_000n * TRAC,
        expiresAt,
        nonce: await CSS.assignmentNonce(accountId),
      };
      await SS.connect(owner).assign(terms, '0x', await signTerms(buyer2, SS, terms));
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [at] }]);
      const afterExpiry = itemFor(await requestFor(p, 0, s1, { nonce: 2n, issuedAt: expiresAt }));
      await expect(submit(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [afterExpiry] }]))
        .to.be.revertedWithCustomError(QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveAssignment);
      const justBefore = itemFor(await requestFor(p, 0, s1, { nonce: 3n, issuedAt: expiresAt - 1n }));
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [justBefore] }]);
    });

    it('F4, a duplicate: a nonce from an earlier batch, twice in one group, or in two buckets of the period', async () => {
      const first = await items(a, 0, s1, 1, { firstNonce: 9n });
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: first.items }]);
      await expectFault(itemFor(await requestFor(a, 1, s1, { nonce: 9n })), Fault.DuplicateNonce);
      // Nonce 2 is the second group's first good item.
      await expectFault(itemFor(await requestFor(a, 1, s1, { nonce: 2n, maxUnits: 999n })), Fault.DuplicateNonce);
      // Nonce 0 is the first group's, in bucket 0.
      await expectFault(itemFor(await requestFor(a, 1, s1, { nonce: 0n, maxUnits: 999n })), Fault.DuplicateNonce);
      // Another seller's nonces are its own.
      await accept(s2, [{ subscriptionId: a, bucketIndex: 1n, items: [itemFor(await requestFor(a, 1, s2, { nonce: 9n }))] }]);
    });

    it('F5, an expired authorization: before the period, at its end, completed before issue, after expiry or after the period', async () => {
      const s = await CSS.getSubscription(a);
      const r = await requestFor(a, 1, s1);
      const cases: Array<[Partial<ServiceRequest>, Partial<Receipt>]> = [
        [{ issuedAt: s.periodStart - 1n }, {}],
        [{ issuedAt: s.periodEnd, expiry: s.periodEnd + 10n }, { completedAt: s.periodEnd }],
        [{}, { completedAt: r.issuedAt - 1n }],
        [{ expiry: r.issuedAt + 5n }, { completedAt: r.issuedAt + 6n }],
        [{ expiry: s.periodEnd + 100n }, { completedAt: s.periodEnd + 1n }],
      ];
      for (const [request, receipt] of cases) {
        const bad = { ...r, ...request };
        await expectFault(itemFor(bad, { completedAt: bad.issuedAt, ...receipt }), Fault.OutsideTime);
      }
      // At the bounds it is accepted: issued at the period's start, completed at its end and at expiry.
      const edge = { ...r, issuedAt: s.periodStart, expiry: s.periodEnd };
      await accept(s1, [{ subscriptionId: a, bucketIndex: 1n, items: [itemFor(edge, { completedAt: s.periodEnd })] }]);
    });

    it("F6, an ask or price-cap breach: a zero ask, or one above the bucket's cap", async () => {
      await expectFault(itemFor(await requestFor(a, 1, s1, { acceptedAskWeiPerUnit: 0n, maxValueWei: 0n })), Fault.AskOutOfRange);
      await expectFault(
        itemFor(await requestFor(a, 1, s1, { acceptedAskWeiPerUnit: CAP + 1n, maxValueWei: 1_000n * (CAP + 1n) })),
        Fault.AskOutOfRange,
      );
      await accept(s1, [
        {
          subscriptionId: a,
          bucketIndex: 1n,
          items: [itemFor(await requestFor(a, 1, s1, { acceptedAskWeiPerUnit: CAP, maxValueWei: 1_000n * CAP }))],
        },
      ]);
    });

    it('F7, impossible arithmetic: zero units, more than the maximum, a value other than units × ask, or above the maximum', async () => {
      const r = await requestFor(a, 1, s1);
      await expectFault(itemFor(r, { units: 0n, valueWei: 0n }), Fault.BadArithmetic);
      await expectFault(itemFor(r, { units: r.maxUnits + 1n, valueWei: (r.maxUnits + 1n) * ASK }), Fault.BadArithmetic);
      await expectFault(itemFor(r, { units: 10n, valueWei: 10n * ASK + 1n }), Fault.BadArithmetic);
      await expectFault(itemFor(r, { units: 10n, valueWei: 10n * ASK - 1n }), Fault.BadArithmetic);
      const capped = { ...r, maxValueWei: r.maxUnits * ASK - 1n };
      await expectFault(itemFor(capped), Fault.BadArithmetic);
      // Fewer units than the maximum, at exactly the signed ask, are accepted.
      await accept(s1, [{ subscriptionId: a, bucketIndex: 1n, items: [itemFor(r, { units: 10n, valueWei: 10n * ASK })] }]);
      expect(await QIS.bucketClaimed(a, 1n)).to.equal(10n * ASK);
    });

    it('F8, an inconsistent result commitment: zero', async () => {
      await expectFault(itemFor(await requestFor(a, 1, s1), { resultCommitment: ethers.ZeroHash }), Fault.ZeroResultCommitment);
    });
  });

  // -------------------------------------------------------------------------
  // The group checks
  // -------------------------------------------------------------------------

  describe('the group checks and the batch deadline', () => {
    let a: string;
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await epochNow();
      a = await walletFund(buyer, epoch, [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it('an unknown period, an unknown bucket and an empty group are refused, with the group index', async () => {
      const good = await items(a, 0, s1, 1);
      const unknown = ethers.id('never-funded');
      for (const [group, fault] of [
        [{ subscriptionId: unknown, bucketIndex: 0n, items: good.items }, Fault.UnknownPeriod],
        [{ subscriptionId: a, bucketIndex: 1n, items: good.items }, Fault.UnknownBucket],
        [{ subscriptionId: a, bucketIndex: 0n, items: [] }, Fault.EmptyGroup],
      ] as Array<[ReceiptGroup, bigint]>) {
        await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: good.items }, group]))
          .to.be.revertedWithCustomError(QS, 'GroupFault')
          .withArgs(1n, fault);
      }
    });

    it("a batch lands up to the epoch's end plus the grace, and not a second later", async () => {
      const issuedAt = await latest();
      const first = await items(a, 0, s1, 1, { issuedAt });
      const second = await items(a, 0, s1, 1, { issuedAt, firstNonce: 1n });
      const deadline = (await epochStart(epoch + 1n)) + (await QIS.receiptGraceSecondsAt(epoch));
      expect(await QS.batchDeadline(a)).to.equal(deadline);
      expect(await ChronosContract.epochAtTimestamp(deadline)).to.equal(epoch + 1n);

      await time.setNextBlockTimestamp(deadline);
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: first.items }]);
      await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: second.items }]))
        .to.be.revertedWithCustomError(QS, 'GroupFault')
        .withArgs(0n, Fault.PastDeadline);
    });

    it("a Conviction Account period revoked mid-epoch takes the revocation plus the grace, and an expiry the same", async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      await SS.connect(buyer2).fundFromConviction(
        requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address }),
      );
      const p = subscriptionIdOf(buyer2.address, epoch);
      const served = await items(p, 0, s1, 2);
      await SS.connect(owner).revoke(accountId, buyer2.address);
      const revokedAt = (await CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      const grace = await QIS.receiptGraceSecondsAt(epoch);
      expect(await QS.batchDeadline(p)).to.equal(revokedAt + grace);

      await time.setNextBlockTimestamp(revokedAt + grace);
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [served.items[0]] }]);
      await expect(submit(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [served.items[1]] }]))
        .to.be.revertedWithCustomError(QS, 'GroupFault')
        .withArgs(0n, Fault.PastDeadline);
      // The wallet period of the same epoch still takes batches.
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: (await items(a, 0, s1, 1)).items }]);
    });
  });

  // -------------------------------------------------------------------------
  // The bitmap, the bounds, the pause and activation
  // -------------------------------------------------------------------------

  describe('the nonce bitmap and the batch bounds', () => {
    let a: string;

    beforeEach(async () => {
      a = await walletFund(buyer, await epochNow(), [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it('a word holds 256 nonces: 0, 255, 256, 511, 512 and the largest nonce land in their words and bits', async () => {
      const top = (1n << 64n) - 1n;
      const nonces = [0n, 255n, 256n, 511n, 512n, top];
      const group = await Promise.all(nonces.map(async (nonce) => itemFor(await requestFor(a, 0, s1, { nonce }))));
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: group }]);
      expect(await QIS.nonceWord(a, s1.identityId, 0n)).to.equal((1n << 255n) | 1n);
      expect(await QIS.nonceWord(a, s1.identityId, 1n)).to.equal((1n << 255n) | 1n);
      expect(await QIS.nonceWord(a, s1.identityId, 2n)).to.equal(1n);
      expect(await QIS.nonceWord(a, s1.identityId, top >> 8n)).to.equal(1n << 255n);
      expect(await QIS.nonceWord(a, s1.identityId, 3n)).to.equal(0n);
    });

    it('non-monotone nonces in one group write back each word, and a duplicate across words is still caught', async () => {
      const group = await Promise.all(
        [5n, 300n, 6n, 301n].map(async (nonce) => itemFor(await requestFor(a, 0, s1, { nonce }))),
      );
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: group }]);
      expect(await QIS.nonceWord(a, s1.identityId, 0n)).to.equal((1n << 5n) | (1n << 6n));
      expect(await QIS.nonceWord(a, s1.identityId, 1n)).to.equal((1n << 44n) | (1n << 45n));
      const again = await Promise.all(
        [7n, 302n, 5n].map(async (nonce) => itemFor(await requestFor(a, 0, s1, { nonce, maxUnits: 999n }))),
      );
      await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: again }]))
        .to.be.revertedWithCustomError(QS, 'ReceiptFault')
        .withArgs(0n, 2n, Fault.DuplicateNonce);
    });

    it('takes 1 to maxGroupsPerBatch groups and 1 to maxItemsPerBatch items, from QueryInferenceStorage', async () => {
      await forward(QIS, 'setMaxGroupsPerBatch', [2n]);
      await forward(QIS, 'setMaxItemsPerBatch', [4n]);
      const g = await items(a, 0, s1, 5);
      const group = (from: number, to: number): ReceiptGroup => ({
        subscriptionId: a,
        bucketIndex: 0n,
        items: g.items.slice(from, to),
      });
      for (const [groups, groupCount, itemCount] of [
        [[], 0n, 0n],
        [[group(0, 1), group(1, 2), group(2, 3)], 3n, 3n],
        [[group(0, 5)], 1n, 5n],
        [[group(0, 3), group(3, 5)], 2n, 5n],
        [[group(0, 0)], 1n, 0n],
      ] as Array<[ReceiptGroup[], bigint, bigint]>) {
        await expect(submit(s1, groups))
          .to.be.revertedWithCustomError(QS, 'BatchOutOfBounds')
          .withArgs(groupCount, itemCount);
      }
      await accept(s1, [group(0, 2), group(2, 4)]);
      expect(await QIS.bucketClaimed(a, 0n)).to.equal(4n * 1_000n * ASK);
    });

    it('is refused while QueryInferenceStorage is paused, and goes on once it is not', async () => {
      const g = await items(a, 0, s1, 1);
      await forward(QIS, 'setPaused', [true]);
      await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }])).to.be.revertedWithCustomError(
        QS,
        'QueryInferencePaused',
      );
      await forward(QIS, 'setPaused', [false]);
      await accept(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]);
    });

    it('is refused before the activation epoch and while it is unset', async () => {
      const g = await items(a, 0, s1, 1);
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await forward(QS, 'initialize');
      const now = await epochNow();
      await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]))
        .to.be.revertedWithCustomError(QS, 'QueryInferenceNotActive')
        .withArgs(0n, now);
      await forward(fresh, 'setActivationEpoch', [now + 1n]);
      await expect(submit(s1, [{ subscriptionId: a, bucketIndex: 0n, items: g.items }]))
        .to.be.revertedWithCustomError(QS, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
    });
  });
});
