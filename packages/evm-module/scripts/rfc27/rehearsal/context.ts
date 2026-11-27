// What every phase of the fork rehearsal works with, built once by the entry
// point: the chain guard, which admits the local anvil fork only; the contracts
// through the Hub; the fork's own operations; the report; and every
// transaction a phase sends, through the shared runner, which checks its
// estimate against 2^24 first.

import * as fs from 'fs';

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { Signer, TransactionReceipt } from 'ethers';

import { BaseContracts, Contracts, Stack, errorMessage } from '../contracts';
import { Fork } from '../fork';
import { Net, guardNetwork } from '../network';
import { Report } from '../report';
import { TX_GAS_CAP, TxReverted, TxRunner } from '../tx';
import { deepestFailure } from './plumbing';
import { CheckEntry, TxEntry, asNumber, asObject, asString, save } from './results';

export const LIVE_JSON = 'deployments/base_sepolia_v10_contracts.json';

/** An entry of the tracked deployments file: where a contract was before the upgrade, and when it was deployed (ms). */
export type LiveEntry = { evmAddress: string; deploymentTimestamp: number };

function readLive(): Readonly<Record<string, LiveEntry>> {
  const contracts = asObject(asObject(JSON.parse(fs.readFileSync(LIVE_JSON, 'utf8')), LIVE_JSON).contracts, `${LIVE_JSON}.contracts`);
  const out: Record<string, LiveEntry> = {};
  for (const [name, v] of Object.entries(contracts)) {
    const e = asObject(v, `${LIVE_JSON}.contracts.${name}`);
    out[name] = {
      evmAddress: asString(e.evmAddress, `${LIVE_JSON}.contracts.${name}.evmAddress`),
      deploymentTimestamp: e.deploymentTimestamp === undefined ? 0 : asNumber(e.deploymentTimestamp, `${LIVE_JSON}.contracts.${name}.deploymentTimestamp`),
    };
  }
  return out;
}

/** The tracked deployments file, read, never written. */
export const LIVE = readLive();
export const HUB = LIVE.Hub.evmAddress;

export type Ctx = {
  hre: HardhatRuntimeEnvironment;
  net: Net;
  report: Report;
  stack: Stack;
  base: BaseContracts;
  fork: Fork;
  tx: TxRunner;
  /** The transactions the phase sent, in order, as its results file lists them. */
  txs: TxEntry[];
};

export async function createContext(hre: HardhatRuntimeEnvironment, report: Report): Promise<Ctx> {
  const net = await guardNetwork(hre, report.redactor);
  if (!net.local) throw new Error(`refusing to run: the rehearsal runs on the local anvil fork only, and this is ${net.name}`);
  const stack = await Stack.at(hre, HUB);
  return { hre, net, report, stack, base: await stack.base(), fork: new Fork(hre, net, report), tx: new TxRunner(hre, report), txs: [] };
}

/** The OT-RFC-27 contracts too, as the Hub holds them now. */
export async function withPool(ctx: Ctx): Promise<Contracts> {
  return { ...ctx.base, ...(await ctx.stack.pool()) };
}

export type Sent = { receipt: TransactionReceipt; gasUsed: bigint };

/** FORK-ONLY: a part of a transaction's label; a phase fails just before it, to show what its snapshots restore. */
const FAIL_AT = process.env.REHEARSAL_FAIL_AT;

/**
 * One transaction, through the shared runner: estimated, the estimate, its
 * smallest gas limit, checked against 2^24 as a check of its own (anvil does
 * not enforce EIP-7825's cap, which Base Sepolia does), then sent with a gas
 * limit set by hand. Without `to`, `data` is a contract's creation code. A
 * transaction whose estimate does not fit is not sent, and the phase stops;
 * a revert is recorded and rethrown.
 */
export async function send(ctx: Ctx, label: string, signer: Signer, to: string | undefined, data: string): Promise<Sent> {
  if (FAIL_AT && label.includes(FAIL_AT)) throw new Error(`REHEARSAL_FAIL_AT: stopping before "${label}"`);
  let result;
  try {
    result = await ctx.tx.run({ label, signer, to, data });
  } catch (e: unknown) {
    const hash = e instanceof TxReverted ? e.receipt.hash : undefined;
    const why = hash ? await deepestFailure(ctx, hash) : errorMessage(e);
    ctx.txs.push(hash ? { label, hash, status: 0, error: why } : { label, status: 'reverted before inclusion', error: why });
    ctx.report.note(`✗ ${label}: ${hash ? `reverted on chain, ${why}` : why}`);
    throw e;
  }
  const { receipt, estimate, gasLimit } = result;
  const gasUsed = receipt.gasUsed;
  ctx.txs.push({
    label,
    hash: receipt.hash,
    block: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    gasUsed,
    gasLimit,
    estimate,
    overTxGasCap: gasUsed > TX_GAS_CAP,
    status: receipt.status ?? 0,
  });
  return { receipt, gasUsed };
}

/** A call that must revert, simulated from `from` and never sent: its decoded error. */
export async function expectRevert(ctx: Ctx, label: string, from: string, to: string, data: string): Promise<string> {
  const why = await ctx.tx.refusal(from, to, data);
  ctx.report.note(why === 'did not revert' ? `✗ ${label} did NOT revert` : `✓ ${label} reverts: ${why}`);
  return why;
}

/** Whether a call from `from` would go through now. */
export async function succeeds(ctx: Ctx, from: string, to: string, data: string): Promise<boolean> {
  try {
    await ctx.tx.call(from, to, data);
    return true;
  } catch {
    return false;
  }
}

export const checksOf = (report: Report): CheckEntry[] => report.checks.map((c) => [c.label, c.ok, c.detail]);

/** Writes the phase's results file, with its transactions and its checks, unless told to leave either out. */
export function saveResults(ctx: Ctx, name: string, data: { [key: string]: unknown }, o: { txs?: boolean; checks?: boolean } = {}): void {
  const out: { [key: string]: unknown } = { ...data };
  if (o.txs !== false) out.txs = ctx.txs;
  if (o.checks !== false) out.checks = checksOf(ctx.report);
  if (ctx.report.forkOnly.length) out.forkOnly = ctx.report.forkOnly;
  const file = save(name, out, ctx.report.redactor);
  ctx.report.say(`\n→ wrote ${file}`);
}
