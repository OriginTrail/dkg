// Shared set-up for the receipt settlement tests of the query/inference pool
// (OT-RFC-27): the EIP-712 request and receipt formats, session keys that sign
// locally, compact signatures, receipt items, Core Node sellers, Conviction
// Account periods, and node scores.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  QueryInferenceStorage,
  RandomSamplingStorage,
  ServiceSubscriptions,
  StakingV10,
  Token,
} from '../../typechain';
import { ACCOUNT_STACK_TAGS, DAY, Domain, Terms, registerServiceContracts, signTerms } from './conviction-service';
import { createProfile } from './profile-helpers';

/**
 * The account and staking stacks with every plan-period and settlement
 * contract registered and the activation epoch set to the current epoch, as
 * the development deploy leaves them. For `loadFixture`.
 */
export async function deploySettlementStack() {
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
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    QIS,
    CSS,
    SS,
    SSW: SSW!,
    QS: QS!,
  };
}

export type SettlementStack = Awaited<ReturnType<typeof deploySettlementStack>>;

export const SCALE18 = 10n ** 18n;
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** Fault codes of `QueryInferenceSettlement.Fault`, in declaration order. */
export const Fault = {
  None: 0n,
  UnknownPeriod: 1n,
  UnknownBucket: 2n,
  PastDeadline: 3n,
  EmptyGroup: 4n,
  BadSignature: 5n,
  InactiveAssignment: 6n,
  DuplicateNonce: 7n,
  OutsideTime: 8n,
  AskOutOfRange: 9n,
  BadArithmetic: 10n,
  ZeroResultCommitment: 11n,
} as const;

// ---------------------------------------------------------------------------
// The formats
// ---------------------------------------------------------------------------

export const REQUEST_TYPES = {
  ServiceRequest: [
    { name: 'subscriptionId', type: 'bytes32' },
    { name: 'bucketId', type: 'bytes32' },
    { name: 'seller', type: 'uint72' },
    { name: 'nonce', type: 'uint64' },
    { name: 'acceptedAskWeiPerUnit', type: 'uint96' },
    { name: 'maxUnits', type: 'uint64' },
    { name: 'maxValueWei', type: 'uint96' },
    { name: 'issuedAt', type: 'uint40' },
    { name: 'expiry', type: 'uint40' },
  ],
};

export const RECEIPT_TYPES = {
  QueryInferenceReceipt: [
    { name: 'requestDigest', type: 'bytes32' },
    { name: 'resultCommitment', type: 'bytes32' },
    { name: 'units', type: 'uint64' },
    { name: 'valueWei', type: 'uint96' },
    { name: 'completedAt', type: 'uint40' },
  ],
};

export type ServiceRequest = {
  subscriptionId: string;
  bucketId: string;
  seller: bigint;
  nonce: bigint;
  acceptedAskWeiPerUnit: bigint;
  maxUnits: bigint;
  maxValueWei: bigint;
  issuedAt: bigint;
  expiry: bigint;
};

export type Receipt = {
  resultCommitment: string;
  units: bigint;
  valueWei: bigint;
  completedAt: bigint;
};

export type ReceiptItem = {
  nonce: bigint;
  acceptedAskWeiPerUnit: bigint;
  maxUnits: bigint;
  maxValueWei: bigint;
  issuedAt: bigint;
  expiry: bigint;
  units: bigint;
  valueWei: bigint;
  resultCommitment: string;
  completedAt: bigint;
  sigR: string;
  sigVS: string;
};

export type ReceiptGroup = { subscriptionId: string; bucketIndex: bigint; items: ReceiptItem[] };

/** The signing domain of requests and receipts: the verifying contract is QueryInferenceStorage. */
export async function queryInferenceDomain(qis: QueryInferenceStorage): Promise<Domain> {
  return {
    name: 'DKGQueryInference',
    version: '1',
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    verifyingContract: await qis.getAddress(),
  };
}

export const requestDigestOf = (domain: Domain, r: ServiceRequest): string =>
  ethers.TypedDataEncoder.hash(domain, REQUEST_TYPES, r);

export const receiptDigestOf = (domain: Domain, requestDigest: string, r: Receipt): string =>
  ethers.TypedDataEncoder.hash(domain, RECEIPT_TYPES, { requestDigest, ...r });

/**
 * Hardhat's deterministic account `index` as a local wallet, so a test signs
 * many requests without a round trip to the node.
 */
export function hardhatWallet(index: number): ethers.HDNodeWallet {
  const cfg = hre.network.config.accounts as { mnemonic: string; path: string; initialIndex?: number };
  return ethers.HDNodeWallet.fromPhrase(cfg.mnemonic, undefined, `${cfg.path}/${(cfg.initialIndex ?? 0) + index}`);
}

/** The EIP-2098 compact signature `(r, vs)` of `wallet` over `digest`, with a low s. */
export function signCompact(wallet: ethers.HDNodeWallet, digest: string): { sigR: string; sigVS: string } {
  const sig = wallet.signingKey.sign(digest);
  return { sigR: sig.r, sigVS: sig.yParityAndS };
}

/** The receipt of a request served in full: maxUnits at the accepted ask, completed when issued. */
export const fullReceipt = (r: ServiceRequest, overrides: Partial<Receipt> = {}): Receipt => ({
  resultCommitment: ethers.keccak256(ethers.toBeHex(r.nonce + 1n, 32)),
  units: r.maxUnits,
  valueWei: r.maxUnits * r.acceptedAskWeiPerUnit,
  completedAt: r.issuedAt,
  ...overrides,
});

/** A batch item: the request's own fields, the receipt's, and the signature. */
export const itemOf = (r: ServiceRequest, receipt: Receipt, sig: { sigR: string; sigVS: string }): ReceiptItem => ({
  nonce: r.nonce,
  acceptedAskWeiPerUnit: r.acceptedAskWeiPerUnit,
  maxUnits: r.maxUnits,
  maxValueWei: r.maxValueWei,
  issuedAt: r.issuedAt,
  expiry: r.expiry,
  units: receipt.units,
  valueWei: receipt.valueWei,
  resultCommitment: receipt.resultCommitment,
  completedAt: receipt.completedAt,
  ...sig,
});

/**
 * Requests of one bucket of one period, signed by its session key, and the
 * items that claim them: `count` requests with nonces from `firstNonce`, each
 * of `units` units at `ask`, issued at `issuedAt` and valid for a day.
 */
export function signedItems(opts: {
  domain: Domain;
  wallet: ethers.HDNodeWallet;
  subscriptionId: string;
  bucketId: string;
  seller: bigint;
  firstNonce?: bigint;
  count: number;
  units?: bigint;
  ask?: bigint;
  issuedAt: bigint;
  expiry?: bigint;
}): { requests: ServiceRequest[]; receipts: Receipt[]; items: ReceiptItem[] } {
  const requests: ServiceRequest[] = [];
  const receipts: Receipt[] = [];
  const items: ReceiptItem[] = [];
  for (let i = 0; i < opts.count; i++) {
    const units = opts.units ?? 1_000n;
    const ask = opts.ask ?? 10n ** 9n;
    const r: ServiceRequest = {
      subscriptionId: opts.subscriptionId,
      bucketId: opts.bucketId,
      seller: opts.seller,
      nonce: (opts.firstNonce ?? 0n) + BigInt(i),
      acceptedAskWeiPerUnit: ask,
      maxUnits: units,
      maxValueWei: units * ask,
      issuedAt: opts.issuedAt,
      expiry: opts.expiry ?? opts.issuedAt + DAY,
    };
    const receipt = fullReceipt(r);
    requests.push(r);
    receipts.push(receipt);
    items.push(itemOf(r, receipt, signCompact(opts.wallet, requestDigestOf(opts.domain, r))));
  }
  return { requests, receipts, items };
}

/** keccak256 of the concatenated digests: a group's or a batch's digest. */
export const digestOfDigests = (digests: string[]): string => ethers.keccak256(ethers.concat(digests));

/** The stake factor RandomSampling computes: sqrt(floor(min(stake, cap) × 1e18 / cap) × 1e18). */
export function stakeFactorOf(stake: bigint, cap: bigint): bigint {
  const capped = stake > cap ? cap : stake;
  return isqrt(((capped * SCALE18) / cap) * SCALE18);
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Core Node sellers and their scores
// ---------------------------------------------------------------------------

/**
 * A node with a profile, its operational and admin keys, and, with a stake, a
 * conviction position of that much TRAC at `lockTier` (0, the 1x rest state,
 * by default): at the minimum stake or more, staking also places it in the
 * sharding table, as on the production path.
 */
export async function createNode(opts: {
  Profile: Profile;
  Token: Token;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  operational: SignerWithAddress;
  admin: SignerWithAddress;
  stake?: bigint;
  lockTier?: bigint;
}): Promise<bigint> {
  const { identityId } = await createProfile(opts.Profile, { operational: opts.operational, admin: opts.admin });
  if (opts.stake !== undefined && opts.stake > 0n) {
    await stakeOn(opts, BigInt(identityId), opts.stake, opts.lockTier ?? 0n);
  }
  return BigInt(identityId);
}

/** Stake `amount` more on `identityId`, as a position of the operational key at `lockTier`. */
export async function stakeOn(
  opts: { Token: Token; StakingV10: StakingV10; StakingNFT: DKGStakingConvictionNFT; operational: SignerWithAddress },
  identityId: bigint,
  amount: bigint,
  lockTier = 0n,
): Promise<void> {
  await opts.Token.mint(opts.operational.address, amount);
  await opts.Token.connect(opts.operational).approve(await opts.StakingV10.getAddress(), amount);
  await opts.StakingNFT.connect(opts.operational).createConviction(identityId, amount, lockTier);
}

/**
 * Give `identityId` a node score in `epoch`, as a valid proof would: the Hub
 * owner passes RandomSamplingStorage's `onlyContracts`, standing in for
 * RandomSampling.
 */
export async function scoreNode(rss: RandomSamplingStorage, epoch: bigint, identityId: bigint, score = SCALE18) {
  await rss.addToNodeEpochScore(epoch, identityId, score);
  await rss.addToAllNodesEpochScore(epoch, score);
}

// ---------------------------------------------------------------------------
// Conviction Account periods
// ---------------------------------------------------------------------------

/**
 * An opted-in Conviction Account of `owner`, committing `committed` TRAC (its
 * tier follows), with `assignee` assigned under a per-period limit until
 * `expiresAt`.
 */
export async function openConvictionAccount(opts: {
  Token: Token;
  NFT: DKGPublishingConvictionNFT;
  SS: ServiceSubscriptions;
  CSS: ConvictionServiceStorage;
  owner: SignerWithAddress;
  assignee: SignerWithAddress;
  committed: bigint;
  limit: bigint;
  expiresAt?: bigint;
}): Promise<{ accountId: bigint; terms: Terms }> {
  await opts.Token.mint(opts.owner.address, opts.committed);
  await opts.Token.connect(opts.owner).approve(await opts.NFT.getAddress(), opts.committed);
  await (await opts.NFT.connect(opts.owner).createAccount(opts.committed, 0)).wait();
  const accountId = await opts.NFT.totalSupply();
  await opts.SS.connect(opts.owner).setServiceSpending(accountId, true);
  const latest = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
  const terms: Terms = {
    accountId,
    assignee: opts.assignee.address,
    maxCostPerPeriod: opts.limit,
    expiresAt: opts.expiresAt ?? latest + 400n * DAY,
    nonce: await opts.CSS.assignmentNonce(accountId),
  };
  await opts.SS.connect(opts.owner).assign(terms, '0x', await signTerms(opts.assignee, opts.SS, terms));
  return { accountId, terms };
}
