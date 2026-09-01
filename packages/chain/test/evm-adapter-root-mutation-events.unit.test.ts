/**
 * `listenForEvents` — the four Knowledge-Asset root-mutation events (#2435).
 *
 * A KA's committed Merkle-root set changes through four distinct emitters
 * (`updateKnowledgeAsset`, `pushMerkleRoot`, `setMerkleRoots`, `popMerkleRoot`).
 * Until this branch existed the adapter produced none of them, and the
 * publisher lane that declared a callback for `KnowledgeAssetUpdated` was
 * therefore permanently idle — asking for a name the adapter never yields is
 * indistinguishable from "there were no such events".
 *
 * These are pure-logic tests: the adapter's `init()` and `readContractWith()`
 * seams are replaced so no RPC is made, and the logs are encoded with the
 * SHIPPED ABI via `Interface.encodeEventLog` so a field-ordering drift in
 * `abi/DKGKnowledgeAssets.json` shows up here rather than in production.
 *
 * The properties under test, and why each one can actually fail:
 *
 *  - `kaId` is read from `topics[1]`, NOT from `parseLog`. A log whose
 *    non-indexed tail fails to decode still identifies its asset. Deleting
 *    the topic read in favour of `parseLog` reds `yields kaId from topics[1]
 *    even when the payload cannot be decoded`.
 *  - Every branch is guarded by an ABI-fragment check, so a node bound to a
 *    legacy `DKGKnowledgeAssets` degrades to "yields nothing" instead of
 *    throwing out of the caller's whole scan. Dropping the guard reds
 *    `a legacy ABI ... does not throw`.
 *  - The scan fetches RAW logs (`eth_getLogs` via `readProvider`) with the
 *    `wideLogScan` policy and `skipPreferred` carve-out, keeping tip coverage
 *    aligned with the head that advances the lane cursor. A `queryFilter`
 *    route would ALSO eagerly decode every matched log's payload inside
 *    ethers (review r2) — the raw route decodes nothing until this code
 *    chooses to. Rerouting reds `every scan is issued through the wide-log
 *    failover path`.
 *  - `KnowledgeAssetMerkleRootsUpdated` is never ABI-decoded (unbounded
 *    dynamic-array decode on an untrusted payload). Adding a `parseLog` call
 *    for it reds `never decodes the dynamic root array`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers, Interface } from 'ethers';
import {
  EVMChainAdapter,
  type EVMAdapterConfig,
} from '../src/evm-adapter.js';
import {
  KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES,
  SERVED_EVENT_TYPES,
  type KnowledgeAssetRootMutationEventType,
} from '../src/evm-adapter-events.js';
import { InvalidRpcLogResponseError, RpcFailoverClient, type RpcEndpoint } from '../src/rpc-failover-client.js';
import type { ChainEvent } from '../src/chain-adapter.js';

const ABI_DIR = join(import.meta.dirname, '..', 'abi');
const KA_ABI = JSON.parse(readFileSync(join(ABI_DIR, 'DKGKnowledgeAssets.json'), 'utf8'));

// A hardhat-account key; never used to sign here (no provider is reachable).
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const KA_ID = 123_456_789n;
const ROOT = '0x' + 'ab'.repeat(32);
const AUTHOR = '0x' + '11'.repeat(20);
const BLOCK_HASH = '0x' + 'cd'.repeat(32);
const TX_HASH = '0x' + 'ef'.repeat(32);

/** Minimal off-chain adapter config — nothing here is dialled. */
function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

interface FakeLog {
  address?: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  index: number;
}

interface ScanRecord {
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
function encodeLog(
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

function sampleLog(iface: Interface, eventName: KnowledgeAssetRootMutationEventType): FakeLog {
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
function makeAdapter(options: {
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

async function drain(adapter: EVMChainAdapter, eventTypes: string[]): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for await (const ev of adapter.listenForEvents({ eventTypes, fromBlock: 1, toBlock: 9_000 })) {
    out.push(ev);
  }
  return out;
}

describe('KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES', () => {
  it('enumerates exactly the four root-mutating emitters', () => {
    // A literal pin, not a derivation: dropping a name from the constant
    // silently un-subscribes the lane (it just stops finding those events),
    // so the list is the thing that must be asserted.
    expect([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]).toEqual([
      'KnowledgeAssetUpdated',
      'KnowledgeAssetMerkleRootAdded',
      'KnowledgeAssetMerkleRootsUpdated',
      'KnowledgeAssetMerkleRootRemoved',
    ]);
  });

  it('every name exists in the shipped DKGKnowledgeAssets ABI', () => {
    const iface = new Interface(KA_ABI as never);
    for (const name of KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES) {
      expect(iface.getEvent(name), `${name} missing from ABI`).not.toBeNull();
    }
  });

  it('every name carries the KA id as its FIRST indexed argument', () => {
    // This is the precondition the `topics[1]` read depends on. An emitter
    // added to the constant whose first indexed field is something else
    // (a publisher address, say) would yield a confidently WRONG `kaId`
    // rather than failing — so the shape is pinned, not assumed.
    const iface = new Interface(KA_ABI as never);
    for (const name of KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES) {
      const indexed = iface.getEvent(name)!.inputs.filter((i) => i.indexed);
      expect(indexed.length, `${name} has no indexed args`).toBeGreaterThan(0);
      expect(indexed[0].name, `${name} first indexed arg`).toBe('id');
      expect(indexed[0].type, `${name} first indexed arg type`).toBe('uint256');
    }
  });
});

describe('EVMChainAdapter.listenForEvents — KA root mutations', () => {
  it('yields all four types with the documented data keys', async () => {
    const iface = new Interface(KA_ABI as never);
    const logsByEvent: Record<string, FakeLog[]> = {};
    for (const name of KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES) {
      logsByEvent[name] = [sampleLog(iface, name)];
    }
    const { adapter } = makeAdapter({ logsByEvent });

    const events = await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    expect(events.map((e) => e.type)).toEqual([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);
    for (const ev of events) {
      expect(ev.blockNumber).toBe(4_242);
      expect(ev.data['kaId']).toBe(KA_ID.toString());
      expect(ev.data['txHash']).toBe(TX_HASH);
      expect(ev.data['txIndex']).toBe(7);
      expect(ev.data['logIndex']).toBe(3);
      expect(ev.data['blockHash']).toBe(BLOCK_HASH);
    }
  });

  it('carries merkleRoot on the three single-root events and omits it on roots-replaced', async () => {
    const iface = new Interface(KA_ABI as never);
    const logsByEvent: Record<string, FakeLog[]> = {};
    for (const name of KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES) {
      logsByEvent[name] = [sampleLog(iface, name)];
    }
    const { adapter } = makeAdapter({ logsByEvent });

    const byType = new Map(
      (await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES])).map((e) => [e.type, e]),
    );

    expect(byType.get('KnowledgeAssetUpdated')!.data['merkleRoot']).toBe(ROOT);
    expect(byType.get('KnowledgeAssetMerkleRootAdded')!.data['merkleRoot']).toBe(ROOT);
    expect(byType.get('KnowledgeAssetMerkleRootRemoved')!.data['merkleRoot']).toBe(ROOT);
    expect('merkleRoot' in byType.get('KnowledgeAssetMerkleRootsUpdated')!.data).toBe(false);
  });

  it('carries author on the lifecycle update only', async () => {
    const iface = new Interface(KA_ABI as never);
    const logsByEvent: Record<string, FakeLog[]> = {};
    for (const name of KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES) {
      logsByEvent[name] = [sampleLog(iface, name)];
    }
    const { adapter } = makeAdapter({ logsByEvent });

    const byType = new Map(
      (await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES])).map((e) => [e.type, e]),
    );

    expect(String(byType.get('KnowledgeAssetUpdated')!.data['author']).toLowerCase())
      .toBe(AUTHOR.toLowerCase());
    // The other three emitters declare no author field at all. Absent (rather
    // than `null`) keeps "the chain said nobody" separable from "no such field".
    expect('author' in byType.get('KnowledgeAssetMerkleRootAdded')!.data).toBe(false);
    expect('author' in byType.get('KnowledgeAssetMerkleRootsUpdated')!.data).toBe(false);
    expect('author' in byType.get('KnowledgeAssetMerkleRootRemoved')!.data).toBe(false);
  });

  it('yields kaId from topics[1] even when the payload cannot be decoded', async () => {
    // The topic0 and the indexed id are intact; the non-indexed tail is not a
    // valid encoding, so `parseLog` throws. A consumer still learns WHICH
    // asset moved — which is the only field it needs to act.
    const iface = new Interface(KA_ABI as never);
    const good = sampleLog(iface, 'KnowledgeAssetUpdated');
    const undecodable: FakeLog = { ...good, data: '0xdeadbeef' };
    const { adapter } = makeAdapter({
      logsByEvent: { KnowledgeAssetUpdated: [undecodable] },
    });

    const events = await drain(adapter, ['KnowledgeAssetUpdated']);

    expect(events).toHaveLength(1);
    expect(events[0].data['kaId']).toBe(KA_ID.toString());
    expect('merkleRoot' in events[0].data).toBe(false);
    expect(events[0].data['blockHash']).toBe(BLOCK_HASH);
  });

  it('a malformed indexed id from the ONLY endpoint fails the scan — no partial consumption (review r14)', async () => {
    // r14 overturned the r2 skip rule: a wrong-sized topic on a log matching
    // our filter cannot originate on-chain, so it is endpoint corruption. With
    // every endpoint exhausted the scan FAILS (the lane holds its cursor and
    // retries later) rather than reporting a successful scan that silently
    // dropped a mutation the endpoint mangled. Nothing from the corrupt
    // response is consumed — not even its well-formed logs.
    const iface = new Interface(KA_ABI as never);
    const good = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const malformed: FakeLog = { ...good, topics: [good.topics[0], 'not-a-hex-word'] };
    // The VALID log comes FIRST (review r17): an implementation that
    // validated incrementally would yield it before throwing on the
    // malformed tail — a callback would then act on an untrustworthy
    // partial response. The iterator's FIRST result must already reject.
    const { adapter } = makeAdapter({
      logsByEvent: { KnowledgeAssetMerkleRootAdded: [good, malformed] },
    });

    const iterator = adapter
      .listenForEvents({ eventTypes: ['KnowledgeAssetMerkleRootAdded'], fromBlock: 1, toBlock: 9_000 })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/malformed log at block/);
  });

  it('a short-but-parsable hex topic never mints a WRONG kaId (reviews r2+r14)', async () => {
    // The sharper malformed case: `0x01` is not a 32-byte EVM topic, but
    // `ethers.getBigInt` parses it happily — so without an exact-width guard
    // the scan would yield kaId "1" and a consumer would durably record a
    // re-verification intent for an asset that was never mutated. Under the
    // r14 contract the corrupt response fails the scan outright; the property
    // this row pins is that NO reading of it ever becomes kaId "1".
    const iface = new Interface(KA_ABI as never);
    const good = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const shortTopic: FakeLog = { ...good, topics: [good.topics[0], '0x01'] };
    // Valid log first (review r17): the whole response must be validated
    // before ANY consumption, so the first iterator result rejects.
    const { adapter } = makeAdapter({
      logsByEvent: { KnowledgeAssetMerkleRootAdded: [good, shortTopic] },
    });

    const iterator = adapter
      .listenForEvents({ eventTypes: ['KnowledgeAssetMerkleRootAdded'], fromBlock: 1, toBlock: 9_000 })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/malformed log at block/);
  });

  it('never decodes the dynamic root array of KnowledgeAssetMerkleRootsUpdated', async () => {
    const iface = new Interface(KA_ABI as never);
    const log = sampleLog(iface, 'KnowledgeAssetMerkleRootsUpdated');
    const { adapter, parseLogCalls } = makeAdapter({
      logsByEvent: { KnowledgeAssetMerkleRootsUpdated: [log] },
    });

    const events = await drain(adapter, ['KnowledgeAssetMerkleRootsUpdated']);

    expect(events).toHaveLength(1);
    expect(events[0].data['kaId']).toBe(KA_ID.toString());
    // The log IS decodable — so a `parseLog` call here would pass its own
    // assertions and only show up as unbounded work on an untrusted payload.
    expect(parseLogCalls).toEqual([]);
  });

  it('issues every scan through the wide-log failover path', async () => {
    const { adapter, scans } = makeAdapter({});

    await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    // ONE combined scan for the whole group (review r6) — not four.
    expect(scans.map((s) => s.label)).toEqual(['kas.getLogs(KnowledgeAssetRootMutations)']);
    for (const scan of scans) {
      // `wideLogScan` owns the multi-RPC log timeout; `skipPreferred` keeps the
      // scan canonical-fresh so a lagging sticky endpoint cannot clamp
      // `toBlock` below the head that advances the cursor.
      expect(scan.policy, scan.label).toBe('wideLogScan');
      expect(scan.skipPreferred, scan.label).toBe(true);
    }
  });

  it('sends the owning address, the four-topic OR filter and the requested block range (review r7)', async () => {
    const { adapter, scans, iface } = makeAdapter({});

    await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    expect(scans).toHaveLength(1);
    const req = scans[0].request;
    expect(req, 'the production callback never issued getLogs').toBeDefined();
    // The scan is pinned to the storage contract that owns the events — an
    // address-less request would match every contract on the chain.
    expect(req?.address).toBe('0x' + '22'.repeat(20));
    // topics[0] is the OR-set of exactly the four root-mutation topic hashes;
    // no further topic positions are constrained.
    const expectedHashes = KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES
      .map((name) => iface.getEvent(name)!.topicHash);
    const topics = req?.topics as string[][];
    expect(topics).toHaveLength(1);
    expect([...topics[0]].sort()).toEqual([...expectedHashes].sort());
    // The range is the caller's window, verbatim — a dropped bound would scan
    // from genesis or clamp to a lagging endpoint's tip.
    expect(req?.fromBlock).toBe(1);
    expect(req?.toBlock).toBe(9_000);
  });

  it('a corrupt endpoint FAILS OVER instead of yielding a successful empty scan (review r14)', async () => {
    // A wrong-sized indexed-id topic on a log matching our filter cannot
    // originate on-chain — it is endpoint corruption. Silently skipping it
    // let a faulty RPC hide a real mutation behind a "successful" response:
    // the failover never fired and the lane cursor advanced past the block.
    const iface = new Interface(KA_ABI as never);
    const valid = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const corrupt: FakeLog = { ...valid, topics: [valid.topics[0]!, '0x01', ...valid.topics.slice(2)] };

    const { adapter } = makeAdapter({});
    const attempts: string[] = [];
    const priv = adapter as unknown as {
      readProvider: (label: string, fn: unknown, opts?: unknown) => Promise<unknown>;
    };
    priv.readProvider = async (_label, fn) => {
      // Emulate the production read-failover contract: run the callback per
      // endpoint; a throw moves to the next endpoint.
      const run = fn as (p: { getLogs: (req: unknown) => Promise<FakeLog[]> }) => Promise<FakeLog[]>;
      try {
        attempts.push('corrupt-endpoint');
        return await run({ getLogs: async () => [corrupt] });
      } catch {
        attempts.push('healthy-endpoint');
        return run({ getLogs: async () => [valid] });
      }
    };

    const events = await drain(adapter, ['KnowledgeAssetMerkleRootAdded']);

    // The corrupt response was rejected INSIDE the per-provider callback, the
    // failover tried the healthy endpoint, and the real mutation arrived.
    expect(attempts).toEqual(['corrupt-endpoint', 'healthy-endpoint']);
    expect(events).toHaveLength(1);
    expect(events[0].data['kaId']).toBe(KA_ID.toString());
  });

  it('endpoint corruption rides the REAL failover: BAD_DATA advances to the healthy endpoint (review r15)', async () => {
    // The row above emulates the failover contract; this one runs the REAL
    // RpcFailoverClient so the production retry CLASSIFIER decides the
    // advance. A plain Error is non-retryable there — the corrupt endpoint
    // would hold the lane in failure/backoff and the healthy endpoint would
    // never be queried. The corruption error carries `code: 'BAD_DATA'`,
    // which the raw-provider read path classifies as retryable.
    const iface = new Interface(KA_ABI as never);
    const valid = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const corrupt: FakeLog = { ...valid, topics: [valid.topics[0]!, '0x01', ...valid.topics.slice(2)] };

    const { adapter } = makeAdapter({});
    const calls: string[] = [];
    const endpoint = (name: string, logs: FakeLog[]): RpcEndpoint => ({
      rpcUrl: `http://fake-${name}.invalid`,
      provider: {
        getLogs: async () => { calls.push(name); return logs; },
      } as unknown as RpcEndpoint['provider'],
    });
    const failover = new RpcFailoverClient(
      () => [endpoint('corrupt', [corrupt]), endpoint('healthy', [valid])],
      (async () => { throw new Error('no signing in this test'); }) as never,
      () => 'evm:31337',
      { stickiness: { enabled: false } },
    );
    const priv = adapter as unknown as { rpcFailover: RpcFailoverClient; readProvider?: unknown };
    priv.rpcFailover = failover;
    // Drop the harness stub so the PROTOTYPE readProvider — the production
    // transport entry — runs against the real failover client above.
    delete priv.readProvider;

    const events = await drain(adapter, ['KnowledgeAssetMerkleRootAdded']);

    expect(calls).toEqual(['corrupt', 'healthy']);
    expect(events).toHaveLength(1);
    expect(events[0].data['kaId']).toBe(KA_ID.toString());
  });

  it('a response log that ESCAPES the requested filter is endpoint corruption (review r16)', async () => {
    // eth_getLogs filters by address and block range. A log from another
    // contract, or outside the requested window, proves the endpoint violated
    // the request — accepting it would fabricate a root-mutation position and
    // poison downstream ordering/de-duplication; silently dropping it would
    // hide the corruption from the failover. Both reject through the same
    // retryable corruption path.
    const iface = new Interface(KA_ABI as never);
    const good = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const foreignContract: FakeLog = { ...good, address: '0x' + '99'.repeat(20) };
    const outsideWindow: FakeLog = { ...good, blockNumber: 10_000 }; // drain requests 1..9_000

    for (const [label, bad] of [['foreign contract', foreignContract], ['outside window', outsideWindow]] as const) {
      // Valid log FIRST (review r17): rejection must precede any yield.
      const { adapter } = makeAdapter({
        logsByEvent: { KnowledgeAssetMerkleRootAdded: [good, bad] },
      });
      const iterator = adapter
        .listenForEvents({ eventTypes: ['KnowledgeAssetMerkleRootAdded'], fromBlock: 1, toBlock: 9_000 })
        [Symbol.asyncIterator]();
      await expect(iterator.next(), label).rejects.toThrow(/outside the requested filter/);
    }
  });

  it('each yielded event carries the position of ITS OWN log (review r10)', async () => {
    // Every other row shares one set of position constants, so a regression
    // that stamped the FIRST log's transaction hash and indexes onto all four
    // events would have stayed green while later mutations de-duplicated and
    // ordered against the wrong position.
    const iface = new Interface(KA_ABI as never);
    const distinct = (n: number): Partial<FakeLog> => ({
      blockNumber: 4_000 + n,
      blockHash: '0x' + n.toString(16).padStart(2, '0').repeat(32),
      transactionHash: '0x' + (0x30 + n).toString(16).repeat(32),
      transactionIndex: 10 + n,
      index: 20 + n,
    });
    const { adapter } = makeAdapter({
      logsByEvent: {
        KnowledgeAssetUpdated: [encodeLog(iface, 'KnowledgeAssetUpdated', [KA_ID, AUTHOR, 'op-1', ROOT, 4_096n, 10n], distinct(1))],
        KnowledgeAssetMerkleRootAdded: [encodeLog(iface, 'KnowledgeAssetMerkleRootAdded', [KA_ID, ROOT], distinct(2))],
        KnowledgeAssetMerkleRootsUpdated: [encodeLog(iface, 'KnowledgeAssetMerkleRootsUpdated', [KA_ID, [[AUTHOR, ROOT, 1_700_000_000n]]], distinct(3))],
        KnowledgeAssetMerkleRootRemoved: [encodeLog(iface, 'KnowledgeAssetMerkleRootRemoved', [KA_ID, ROOT], distinct(4))],
      },
    });

    const events = await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    expect(events).toHaveLength(4);
    const byType = new Map(events.map((e) => [e.type, e]));
    const expected: ReadonlyArray<readonly [number, string]> = [
      [1, 'KnowledgeAssetUpdated'],
      [2, 'KnowledgeAssetMerkleRootAdded'],
      [3, 'KnowledgeAssetMerkleRootsUpdated'],
      [4, 'KnowledgeAssetMerkleRootRemoved'],
    ];
    for (const [n, type] of expected) {
      const e = byType.get(type);
      expect(e, type).toBeDefined();
      expect(e?.blockNumber, type).toBe(4_000 + n);
      expect(e?.data['blockHash'], type).toBe('0x' + n.toString(16).padStart(2, '0').repeat(32));
      expect(e?.data['txHash'], type).toBe('0x' + (0x30 + n).toString(16).repeat(32));
      expect(e?.data['txIndex'], type).toBe(10 + n);
      expect(e?.data['logIndex'], type).toBe(20 + n);
    }
  });

  it('a legacy ABI without the four events yields nothing and does not throw', async () => {
    // `contract.filters.<name>()` on an ABI lacking the fragment throws, and a
    // throw inside `listenForEvents` aborts the WHOLE scan — the node would
    // lose the events it can serve because of one it cannot.
    const legacyAbi = (KA_ABI as unknown[]).filter(
      (entry) => !(
        (entry as { type?: string }).type === 'event' &&
        (KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES as readonly string[])
          .includes((entry as { name?: string }).name ?? '')
      ),
    );
    const { adapter, scans } = makeAdapter({ abi: legacyAbi });

    const events = await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    expect(events).toEqual([]);
    expect(scans).toEqual([]);
  });

  it('yields nothing when no knowledgeAssetStorage is bound', async () => {
    const { adapter, scans } = makeAdapter({ bindStorage: false });

    const events = await drain(adapter, [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);

    expect(events).toEqual([]);
    expect(scans).toEqual([]);
  });

  it('stays silent for an event type it does not serve', async () => {
    const { adapter, scans } = makeAdapter({});

    const events = await drain(adapter, ['SomeEventNobodyEmits']);

    expect(events).toEqual([]);
    expect(scans).toEqual([]);
  });

  it('does not disturb the pre-existing branches when they share a filter', async () => {
    // The seven shipped branches and the new one are selected by independent
    // `if`s over the same `eventType` loop; a regression that turned the new
    // membership test into an `else` would silently drop one of them.
    const iface = new Interface(KA_ABI as never);
    const { adapter, scans } = makeAdapter({
      logsByEvent: { KnowledgeAssetMerkleRootAdded: [sampleLog(iface, 'KnowledgeAssetMerkleRootAdded')] },
    });

    const events = await drain(adapter, ['KCCreated', 'KnowledgeAssetMerkleRootAdded']);

    expect(events.map((e) => e.type)).toEqual(['KnowledgeAssetMerkleRootAdded']);
    // KCCreated scanned its own create/mint/transfer surfaces on the same
    // binding, then the root-mutation branch scanned its one name.
    expect(scans.some((s) => s.label.includes('KnowledgeAssetCreated'))).toBe(true);
    expect(scans.some((s) => s.label === 'kas.getLogs(KnowledgeAssetRootMutations)')).toBe(true);
  });
});

describe('validated raw-log scan — typed corruption classification (review r3-bot)', () => {
  it('corruption escapes as InvalidRpcLogResponseError, no ethers code inspected or forged', async () => {
    // The classification is a NAMED transport error routed through
    // ReadOpts.isRetryable — the previous shape mutated `.code = 'BAD_DATA'`
    // onto a plain Error to satisfy the generic classifier, coupling this
    // feature to an incidental ethers string.
    const iface = new Interface(KA_ABI as never);
    const good = sampleLog(iface, 'KnowledgeAssetMerkleRootAdded');
    const malformed: FakeLog = { ...good, topics: [good.topics[0], 'not-a-hex-word'] };
    const { adapter } = makeAdapter({
      logsByEvent: { KnowledgeAssetMerkleRootAdded: [malformed] },
    });

    const iterator = adapter
      .listenForEvents({ eventTypes: ['KnowledgeAssetMerkleRootAdded'], fromBlock: 1, toBlock: 9_000 })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(InvalidRpcLogResponseError);
  });
});
describe('EVMChainAdapter.supportsEventTypes', () => {
  it('accepts EACH alias spelling independently, not only the primary (review r3-bot)', async () => {
    // Both fixtures previously carried the FIRST spelling only, so dropping
    // or mis-probing the fallback would stay green. One minimal ABI per
    // SPELLING, bound to the owning contract, each probed alone.
    const cases = [
      {
        name: 'KCCreated',
        owner: 'knowledgeAssetStorage',
        spellings: [
          { fragment: 'KnowledgeAssetCreated' },
          { fragment: 'KCCreated' },
        ],
      },
      {
        name: 'ContextGraphNameClaimed',
        owner: 'contextGraphNameRegistry',
        spellings: [
          { fragment: 'NameClaimed' },
          { fragment: 'ContextGraphNameClaimed' },
        ],
      },
    ] as const;
    for (const { name, owner, spellings } of cases) {
      for (const spelling of spellings) {
        const abi = [{
          type: 'event', name: spelling.fragment, anonymous: false,
          inputs: [{ indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' }],
        }];
        const contract = new ethers.Contract('0x' + '44'.repeat(20), abi as never);
        const { adapter } = makeAdapter({});
        (adapter as unknown as { contracts: Record<string, unknown> }).contracts[owner] = contract;

        await expect(
          adapter.supportsEventTypes([name]),
          `${name} must be supported by a ${spelling.fragment}-ONLY ABI`,
        ).resolves.toEqual([]);
      }
      // And an owning ABI with NEITHER spelling refuses the name — the
      // aliases widen acceptance, they do not disable the probe.
      const emptyAbi = [{
        type: 'event', name: 'SomethingUnrelated', anonymous: false,
        inputs: [{ indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' }],
      }];
      const bare = new ethers.Contract('0x' + '45'.repeat(20), emptyAbi as never);
      const { adapter } = makeAdapter({});
      (adapter as unknown as { contracts: Record<string, unknown> }).contracts[owner] = bare;
      await expect(adapter.supportsEventTypes([name])).resolves.toEqual([name]);
    }
  });

  it('the served roster equals an INDEPENDENTLY written vocabulary (review r3-bot)', () => {
    // SERVED_EVENT_TYPES is the implementation output; using it as the test
    // input let an omitted ownership row hide (the probe would refuse an
    // event listenForEvents still serves, while every parity assertion
    // stayed green). This roster is written BY HAND — update it only when
    // the public event vocabulary genuinely changes.
    const EXPECTED_ROSTER = [
      'KnowledgeBatchCreated',
      'ContextGraphExpanded',
      'KnowledgeAssetRegisteredToContextGraph',
      'KCCreated',
      'KnowledgeAssetCreated',
      'NameClaimed',
      'ContextGraphNameClaimed',
      'ContextGraphCreated',
      'RelayCapabilityUpdated',
      'KnowledgeAssetUpdated',
      'KnowledgeAssetMerkleRootAdded',
      'KnowledgeAssetMerkleRootsUpdated',
      'KnowledgeAssetMerkleRootRemoved',
    ];
    expect([...SERVED_EVENT_TYPES].sort()).toEqual([...EXPECTED_ROSTER].sort());
  });
  it('reports nothing missing when the bound ABI declares every name', async () => {
    const { adapter } = makeAdapter({});
    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual([]);
  });

  it('names the specific events a legacy ABI cannot produce', async () => {
    const legacyAbi = (KA_ABI as unknown[]).filter(
      (entry) => (entry as { name?: string }).name !== 'KnowledgeAssetMerkleRootRemoved',
    );
    const { adapter } = makeAdapter({ abi: legacyAbi });

    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual(['KnowledgeAssetMerkleRootRemoved']);
  });

  it('reports every name missing when no storage contract is bound', async () => {
    const { adapter } = makeAdapter({ bindStorage: false });
    await expect(
      adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
    ).resolves.toEqual([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);
  });

  it('answers each name from the contract that OWNS it, not from one hard-coded binding (review r2)', async () => {
    // The first implementation asked `knowledgeAssetStorage` about every name,
    // so `ContextGraphCreated` — an event this adapter genuinely serves from
    // `contextGraphStorage` — was reported missing. The registry keys the
    // answer per event.
    const cgAbi = [{
      type: 'event', name: 'ContextGraphCreated', anonymous: false,
      inputs: [{ indexed: true, internalType: 'uint256', name: 'contextGraphId', type: 'uint256' }],
    }];
    const cgContract = new ethers.Contract('0x' + '33'.repeat(20), cgAbi as never);
    const { adapter } = makeAdapter({});
    (adapter as unknown as { contracts: Record<string, unknown> }).contracts['contextGraphStorage'] = cgContract;

    // Owned by contextGraphStorage and declared there → supported.
    await expect(adapter.supportsEventTypes(['ContextGraphCreated'])).resolves.toEqual([]);
    // Served by this adapter but its owning contract lacks the fragment → missing.
    await expect(adapter.supportsEventTypes(['ContextGraphExpanded'])).resolves.toEqual(['ContextGraphExpanded']);
    // No scan branch serves this name at all → missing, whatever any ABI says.
    await expect(adapter.supportsEventTypes(['NoSuchEventAnywhere'])).resolves.toEqual(['NoSuchEventAnywhere']);
    // Mixed probe: each name judged independently.
    await expect(
      adapter.supportsEventTypes(['ContextGraphCreated', 'KnowledgeAssetUpdated', 'NoSuchEventAnywhere']),
    ).resolves.toEqual(['NoSuchEventAnywhere']);
    // r6 divergence row: both public spellings of the name-claim event are
    // served from ContextGraphNameRegistry, whose ABI spells the fragment
    // `NameClaimed` — the probe must answer BOTH spellings as supported.
    const nameAbi = [{
      type: 'event', name: 'NameClaimed', anonymous: false,
      inputs: [{ indexed: true, internalType: 'bytes32', name: 'nameHash', type: 'bytes32' }],
    }];
    const registry = new ethers.Contract('0x' + '44'.repeat(20), nameAbi as never);
    (adapter as unknown as { contracts: Record<string, unknown> }).contracts['contextGraphNameRegistry'] = registry;
    await expect(adapter.supportsEventTypes(['NameClaimed', 'ContextGraphNameClaimed'])).resolves.toEqual([]);
    // Served name whose ABI FRAGMENT is spelled differently (review r3):
    // `listenForEvents` serves the public name `KCCreated` by scanning the
    // greenfield `KnowledgeAssetCreated` fragment, so the probe must accept
    // the alias — a literal-fragment probe reports a served event missing.
    await expect(adapter.supportsEventTypes(['KCCreated'])).resolves.toEqual([]);
  });
});
