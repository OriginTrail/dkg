// The smoke test's settings: the environment, the amounts of a run, and the gas
// it plans for.

import * as path from 'path';

import { ethers } from 'ethers';

import type { BaseContracts } from '../contracts';
import { UNIT_PRICE } from '../plans';
import { fmt } from '../report';
import { Amounts, PHASES, PhaseName, SmokeState } from './state';

const TRAC = 10n ** 18n;

export const LIVE_JSON = 'deployments/base_sepolia_v10_contracts.json';
export const RESULTS_DIR = path.join('cache', 'rfc27-smoke');
/** Setup and serve both land in E, whose end is the deadline of every batch: setup starts with at least this much of E left. */
export const MIN_EPOCH_LEFT = 3_600n;
/** A withdrawal "in the middle of an epoch": not within 10 minutes of either end. */
export const MID_EPOCH_MARGIN = 600n;

/**
 * The gas each role's transactions are planned at, for the balance check, and
 * how many it sends: about twice what the fork run measured (owner 3.27M over 16
 * transactions, buyer 0.75M over 2, edge buyer 0.47M, seller 0.62M over
 * 2). The gas limits come from each transaction's own estimate.
 */
export const PLANNED_GAS = {
  owner: { gas: 6_600_000n, txs: 16n },
  buyer: { gas: 1_550_000n, txs: 2n },
  edgeBuyer: { gas: 1_000_000n, txs: 1n },
  seller: { gas: 1_250_000n, txs: 2n },
};
/** Per transaction: Base adds an L1 data fee to the gas. */
export const L1_FEE_ALLOWANCE = 10n ** 13n;

/** Twice the planned gas at the max fee, which the sender's balance must cover up front, and the L1 data fee. */
export const gasCost = (gas: bigint, txs: bigint, maxFee: bigint): bigint => 2n * gas * maxFee + txs * L1_FEE_ALLOWANCE;

/** How far a run has got, as the journal and the chain confirm it. */
export type Progress = {
  staked: boolean;
  accountCreated: boolean;
  walletFunded: boolean;
  buyerFunded: boolean;
  edgeBuyerFunded: boolean;
  /** The transactions each role has sent. */
  sent: { owner: bigint; buyer: bigint; edgeBuyer: bigint; seller: bigint };
};

export const NOTHING_YET: Progress = { staked: false, accountCreated: false, walletFunded: false, buyerFunded: false, edgeBuyerFunded: false, sent: { owner: 0n, buyer: 0n, edgeBuyer: 0n, seller: 0n } };

/** What a run still spends: only what its remaining steps will. */
export function needsOf(a: Amounts, maxFee: bigint, p: Progress) {
  const gasLeft = (role: keyof Progress['sent']): bigint => {
    const { gas, txs } = PLANNED_GAS[role];
    const left = txs > p.sent[role] ? txs - p.sent[role] : 0n;
    return gasCost((gas * left) / txs, left, maxFee);
  };
  return {
    ownerTrac: (p.accountCreated ? 0n : a.committed) + (p.walletFunded ? 0n : a.walletValue) + (p.staked ? 0n : a.stake),
    ownerEth: gasLeft('owner') + (p.buyerFunded ? 0n : a.keyEth) + (p.edgeBuyerFunded ? 0n : a.keyEth),
    sellerEth: gasLeft('seller'),
    buyerEth: gasLeft('buyer'),
    edgeBuyerEth: gasLeft('edgeBuyer'),
  };
}

export type SmokeEnv = {
  phase: PhaseName;
  send: boolean;
  /** Fork-only: move the clock to the first moment a phase may run. */
  warp: boolean;
  /** Fork-only: write the seller's proofs where the real node would have proved. */
  proofs: boolean;
  /** Fork-only: end the process right after the journal records this step, as a crash would. */
  stopAfter?: string;
  run: string;
  stateFile: string;
};

export function readEnv(): SmokeEnv {
  const phase = PHASES.find((p) => p === (process.env.PHASE ?? 'check'));
  if (!phase) throw new Error(`set PHASE to one of ${PHASES.join(', ')}`);
  const run = process.env.RFC27_SMOKE_RUN ?? 'smoke';
  // No dots: a run's state and its reports share a directory, and `<run>.<phase>.json` must never name another run's state.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) throw new Error('RFC27_SMOKE_RUN must be 1 to 64 letters, digits, dashes or underscores');
  return {
    phase,
    send: process.env.SEND === '1',
    warp: process.env.FORK_WARP === '1',
    proofs: process.env.FORK_PROOFS === '1',
    stopAfter: process.env.FORK_STOP_AFTER || undefined,
    run,
    stateFile: path.join(RESULTS_DIR, `${run}.json`),
  };
}

export function amountFromEnv(name: string, def: string): bigint {
  const raw = process.env[name] ?? def;
  let v: bigint;
  try {
    v = ethers.parseEther(raw);
  } catch {
    throw new Error(`${name} must be a decimal amount, got "${raw}"`);
  }
  if (v <= 0n) throw new Error(`${name} must be above 0`);
  return v;
}

/**
 * The amounts of a new run, from the environment and the lock on chain. A
 * running one reads its own from the state. There is no contract minimum for
 * a commitment: the floor is the lock times what the run spends in the first
 * billing window, the account subscription, its top-up and the edge subscription, at no
 * discount. The default rounds the spends up to whole TRAC and adds 1 TRAC a
 * window, so the first window keeps room beyond the run's own spends.
 */
export async function plannedAmounts(c: BaseContracts, state: SmokeState | undefined, maxFee: bigint): Promise<Amounts> {
  if (state) return state.amounts;
  const lock = await c.params.publishingConvictionEpochs();
  const caValue = amountFromEnv('RFC27_SMOKE_CA_VALUE', '3');
  const caTopUp = amountFromEnv('RFC27_SMOKE_CA_TOPUP', '1');
  const edgeValue = amountFromEnv('RFC27_SMOKE_EDGE_VALUE', '0.5');
  const walletValue = amountFromEnv('RFC27_SMOKE_WALLET_VALUE', '2');
  for (const [n, v, units] of [
    ['RFC27_SMOKE_CA_VALUE', caValue, 2n],
    ['RFC27_SMOKE_CA_TOPUP', caTopUp, 2n],
    ['RFC27_SMOKE_EDGE_VALUE', edgeValue, 1n],
    ['RFC27_SMOKE_WALLET_VALUE', walletValue, 4n],
  ] as const) {
    if (v < units * UNIT_PRICE) throw new Error(`${n} must be at least ${fmt(units * UNIT_PRICE)} TRAC: each request is at least one unit of ${fmt(UNIT_PRICE)} TRAC`);
  }
  const spends = caValue + caTopUp + edgeValue;
  const committedFloor = lock * spends;
  const committed = process.env.RFC27_SMOKE_COMMITTED
    ? amountFromEnv('RFC27_SMOKE_COMMITTED', '0')
    : lock * (((spends + TRAC - 1n) / TRAC) * TRAC + TRAC);
  if (committed < committedFloor) {
    throw new Error(
      `RFC27_SMOKE_COMMITTED is ${fmt(committed)} TRAC, under the ${fmt(committedFloor)} TRAC the run spends: the lock of ${lock} windows times the ${fmt(spends)} TRAC spent in the first`,
    );
  }
  if (committed >= 1n << 96n) throw new Error('RFC27_SMOKE_COMMITTED does not fit a uint96');
  // Each derived buyer's ETH: 0.0002, or what its gas needs at the current fee if that is more.
  const need = gasCost(PLANNED_GAS.buyer.gas > PLANNED_GAS.edgeBuyer.gas ? PLANNED_GAS.buyer.gas : PLANNED_GAS.edgeBuyer.gas, 2n, maxFee);
  const step = 10n ** 14n;
  const keyEthDefault = need > 2n * step ? ((need + step - 1n) / step) * step : 2n * step;
  return {
    stake: amountFromEnv('RFC27_SMOKE_STAKE', '50'),
    caValue,
    caTopUp,
    edgeValue,
    walletValue,
    keyEth: process.env.RFC27_SMOKE_KEY_ETH ? amountFromEnv('RFC27_SMOKE_KEY_ETH', '0') : keyEthDefault,
    committed,
    committedFloor,
    lock,
    discountBps: await c.nft.getDiscountBps(committed),
  };
}

/** Units of UNIT_PRICE each request carries, and how many requests: per batch group. */
export type RequestPlan = { caFirst: { count: number; units: bigint }; caAfterTopUp: { count: number; units: bigint }; wallet: { count: number; units: bigint } };

/**
 * The requests the serve phase signs: two account requests up to the
 * subscription's value before the top-up, one more after it, and two wallet
 * requests of a quarter of the wallet subscription each.
 */
export function requestPlan(a: Amounts): RequestPlan {
  return {
    caFirst: { count: 2, units: a.caValue / 2n / UNIT_PRICE },
    caAfterTopUp: { count: 1, units: a.caTopUp / 2n / UNIT_PRICE },
    wallet: { count: 2, units: a.walletValue / 4n / UNIT_PRICE },
  };
}

export const planValue = (g: { count: number; units: bigint }): bigint => BigInt(g.count) * g.units * UNIT_PRICE;
