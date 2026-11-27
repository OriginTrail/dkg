// OT-RFC-27 script support: what only the local anvil fork allows, standing in
// for what the real network has by itself: impersonated keys, anvil's balance
// setters, a clock moved forward, and node proofs a fork cannot produce. Every
// method refuses to run anywhere but the fork that the chain guard detected.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ethers } from 'ethers';

import { errorMessage } from './contracts';
import type { BaseContracts } from './contracts';
import { Net, chainNow, rpc } from './network';
import { Report, iso, span } from './report';
import { gasLimitFor } from './tx';

export const FORK_ETH = 10n * 10n ** 18n;
const SCALE18 = 10n ** 18n;

/** A signer of the node's own, as hardhat-ethers gives one for an impersonated address. */
export type NodeSigner = Awaited<ReturnType<HardhatRuntimeEnvironment['ethers']['getSigner']>>;

export class Fork {
  constructor(
    private readonly hre: HardhatRuntimeEnvironment,
    readonly net: Net,
    private readonly report: Report,
  ) {}

  private only(what: string): void {
    if (!this.net.local) throw new Error(`${what} runs on the local fork only`);
  }

  async impersonate(address: string): Promise<NodeSigner> {
    this.only('impersonation');
    await rpc(this.hre, 'anvil_impersonateAccount', [address]);
    return this.hre.ethers.getSigner(address);
  }

  async setEth(address: string, wei: bigint): Promise<void> {
    this.only('anvil_setBalance');
    await rpc(this.hre, 'anvil_setBalance', [address, ethers.toQuantity(wei)]);
  }

  async dealErc20(token: string, address: string, wei: bigint): Promise<void> {
    this.only('anvil_dealERC20');
    await rpc(this.hre, 'anvil_dealERC20', [address, token, ethers.toQuantity(wei)]);
  }

  /** Move the fork's clock to `ts` with evm_increaseTime and evm_mine. */
  async warpTo(ts: bigint): Promise<void> {
    this.only('time travel');
    const t = await chainNow(this.hre);
    if (ts > t) await rpc(this.hre, 'evm_increaseTime', [Number(ts - t)]);
    await rpc(this.hre, 'evm_mine', []);
  }

  /** Mine a block, stamped with the fork's clock. */
  async mine(): Promise<void> {
    this.only('mining a block');
    await rpc(this.hre, 'evm_mine', []);
  }

  /** The fork's state now, to return to with `revert`: the chain, its clock and every balance. */
  async snapshot(): Promise<string> {
    this.only('a snapshot');
    return String(await rpc(this.hre, 'evm_snapshot', []));
  }

  async revert(snapshot: string): Promise<void> {
    this.only('a revert');
    if ((await rpc(this.hre, 'evm_revert', [snapshot])) !== true) throw new Error(`evm_revert(${snapshot}) failed`);
  }

  /**
   * `body` inside a snapshot, which is reverted however it ends: a failure
   * leaves the fork as it was, and is the error that reaches the caller, even
   * if the revert fails as well.
   */
  async inSnapshot<T>(body: () => Promise<T>): Promise<T> {
    const snap = await this.snapshot();
    let done = false;
    try {
      const out = await body();
      done = true;
      return out;
    } finally {
      await this.restore(snap, !done);
    }
  }

  /**
   * `body`, whose changes stay if it succeeds. If it throws, or `failed` says so
   * once it has ended, the fork goes back as it was, and it can run again. Its
   * error is the one that reaches the caller, even if the revert fails as well.
   */
  async undoIfFailed(body: () => Promise<void>, failed: () => boolean): Promise<void> {
    const snap = await this.snapshot();
    let threw = true;
    try {
      await body();
      threw = false;
    } finally {
      if (threw || failed()) {
        await this.restore(snap, threw);
        this.report.note('it failed: the fork is restored as it was before it');
      }
    }
  }

  /** Reverts to `snap`; if an error is on its way already, a failed revert is noted rather than replacing it. */
  private async restore(snap: string, errorOnItsWay: boolean): Promise<void> {
    await this.revert(snap).catch((e: unknown) => {
      if (!errorOnItsWay) throw e;
      this.report.note(`the snapshot was not restored: ${errorMessage(e)}`);
    });
  }

  /** A stand-in transaction from an impersonated address, its gas limit set by hand too. */
  async send(label: string, from: NodeSigner, to: string, data: string): Promise<void> {
    this.only(label);
    const estimate = await this.hre.ethers.provider.estimateGas({ from: from.address, to, data });
    const tx = await from.sendTransaction({ to, data, gasLimit: gasLimitFor(estimate) });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`fork-only ${label} reverted`);
  }

  /**
   * `node`'s next proof in the current epoch, written as
   * RandomSampling.submitProof writes it, through the contract the Hub holds
   * as RandomSampling, impersonated: a fork cannot produce a proof.
   */
  async proof(c: BaseContracts, node: bigint, score18: bigint, why: string): Promise<bigint> {
    this.only('a stand-in proof');
    const rs = await this.impersonate(c.randomSampling);
    await this.setEth(c.randomSampling, FORK_ETH);
    const e = await c.chronos.getCurrentEpoch();
    const rss = await c.rss.getAddress();
    const css = await c.css.getAddress();
    await this.send('settleNodeTo', rs, css, c.css.interface.encodeFunctionData('settleNodeTo', [node, await chainNow(this.hre)]));
    const effective = await c.css.getNodeRunningEffectiveStake(node);
    const proofPeriodStart = await c.rss.getActiveProofPeriodStartBlock();
    const write = (fn: string, data: string) => this.send(fn, rs, rss, data);
    await write('incrementEpochNodeValidProofsCount', c.rss.interface.encodeFunctionData('incrementEpochNodeValidProofsCount', [e, node]));
    await write('addToNodeEpochProofPeriodScore', c.rss.interface.encodeFunctionData('addToNodeEpochProofPeriodScore', [e, proofPeriodStart, node, score18]));
    await write('addToNodeEpochScore', c.rss.interface.encodeFunctionData('addToNodeEpochScore', [e, node, score18]));
    await write('addToAllNodesEpochScore', c.rss.interface.encodeFunctionData('addToAllNodesEpochScore', [e, score18]));
    const last = await c.rss.getEpochLastScorePerStake(node, e);
    const next = last + (score18 * SCALE18) / effective;
    await write('appendCheckpoint', c.rss.interface.encodeFunctionData('appendCheckpoint', [node, e, await chainNow(this.hre), next]));
    this.report.standIn(`a proof of node ${node} in epoch ${e}, score ${score18}, written as RandomSampling: ${why}`);
    return e;
  }
}

/**
 * The gate of a phase that may run from `ts`. On the local fork with warping
 * on, the clock moves there; otherwise, before it, the phase is deferred, and
 * the report says when it opens.
 */
export async function notBefore(
  o: { hre: HardhatRuntimeEnvironment; fork: Fork; report: Report; warp: boolean },
  ts: bigint,
  what: string,
): Promise<boolean> {
  const t = await chainNow(o.hre);
  if (t >= ts) return true;
  if (o.fork.net.local && o.warp) {
    await o.fork.warpTo(ts);
    o.report.standIn(`the clock moved ${span(ts - t)} forward, to ${iso(ts)}: ${what}`);
    return true;
  }
  o.report.defer(`${what}: opens at ${iso(ts)}, in ${span(ts - t)} (chain time ${iso(t)})`);
  return false;
}
