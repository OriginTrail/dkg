// The scenario's way to the chain: a provider that rides out a public endpoint's
// errors, the contracts resolved through the Hub, reverts decoded, and one way to
// send a transaction: simulated first, sized by hand, its fee bounded, and logged.

import { ethers } from 'ethers';

import DKGPublishingConvictionNFT from '../../../abi/DKGPublishingConvictionNFT.json';
import Chronos from '../../../abi/Chronos.json';
import Hub from '../../../abi/Hub.json';
import IdentityStorage from '../../../abi/IdentityStorage.json';
import ParametersStorage from '../../../abi/ParametersStorage.json';
import PublishingConviction from '../../../abi/PublishingConviction.json';
import PublishingConvictionStorage from '../../../abi/PublishingConvictionStorage.json';
import QueryInferenceSettlement from '../../../abi/QueryInferenceSettlement.json';
import QueryInferenceStorage from '../../../abi/QueryInferenceStorage.json';
import RandomSamplingStorage from '../../../abi/RandomSamplingStorage.json';
import ServiceSubscriptions from '../../../abi/ServiceSubscriptions.json';
import ServiceSubscriptionsStorage from '../../../abi/ServiceSubscriptionsStorage.json';
import ServiceSubscriptionsWallet from '../../../abi/ServiceSubscriptionsWallet.json';
import ShardingTableStorage from '../../../abi/ShardingTableStorage.json';
import Token from '../../../abi/Token.json';
import { Fault } from '../../../test/helpers/query-inference';
import { errorData, errorMessage } from '../contracts';
import { TX_GAS_CAP, gasLimitFor } from '../tx';

import { CHAIN_ID, FIRST_EPOCH, FIRST_EPOCH_START, HUB } from './config';

export type Fields = Record<string, unknown>;

/** Where a tick's actions go. */
export interface Log {
  event(kind: string, fields?: Fields): void;
}

export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const TRANSIENT = /rate limit|too many|timeout|timed out|temporar|overload|unavailable|econnreset|etimedout|econnrefused|enotfound|eai_again|socket hang up|fetch failed|bad gateway|gateway|missing response|bad response|server error|header not found|block not found|-32603|-32005|-32016/i;

function isTransient(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  if (code === 'CALL_EXCEPTION' || code === 'INSUFFICIENT_FUNDS' || code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED') return false;
  if (code === 'SERVER_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR') return true;
  return TRANSIENT.test(errorMessage(e));
}

/** A JSON-RPC provider that retries an endpoint's transient errors with backoff. Never a send: a next tick redoes one, from what the chain says. */
export class RetryingProvider extends ethers.JsonRpcProvider {
  constructor(url: string, chainId = CHAIN_ID) {
    const request = new ethers.FetchRequest(url);
    request.timeout = 30_000;
    // No cache: a tick reads the chain as it is now, also on a fork whose clock jumps.
    super(request, chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  }

  override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    const tries = method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction' ? 1 : 6;
    for (let i = 1; ; i++) {
      try {
        return await super.send(method, params);
      } catch (e: unknown) {
        if (i >= tries || !isTransient(e)) throw e;
        await sleep(500 * 2 ** i);
      }
    }
  }
}

export type Contracts = {
  hub: ethers.Contract;
  token: ethers.Contract;
  chronos: ethers.Contract;
  ids: ethers.Contract;
  params: ethers.Contract;
  sts: ethers.Contract;
  rss: ethers.Contract;
  nft: ethers.Contract;
  pc: ethers.Contract;
  pcs: ethers.Contract;
  qis: ethers.Contract;
  qs: ethers.Contract;
  ss: ethers.Contract;
  ssw: ethers.Contract;
  sss: ethers.Contract;
};

/** Every address from the Hub, on a read-only provider: no signer ever touches the Hub here. */
export async function resolveContracts(provider: ethers.Provider): Promise<Contracts> {
  const hub = new ethers.Contract(HUB, Hub, provider);
  const at = async (name: string, abi: ethers.InterfaceAbi, hubName = name): Promise<ethers.Contract> => new ethers.Contract(String(await hub.getContractAddress(hubName)), abi, provider);
  return {
    hub,
    token: await at('Token', Token),
    chronos: await at('Chronos', Chronos),
    ids: await at('IdentityStorage', IdentityStorage),
    params: await at('ParametersStorage', ParametersStorage),
    sts: await at('ShardingTableStorage', ShardingTableStorage),
    rss: await at('RandomSamplingStorage', RandomSamplingStorage),
    nft: await at('DKGPublishingConvictionNFT', DKGPublishingConvictionNFT),
    pc: await at('PublishingConviction', PublishingConviction),
    pcs: await at('PublishingConvictionStorage', PublishingConvictionStorage),
    qis: await at('QueryInferenceStorage', QueryInferenceStorage),
    qs: await at('QueryInferenceSettlement', QueryInferenceSettlement),
    ss: await at('ServiceSubscriptions', ServiceSubscriptions),
    ssw: await at('ServiceSubscriptionsWallet', ServiceSubscriptionsWallet),
    sss: await at('ServiceSubscriptionsStorage', ServiceSubscriptionsStorage),
  };
}

/** The chain's clock: the latest block's time, never the local one. */
export async function chainNow(provider: ethers.Provider): Promise<number> {
  const b = await provider.getBlock('latest');
  if (!b) throw new Error('no latest block');
  return b.timestamp;
}

/** The chain is what the plan was made for. */
export async function checkChain(provider: ethers.JsonRpcProvider, c: Contracts): Promise<void> {
  const chainId = BigInt(String(await provider.send('eth_chainId', [])));
  if (chainId !== BigInt(CHAIN_ID)) throw new Error(`wrong chain ${chainId}`);
  const start = Number(await c.chronos.timestampForEpoch(FIRST_EPOCH));
  if (start !== FIRST_EPOCH_START) throw new Error(`epoch ${FIRST_EPOCH} starts at ${start} on the chain, not at ${FIRST_EPOCH_START}`);
}

// ---------------------------------------------------------------------------
// Reverts
// ---------------------------------------------------------------------------

const ERROR_ABIS: ethers.InterfaceAbi[] = [
  QueryInferenceSettlement,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  ServiceSubscriptionsStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  DKGPublishingConvictionNFT,
  Token,
  Hub,
];
let errorInterfaces: ethers.Interface[] | undefined;

const FAULT_NAMES = new Map<bigint, string>(Object.entries(Fault).map(([k, v]) => [v, k]));

export type Revert = { name: string; args: unknown[]; text: string };

/** A revert's data, decoded against the stack's errors. A fault's code reads as its name. */
export function decodeRevert(data: string | undefined): Revert {
  if (!data || data === '0x') return { name: 'revert', args: [], text: 'revert (no data)' };
  if (data.startsWith('0x4e487b71') && data.length === 74) {
    const text = `Panic(0x${BigInt(`0x${data.slice(10)}`).toString(16)})`;
    return { name: 'Panic', args: [], text };
  }
  errorInterfaces ??= ERROR_ABIS.map((a) => new ethers.Interface(a));
  for (const i of errorInterfaces) {
    try {
      const e = i.parseError(data);
      if (e) {
        const args = [...e.args] as unknown[];
        const shown = args.map((a) => {
          if (typeof a === 'bigint' && (e.name === 'ReceiptFault' || e.name === 'GroupFault') && a === args[args.length - 1]) return FAULT_NAMES.get(a) ?? String(a);
          return String(a);
        });
        return { name: e.name, args, text: `${e.name}(${shown.join(', ')})` };
      }
    } catch {
      // not this interface's
    }
  }
  return { name: 'unknown', args: [], text: `revert ${data.slice(0, 10)}` };
}

/** What an error is, if it is a revert the chain gave: decoded. A failure to reach the chain is no revert. */
export function revertOf(e: unknown): Revert | undefined {
  if ((e as { code?: unknown }).code === 'CALL_EXCEPTION' || errorData(e) !== undefined) return decodeRevert(errorData(e));
  return undefined;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type RawLog = { address: string; topics: string[]; data: string };
export type Landed = { hash: string; gasUsed: bigint; status: number; fee: bigint; l1Fee: bigint; block: number; logs: RawLog[] };

export type SendOutcome =
  | { sent: true; receipt: Landed; estimate: bigint }
  | { sent: false; why: 'reverted'; revert: Revert }
  | { sent: false; why: 'fee' | 'error' | 'pending'; note: string };

/** The base fee above which a send waits, unless it is the last stretch of the epoch, whose limit is higher. */
const MAX_BASE_FEE = 250_000_000n;
const MAX_BASE_FEE_LAST_STRETCH = 1_000_000_000n;
const TIP = 1_000_000n;

export type Sender = {
  provider: ethers.JsonRpcProvider;
  log: Log;
  /** How long to wait for a transaction to be mined, in ms. */
  waitMs?: number;
  /** Fork only: stops right after a send, as a crash would. */
  crashAfterSend?: () => boolean;
};

const nextNonce = new Map<string, number>();

async function pollReceipt(s: Sender, hash: string): Promise<Landed | undefined> {
  const deadline = Date.now() + (s.waitMs ?? 120_000);
  for (let pause = 100; ; pause = Math.min(pause * 2, 1_000)) {
    const r = (await s.provider.send('eth_getTransactionReceipt', [hash])) as {
      status?: string;
      gasUsed: string;
      effectiveGasPrice?: string;
      l1Fee?: string;
      blockNumber: string;
      logs: RawLog[];
    } | null;
    if (r) {
      const gasUsed = BigInt(r.gasUsed);
      const l1Fee = BigInt(r.l1Fee ?? '0x0');
      return { hash, gasUsed, status: Number(r.status ?? '0x1'), fee: gasUsed * BigInt(r.effectiveGasPrice ?? '0x0') + l1Fee, l1Fee, block: Number(r.blockNumber), logs: r.logs };
    }
    if (Date.now() > deadline) return undefined;
    await sleep(pause);
  }
}

/**
 * One transaction: simulated first, and not sent if that reverts; its gas limit
 * set by hand under Base's cap; its fee bounded. Never throws for what the chain
 * or the endpoint says: the outcome says it, and it is logged.
 */
export async function send(s: Sender, opts: { label: string; signer: ethers.Signer; to: string; data: string; value?: bigint; lastStretch?: boolean; fields?: Fields }): Promise<SendOutcome> {
  const { label, signer, to, data } = opts;
  const value = opts.value ?? 0n;
  const fields = opts.fields ?? {};
  try {
    const from = await signer.getAddress();
    let estimate: bigint;
    try {
      estimate = await s.provider.estimateGas({ from, to, data, value });
    } catch (e: unknown) {
      const revert = revertOf(e);
      if (revert) {
        s.log.event('simulation-reverted', { label, from, why: revert.text, ...fields });
        return { sent: false, why: 'reverted', revert };
      }
      s.log.event('rpc-error', { label, from, error: errorMessage(e).slice(0, 300), ...fields });
      return { sent: false, why: 'error', note: errorMessage(e) };
    }
    if (estimate >= TX_GAS_CAP) {
      s.log.event('over-gas-cap', { label, estimate: estimate.toString(), ...fields });
      return { sent: false, why: 'error', note: 'over the gas cap' };
    }
    const block = await s.provider.getBlock('latest');
    const base = block?.baseFeePerGas ?? 0n;
    const limit = opts.lastStretch ? MAX_BASE_FEE_LAST_STRETCH : MAX_BASE_FEE;
    if (base > limit) {
      s.log.event('fee-too-high', { label, baseFee: base.toString(), limit: limit.toString(), ...fields });
      return { sent: false, why: 'fee', note: `base fee ${base}` };
    }
    const fetched = await s.provider.getTransactionCount(from, 'pending');
    const nonce = Math.max(fetched, nextNonce.get(from) ?? 0);
    const tx = await signer.sendTransaction({
      to,
      data,
      value,
      nonce,
      gasLimit: gasLimitFor(estimate),
      maxFeePerGas: base * 2n + TIP,
      maxPriorityFeePerGas: TIP,
      type: 2,
    });
    nextNonce.set(from, nonce + 1);
    s.log.event('tx-sent', { label, from, hash: tx.hash, nonce, estimate: estimate.toString(), ...fields });
    if (s.crashAfterSend?.()) throw new Error('stopped right after the send, as a crash would');
    const receipt = await pollReceipt(s, tx.hash);
    if (!receipt) {
      s.log.event('tx-pending', { label, from, hash: tx.hash, ...fields });
      return { sent: false, why: 'pending', note: tx.hash };
    }
    s.log.event(receipt.status === 1 ? 'tx-mined' : 'tx-reverted-on-chain', {
      label,
      from,
      hash: tx.hash,
      gasUsed: receipt.gasUsed.toString(),
      feeWei: receipt.fee.toString(),
      l1FeeWei: receipt.l1Fee.toString(),
      block: receipt.block,
      ...fields,
    });
    if (receipt.status !== 1) return { sent: false, why: 'error', note: `reverted on chain: ${tx.hash}` };
    return { sent: true, receipt, estimate };
  } catch (e: unknown) {
    s.log.event('send-error', { label, error: errorMessage(e).slice(0, 300), ...fields });
    return { sent: false, why: 'error', note: errorMessage(e) };
  }
}
