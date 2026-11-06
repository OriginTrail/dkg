// The off-chain formats of the query/inference pool (OT-RFC-27) that
// QueryInferenceSettlement verifies:
//   - the EIP-712 domain, built by hand, binds QueryInferenceStorage;
//   - the ServiceRequest and QueryInferenceReceipt type hashes and digests
//     equal ethers' TypedDataEncoder, on ordinary values and at every field's
//     bounds;
//   - the digests a batch hashes in scratch memory equal hashRequest and
//     hashReceipt, at every width of every field.
// Compact signatures, and the refusal of a high s, are exercised through
// receipt batches in v10-query-inference-receipts.test.ts, and so is a batch
// that verifies the digest hashRequest returns.

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Hub, QueryInferenceDigestHarness, QueryInferenceSettlement, QueryInferenceStorage } from '../../typechain';
import { ACCOUNT_STACK_TAGS, registerServiceContracts } from '../helpers/conviction-service';
import {
  RECEIPT_TYPES,
  REQUEST_TYPES,
  Receipt,
  ServiceRequest,
  itemOf,
  queryInferenceDomain,
  receiptDigestOf,
  requestDigestOf,
} from '../helpers/query-inference';

const MAX = (bits: bigint) => (1n << bits) - 1n;

async function deployFixture() {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, QS } = await registerServiceContracts(Hub, { settlement: true });
  const Harness = (await (
    await hre.ethers.getContractFactory('QueryInferenceDigestHarness')
  ).deploy(await Hub.getAddress())) as unknown as QueryInferenceDigestHarness;
  await Harness.waitForDeployment();
  return { QIS, QS: QS!, Harness };
}

describe('@unit QueryInferenceSettlement formats', () => {
  let QIS: QueryInferenceStorage;
  let QS: QueryInferenceSettlement;
  let Harness: QueryInferenceDigestHarness;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ QIS, QS, Harness } = await loadFixture(deployFixture));
  });

  const request = (overrides: Partial<ServiceRequest> = {}): ServiceRequest => ({
    subscriptionId: ethers.id('subscription'),
    serviceId: ethers.toBeHex(1n, 32),
    seller: 7n,
    nonce: 3n,
    pricePerUnit: 10n ** 12n,
    maxUnits: 2_000n,
    maxValueWei: 2n * 10n ** 15n,
    issuedAt: 1_790_000_000n,
    expiry: 1_790_000_600n,
    ...overrides,
  });

  const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
    resultCommitment: ethers.id('result'),
    units: 1_500n,
    valueWei: 15n * 10n ** 14n,
    completedAt: 1_790_000_300n,
    ...overrides,
  });

  it('the domain is DKGQueryInference, version 1, this chain and QueryInferenceStorage', async () => {
    const domain = await queryInferenceDomain(QIS);
    expect(await QS.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(domain));
    expect(await QS.queryInferenceStorage()).to.equal(await QIS.getAddress());
  });

  it('the type hashes are those of the encoded types', async () => {
    const requestType = ethers.TypedDataEncoder.from(REQUEST_TYPES).encodeType('ServiceRequest');
    const receiptType = ethers.TypedDataEncoder.from(RECEIPT_TYPES).encodeType('QueryInferenceReceipt');
    expect(requestType).to.equal(
      'ServiceRequest(bytes32 subscriptionId,bytes32 serviceId,uint72 seller,uint64 nonce,uint96 pricePerUnit,uint64 maxUnits,uint96 maxValueWei,uint40 issuedAt,uint40 expiry)',
    );
    expect(receiptType).to.equal(
      'QueryInferenceReceipt(bytes32 requestDigest,bytes32 resultCommitment,uint64 units,uint96 valueWei,uint40 completedAt)',
    );
    expect(await QS.SERVICE_REQUEST_TYPEHASH()).to.equal(ethers.id(requestType));
    expect(await QS.QUERY_INFERENCE_RECEIPT_TYPEHASH()).to.equal(ethers.id(receiptType));
  });

  it('request digests equal TypedDataEncoder vectors, ordinary and at every bound', async () => {
    const domain = await queryInferenceDomain(QIS);
    const vectors: ServiceRequest[] = [
      request(),
      request({ seller: 1n, nonce: 0n, issuedAt: 0n, expiry: 0n }),
      request({
        subscriptionId: ethers.toBeHex(ethers.MaxUint256, 32),
        serviceId: ethers.ZeroHash,
        seller: MAX(72n),
        nonce: MAX(64n),
        pricePerUnit: MAX(96n),
        maxUnits: MAX(64n),
        maxValueWei: MAX(96n),
        issuedAt: MAX(40n),
        expiry: MAX(40n),
      }),
    ];
    for (const r of vectors) {
      expect(await QS.hashRequest(r)).to.equal(requestDigestOf(domain, r));
    }
    // Every field is bound: changing any one changes the digest.
    const base = await QS.hashRequest(request());
    for (const [field, value] of Object.entries({
      subscriptionId: ethers.id('other'),
      serviceId: ethers.toBeHex(2n, 32),
      seller: 8n,
      nonce: 4n,
      pricePerUnit: 10n ** 12n + 1n,
      maxUnits: 2_001n,
      maxValueWei: 2n * 10n ** 15n + 1n,
      issuedAt: 1_790_000_001n,
      expiry: 1_790_000_601n,
    })) {
      expect(await QS.hashRequest(request({ [field]: value })), field).to.not.equal(base);
    }
  });

  it('receipt digests equal TypedDataEncoder vectors, ordinary and at every bound', async () => {
    const domain = await queryInferenceDomain(QIS);
    const requestDigest = requestDigestOf(domain, request());
    for (const r of [
      receipt(),
      receipt({ resultCommitment: ethers.ZeroHash, units: 0n, valueWei: 0n, completedAt: 0n }),
      receipt({ resultCommitment: ethers.id('x'), units: MAX(64n), valueWei: MAX(96n), completedAt: MAX(40n) }),
    ]) {
      expect(await QS.hashReceipt({ requestDigest, ...r })).to.equal(receiptDigestOf(domain, requestDigest, r));
    }
  });

  describe('the digests a batch hashes in scratch memory', () => {
    const ones = ethers.toBeHex(ethers.MaxUint256, 32);
    const widths = {
      seller: MAX(72n),
      nonce: MAX(64n),
      pricePerUnit: MAX(96n),
      maxUnits: MAX(64n),
      maxValueWei: MAX(96n),
      issuedAt: MAX(40n),
      expiry: MAX(40n),
    };
    const zero: ServiceRequest = {
      subscriptionId: ethers.ZeroHash,
      serviceId: ethers.ZeroHash,
      seller: 0n,
      nonce: 0n,
      pricePerUnit: 0n,
      maxUnits: 0n,
      maxValueWei: 0n,
      issuedAt: 0n,
      expiry: 0n,
    };
    const noReceipt: Receipt = { resultCommitment: ethers.ZeroHash, units: 0n, valueWei: 0n, completedAt: 0n };

    /** Each of a record's fields at `value`, the others as in `base`. */
    const oneAtATime = <T extends object>(base: T, values: Partial<T>): T[] =>
      Object.entries(values).map(([field, value]) => ({ ...base, [field]: value }));

    /** Values with no structure, the same on every run, within each field's width. */
    const scattered = (seed: number): { r: ServiceRequest; receipt: Receipt } => {
      const word = (i: number) => BigInt(ethers.id(`${seed}/${i}`));
      const fit = (i: number, bits: bigint) => word(i) & MAX(bits);
      return {
        r: {
          subscriptionId: ethers.toBeHex(word(0), 32),
          serviceId: ethers.toBeHex(word(1), 32),
          seller: fit(2, 72n),
          nonce: fit(3, 64n),
          pricePerUnit: fit(4, 96n),
          maxUnits: fit(5, 64n),
          maxValueWei: fit(6, 96n),
          issuedAt: fit(7, 40n),
          expiry: fit(8, 40n),
        },
        receipt: {
          resultCommitment: ethers.toBeHex(word(9), 32),
          units: fit(10, 64n),
          valueWei: fit(11, 96n),
          completedAt: fit(12, 40n),
        },
      };
    };

    const allWide: ServiceRequest = { ...zero, subscriptionId: ones, serviceId: ones, ...widths };
    const allWideReceipt: Receipt = { resultCommitment: ones, units: MAX(64n), valueWei: MAX(96n), completedAt: MAX(40n) };
    const pairs = (): Array<{ r: ServiceRequest; receipt: Receipt }> => [
      { r: request(), receipt: receipt() },
      { r: zero, receipt: noReceipt },
      { r: allWide, receipt: allWideReceipt },
      // One field wide and the rest empty, and one empty and the rest wide, so
      // a field that spills into, or is read from, its neighbour shows.
      ...oneAtATime(zero, { subscriptionId: ones, serviceId: ones, ...widths }).map((r) => ({ r, receipt: noReceipt })),
      ...oneAtATime(allWide, { ...zero }).map((r) => ({ r, receipt: allWideReceipt })),
      ...oneAtATime<Receipt>(noReceipt, { resultCommitment: ones, units: MAX(64n), valueWei: MAX(96n), completedAt: MAX(40n) }).map(
        (rec) => ({ r: request(), receipt: rec }),
      ),
      ...oneAtATime<Receipt>(allWideReceipt, { ...noReceipt }).map((rec) => ({ r: request(), receipt: rec })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(scattered),
    ];

    const unsigned = { sigR: ethers.ZeroHash, sigVS: ethers.ZeroHash };

    it('a request hashes as hashRequest does, and a receipt as hashReceipt does, at every width of every field', async () => {
      const separator = await QS.domainSeparator();
      for (const { r, receipt: rec } of pairs()) {
        const label = JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        const item = itemOf(r, rec, unsigned);
        const requestDigest = await QS.hashRequest(r);
        expect(
          await Harness.batchRequestDigest(separator, r.subscriptionId, r.serviceId, r.seller, item),
          label,
        ).to.equal(requestDigest);
        expect(await Harness.batchReceiptDigest(separator, requestDigest, item), label).to.equal(
          await QS.hashReceipt({ requestDigest, ...rec }),
        );
      }
    });

    it('the fields of a batch item it does not sign leave the request digest as it is, and the request digest and domain are bound', async () => {
      const separator = await QS.domainSeparator();
      const r = request();
      const rec = receipt();
      const item = itemOf(r, rec, unsigned);
      const requestDigest = await QS.hashRequest(r);
      const other = itemOf(r, { resultCommitment: ones, units: MAX(64n), valueWei: MAX(96n), completedAt: MAX(40n) }, {
        sigR: ones,
        sigVS: ones,
      });
      expect(await Harness.batchRequestDigest(separator, r.subscriptionId, r.serviceId, r.seller, other)).to.equal(requestDigest);
      expect(await Harness.batchReceiptDigest(separator, ethers.id('other'), item)).to.not.equal(
        await Harness.batchReceiptDigest(separator, requestDigest, item),
      );
      expect(await Harness.batchRequestDigest(ethers.id('other'), r.subscriptionId, r.serviceId, r.seller, item)).to.not.equal(
        requestDigest,
      );
    });
  });

  it('a digest is bound to the storage: another verifying contract gives another digest', async () => {
    const domain = await queryInferenceDomain(QIS);
    const other = { ...domain, verifyingContract: await QS.getAddress() };
    expect(await QS.hashRequest(request())).to.not.equal(requestDigestOf(other, request()));
  });
});
