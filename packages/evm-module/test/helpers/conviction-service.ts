// Shared set-up for the Conviction Account service spending tests (OT-RFC-27):
// Hub registration of ConvictionServiceStorage and ServiceSubscriptions, the
// EIP-712 ServiceAssignment consent, funding requests, a model of the label
// basis, and synthetic accounts from before the schedule cut-over.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  DKGPublishingConvictionNFT,
  Hub,
  PublishingConvictionStorage,
  ServiceSubscriptions,
} from '../../typechain';
import { PoolModel, prorateActiveSink } from './emission-model';

export const TRAC = 10n ** 18n;
export const DAY = 86_400n;
export const BPS = 10_000n;
export const CLASS_INFERENCE = 1n;
export const CLASS_QUERY = 2n;

/** The deploy tags of the account stack, as the publishing conviction suites use them. */
export const ACCOUNT_STACK_TAGS = [
  'Token',
  'AskStorage',
  'EpochStorage',
  'Chronos',
  'Profile',
  'Identity',
  'KnowledgeAssetsLifecycle',
  'ContextGraphStorage',
  'ContextGraphs',
  'ContextGraphValueStorage',
  'ContextGraphWaiverStorage',
  'DKGPublishingConvictionNFT',
  'DKGStakingConvictionNFT',
  'StakingV10',
];

/**
 * Deploy ConvictionServiceStorage and ServiceSubscriptions and register both in
 * the Hub's contract set, as the development deploy helper does: the Hub
 * registration, then `initialize()` through `Hub.forwardCall`. The storage
 * comes first, because ServiceSubscriptions wires it at initialization.
 */
export async function registerServiceContracts(hub: Hub): Promise<{
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
}> {
  const hubAddress = await hub.getAddress();

  const CSS = (await (
    await hre.ethers.getContractFactory('ConvictionServiceStorage')
  ).deploy(hubAddress)) as unknown as ConvictionServiceStorage;
  await CSS.waitForDeployment();
  await hub.setContractAddress('ConvictionServiceStorage', await CSS.getAddress());
  await hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData('initialize'));

  const SS = (await (
    await hre.ethers.getContractFactory('ServiceSubscriptions')
  ).deploy(hubAddress)) as unknown as ServiceSubscriptions;
  await SS.waitForDeployment();
  await hub.setContractAddress('ServiceSubscriptions', await SS.getAddress());
  await hub.forwardCall(await SS.getAddress(), SS.interface.encodeFunctionData('initialize'));

  return { CSS, SS };
}

/** Set the schedule cut-over through Hub.forwardCall; defaults to the latest block time. */
export async function setExactScheduleFrom(
  hub: Hub,
  css: ConvictionServiceStorage,
  timestamp?: bigint,
): Promise<bigint> {
  const ts = timestamp ?? BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
  await hub.forwardCall(await css.getAddress(), css.interface.encodeFunctionData('setExactScheduleFrom', [ts]));
  return ts;
}

// ---------------------------------------------------------------------------
// EIP-712 consent
// ---------------------------------------------------------------------------

export const SERVICE_ASSIGNMENT_TYPES = {
  ServiceAssignment: [
    { name: 'accountId', type: 'uint256' },
    { name: 'assignee', type: 'address' },
    { name: 'maxCostPerPeriod', type: 'uint96' },
    { name: 'maxInferenceCostPerPeriod', type: 'uint96' },
    { name: 'maxQueryCostPerPeriod', type: 'uint96' },
    { name: 'maxCostPerWindow', type: 'uint96' },
    { name: 'maxTotalCost', type: 'uint96' },
    { name: 'maxPeriodSeconds', type: 'uint32' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'uint64' },
  ],
};

export type Terms = {
  accountId: bigint;
  assignee: string;
  maxCostPerPeriod: bigint;
  maxInferenceCostPerPeriod: bigint;
  maxQueryCostPerPeriod: bigint;
  maxCostPerWindow: bigint;
  maxTotalCost: bigint;
  maxPeriodSeconds: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

export type Caps = Omit<Terms, 'accountId' | 'assignee' | 'nonce'>;

export const capsOf = (t: Terms): Caps => ({
  maxCostPerPeriod: t.maxCostPerPeriod,
  maxInferenceCostPerPeriod: t.maxInferenceCostPerPeriod,
  maxQueryCostPerPeriod: t.maxQueryCostPerPeriod,
  maxCostPerWindow: t.maxCostPerWindow,
  maxTotalCost: t.maxTotalCost,
  maxPeriodSeconds: t.maxPeriodSeconds,
  expiresAt: t.expiresAt,
});

export type Domain = { name: string; version: string; chainId: bigint; verifyingContract: string };

export async function domainOf(ss: ServiceSubscriptions): Promise<Domain> {
  return {
    name: 'DKGConvictionServices',
    version: '1',
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    verifyingContract: await ss.getAddress(),
  };
}

/** A 65-byte (r, s, v) EIP-712 signature over the terms. */
export async function signTerms(
  signer: SignerWithAddress,
  ss: ServiceSubscriptions,
  terms: Terms,
  domain?: Domain,
): Promise<string> {
  return signer.signTypedData(domain ?? (await domainOf(ss)), SERVICE_ASSIGNMENT_TYPES, terms);
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The malleated twin of a low-s signature: s' = n − s and the other v. It recovers to the same signer. */
export function highS(signature: string): string {
  const sig = ethers.Signature.from(signature);
  const s = SECP256K1_N - BigInt(sig.s);
  const v = sig.v === 27 ? 28 : 27;
  return ethers.concat([sig.r, ethers.toBeHex(s, 32), ethers.toBeHex(v, 1)]);
}

/** The EIP-2098 64-byte (r, vs) form of a signature. */
export function compact(signature: string): string {
  const sig = ethers.Signature.from(signature);
  return ethers.concat([sig.r, sig.yParityAndS]);
}

// ---------------------------------------------------------------------------
// Funding requests
// ---------------------------------------------------------------------------

export type Bucket = { bucketId: string; serviceClass: bigint; value: bigint; maxAskWeiPerUnit: bigint };

export type Request = {
  accountId: bigint;
  periodId: string;
  sessionKey: string;
  periodSeconds: bigint;
  planDigest: string;
  buckets: Bucket[];
};

/** A bucket id that sorts by `rank`, so tests can order buckets explicitly. */
export const bucketId = (rank: number): string => ethers.toBeHex(BigInt(rank) + 1n, 32);

export const bucket = (
  rank: number,
  serviceClass: bigint,
  value: bigint,
  maxAskWeiPerUnit: bigint = 10n ** 12n,
): Bucket => ({ bucketId: bucketId(rank), serviceClass, value, maxAskWeiPerUnit });

export const SESSION_KEY = ethers.getAddress('0x00000000000000000000000000000000005e5510');

let periodCounter = 0;

/** A one-bucket inference request with a fresh period id. */
export function requestOf(accountId: bigint, overrides: Partial<Request> = {}): Request {
  periodCounter += 1;
  return {
    accountId,
    periodId: ethers.id(`period-${periodCounter}`),
    sessionKey: SESSION_KEY,
    periodSeconds: 7n * DAY,
    planDigest: ethers.id(`plan-${periodCounter}`),
    buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC)],
    ...overrides,
  };
}

/** The discounted cost of a value, with the 1-wei floor, as publishing computes it. */
export const costOf = (value: bigint, bps: bigint): bigint => {
  if (value === 0n) return 0n;
  const cost = (value * (BPS - bps)) / BPS;
  return cost === 0n ? 1n : cost;
};

/** The smallest value whose discounted cost is exactly `cost`. */
export const valueFor = (cost: bigint, bps: bigint): bigint => (cost * BPS + (BPS - bps) - 1n) / (BPS - bps);

// ---------------------------------------------------------------------------
// The label basis
// ---------------------------------------------------------------------------

/**
 * The emission per epoch of an account whose window w spreads `amounts[w]`
 * forward from its close, as the schedule written at creation or migration
 * does: prorateActiveSink over the lock, anchored at each window's close. With
 * a carry of 0 every range divides exactly, so this is S(e).
 */
export async function emissionOfWindows(opts: {
  chronos: Chronos;
  amounts: bigint[];
  createdAt: bigint;
  lock: bigint;
  epLen: bigint;
}): Promise<Map<bigint, bigint>> {
  const model = new PoolModel(0n);
  for (let w = 0n; w < opts.lock; w++) {
    const amount = opts.amounts[Number(w)];
    if (amount === 0n) continue;
    const fromTs = opts.createdAt + (w + 1n) * opts.epLen;
    const anchor = await opts.chronos.epochAtTimestamp(fromTs);
    const timeRemaining = (await opts.chronos.timestampForEpoch(anchor + 1n)) - fromTs;
    for (const r of prorateActiveSink(amount, anchor, opts.lock, opts.epLen, timeRemaining)) model.add(r);
  }
  return model.perEpoch;
}

/**
 * The window amounts of the label basis. An account created at or after the
 * cut-over has its window budget in every window; an older one has 0 for a
 * window that closed by the cut-over and the budget less what publishing drew
 * (window spend less service spend) for any other, rounded down to a multiple
 * of the lock. The last window also carries the `committed mod lock` dust.
 */
export function basisAmounts(opts: {
  committed: bigint;
  lock: bigint;
  epLen: bigint;
  createdAt: bigint;
  cutOver: bigint;
  published?: (w: bigint) => bigint;
}): bigint[] {
  const budget = opts.committed / opts.lock;
  const dust = opts.committed - budget * opts.lock;
  const exact = opts.createdAt >= opts.cutOver;
  const out: bigint[] = [];
  for (let w = 0n; w < opts.lock; w++) {
    let amount = 0n;
    if (exact) {
      amount = budget;
    } else if (opts.createdAt + (w + 1n) * opts.epLen > opts.cutOver) {
      const published = opts.published ? opts.published(w) : 0n;
      amount = budget > published ? budget - published : 0n;
    }
    if (w === opts.lock - 1n) amount += dust;
    if (!exact) amount -= amount % opts.lock;
    out.push(amount);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accounts from before the schedule cut-over
// ---------------------------------------------------------------------------

let ownersSlot: bigint | undefined;

/** The storage slot of OpenZeppelin ERC721's `_owners` in the account NFT, from the compiler's layout. */
async function nftOwnersSlot(): Promise<bigint> {
  if (ownersSlot !== undefined) return ownersSlot;
  const sourceName = 'contracts/DKGPublishingConvictionNFT.sol';
  const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:DKGPublishingConvictionNFT`);
  const output = buildInfo?.output.contracts[sourceName].DKGPublishingConvictionNFT as unknown as
    | { storageLayout?: { storage: Array<{ label: string; slot: string }> } }
    | undefined;
  const entry = output?.storageLayout?.storage.find((s) => s.label === '_owners');
  if (!entry) throw new Error('no storage layout for DKGPublishingConvictionNFT._owners');
  ownersSlot = BigInt(entry.slot);
  return ownersSlot;
}

/**
 * Write an account record the way an older build left it: created at
 * `createdAt`, with `lastSettledWindow` windows already swept under the old
 * per-window rules and `spent` drawn per window, but no up-front schedule. The
 * record goes straight into PublishingConvictionStorage (the Hub owner passes
 * its `onlyContracts`), and the NFT's ERC-721 owner slot is set to `owner`, so
 * the account has an owner without the creation path that would schedule it.
 */
export async function writeLegacyAccount(opts: {
  pcs: PublishingConvictionStorage;
  nft: DKGPublishingConvictionNFT;
  chronosEpochAt: (ts: bigint) => Promise<bigint>;
  accountId: bigint;
  owner: string;
  committed: bigint;
  createdAt: bigint;
  lock: bigint;
  epLen: bigint;
  discountBps?: bigint;
  lastSettledWindow?: bigint;
  spent?: Map<bigint, bigint>;
}): Promise<void> {
  const createdEpoch = await opts.chronosEpochAt(opts.createdAt);
  const expiresAt = opts.createdAt + opts.lock * opts.epLen;
  const expiresEpoch = (await opts.chronosEpochAt(expiresAt - 1n)) + 1n;
  await opts.pcs.createAccount(opts.accountId, {
    committedTRAC: opts.committed,
    createdAtEpoch: createdEpoch,
    expiresAtEpoch: expiresEpoch,
    createdAtTimestamp: opts.createdAt,
    expiresAtTimestamp: expiresAt,
    lockDurationEpochs: opts.lock,
    discountBps: opts.discountBps ?? 0n,
    lastSettledWindow: opts.lastSettledWindow ?? 0n,
    fullySwept: false,
    primaryNode: 0,
    lastPrimaryNodeChangeEpoch: createdEpoch,
  });
  for (const [w, amount] of opts.spent ?? new Map()) {
    await opts.pcs.increaseWindowSpent(opts.accountId, w, amount);
  }
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [opts.accountId, await nftOwnersSlot()]),
  );
  await hre.network.provider.send('hardhat_setStorageAt', [
    await opts.nft.getAddress(),
    slot,
    ethers.zeroPadValue(opts.owner, 32),
  ]);
}
