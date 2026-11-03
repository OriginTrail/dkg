// What every phase of the smoke test works with, built once by the entry point.

import * as fs from 'fs';

import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { BaseContracts, Contracts, Stack } from '../contracts';
import { Fork, notBefore } from '../fork';
import { Marketplace } from '../marketplace';
import { Net, chainNow } from '../network';
import { Report } from '../report';
import { TxRunner } from '../tx';
import { LIVE_JSON, SmokeEnv } from './config';
import { Roles } from './roles';
import { SmokeState, StateFile } from './state';

export type Ctx = {
  hre: HardhatRuntimeEnvironment;
  env: SmokeEnv;
  net: Net;
  report: Report;
  stack: Stack;
  base: BaseContracts;
  fork: Fork;
  file: StateFile;
  tx: TxRunner;
  roles: Roles;
};

/** A context of a deployed stack: the pool contracts and the marketplace operations too. */
export type PoolCtx = Ctx & { c: Contracts; market: Marketplace };

export const HUB = (JSON.parse(fs.readFileSync(LIVE_JSON, 'utf8')) as { contracts: { Hub: { evmAddress: string } } }).contracts.Hub.evmAddress;

export async function withPool(ctx: Ctx): Promise<PoolCtx> {
  const c: Contracts = { ...ctx.base, ...(await ctx.stack.pool()) };
  return { ...ctx, c, market: new Marketplace(c, ctx.tx) };
}

export const now = (ctx: Ctx): Promise<bigint> => chainNow(ctx.hre);

/** The phase may run from `ts`: see fork.notBefore. */
export const opensAt = (ctx: Ctx, ts: bigint, what: string): Promise<boolean> =>
  notBefore({ hre: ctx.hre, fork: ctx.fork, report: ctx.report, warp: ctx.env.warp }, ts, what);

export const epochStart = (ctx: Ctx, e: bigint): Promise<bigint> => ctx.base.chronos.timestampForEpoch(e);

/**
 * Binds the state file to this network: a fork run never resumes on testnet,
 * nor the reverse, nor a run of another Hub, settlement, fork block or owner.
 */
export async function bindState(ctx: PoolCtx): Promise<SmokeState | undefined> {
  const s = ctx.file.load();
  if (!s) return undefined;
  const network = ctx.net.local ? 'fork' : 'base-sepolia';
  const settlement = await ctx.c.qs.getAddress();
  const problems: string[] = [];
  if (s.network !== network) problems.push(`it is a ${s.network} run, this is ${network}`);
  if (s.chainId !== ctx.net.chainId) problems.push(`chain ${s.chainId}`);
  if (s.hub.toLowerCase() !== HUB.toLowerCase()) problems.push(`Hub ${s.hub}`);
  if (s.settlement.toLowerCase() !== settlement.toLowerCase()) problems.push(`settlement ${s.settlement}, the Hub now holds ${settlement}`);
  if (ctx.net.local && s.forkBlock !== ctx.net.forkBlock) problems.push(`fork block ${s.forkBlock}, this fork is at ${ctx.net.forkBlock}`);
  if (ctx.roles.ownerAddr && s.addresses.owner !== ctx.roles.ownerAddr) problems.push(`owner ${s.addresses.owner}, this key is ${ctx.roles.ownerAddr}`);
  if (problems.length) throw new Error(`${ctx.file.file} belongs to another run: ${problems.join('; ')}. Use another RFC27_SMOKE_RUN`);
  return s;
}

/** The state of a run that has started, bound to this network. */
export async function runState(ctx: PoolCtx, after: 'setup' | 'serve' | 'close-claim'): Promise<SmokeState> {
  const s = await bindState(ctx);
  if (!s) throw new Error(`${ctx.file.file} is missing: run PHASE=setup SEND=1 first`);
  if (!ctx.file.done(after)) throw new Error(`run PHASE=${after} SEND=1 first`);
  return s;
}

/** A phase that completed earlier: say so, and keep the results it wrote then. */
export function doneEarlier(ctx: Ctx, what: string): boolean {
  if (!ctx.file.done(ctx.env.phase)) return false;
  ctx.report.note(`${ctx.env.phase} is done${what ? `: ${what}` : ''}`);
  ctx.report.status = 'done earlier';
  return true;
}

/** Marks the phase done once it ran to its end with SEND=1. */
export function complete(ctx: Ctx): void {
  if (ctx.env.send && !ctx.report.stopped && ctx.report.status === 'ran') ctx.file.markDone(ctx.env.phase, ctx.report.failed);
}

/** FORK-ONLY: the seller's next proof, where the real node would have proved, with FORK_PROOFS=1. */
export async function standInProof(ctx: PoolCtx, why: string): Promise<boolean> {
  if (!ctx.net.local || !ctx.env.proofs) return false;
  const s = ctx.file.s;
  s.fork ??= { proofs: [] };
  if (s.fork.mirrorScore === undefined) {
    // What the seller scored in the last full epoch before the fork.
    const block = await ctx.hre.ethers.provider.getBlock(Number(ctx.net.forkBlock));
    const forkEpoch = await ctx.c.chronos.epochAtTimestamp(BigInt(block?.timestamp ?? 0));
    const scored = await ctx.c.rss.getNodeEpochScore(forkEpoch - 1n, s.sellerId);
    s.fork.mirrorScore = scored > 0n ? scored : 10n ** 18n;
  }
  const e = await ctx.fork.proof(ctx.base, s.sellerId, s.fork.mirrorScore, why);
  s.fork.proofs.push(e.toString());
  ctx.file.save();
  return true;
}
