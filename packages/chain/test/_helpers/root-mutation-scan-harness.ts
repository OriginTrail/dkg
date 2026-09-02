/**
 * Shared harness for the EVM adapter's root-mutation scan suites (#2435):
 * an adapter with its RPC seams replaced, the shipped-ABI log encoder, and
 * the drain helper. Extracted at review r9 so the raw-log scanning suite and
 * the capability/alias suite mirror the production boundary without each
 * carrying a copy of the seam.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers, Interface } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../../src/evm-adapter.js';
import type { KnowledgeAssetRootMutationEventType } from '../../src/evm-adapter-events.js';
import type { ChainEvent } from '../../src/chain-adapter.js';

export const ABI_DIR = join(import.meta.dirname, '..', '..', 'abi');
export const KA_ABI = JSON.parse(readFileSync(join(ABI_DIR, 'DKGKnowledgeAssets.json'), 'utf8'));

// A hardhat-account key; never used to sign here (no provider is reachable).
export const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const KA_ID = 123_456_789n;
export const ROOT = '0x' + 'ab'.repeat(32);
export const AUTHOR = '0x' + '11'.repeat(20);
export const BLOCK_HASH = '0x' + 'cd'.repeat(32);
export const TX_HASH = '0x' + 'ef'.repeat(32);

/** Minimal off-chain adapter config — nothing here is dialled. */
export function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

export interface FakeLog {
  address?: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  index: number;
}

export interface ScanRecord {
  label: string;
  policy?: string;
  skipPreferred?: boolean;
  fromBlock: unknown;
  toBlock: unknown;
  /** The COMPLETE `eth_getLogs` request the production callback issued (review r7). */
  request?: { address?: unknown; topics?: unknown; fromBlock?: unknown; toBlock?: unknown };
}

/**
 * Encode a genuinely decodable log for `eventName` using the shipped ABI.
 * `overrides` lets a test corrupt exactly one field.
 */
export function encodeLog(
  iface: Interface,
  eventName: string,
  values: unknown[],
  overrides: Partial<FakeLog> = {},
): FakeLog {
  const fragment = iface.getEvent(eventName);
  if (!fragment) throw new Error(`event ${eventName} not in ABI`);
  const { data, topics } = iface.encodeEventLog(fragment, values);
  return {
    // The bound storage contract's address — the r16 escape guard rejects a
    // response log from any other contract as endpoint corruption.
    address: '0x' + '22'.repeat(20),
    topics: [...topics],
    data,
    blockNumber: 4_242,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    transactionIndex: 7,
    index: 3,
    ...overrides,
  };
}

export function sampleLog(iface: Interface, eventName: KnowledgeAssetRootMutationEventType): FakeLog {
  switch (eventName) {
    case 'KnowledgeAssetUpdated':
      return encodeLog(iface, eventName, [KA_ID, AUTHOR, 'op-1', ROOT, 4_096n, 10n]);
    case 'KnowledgeAssetMerkleRootAdded':
    case 'KnowledgeAssetMerkleRootRemoved':
      return encodeLog(iface, eventName, [KA_ID, ROOT]);
    case 'KnowledgeAssetMerkleRootsUpdated':
      return encodeLog(iface, eventName, [KA_ID, [[AUTHOR, ROOT, 1_700_000_000n]]]);
  }
}

/**
 * An adapter with its RPC seams replaced: `init()` is a no-op, the bound
 * `knowledgeAssetStorage` is an offline `Contract`, and `readContractWith`
 * records the call and returns canned logs WITHOUT invoking the reader.
 *
 * Because the reader is never invoked, any code path that reaches the chain by
 * some OTHER route (a direct `contract.queryFilter`) would have to dial
 * 127.0.0.1:59998 and fail — it cannot silently pass.
 */
export function makeAdapter(options: {
  abi?: unknown;
  bindStorage?: boolean;
  logsByEvent?: Partial<Record<string, FakeLog[]>>;
}): {
  adapter: EVMChainAdapter;
  scans: ScanRecord[];
  parseLogCalls: string[];
  iface: Interface;
} {
  const abi = options.abi ?? KA_ABI;
  const iface = new Interface(abi as never);
  const contract = new ethers.Contract('0x' + '22'.repeat(20), abi as never);
  const scans: ScanRecord[] = [];
  const parseLogCalls: string[] = [];

  // Record which topic0 the production code asks the interface to decode.
  const realParseLog = contract.interface.parseLog.bind(contract.interface);
  (contract.interface as unknown as { parseLog: unknown }).parseLog = (log: {
    topics: ReadonlyArray<string>;
    data: string;
  }) => {
    parseLogCalls.push(log.topics[0] ?? '(no-topic0)');
    return realParseLog(log);
  };

  const adapter = new EVMChainAdapter(minimalConfig());
  const priv = adapter as unknown as {
    init: () => Promise<void>;
    contracts: Record<string, unknown>;
    readContractWith: (
      c: unknown,
      label: string,
      fn: unknown,
      opts?: { policy?: string; skipPreferred?: boolean },
    ) => Promise<unknown>;
    readProvider: (
      label: string,
      fn: unknown,
      opts?: { policy?: string; skipPreferred?: boolean },
    ) => Promise<unknown>;
  };
  priv.init = async () => { /* offline */ };
  priv.contracts = options.bindStorage === false ? {} : { knowledgeAssetStorage: contract };
  const recordScan = (
    label: string,
    opts: { policy?: string; skipPreferred?: boolean } | undefined,
  ): FakeLog[] => {
    // The label carries the event name (`kas.getLogs(<event>)`), which is what
    // the assertions key on; from/to close over inside the never-invoked `fn`.
    scans.push({
      label,
      policy: opts?.policy,
      skipPreferred: opts?.skipPreferred,
      fromBlock: undefined,
      toBlock: undefined,
    });
    const match = /\(([^)]+)\)$/.exec(label);
    const eventName = match?.[1] ?? '';
    if (eventName === 'KnowledgeAssetRootMutations') {
      // The combined topic-OR scan (review r6): the fake plays the provider,
      // returning every recorded log in insertion order; production
      // classification by topic0 narrows to the requested-and-declared set.
      return Object.values(options.logsByEvent ?? {}).flat() as FakeLog[];
    }
    return options.logsByEvent?.[eventName] ?? [];
  };
  // The root-mutation scan fetches RAW logs (`eth_getLogs` via `readProvider`)
  // so ethers never eagerly decodes an untrusted payload (review r2): a
  // `queryFilter` route would wrap each log in an `EventLog`, whose
  // construction decodes the non-indexed tail before topics[1] is ever read.
  //
  // The seam EXECUTES the real callback against a fake provider (review r7): a
  // stub that returned canned logs without running `fn` left the owning
  // address, the topic OR-set and the block range unasserted — dropping
  // `fromBlock` from the production request would have stayed green.
  priv.readProvider = async (label, fn, opts) => {
    const canned = recordScan(label, opts);
    const record = scans[scans.length - 1];
    const fakeProvider = {
      getLogs: async (req: NonNullable<ScanRecord['request']>) => {
        record.request = { ...req };
        record.fromBlock = req.fromBlock;
        record.toBlock = req.toBlock;
        return canned;
      },
    };
    return (fn as (p: typeof fakeProvider) => Promise<unknown>)(fakeProvider);
  };
  priv.readContractWith = async (_c, label, _fn, opts) => {
    // The group scan must use the RAW provider route. A revival of the
    // contract-read route (say, `queryFilterWithFailover` under the same
    // label) FAILS here rather than silently receiving the same canned logs
    // (review r7); legacy single-event branches still stub as before.
    if (label.includes('KnowledgeAssetRootMutations')) {
      throw new Error(`root-mutation scan took the contract-read route: ${label}`);
    }
    return recordScan(label, opts);
  };

  return { adapter, scans, parseLogCalls, iface };
}

export async function drain(adapter: EVMChainAdapter, eventTypes: string[]): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for await (const ev of adapter.listenForEvents({ eventTypes, fromBlock: 1, toBlock: 9_000 })) {
    out.push(ev);
  }
  return out;
}
