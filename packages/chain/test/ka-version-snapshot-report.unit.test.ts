// SPDX-License-Identifier: Apache-2.0

/**
 * What `readKnowledgeAssetVersionSnapshot` says beside its answer.
 *
 * The rule is tested in ka-version-snapshot.unit.test.ts and is not what these rows are about:
 * the primary endpoint is asked for a complete view at one pinned block, then the configured
 * fallbacks in order (GH#3098). These rows are about what that read otherwise drops. An endpoint
 * that fails is passed over without a word, and a `null` does not say which endpoint failed, at
 * which step, or why. A node whose only endpoint serves `latest` reads and refuses every read
 * pinned to a block number never finalizes a confirmed publish, and nothing named the endpoint.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Contract, Interface } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  KnowledgeAssetVersionSnapshotTrace,
  _resetKnowledgeAssetVersionSnapshotHealthForTest,
  classifyKnowledgeAssetVersionSnapshotEndpointError,
  describeKnowledgeAssetVersionSnapshotEndpointFailure,
  describeKnowledgeAssetVersionSnapshotUnavailable,
  getKnowledgeAssetVersionSnapshotHealth,
  type KnowledgeAssetVersionSnapshotEndpointFailure,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '../src/ka-version-snapshot-report.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';

const KA_ID = 7n;
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ROOT = `0x${'aa'.repeat(32)}`;
const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;
const KAS_ADDRESS = `0x${'33'.repeat(20)}`;
const SECRET_PATH = 'v3/SECRET-PATH-KEY';
const SECRET_QUERY = 'apikey=SECRET-QUERY-KEY';

const NOTHING_RECORDED = {
  established: 0,
  unavailable: 0,
  consecutiveUnavailable: 0,
  unavailableSince: null,
  lastUnavailableReason: null,
  failingEndpoints: [],
};

function hashForBlock(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, '0')}`;
}

function config(rpcUrls: string[], finalityConfirmations = 1) {
  return {
    rpcUrl: rpcUrls[0],
    rpcUrls: rpcUrls.slice(1),
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    finalityConfirmations,
  } as never;
}

/** Reads the snapshot and returns the answer with the report the caller was handed, if any. */
async function readWithReport(adapter: any, signal?: AbortSignal) {
  const reports: KnowledgeAssetVersionSnapshotUnavailable[] = [];
  const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID, {
    ...(signal ? { signal } : {}),
    onUnavailable: (report: KnowledgeAssetVersionSnapshotUnavailable) => { reports.push(report); },
  });
  return { view, reports };
}

beforeEach(() => {
  _resetKnowledgeAssetVersionSnapshotHealthForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The real transport: endpoints that serve `latest` and refuse pinned reads
// ---------------------------------------------------------------------------

const KAS_INTERFACE = new Interface(loadAbi('DKGKnowledgeAssets') as never[]);

interface RpcEndpoint {
  server: Server;
  url: string;
  host: string;
  /** How this endpoint answers an `eth_call` pinned to a block number. */
  pinned: { kind: 'serve' } | { kind: 'http'; status: number } | { kind: 'rpc-error' };
  /** Requests received, of any kind, and pinned calls among them. */
  requests: number;
  pinnedCalls: number;
}

async function startRpcEndpoint(pinned: RpcEndpoint['pinned'], head = 500): Promise<RpcEndpoint> {
  const endpoint = { pinned, requests: 0, pinnedCalls: 0 } as RpcEndpoint;
  const answer = (call: { id: unknown; method: string; params: any[] }) => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
    if (call.method === 'eth_chainId') return ok('0x7a69');
    if (call.method === 'eth_getBlockByNumber') {
      return ok({
        number: `0x${head.toString(16)}`,
        hash: hashForBlock(head),
        parentHash: hashForBlock(head - 1),
        timestamp: '0x1',
        nonce: '0x0000000000000000',
        difficulty: '0x0',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        miner: AUTHOR,
        extraData: '0x',
        baseFeePerGas: '0x1',
        transactions: [],
      });
    }
    if (call.method === 'eth_call') {
      if (call.params[1] !== 'latest') {
        endpoint.pinnedCalls += 1;
        if (endpoint.pinned.kind === 'http') return endpoint.pinned.status;
        if (endpoint.pinned.kind === 'rpc-error') {
          return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'state is not available' } };
        }
      }
      const fn = KAS_INTERFACE.getFunction(String(call.params[0].data).slice(0, 10))!;
      const values: Record<string, unknown[]> = {
        getLatestMerkleRoot: [ROOT],
        getKnowledgeAssetUpdateContext: [3n, 1n, 100n, 10n, 0n, false, 4],
        getLatestMerkleRootAuthor: [AUTHOR],
        getLatestMerkleRootPublisher: [PUBLISHER],
      };
      return ok(KAS_INTERFACE.encodeFunctionResult(fn, values[fn.name]!));
    }
    return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'method not found' } };
  };
  endpoint.server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      endpoint.requests += 1;
      const answered = answer(JSON.parse(body));
      if (typeof answered === 'number') {
        res.writeHead(answered, { 'content-type': 'text/plain' });
        res.end('Unknown state. First available state is 1');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answered));
    });
  });
  await new Promise<void>((resolve) => endpoint.server.listen(0, '127.0.0.1', resolve));
  endpoint.host = `127.0.0.1:${(endpoint.server.address() as AddressInfo).port}`;
  // A path and a query, as a keyed provider URL has. Neither may leave the chain package.
  endpoint.url = `http://${endpoint.host}/${SECRET_PATH}?${SECRET_QUERY}`;
  return endpoint;
}

/** The adapter as configured: its own per-endpoint providers and the real ABI. Only the Hub is absent. */
function adapterOverEndpoints(endpoints: RpcEndpoint[]) {
  const adapter: any = new EVMChainAdapter(config(endpoints.map((endpoint) => endpoint.url)));
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.contracts = {
    knowledgeAssetStorage: new Contract(KAS_ADDRESS, KAS_INTERFACE, adapter.providers[0]),
  };
  return adapter;
}

describe('endpoints that serve latest reads and refuse block-pinned ones', () => {
  let endpoints: RpcEndpoint[] = [];
  let adapter: any;

  afterEach(async () => {
    for (const provider of adapter?.providers ?? []) provider.destroy();
    await Promise.all(endpoints.map((endpoint) => new Promise<void>((resolve) => {
      endpoint.server.closeAllConnections();
      endpoint.server.close(() => resolve());
    })));
    endpoints = [];
    adapter = undefined;
  });

  it('a refusing primary is passed over, the read succeeds, and the primary is on record', async () => {
    endpoints = [
      await startRpcEndpoint({ kind: 'http', status: 400 }),
      await startRpcEndpoint({ kind: 'serve' }),
      await startRpcEndpoint({ kind: 'serve' }),
    ];
    adapter = adapterOverEndpoints(endpoints);
    const [primary, fallback, unused] = endpoints as [RpcEndpoint, RpcEndpoint, RpcEndpoint];

    const first = await readWithReport(adapter);
    const second = await readWithReport(adapter);

    // The decision is the fallback's own: the first endpoint with a complete view answers.
    expect(first.view).toMatchObject({ latestRoot: ROOT, rootCount: 3n, blockNumber: 500 });
    expect(second.view).toMatchObject({ latestRoot: ROOT, rootCount: 3n, blockNumber: 500 });
    expect(first.reports).toEqual([]);
    expect(fallback.pinnedCalls).toBeGreaterThan(0);
    expect(unused.requests).toBe(0);
    // What the read used to drop: every read pays for the primary's refusal first.
    expect(primary.pinnedCalls).toBeGreaterThan(0);
    const health = getKnowledgeAssetVersionSnapshotHealth();
    expect(health).toMatchObject({
      established: 2,
      unavailable: 0,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      failingEndpoints: [{
        position: 1,
        endpointCount: 3,
        host: primary.host,
        stage: 'pinned-read',
        failure: 'http-client-error',
        httpStatus: 400,
        consecutive: 2,
      }],
    });
    // ethers puts the request URL, key included, in this error's message. Nothing produced
    // here may carry it: not the path, not the query, not a URL at all.
    const produced = JSON.stringify(health);
    expect(produced).not.toContain('SECRET');
    expect(produced).not.toContain('apikey');
    expect(produced).not.toContain('://');
  });

  it('when no endpoint serves the pinned read the answer is null and each one is named', async () => {
    endpoints = [
      await startRpcEndpoint({ kind: 'http', status: 400 }),
      await startRpcEndpoint({ kind: 'http', status: 403 }),
    ];
    adapter = adapterOverEndpoints(endpoints);
    const [primary, fallback] = endpoints as [RpcEndpoint, RpcEndpoint];

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 2,
      endpoints: [
        { position: 1, host: primary.host, stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 },
        { position: 2, host: fallback.host, stage: 'pinned-read', failure: 'http-client-error', httpStatus: 403 },
      ],
    }]);
    const words = describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!);
    expect(words).toBe(
      `endpoint 1 of 2 (${primary.host}) refused a block-pinned read (http 400); `
      + `endpoint 2 of 2 (${fallback.host}) refused a block-pinned read (http 403)`,
    );
    const health = getKnowledgeAssetVersionSnapshotHealth();
    expect(health).toMatchObject({
      established: 0,
      unavailable: 1,
      consecutiveUnavailable: 1,
      lastUnavailableReason: 'endpoints-failed',
    });
    expect(health.unavailableSince).toEqual(expect.any(Number));
    expect(health.failingEndpoints.map((entry) => entry.position)).toEqual([1, 2]);
    const produced = [JSON.stringify(reports), words, JSON.stringify(health)].join('\n');
    expect(produced).not.toContain('SECRET');
    expect(produced).not.toContain(SECRET_PATH);
    expect(produced).not.toContain('apikey');
    expect(produced).not.toContain('://');

    // The fallback starts serving pinned reads: the read succeeds, the fallback is forgotten,
    // and the primary stays on record as the endpoint every read passes over.
    fallback.pinned = { kind: 'serve' };
    const recovered = await readWithReport(adapter);

    expect(recovered.view).toMatchObject({ latestRoot: ROOT, blockNumber: 500 });
    expect(recovered.reports).toEqual([]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 1,
      unavailable: 1,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      lastUnavailableReason: null,
      failingEndpoints: [{ position: 1, host: primary.host, httpStatus: 400, consecutive: 2 }],
    });
  });

  it('a JSON-RPC error answer to the pinned read is a call exception, not an outage', async () => {
    endpoints = [await startRpcEndpoint({ kind: 'rpc-error' })];
    adapter = adapterOverEndpoints(endpoints);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports[0]!.endpoints).toEqual([{
      position: 1,
      host: endpoints[0]!.host,
      stage: 'pinned-read',
      failure: 'call-exception',
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      `endpoint 1 of 1 (${endpoints[0]!.host}) rejected a block-pinned read (call exception)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Every step of the per-endpoint read, over scripted providers
// ---------------------------------------------------------------------------

interface Script {
  host: string;
  chainId?: bigint;
  /** Head height; `null` is an endpoint that returns no head block. */
  head?: number | null;
  /** Errors for successive head reads, before `head` is served. */
  headErrors?: unknown[];
  /** `null` models a block without a hash. */
  hash?: string | null;
  /** Errors for successive pinned reads, before the view is served. */
  readErrors?: unknown[];
  author?: string | null;
  /** Never settles at this step. */
  stall?: 'head' | 'read';
}

function adapterOverScripts(scripts: Script[], opts: { finalityConfirmations?: number } = {}) {
  const asked: string[] = [];
  const providers = scripts.map((script) => ({
    script,
    async getNetwork() {
      asked.push(script.host);
      return { chainId: script.chainId ?? 31337n };
    },
    async getBlock(tag: 'latest' | number) {
      if (script.stall === 'head') return new Promise(() => {}) as never;
      if (tag === 'latest' && script.headErrors?.length) throw script.headErrors.shift();
      const head = script.head === undefined ? 500 : script.head;
      if (head === null) return null;
      const number = tag === 'latest' ? head : tag;
      return { number, hash: script.hash === undefined ? hashForBlock(number) : script.hash };
    },
  }));
  const adapter: any = new EVMChainAdapter(
    config(scripts.map((script) => `https://${script.host}/${SECRET_PATH}?${SECRET_QUERY}`),
      opts.finalityConfirmations),
  );
  adapter.ensureConfiguredStaticChainIdValidated = async () => 31337n;
  adapter.initialized = true;
  adapter.init = async () => {};
  const storage = { target: KAS_ADDRESS };
  adapter.contracts = { knowledgeAssetStorage: storage };
  adapter.providers = providers;
  adapter.rebindContract = (_contract: unknown, provider: (typeof providers)[number]) => ({
    async getLatestMerkleRoot() {
      if (provider.script.stall === 'read') return new Promise(() => {}) as never;
      if (provider.script.readErrors?.length) throw provider.script.readErrors.shift();
      return ROOT;
    },
    async getKnowledgeAssetUpdateContext() {
      return { 0: 3n, length: 7 };
    },
    async getLatestMerkleRootAuthor() {
      return provider.script.author === undefined ? AUTHOR : provider.script.author;
    },
    async getLatestMerkleRootPublisher() {
      return PUBLISHER;
    },
  });
  /** Hosts in the order the read first asked them. */
  const order = () => [...new Set(asked)];
  return { adapter, storage, order };
}

const HEALTHY: Script = { host: 'healthy.example' };
type Expected = Omit<KnowledgeAssetVersionSnapshotEndpointFailure, 'position' | 'host'>;

describe('which step an endpoint stopped at, and why', () => {
  // A script that fails the same way on its transient retry carries the error twice.
  const cases: Array<[string, () => Script, Expected, string]> = [
    [
      'another chain',
      () => ({ host: 'odd.example', chainId: 999n }),
      { stage: 'chain-id', failure: 'wrong-chain' },
      'answered for a different chain',
    ],
    [
      'no head block',
      () => ({ host: 'odd.example', head: null }),
      { stage: 'head-block', failure: 'incomplete-view' },
      'returned an incomplete answer to the head block read',
    ],
    [
      'a head read that cannot connect',
      () => ({ host: 'odd.example', headErrors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] }),
      { stage: 'head-block', failure: 'network' },
      'could not be reached for the head block read',
    ],
    [
      'a head read that times out',
      () => ({ host: 'odd.example', headErrors: [{ code: 'TIMEOUT' }] }),
      { stage: 'head-block', failure: 'timeout' },
      'timed out on the head block read',
    ],
    [
      'a block without a hash',
      () => ({ host: 'odd.example', hash: null }),
      { stage: 'pinned-block', failure: 'incomplete-view' },
      'returned an incomplete answer to the pinned block header read',
    ],
    [
      'a refused pinned read',
      () => ({
        host: 'odd.example',
        readErrors: [{ code: 'SERVER_ERROR', status: 400 }, { code: 'SERVER_ERROR', status: 400 }],
      }),
      { stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 },
      'refused a block-pinned read (http 400)',
    ],
    [
      'a throttled pinned read',
      () => ({ host: 'odd.example', readErrors: [{ status: 429 }, { status: 429 }] }),
      { stage: 'pinned-read', failure: 'http-throttled', httpStatus: 429 },
      'throttled a block-pinned read (http 429)',
    ],
    [
      'a pinned read behind a failing gateway',
      () => ({ host: 'odd.example', readErrors: [{ status: 503 }, { status: 503 }] }),
      { stage: 'pinned-read', failure: 'http-server-error', httpStatus: 503 },
      'failed a block-pinned read (http 503)',
    ],
    [
      'a pinned read the node rejects',
      () => ({ host: 'odd.example', readErrors: [{ code: 'CALL_EXCEPTION' }] }),
      { stage: 'pinned-read', failure: 'call-exception' },
      'rejected a block-pinned read (call exception)',
    ],
    [
      'a view without its author',
      () => ({ host: 'odd.example', author: null }),
      { stage: 'pinned-read', failure: 'incomplete-view' },
      'returned an incomplete answer to a block-pinned read',
    ],
  ];

  it.each(cases)('%s, as the only endpoint: null, and named', async (_name, odd, expected, words) => {
    const { adapter } = adapterOverScripts([odd()]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 1,
      endpoints: [{ position: 1, host: 'odd.example', ...expected }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      `endpoint 1 of 1 (odd.example) ${words}`,
    );
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  });

  it.each(cases)('%s, as the primary: passed over, and on record', async (_name, odd, expected) => {
    const { adapter, order } = adapterOverScripts([odd(), HEALTHY]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toMatchObject({ latestRoot: ROOT, blockNumber: 500 });
    expect(reports).toEqual([]);
    expect(order()).toEqual(['odd.example', 'healthy.example']);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 1,
      unavailable: 0,
      failingEndpoints: [{ position: 1, endpointCount: 2, host: 'odd.example', ...expected, consecutive: 1 }],
    });
  });

  it('a healthy primary answers alone: nothing is asked of the others and nothing is recorded', async () => {
    const { adapter, order } = adapterOverScripts([HEALTHY, { host: 'odd.example', chainId: 999n }]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toMatchObject({ latestRoot: ROOT, blockNumber: 500 });
    expect(reports).toEqual([]);
    expect(order()).toEqual(['healthy.example']);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual({ ...NOTHING_RECORDED, established: 1 });
  });

  it('names every endpoint that was asked, in configured order', async () => {
    const { adapter } = adapterOverScripts([
      { host: 'a.example', readErrors: [{ status: 401 }, { status: 401 }] },
      { host: 'b.example', chainId: 1n },
      { host: 'c.example', head: null },
    ]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'endpoint 1 of 3 (a.example) refused a block-pinned read (http 401); '
      + 'endpoint 2 of 3 (b.example) answered for a different chain; '
      + 'endpoint 3 of 3 (c.example) returned an incomplete answer to the head block read',
    );
  });

  it('reports the last attempt when the in-place retry fails differently', async () => {
    // The first failure is transient and retried; the endpoint's second answer is the one
    // the read moved on from, so it is the one reported.
    const { adapter } = adapterOverScripts([
      { host: 'odd.example', readErrors: [{ status: 503 }, { code: 'SERVER_ERROR', status: 404 }] },
    ]);

    const { reports } = await readWithReport(adapter);

    expect(reports[0]!.endpoints).toEqual([
      { position: 1, host: 'odd.example', stage: 'pinned-read', failure: 'http-client-error', httpStatus: 404 },
    ]);
  });

  it('says nothing when a transient failure is followed by a view from the same endpoint', async () => {
    const { adapter } = adapterOverScripts([{ host: 'blip.example', headErrors: [{ code: 'SERVER_ERROR' }] }]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toMatchObject({ latestRoot: ROOT, blockNumber: 500 });
    expect(reports).toEqual([]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual({ ...NOTHING_RECORDED, established: 1 });
  });

  it('a chain younger than the confirmation depth is an incomplete pinned block', async () => {
    const { adapter } = adapterOverScripts([{ host: 'young.example', head: 1 }], { finalityConfirmations: 3 });

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports[0]!.endpoints).toEqual([
      { position: 1, host: 'young.example', stage: 'pinned-block', failure: 'incomplete-view' },
    ]);
  });
});

describe('a null that no endpoint explains', () => {
  it('no storage contract, or one without an address', async () => {
    for (const storage of [undefined, {}]) {
      _resetKnowledgeAssetVersionSnapshotHealthForTest();
      const { adapter, order } = adapterOverScripts([HEALTHY]);
      adapter.contracts = { knowledgeAssetStorage: storage };

      const { view, reports } = await readWithReport(adapter);

      expect(view).toBeNull();
      expect(order()).toEqual([]);
      expect(reports).toEqual([{ reason: 'no-storage-contract', endpointCount: 1, endpoints: [] }]);
      expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
        'the knowledge asset storage contract is not resolved',
      );
      expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
        unavailable: 1,
        lastUnavailableReason: 'no-storage-contract',
        failingEndpoints: [],
      });
    }
  });

  /** Reads with `host`'s pinned read held until the storage binding has moved on, as a Hub rotation does. */
  async function readAcrossBindingChange(adapter: any, host: string) {
    let started!: () => void;
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rebind = adapter.rebindContract;
    adapter.rebindContract = (contract: unknown, provider: { script: Script }) => {
      const bound = rebind(contract, provider);
      if (provider.script.host !== host) return bound;
      const read = bound.getLatestMerkleRoot;
      bound.getLatestMerkleRoot = async () => { started(); await gate; return read(); };
      return bound;
    };

    const pending = readWithReport(adapter);
    await inFlight;
    adapter.knowledgeAssetStorageBindingGeneration += 1;
    release();
    return pending;
  }

  it('a storage binding that changes while the primary is read: no endpoint is blamed for it', async () => {
    // The primary's answer is for the binding the read began with, and the backup is never
    // asked: the node's own fence ends the read, and neither endpoint failed.
    const { adapter, order } = adapterOverScripts([{ host: 'a.example' }, { host: 'b.example' }]);

    const { view, reports } = await readAcrossBindingChange(adapter, 'a.example');

    expect(view).toBeNull();
    expect(order()).toEqual(['a.example']);
    expect(reports).toEqual([{ reason: 'storage-binding-changed', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'the storage contract binding changed during the read',
    );
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailable: 1,
      lastUnavailableReason: 'storage-binding-changed',
      failingEndpoints: [],
    });
  });

  it('an endpoint that failed before the binding changed is still named beside it', async () => {
    const { adapter, order } = adapterOverScripts([
      { host: 'odd.example', chainId: 999n },
      { host: 'a.example' },
      { host: 'b.example' },
    ]);

    const { view, reports } = await readAcrossBindingChange(adapter, 'a.example');

    expect(view).toBeNull();
    expect(order()).toEqual(['odd.example', 'a.example']);
    expect(reports).toEqual([{
      reason: 'storage-binding-changed',
      endpointCount: 3,
      endpoints: [{ position: 1, host: 'odd.example', stage: 'chain-id', failure: 'wrong-chain' }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'endpoint 1 of 3 (odd.example) answered for a different chain; '
      + 'the storage contract binding changed during the read',
    );
    expect(getKnowledgeAssetVersionSnapshotHealth().failingEndpoints).toMatchObject([
      { position: 1, host: 'odd.example', failure: 'wrong-chain' },
    ]);
  });

  it('a storage binding that changes after the endpoint answered', async () => {
    const { adapter } = adapterOverScripts([{ host: 'a.example' }, { host: 'b.example' }]);
    // The endpoint's read checks the binding as it starts and as it ends; the read checks it
    // once more before it answers.
    let checks = 0;
    adapter.knowledgeAssetStorageBindingIsCurrent = () => { checks += 1; return checks <= 2; };

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(checks).toBe(3);
    expect(reports).toEqual([{ reason: 'storage-binding-changed', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'the storage contract binding changed during the read',
    );
  });

  it("the node's own request budget stops the read: no endpoint is blamed for it", async () => {
    const { adapter, order } = adapterOverScripts([
      { host: 'a.example', headErrors: [new RpcRequestGovernorQueueFullError(8)] },
      HEALTHY,
    ]);

    const { view, reports } = await readWithReport(adapter);

    // The read ends there instead of asking the fallback, as it did before this report existed.
    expect(view).toBeNull();
    expect(order()).toEqual(['a.example']);
    expect(reports).toEqual([{ reason: 'local-pressure', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      "the node's own RPC request budget was full before another endpoint could be asked",
    );
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailable: 1,
      lastUnavailableReason: 'local-pressure',
      failingEndpoints: [],
    });
  });

  it('an endpoint that failed before the budget ran out is still named beside it', async () => {
    const { adapter } = adapterOverScripts([
      { host: 'odd.example', chainId: 999n },
      { host: 'b.example', headErrors: [new RpcRequestGovernorQueueFullError(8)] },
      HEALTHY,
    ]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'local-pressure',
      endpointCount: 3,
      endpoints: [{ position: 1, host: 'odd.example', stage: 'chain-id', failure: 'wrong-chain' }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'endpoint 1 of 3 (odd.example) answered for a different chain; '
      + "the node's own RPC request budget was full before another endpoint could be asked",
    );
  });
});

describe('a read the caller cancels', () => {
  it.each([
    ['head', 'head-block', 'the head block read'],
    ['read', 'pinned-read', 'a block-pinned read'],
  ] as const)('names the endpoint still waiting on its %s, and does not record it', async (stall, stage, read) => {
    const { adapter } = adapterOverScripts([{ host: 'slow.example', stall }]);
    const controller = new AbortController();

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { view, reports } = await pending;

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'aborted',
      endpointCount: 1,
      endpoints: [{ position: 1, host: 'slow.example', stage, failure: 'no-answer' }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      `endpoint 1 of 1 (slow.example) had not answered ${read} when the read was cancelled`,
    );
    // A cancelled read says nothing about whether a view can be established, and an
    // endpoint that was still in flight had not failed.
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual(NOTHING_RECORDED);
  });

  it('keeps what an endpoint had already failed with before the cancellation', async () => {
    const { adapter } = adapterOverScripts([
      { host: 'odd.example', chainId: 999n },
      { host: 'slow.example', stall: 'read' },
    ]);
    const controller = new AbortController();

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { reports } = await pending;

    expect(reports).toEqual([{
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [
        { position: 1, host: 'odd.example', stage: 'chain-id', failure: 'wrong-chain' },
        { position: 2, host: 'slow.example', stage: 'pinned-read', failure: 'no-answer' },
      ],
    }]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 0,
      unavailable: 0,
      failingEndpoints: [{ position: 1, host: 'odd.example', failure: 'wrong-chain', consecutive: 1 }],
    });
  });

  it('reports nothing when the signal was aborted before the read began', async () => {
    const { adapter, order } = adapterOverScripts([HEALTHY]);
    const controller = new AbortController();
    controller.abort();

    const { view, reports } = await readWithReport(adapter, controller.signal);

    expect(view).toBeNull();
    expect(order()).toEqual([]);
    expect(reports).toEqual([]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual(NOTHING_RECORDED);
  });

  it('an endpoint that fails after the cancellation is one that had not answered', async () => {
    // Its error arrives once the signal is aborted: that is the cancellation, not a refusal.
    const { adapter } = adapterOverScripts([{ host: 'late.example' }]);
    const controller = new AbortController();
    let fail!: (error: unknown) => void;
    adapter.providers[0].getBlock = () => new Promise((_resolve, reject) => { fail = reject; });

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    fail(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    const { reports } = await pending;

    expect(reports[0]!.endpoints).toEqual([
      { position: 1, host: 'late.example', stage: 'head-block', failure: 'no-answer' },
    ]);
  });
});

describe('the report never changes the answer', () => {
  it('a callback that throws still gets a null back', async () => {
    const { adapter } = adapterOverScripts([{ host: 'odd.example', chainId: 2n }]);

    const view = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID, {
      onUnavailable: () => { throw new Error('caller bug'); },
    });

    expect(view).toBeNull();
    expect(getKnowledgeAssetVersionSnapshotHealth().unavailable).toBe(1);
  });

  it('a caller that passes no callback gets the same null and the same view', async () => {
    const failing = adapterOverScripts([{ host: 'odd.example', head: null }]).adapter;
    await expect(failing.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();

    const healthy = adapterOverScripts([HEALTHY, { host: 'second.example' }]).adapter;
    await expect(healthy.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toEqual({
      knowledgeAssetId: KA_ID,
      latestRoot: ROOT,
      rootCount: 3n,
      latestAuthor: AUTHOR,
      latestPublisher: PUBLISHER,
      blockNumber: 500,
      blockHash: hashForBlock(500),
      knowledgeAssetStorageAddress: KAS_ADDRESS,
      knowledgeAssetStorageGeneration: 0,
    });
  });

  it('passes the per-endpoint answer and error through unchanged', async () => {
    const trace = new KnowledgeAssetVersionSnapshotTrace(['p'], ['https://a.example/key'], {
      cancelled: () => false,
    });
    const failure = Object.assign(new Error('boom'), { code: 'CALL_EXCEPTION' });
    const view = { latestRoot: ROOT };

    await expect(trace.observe(async () => { throw failure; })('p', undefined)).rejects.toBe(failure);
    await expect(trace.observe(async () => view)('p', undefined)).resolves.toBe(view);
    await expect(trace.observe(async (_provider, signal: string) => signal)('p', 'the signal')).resolves.toBe('the signal');
    expect(trace.established(view)).toBe(view);
  });

  it('an endpoint error that cannot be inspected is passed through and recorded as unclassified', async () => {
    const reports: KnowledgeAssetVersionSnapshotUnavailable[] = [];
    const trace = new KnowledgeAssetVersionSnapshotTrace(['p'], ['https://a.example/key'], {
      cancelled: () => false,
      onUnavailable: (report) => { reports.push(report); },
    });
    const hostile = Object.defineProperty({}, 'code', { get() { throw new Error('no'); } });

    await expect(trace.observe(async () => { throw hostile; })('p', undefined)).rejects.toBe(hostile);

    expect(trace.noView()).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 1,
      endpoints: [{ position: 1, host: 'a.example', stage: 'storage-binding', failure: 'other' }],
    }]);
  });

  it('a cancellation check that throws counts as not cancelled', async () => {
    const reports: KnowledgeAssetVersionSnapshotUnavailable[] = [];
    const trace = new KnowledgeAssetVersionSnapshotTrace(['p'], ['https://a.example/key'], {
      cancelled: () => { throw new Error('caller bug'); },
      onUnavailable: (report) => { reports.push(report); },
    });
    await trace.observe(async (_provider, _signal, step) => { step('chain-id'); return null; })('p', undefined);

    expect(trace.noView()).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 1,
      endpoints: [{ position: 1, host: 'a.example', stage: 'chain-id', failure: 'wrong-chain' }],
    }]);
  });
});

describe('classifyKnowledgeAssetVersionSnapshotEndpointError', () => {
  it.each<[string, unknown, ReturnType<typeof classifyKnowledgeAssetVersionSnapshotEndpointError>]>([
    ['400', { code: 'SERVER_ERROR', status: 400 }, { failure: 'http-client-error', httpStatus: 400 }],
    ['403 nested as ethers nests it', { code: 'SERVER_ERROR', response: { statusCode: 403 } }, { failure: 'http-client-error', httpStatus: 403 }],
    ['429', { status: 429 }, { failure: 'http-throttled', httpStatus: 429 }],
    ['503', { status: '503' }, { failure: 'http-server-error', httpStatus: 503 }],
    ['a redirect', { status: 302 }, { failure: 'other', httpStatus: 302 }],
    ['a call exception', { code: 'CALL_EXCEPTION' }, { failure: 'call-exception' }],
    ['an undecodable answer', { code: 'BAD_DATA' }, { failure: 'incomplete-view' }],
    ['a throttle known only by its words', new Error('Too Many Requests'), { failure: 'http-throttled' }],
    ['a gateway known only by its words', new Error('bad gateway'), { failure: 'http-server-error' }],
    ['a timeout', { code: 'TIMEOUT' }, { failure: 'timeout' }],
    ['a refused connection', { code: 'ECONNREFUSED' }, { failure: 'network' }],
    ['anything else', new Error('unexpected'), { failure: 'other' }],
    ['nothing', undefined, { failure: 'other' }],
  ])('%s', (_name, error, expected) => {
    expect(classifyKnowledgeAssetVersionSnapshotEndpointError(error)).toEqual(expected);
  });

  it('an error that cannot be inspected is unclassified, not a crash', () => {
    const hostile = Object.defineProperty({}, 'status', { get() { throw new Error('no'); } });

    expect(classifyKnowledgeAssetVersionSnapshotEndpointError(hostile)).toEqual({ failure: 'other' });
  });
});

describe('describeKnowledgeAssetVersionSnapshotEndpointFailure', () => {
  const at = (
    failure: KnowledgeAssetVersionSnapshotEndpointFailure['failure'],
    httpStatus?: number,
  ): KnowledgeAssetVersionSnapshotEndpointFailure => ({
    position: 3,
    host: 'rpc.example',
    stage: 'pinned-read',
    failure,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

  it.each<[KnowledgeAssetVersionSnapshotEndpointFailure, string]>([
    [at('http-client-error', 400), 'endpoint 3 of 5 (rpc.example) refused a block-pinned read (http 400)'],
    [at('http-client-error'), 'endpoint 3 of 5 (rpc.example) refused a block-pinned read (client error)'],
    [at('http-throttled'), 'endpoint 3 of 5 (rpc.example) throttled a block-pinned read (rate limited)'],
    [at('http-server-error'), 'endpoint 3 of 5 (rpc.example) failed a block-pinned read (server error)'],
    [at('other', 302), 'endpoint 3 of 5 (rpc.example) failed a block-pinned read (http 302)'],
    [at('other'), 'endpoint 3 of 5 (rpc.example) failed a block-pinned read (unclassified error)'],
    [{ ...at('timeout'), stage: 'chain-id' }, 'endpoint 3 of 5 (rpc.example) timed out on the chain id read'],
  ])('%j', (endpoint, words) => {
    expect(describeKnowledgeAssetVersionSnapshotEndpointFailure(endpoint, 5)).toBe(words);
  });

  it('has words for a read that names no endpoint', () => {
    expect(describeKnowledgeAssetVersionSnapshotUnavailable({
      reason: 'endpoints-failed',
      endpointCount: 2,
      endpoints: [],
    })).toBe('no endpoint returned a complete view');
    expect(describeKnowledgeAssetVersionSnapshotUnavailable({
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [],
    })).toBe('the read was cancelled before it completed');
  });
});

describe('the process-wide record', () => {
  /**
   * One read over endpoints asked in order until one supplies a view, as the adapter's read
   * does. `failing` maps a URL to the error that endpoint throws.
   */
  async function read(urls: string[], failing: Record<string, unknown>) {
    const trace = new KnowledgeAssetVersionSnapshotTrace(urls, urls, { cancelled: () => false });
    const readOne = trace.observe(async (url: string, _signal: undefined, step) => {
      step('pinned-read');
      if (url in failing) throw failing[url];
      return 'view';
    });
    for (const url of urls) {
      const view = await readOne(url, undefined).catch(() => null);
      if (view !== null) return trace.established(view);
    }
    return trace.noView();
  }
  const url = (host: string, key = SECRET_PATH) => `https://${host}/${key}`;

  it('counts reads no endpoint served, from the first of the run', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await read([url('a.example')], { [url('a.example')]: { status: 400 } });
    now.mockReturnValue(2_000);
    await read([url('a.example')], { [url('a.example')]: { status: 400 } });

    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual({
      established: 0,
      unavailable: 2,
      consecutiveUnavailable: 2,
      unavailableSince: 1_000,
      lastUnavailableReason: 'endpoints-failed',
      failingEndpoints: [{
        position: 1,
        endpointCount: 1,
        host: 'a.example',
        stage: 'pinned-read',
        failure: 'http-client-error',
        httpStatus: 400,
        consecutive: 2,
        since: 1_000,
        last: 2_000,
      }],
    });
  });

  it('starts a new count when an endpoint fails in a different way', async () => {
    const urls = [url('a.example'), url('b.example')];
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await read(urls, { [urls[0]!]: { status: 400 } });
    now.mockReturnValue(2_000);
    await read(urls, { [urls[0]!]: { status: 400 } });

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 2,
      unavailableSince: null,
      failingEndpoints: [{ host: 'a.example', httpStatus: 400, consecutive: 2, since: 1_000, last: 2_000 }],
    });

    now.mockReturnValue(3_000);
    await read(urls, { [urls[0]!]: { code: 'TIMEOUT' } });

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 3,
      failingEndpoints: [{ host: 'a.example', failure: 'timeout', consecutive: 1, since: 3_000, last: 3_000 }],
    });
  });

  it('drops an endpoint once it serves, and leaves one that was not asked as it was', async () => {
    const urls = [url('a.example'), url('b.example'), url('c.example')];
    // a and b fail, c serves. Then a serves: b is not asked, so what is known of b stands.
    await read(urls, { [urls[0]!]: { status: 400 }, [urls[1]!]: { status: 403 } });
    await read(urls, {});

    expect(getKnowledgeAssetVersionSnapshotHealth().failingEndpoints).toMatchObject([
      { position: 2, host: 'b.example', httpStatus: 403, consecutive: 1 },
    ]);
  });

  it('keeps two endpoints on one host apart, and shows only the host', async () => {
    // Same host, same position, different keys: the working one must not clear the other.
    await read([url('rpc.example', 'bad-key')], { [url('rpc.example', 'bad-key')]: { status: 403 } });
    await read([url('rpc.example', 'good-key')], {});

    const health = getKnowledgeAssetVersionSnapshotHealth();
    expect(health.failingEndpoints).toMatchObject([
      { position: 1, endpointCount: 1, host: 'rpc.example', httpStatus: 403, consecutive: 1 },
    ]);
    expect(JSON.stringify(health)).not.toContain('key');
  });

  it("a view from one configuration does not clear another configuration's endpoint", async () => {
    await read([url('a.example'), url('b.example')], { [url('a.example')]: { status: 400 } });
    await read([url('c.example')], {});

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 2,
      failingEndpoints: [{ host: 'a.example', position: 1, endpointCount: 2 }],
    });
  });

  it('keeps a bounded number of endpoints, most recently failing last', async () => {
    for (let index = 0; index < 70; index += 1) {
      const failingUrl = url(`host-${index}.example`);
      await read([failingUrl, url('ok.example')], { [failingUrl]: { status: 400 } });
    }

    const hosts = getKnowledgeAssetVersionSnapshotHealth().failingEndpoints.map((entry) => entry.host);
    expect(hosts).toHaveLength(64);
    expect(hosts[0]).toBe('host-6.example');
    expect(hosts.at(-1)).toBe('host-69.example');
    expect(JSON.stringify(getKnowledgeAssetVersionSnapshotHealth())).not.toContain('SECRET');
  });
});
