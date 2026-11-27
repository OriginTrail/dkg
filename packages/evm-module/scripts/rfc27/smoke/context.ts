// What every phase of the smoke test works with, built once by the entry point.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ethers } from 'ethers';

import { subscriptionIdOf } from '../../../test/helpers/conviction-service';

import { BaseContracts, Contracts, Stack } from '../contracts';
import { Fork, notBefore } from '../fork';
import { Net, chainNow } from '../network';
import { Report } from '../report';
import { SmokeEnv } from './config';
import { Marketplace } from './marketplace';
import { Roles } from './roles';
import { ServedState, SetupState, SmokeState, StateFile, isServed, isSetup, serveMissing, setupMissing } from './state';
import { SmokeTx } from './tx';

export type Ctx = {
  hre: HardhatRuntimeEnvironment;
  env: SmokeEnv;
  net: Net;
  report: Report;
  stack: Stack;
  base: BaseContracts;
  fork: Fork;
  file: StateFile;
  tx: SmokeTx;
  roles: Roles;
};

/** A context of a deployed stack: the pool contracts and the marketplace operations too. */
export type PoolCtx = Ctx & { c: Contracts; market: Marketplace };

export async function withPool(ctx: Ctx): Promise<PoolCtx> {
  const c: Contracts = { ...ctx.base, ...(await ctx.stack.pool()) };
  return { ...ctx, c, market: new Marketplace(c, ctx.tx) };
}

export const now = (ctx: Ctx): Promise<bigint> => chainNow(ctx.hre);

/**
 * The phase may run from `ts`: see fork.notBefore. A dry run changes nothing on
 * the fork either, so it does not move the clock: it is deferred, as without
 * FORK_WARP.
 */
export async function opensAt(ctx: Ctx, ts: bigint, what: string): Promise<boolean> {
  const open = await notBefore({ hre: ctx.hre, fork: ctx.fork, report: ctx.report, warp: ctx.env.warp && ctx.env.send }, ts, what);
  if (!open && ctx.env.warp && !ctx.env.send) ctx.report.note('a dry run changes nothing on the fork: FORK_WARP=1 moves the clock with SEND=1 only');
  return open;
}

export const epochStart = (ctx: Ctx, e: bigint): Promise<bigint> => ctx.base.chronos.timestampForEpoch(e);

/** A plan's commitment, opaque to the contracts: the run's label and the plan's name. */
export const planDigest = (ctx: Ctx, what: string): string => ethers.id(`rfc27-smoke/${ctx.env.run}/${what}`);

/**
 * Why the owner's wallet subscription of `epoch`, if it has one, is not this run's. Its
 * id names only the owner and the epoch, while its session key and its plan are
 * the run's: a second run of the same owner in the same epoch would skip funding
 * and sign requests its subscription does not accept.
 */
export async function walletSubscriptionClash(ctx: PoolCtx, r: { ownerAddr: string; walletSession: { address: string } }, value: bigint, epoch: bigint): Promise<string | undefined> {
  const id = subscriptionIdOf(r.ownerAddr, epoch);
  if (!(await ctx.c.sss.subscriptionExists(id))) return undefined;
  const held = await ctx.c.sss.getSubscription(id);
  if (held.sessionKey === r.walletSession.address && held.planDigest === planDigest(ctx, 'wallet plan') && held.value === value) return undefined;
  return `the owner's wallet subscription of epoch ${epoch} is another run's: session key ${held.sessionKey}, plan ${held.planDigest}, value ${held.value}; this run's key is ${r.walletSession.address}`;
}

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
  const hub = await ctx.stack.hub.getAddress();
  if (s.hub.toLowerCase() !== hub.toLowerCase()) problems.push(`Hub ${s.hub}, this stack's is ${hub}`);
  if (s.settlement.toLowerCase() !== settlement.toLowerCase()) problems.push(`settlement ${s.settlement}, the Hub now holds ${settlement}`);
  if (ctx.net.local && s.forkBlock !== ctx.net.forkBlock) problems.push(`fork block ${s.forkBlock}, this fork is at ${ctx.net.forkBlock}`);
  if (ctx.roles.ownerAddr && s.addresses.owner !== ctx.roles.ownerAddr) problems.push(`owner ${s.addresses.owner}, this key is ${ctx.roles.ownerAddr}`);
  if (problems.length) throw new Error(`${ctx.file.file} belongs to another run: ${problems.join('; ')}. Use another RFC27_SMOKE_RUN`);
  return s;
}

/**
 * The gate of a phase: the state of a run bound to this network, in which the
 * phase `after` completed with no failed check. What that phase must have
 * recorded is validated here, once, and the state comes back typed as holding
 * it. It is the same object as the file's, so what a phase writes to it is saved.
 */
export async function runState(ctx: PoolCtx, after: 'setup'): Promise<SetupState>;
export async function runState(ctx: PoolCtx, after: 'serve' | 'claim'): Promise<ServedState>;
export async function runState(ctx: PoolCtx, after: 'setup' | 'serve' | 'claim'): Promise<SetupState> {
  const s = await bindState(ctx);
  if (!s) throw new Error(`${ctx.file.file} is missing: run PHASE=setup SEND=1 first`);
  const failed = ctx.file.failedChecks(after);
  if (failed) throw new Error(`PHASE=${after} ended with ${failed} failed check${failed > 1 ? 's' : ''}: run it again first, which sends nothing it sent already`);
  if (!ctx.file.done(after)) throw new Error(`run PHASE=${after} SEND=1 first`);
  const lacks = (what: string[]) => new Error(`${ctx.file.file} says ${after} completed, but holds no ${what.join(', ')}: start a new run`);
  if (!isSetup(s)) throw lacks(setupMissing(s));
  if (after === 'setup') return s;
  if (!isServed(s)) throw lacks(serveMissing(s));
  return s;
}

/**
 * A phase that completed earlier: say so, and keep the results it wrote then.
 * One whose checks failed did not: it runs again, and its failure stands until
 * they pass.
 */
export function doneEarlier(ctx: Ctx, what: string): boolean {
  const failed = ctx.file.failedChecks(ctx.env.phase);
  if (failed) ctx.report.note(`${ctx.env.phase} ended with ${failed} failed check${failed > 1 ? 's' : ''} when it last ran: running it again, which sends nothing it sent already`);
  if (!ctx.file.done(ctx.env.phase)) return false;
  ctx.report.note(`${ctx.env.phase} is done${what ? `: ${what}` : ''}`);
  ctx.report.status = 'done earlier';
  return true;
}

/** Records the phase's outcome once it ran to its end with SEND=1: done, or failed if any check did. */
export function complete(ctx: Ctx): void {
  if (ctx.env.send && !ctx.report.stopped && ctx.report.status === 'ran') ctx.file.finish(ctx.env.phase, ctx.report.failed);
}

/**
 * FORK-ONLY: the seller's next proof, where the real node would have proved,
 * with FORK_PROOFS=1 and SEND=1. It sends transactions outside the runner, so a
 * dry run only says what it would write.
 */
export async function standInProof(ctx: PoolCtx, why: string): Promise<boolean> {
  if (!ctx.net.local || !ctx.env.proofs) return false;
  if (!ctx.env.send) {
    ctx.report.note(`plan  fork-only: a stand-in proof of node ${ctx.file.s.sellerId}, with SEND=1: ${why}`);
    return false;
  }
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
