// Reads from the chain: JSON-RPC views through Multicall3, pinned to one block,
// and logs and transactions from a block explorer's API, or from the node itself
// for a local fork, which no explorer indexes.

import { AbiCoder, Interface, keccak256 } from 'ethers';

import chronosAbi from '../../../../../abi/Chronos.json';
import csAbi from '../../../../../abi/ConvictionStakingStorage.json';
import epochStorageAbi from '../../../../../abi/EpochStorage.json';
import hubAbi from '../../../../../abi/Hub.json';
import identityStorageAbi from '../../../../../abi/IdentityStorage.json';
import parametersAbi from '../../../../../abi/ParametersStorage.json';
import profileStorageAbi from '../../../../../abi/ProfileStorage.json';
import qisAbi from '../../../../../abi/QueryInferenceStorage.json';
import qsAbi from '../../../../../abi/QueryInferenceSettlement.json';
import rssAbi from '../../../../../abi/RandomSamplingStorage.json';
import ssAbi from '../../../../../abi/ServiceSubscriptions.json';
import sswAbi from '../../../../../abi/ServiceSubscriptionsWallet.json';
import sssAbi from '../../../../../abi/ServiceSubscriptionsStorage.json';
import kpiAbi from '../../../../../abi/StakingKPI.json';
import stakingAbi from '../../../../../abi/StakingV10.json';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicallIface = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);

export const IFACES = {
  Hub: new Interface(hubAbi),
  Chronos: new Interface(chronosAbi),
  QueryInferenceStorage: new Interface(qisAbi),
  QueryInferenceSettlement: new Interface(qsAbi),
  ServiceSubscriptionsStorage: new Interface(sssAbi),
  ServiceSubscriptions: new Interface(ssAbi),
  ServiceSubscriptionsWallet: new Interface(sswAbi),
  StakingKPI: new Interface(kpiAbi),
  StakingV10: new Interface(stakingAbi),
  RandomSamplingStorage: new Interface(rssAbi),
  EpochStorage: new Interface(epochStorageAbi),
  ConvictionStakingStorage: new Interface(csAbi),
  ProfileStorage: new Interface(profileStorageAbi),
  ParametersStorage: new Interface(parametersAbi),
  IdentityStorage: new Interface(identityStorageAbi),
};

/** Every custom error a batch, a funding or a top-up can revert with. */
const errorIface = new Interface(
  [qsAbi, ssAbi, sswAbi]
    .flat()
    .filter((f) => f.type === 'error')
    .filter((f, i, all) => all.findIndex((g) => g.name === f.name) === i),
);

/** The contract names the Hub is asked for, and the interface each is read with. */
export const HUB_NAMES = {
  Chronos: 'Chronos',
  QueryInferenceStorage: 'QueryInferenceStorage',
  QueryInferenceSettlement: 'QueryInferenceSettlement',
  ServiceSubscriptionsStorage: 'ServiceSubscriptionsStorage',
  ServiceSubscriptions: 'ServiceSubscriptions',
  ServiceSubscriptionsWallet: 'ServiceSubscriptionsWallet',
  StakingKPI: 'StakingKPI',
  StakingV10: 'StakingV10',
  RandomSamplingStorage: 'RandomSamplingStorage',
  EpochStorageV8: 'EpochStorage',
  ConvictionStakingStorage: 'ConvictionStakingStorage',
  ProfileStorage: 'ProfileStorage',
  ParametersStorage: 'ParametersStorage',
  IdentityStorage: 'IdentityStorage',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What went wrong, with the reason a failed fetch keeps in its cause. */
const reasonOf = (e) => (e.cause?.code || e.cause?.message ? `${e.message} (${e.cause.code ?? e.cause.message})` : e.message);

export function subscriptionIdOf(buyer, epoch) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [buyer, epoch]));
}

// ------------------------------------------------------------------ JSON-RPC

export class Rpc {
  constructor(urls, { timeoutMs = 20_000, attempts = 5, stats = {} } = {}) {
    this.urls = urls;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.stats = stats;
    this.nextId = 1;
  }

  async call(method, params = []) {
    let last;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const url = this.urls[attempt % this.urls.length];
      try {
        this.stats.rpcCalls = (this.stats.rpcCalls ?? 0) + 1;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
        const body = await res.json();
        if (body.error) {
          const err = new Error(`RPC ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
          err.rpcData = body.error.data;
          err.reverted = /revert/i.test(String(body.error.message ?? ''));
          throw err;
        }
        return body.result;
      } catch (e) {
        last = e;
        if (e.reverted) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw new Error(reasonOf(last));
  }

  /**
   * `calls`, each `{ c: {address, iface}, fn, args }`, through Multicall3 at
   * `blockHex`, in chunks. Each answer is its decoded result, one value unwrapped,
   * or null if that call reverted, so one missing view does not lose the others.
   */
  async readAll(calls, blockHex, chunk = 100) {
    const out = new Array(calls.length).fill(null);
    for (let i = 0; i < calls.length; i += chunk) {
      const part = calls.slice(i, i + chunk);
      const data = multicallIface.encodeFunctionData('aggregate3', [
        part.map((x) => ({ target: x.c.address, allowFailure: true, callData: x.c.iface.encodeFunctionData(x.fn, x.args ?? []) })),
      ]);
      const raw = await this.call('eth_call', [{ to: MULTICALL3, data }, blockHex]);
      const [results] = multicallIface.decodeFunctionResult('aggregate3', raw);
      part.forEach((x, j) => {
        const r = results[j];
        if (!r.success || r.returnData === '0x') return;
        try {
          const decoded = x.c.iface.decodeFunctionResult(x.fn, r.returnData);
          out[i + j] = decoded.length === 1 ? decoded[0] : decoded;
        } catch {
          out[i + j] = null;
        }
      });
    }
    return out;
  }

  /** The block every read of a run is pinned to, with its time. */
  async pinnedBlock(lagBlocks) {
    const head = await this.call('eth_getBlockByNumber', ['latest', false]);
    const wanted = Math.max(0, Number(head.number) - lagBlocks);
    const block = lagBlocks === 0 ? head : ((await this.call('eth_getBlockByNumber', [`0x${wanted.toString(16)}`, false])) ?? head);
    const number = Number(block.number);
    return { number, blockHex: `0x${number.toString(16)}`, timestamp: Number(block.timestamp), head: Number(head.number) };
  }
}

// ------------------------------------------------------------------ what an explorer or a node returns, in one shape

/** What the page uses of the events; the rest stays on-chain. */
const LOG_FIELDS = new Set(['subscriptionId', 'accountId', 'buyer', 'epoch', 'startsAt', 'endsAt', 'value', 'cost', 'discountBps', 'budgets', 'additions', 'budgetIndex', 'seller', 'itemCount', 'counted', 'stakeFactor18', 'maxCostPerEpoch', 'expiresAt', 'nonce', 'enabled', 'tokenId', 'amount']);

/** One decoded log, its numbers as strings, or null if it isn't one of ours. */
export function decodeLog(iface, raw) {
  let parsed;
  try {
    parsed = iface.parseLog({ topics: raw.topics, data: raw.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = {};
  parsed.fragment.inputs.forEach((input, i) => {
    if (LOG_FIELDS.has(input.name)) a[input.name] = plain(parsed.args[i], input);
  });
  return { k: parsed.name, tx: raw.tx, block: raw.block, idx: raw.idx, at: raw.at, addr: raw.address.toLowerCase(), a };
}

function plain(value, input) {
  if (input?.baseType === 'array') return [...value].map((v) => plain(v, input.arrayChildren));
  if (input?.baseType === 'tuple') {
    const out = {};
    input.components.forEach((c, i) => {
      out[c.name || String(i)] = plain(value[i], c);
    });
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && input?.type === 'address') return value.toLowerCase();
  return value;
}

/** The groups of a `submitReceiptBatch`, summed per group, or null for any other call. */
export function decodeBatchInput(input) {
  try {
    const tx = IFACES.QueryInferenceSettlement.parseTransaction({ data: input });
    if (!tx || tx.name !== 'submitReceiptBatch') return null;
    return tx.args[0].map((g) => {
      let units = 0n;
      let value = 0n;
      let minPrice = null;
      let maxPrice = null;
      for (const it of g.items) {
        units += it.units;
        value += it.valueWei;
        if (minPrice === null || it.pricePerUnit < minPrice) minPrice = it.pricePerUnit;
        if (maxPrice === null || it.pricePerUnit > maxPrice) maxPrice = it.pricePerUnit;
      }
      return {
        sub: g.subscriptionId.toLowerCase(),
        budget: Number(g.budgetIndex),
        minCounted: g.minCounted.toString(),
        items: g.items.length,
        units: units.toString(),
        value: value.toString(),
        minPrice: minPrice?.toString() ?? null,
        maxPrice: maxPrice?.toString() ?? null,
      };
    });
  } catch {
    return null;
  }
}

/** A function's name from its calldata, whichever funding contract it went to. */
export function functionName(input) {
  for (const key of ['QueryInferenceSettlement', 'ServiceSubscriptions', 'ServiceSubscriptionsWallet']) {
    try {
      const tx = IFACES[key].parseTransaction({ data: input });
      if (tx) return tx.name;
    } catch {
      /* not this contract's */
    }
  }
  return null;
}

/** What a reverted call's data says, in the marketplace's own terms. */
export function decodeRevert(hex, faults) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('0x') || hex.length < 10) return null;
  let parsed;
  try {
    parsed = errorIface.parseError(hex);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const out = { name: parsed.name };
  if (parsed.name === 'GroupFault') {
    out.group = Number(parsed.args[0]);
    out.fault = faults[Number(parsed.args[1])] ?? `fault ${parsed.args[1]}`;
  } else if (parsed.name === 'ReceiptFault') {
    out.group = Number(parsed.args[0]);
    out.item = Number(parsed.args[1]);
    out.fault = faults[Number(parsed.args[2])] ?? `fault ${parsed.args[2]}`;
  }
  return out;
}

/** `revert_reason` in any form an explorer gives it: a string, `{raw}`, or decoded. */
export function revertHexOf(reason) {
  if (!reason) return null;
  if (typeof reason === 'string') return reason.startsWith('0x') ? reason : null;
  if (typeof reason.raw === 'string' && reason.raw.startsWith('0x')) return reason.raw;
  return null;
}

// ------------------------------------------------------------------ Blockscout

export class BlockscoutSource {
  constructor(base, { timeoutMs = 25_000, attempts = 4, pauseMs = 150, stats = {} } = {}) {
    this.base = base.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.pauseMs = pauseMs;
    this.stats = stats;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
    const url = `${this.base}/api/v2${path}${qs.size ? `?${qs}` : ''}`;
    let last;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        this.stats.explorerCalls = (this.stats.explorerCalls ?? 0) + 1;
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`explorer ${path}: HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        last = e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw new Error(reasonOf(last));
  }

  /** Newest first, every page's `next_page_params` passed back as it came. */
  async *pages(path, params) {
    let next = params;
    for (;;) {
      const d = await this.get(path, next);
      if (!d) return;
      yield d.items ?? [];
      if (!d.next_page_params) return;
      next = { ...params, ...d.next_page_params };
      await sleep(this.pauseMs);
    }
  }

  /** Logs of `address` from `sinceBlock` on. */
  async logs(address, { sinceBlock = 0, topic = null } = {}) {
    const out = [];
    for await (const items of this.pages(`/addresses/${address}/logs`, topic ? { topic } : {})) {
      for (const it of items) {
        if (it.block_number < sinceBlock) return out;
        out.push({
          address,
          topics: (it.topics ?? []).filter(Boolean),
          data: it.data ?? '0x',
          block: it.block_number,
          idx: it.index,
          tx: it.transaction_hash,
          at: Math.floor(Date.parse(it.block_timestamp) / 1000),
        });
      }
    }
    return out;
  }

  /** Transactions sent to `address` from `sinceBlock` on, reverted ones among them. */
  async txs(address, { sinceBlock = 0 } = {}) {
    const out = [];
    for await (const items of this.pages(`/addresses/${address}/transactions`, { filter: 'to' })) {
      for (const it of items) {
        if (it.block_number === null || it.block_number === undefined) continue;
        if (it.block_number < sinceBlock) return out;
        out.push({
          hash: it.hash,
          ok: it.status === 'ok',
          from: it.from?.hash?.toLowerCase() ?? null,
          to: it.to?.hash?.toLowerCase() ?? null,
          input: it.raw_input ?? '0x',
          at: Math.floor(Date.parse(it.timestamp) / 1000),
          block: it.block_number,
          position: it.position ?? 0,
          revert: it.revert_reason ?? null,
        });
      }
    }
    return out;
  }

  /** A reverted transaction's revert data, which a list may leave out. */
  async revertOf(hash) {
    const d = await this.get(`/transactions/${hash}`);
    return d?.revert_reason ?? null;
  }

  /** The newest block the explorer has indexed, with its time. */
  async head() {
    const d = await this.get('/main-page/blocks');
    const b = Array.isArray(d) ? d[0] : null;
    return b ? { block: b.height, at: Math.floor(Date.parse(b.timestamp) / 1000) } : null;
  }
}

// ------------------------------------------------------------------ a local fork's node, in the same shape

export class NodeSource {
  constructor(rpc, fromBlock) {
    this.rpc = rpc;
    this.fromBlock = fromBlock;
    this.times = new Map();
  }

  async timeOf(blockHex) {
    if (!this.times.has(blockHex)) {
      const b = await this.rpc.call('eth_getBlockByNumber', [blockHex, false]);
      this.times.set(blockHex, Number(b.timestamp));
    }
    return this.times.get(blockHex);
  }

  async logs(address, { sinceBlock = 0, topic = null } = {}) {
    const from = Math.max(sinceBlock, this.fromBlock);
    const logs = await this.rpc.call('eth_getLogs', [{ address, fromBlock: `0x${from.toString(16)}`, toBlock: 'latest', ...(topic ? { topics: [topic] } : {}) }]);
    const out = [];
    for (const l of logs) {
      out.push({ address, topics: l.topics, data: l.data, block: Number(l.blockNumber), idx: Number(l.logIndex), tx: l.transactionHash, at: await this.timeOf(l.blockNumber) });
    }
    return out.reverse();
  }

  async txs(address, { sinceBlock = 0 } = {}) {
    const head = Number(await this.rpc.call('eth_blockNumber'));
    const out = [];
    for (let n = Math.max(sinceBlock, this.fromBlock); n <= head; n++) {
      const hex = `0x${n.toString(16)}`;
      const b = await this.rpc.call('eth_getBlockByNumber', [hex, true]);
      for (const t of b.transactions) {
        if (t.to?.toLowerCase() !== address.toLowerCase()) continue;
        const r = await this.rpc.call('eth_getTransactionReceipt', [t.hash]);
        const ok = Number(r.status) === 1;
        out.push({ hash: t.hash, ok, from: t.from.toLowerCase(), to: t.to.toLowerCase(), input: t.input, at: Number(b.timestamp), block: n, position: Number(t.transactionIndex), revert: ok ? null : await this.replay(t, n) });
      }
    }
    return out.reverse();
  }

  async replay(t, block) {
    try {
      await this.rpc.call('eth_call', [{ from: t.from, to: t.to, data: t.input }, `0x${(block - 1).toString(16)}`]);
      return null;
    } catch (e) {
      return typeof e.rpcData === 'string' ? { raw: e.rpcData } : null;
    }
  }

  async revertOf() {
    return null;
  }

  async head() {
    const b = await this.rpc.call('eth_getBlockByNumber', ['latest', false]);
    return { block: Number(b.number), at: Number(b.timestamp) };
  }
}
