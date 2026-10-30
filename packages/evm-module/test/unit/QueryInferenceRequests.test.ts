// The off-chain formats of the query/inference pool (OT-RFC-27) that
// QueryInferenceSettlement verifies:
//   - the EIP-712 domain, built by hand, binds QueryInferenceStorage;
//   - the ServiceRequest and QueryInferenceReceipt type hashes and digests
//     equal ethers' TypedDataEncoder, on ordinary values and at every field's
//     bounds.
// Compact signatures, and the refusal of a high s, are exercised through
// receipt batches in v10-query-inference-receipts.test.ts.

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Hub, QueryInferenceSettlement, QueryInferenceStorage } from '../../typechain';
import { ACCOUNT_STACK_TAGS, registerServiceContracts } from '../helpers/conviction-service';
import {
  RECEIPT_TYPES,
  REQUEST_TYPES,
  Receipt,
  ServiceRequest,
  queryInferenceDomain,
  receiptDigestOf,
  requestDigestOf,
} from '../helpers/query-inference';

const MAX = (bits: bigint) => (1n << bits) - 1n;

async function deployFixture() {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, QS } = await registerServiceContracts(Hub, { settlement: true });
  return { QIS, QS: QS! };
}

describe('@unit QueryInferenceSettlement formats', () => {
  let QIS: QueryInferenceStorage;
  let QS: QueryInferenceSettlement;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ QIS, QS } = await loadFixture(deployFixture));
  });

  const request = (overrides: Partial<ServiceRequest> = {}): ServiceRequest => ({
    subscriptionId: ethers.id('period'),
    bucketId: ethers.toBeHex(1n, 32),
    seller: 7n,
    nonce: 3n,
    acceptedAskWeiPerUnit: 10n ** 12n,
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
      'ServiceRequest(bytes32 subscriptionId,bytes32 bucketId,uint72 seller,uint64 nonce,uint96 acceptedAskWeiPerUnit,uint64 maxUnits,uint96 maxValueWei,uint40 issuedAt,uint40 expiry)',
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
        bucketId: ethers.ZeroHash,
        seller: MAX(72n),
        nonce: MAX(64n),
        acceptedAskWeiPerUnit: MAX(96n),
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
      bucketId: ethers.toBeHex(2n, 32),
      seller: 8n,
      nonce: 4n,
      acceptedAskWeiPerUnit: 10n ** 12n + 1n,
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

  it('a digest is bound to the storage: another verifying contract gives another digest', async () => {
    const domain = await queryInferenceDomain(QIS);
    const other = { ...domain, verifyingContract: await QS.getAddress() };
    expect(await QS.hashRequest(request())).to.not.equal(requestDigestOf(other, request()));
  });
});
