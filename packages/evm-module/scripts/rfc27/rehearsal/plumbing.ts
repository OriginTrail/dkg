// Fork plumbing of the rehearsal, beyond the shared Fork: impersonated senders
// with ETH, the smallest gas limit of a transaction by bisection in reverted
// snapshots, the deepest failing frame of a reverted transaction, and the
// operational keys of real nodes from their recent proof challenges.

import { ethers } from 'ethers';

import type { NodeSigner } from '../fork';
import { field, rpc } from '../network';
import { TX_GAS_CAP } from '../tx';
import type { Ctx } from './context';
import type { GasMeasure } from './results';

/** The ETH every impersonated sender is given: 100. */
export const FUND = 100n * 10n ** 18n;

/** FORK-ONLY: `address` impersonated, with 100 ETH for gas. */
export async function impersonate(ctx: Ctx, address: string): Promise<NodeSigner> {
  const signer = await ctx.fork.impersonate(address);
  await ctx.fork.setEth(address, FUND);
  return signer;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * A transaction's gas used, sent with a generous limit, and the smallest gas
 * limit it goes through with, found by bisection, each try sent and reverted
 * in its own snapshot: the state is left as it was. The sender must be an
 * anvil account or impersonated.
 */
export async function measureTx(ctx: Ctx, from: string, to: string, data: string, hi = 30_000_000n): Promise<GasMeasure> {
  // A cold fork fetches every slot a large claim reads from the upstream
  // endpoint, which can fail transiently (an HTTP 502 or 429): one call first,
  // retried, fills anvil's cache, which the snapshots below keep.
  for (let i = 0; ; i++) {
    try {
      await rpc(ctx.hre, 'eth_call', [{ from, to, data, gas: ethers.toQuantity(hi) }, 'latest']);
      break;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= 5 || !/Fork Error|50[234]|429|timed out|ECONNRESET/i.test(msg)) throw e;
      ctx.report.note(`(upstream error while warming the fork, retrying: ${msg.slice(0, 80)})`);
      await sleep(10_000 * (i + 1));
    }
  }
  const attempt = (gas: bigint): Promise<{ ok: boolean; gasUsed: bigint }> =>
    ctx.fork.inSnapshot(async () => {
      const hash = String(await rpc(ctx.hre, 'eth_sendTransaction', [{ from, to, data, gas: ethers.toQuantity(gas) }]));
      // A fork still fetching upstream state can take minutes to mine a large
      // claim; the snapshot is reverted only once the transaction is in.
      for (let i = 0; i < 6_000; i++) {
        const r = await ctx.hre.ethers.provider.getTransactionReceipt(hash);
        if (r) return { ok: r.status === 1, gasUsed: r.gasUsed };
        await sleep(200);
      }
      throw new Error(`no receipt for ${hash} after 20 minutes`);
    });
  const full = await attempt(hi);
  if (!full.ok) throw new Error(`the transaction fails even with a gas limit of ${hi}`);
  let lo = 21_000n;
  let top = hi;
  while (top - lo > 1_000n) {
    const mid = (lo + top) / 2n;
    if ((await attempt(mid)).ok) top = mid;
    else lo = mid;
  }
  return { gasUsed: full.gasUsed, minGasLimit: top, marginTo2pow24: TX_GAS_CAP - top };
}

/** The deepest failing frame of a mined transaction, from anvil's call tracer. */
export async function deepestFailure(ctx: Ctx, hash: string): Promise<string> {
  try {
    const trace = await rpc(ctx.hre, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    let found = '';
    const walk = (c: unknown) => {
      const error = field(c, 'error');
      if (error) {
        found = `${String(error)} in a call to ${String(field(c, 'to'))} (${String(field(c, 'input')).slice(0, 10)}) with ${BigInt(String(field(c, 'gas') ?? 0))} gas`;
      }
      const calls = field(c, 'calls');
      if (Array.isArray(calls)) for (const s of calls) walk(s);
    };
    walk(trace);
    return found || 'reverted';
  } catch {
    return 'reverted';
  }
}

/** FORK-ONLY: the operational key of each node that sent a recent proof challenge, by node id, to impersonate. */
export async function operationalKeys(ctx: Ctx, span = 1800): Promise<Record<string, string>> {
  const provider = ctx.hre.ethers.provider;
  const topic = ethers.id('ChallengeGenerated(uint72,uint256,uint256,uint256,uint256,uint256)');
  const head = Number(process.env.FORK_BLOCK ?? (await provider.getBlockNumber()));
  const out: Record<string, string> = {};
  for (let to = head; to > head - span; to -= 199) {
    const logs = await provider.getLogs({ address: ctx.base.randomSampling, topics: [topic], fromBlock: to - 198, toBlock: to });
    for (const l of logs) {
      const node = BigInt(l.topics[1]).toString();
      if (out[node]) continue;
      const tx = await provider.getTransaction(l.transactionHash);
      if (tx && (await ctx.base.ids.getIdentityId(tx.from)).toString() === node) out[node] = tx.from;
    }
  }
  return out;
}
