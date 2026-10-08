// SPDX-License-Identifier: Apache-2.0

/**
 * What `readKnowledgeAssetVersionSnapshot` says about a `null`.
 *
 * The rule is unchanged and stays tested in ka-version-snapshot.unit.test.ts: every configured
 * endpoint must produce a complete view at one pinned block. These rows are about the answer's
 * other half: which endpoint contributed no view, at which step, and why, by position and host
 * only. One endpoint that answers `latest` reads and refuses every read pinned to a block
 * number used to hold every confirmed publish with nothing in the log naming it.
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

const KA_ID = 7n;
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ROOT = `0x${'aa'.repeat(32)}`;
const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;
const KAS_ADDRESS = `0x${'33'.repeat(20)}`;

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
// The real transport: an endpoint that serves `latest` and refuses pinned reads
// ---------------------------------------------------------------------------

const KAS_INTERFACE = new Interface(loadAbi('DKGKnowledgeAssets') as never[]);
const SECRET_PATH = 'v3/SECRET-PATH-KEY';
const SECRET_QUERY = 'apikey=SECRET-QUERY-KEY';

interface RpcEndpoint {
  server: Server;
  url: string;
  host: string;
  /** How this endpoint answers an `eth_call` pinned to a block number. */
  pinned: { kind: 'serve' } | { kind: 'http'; status: number } | { kind: 'rpc-error' };
  pinnedCalls: number;
}

async function startRpcEndpoint(pinned: RpcEndpoint['pinned'], head = 500): Promise<RpcEndpoint> {
  const endpoint = { pinned, pinnedCalls: 0 } as RpcEndpoint;
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

describe('an endpoint that serves latest reads and refuses block-pinned ones', () => {
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

  it('is named by position and host, with the HTTP status, and the answer is still null', async () => {
    endpoints = [
      await startRpcEndpoint({ kind: 'serve' }),
      await startRpcEndpoint({ kind: 'http', status: 400 }),
      await startRpcEndpoint({ kind: 'serve' }),
    ];
    adapter = adapterOverEndpoints(endpoints);
    const refusing = endpoints[1]!;

    const { view, reports } = await readWithReport(adapter);

    // The decision is the one it always was: one endpoint without a view, no snapshot.
    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 3,
      endpoints: [{
        position: 2,
        host: refusing.host,
        stage: 'pinned-read',
        failure: 'http-client-error',
        httpStatus: 400,
      }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      `endpoint 2 of 3 (${refusing.host}) refused a block-pinned read (http 400)`,
    );
    // It answered everything that was not pinned: this is not an endpoint that is down.
    expect(refusing.pinnedCalls).toBeGreaterThan(0);

    const health = getKnowledgeAssetVersionSnapshotHealth();
    expect(health).toMatchObject({
      established: 0,
      unavailable: 1,
      consecutiveUnavailable: 1,
      lastUnavailableReason: 'endpoints-failed',
      failingEndpoints: [{
        position: 2,
        endpointCount: 3,
        host: refusing.host,
        stage: 'pinned-read',
        failure: 'http-client-error',
        httpStatus: 400,
        consecutive: 1,
      }],
    });

    // ethers puts the request URL, key included, in this error's message. Nothing produced
    // here may carry it: not the path, not the query, not a URL at all.
    const produced = [
      JSON.stringify(reports),
      describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!),
      JSON.stringify(health),
    ].join('\n');
    expect(produced).not.toContain('SECRET');
    expect(produced).not.toContain(SECRET_PATH);
    expect(produced).not.toContain('apikey');
    expect(produced).not.toContain('://');
  });

  it('counts consecutive refusals, and forgets the endpoint once it serves a pinned read', async () => {
    endpoints = [
      await startRpcEndpoint({ kind: 'serve' }),
      await startRpcEndpoint({ kind: 'http', status: 403 }),
    ];
    adapter = adapterOverEndpoints(endpoints);

    expect((await readWithReport(adapter)).view).toBeNull();
    expect((await readWithReport(adapter)).view).toBeNull();
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailable: 2,
      consecutiveUnavailable: 2,
      failingEndpoints: [{ position: 2, failure: 'http-client-error', httpStatus: 403, consecutive: 2 }],
    });

    endpoints[1]!.pinned = { kind: 'serve' };
    const { view, reports } = await readWithReport(adapter);

    expect(view).toMatchObject({ latestRoot: ROOT, rootCount: 3n, blockNumber: 500 });
    expect(reports).toEqual([]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual({
      established: 1,
      unavailable: 2,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      lastUnavailableReason: null,
      failingEndpoints: [],
    });
  });

  it('a JSON-RPC error answer to the pinned read is a call exception, not an outage', async () => {
    endpoints = [
      await startRpcEndpoint({ kind: 'rpc-error' }),
      await startRpcEndpoint({ kind: 'serve' }),
    ];
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
      `endpoint 1 of 2 (${endpoints[0]!.host}) rejected a block-pinned read (call exception)`,
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
  const providers = scripts.map((script) => ({
    script,
    async getNetwork() {
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
  return { adapter, storage };
}

const HEALTHY: Script = { host: 'healthy.example' };

describe('which step an endpoint stopped at, and why', () => {
  it.each<[string, Script, Omit<KnowledgeAssetVersionSnapshotEndpointFailure, 'position' | 'host'>, string]>([
    [
      'another chain',
      { host: 'odd.example', chainId: 999n },
      { stage: 'chain-id', failure: 'wrong-chain' },
      'endpoint 2 of 2 (odd.example) answered for a different chain',
    ],
    [
      'no head block',
      { host: 'odd.example', head: null },
      { stage: 'head-block', failure: 'incomplete-view' },
      'endpoint 2 of 2 (odd.example) returned an incomplete answer to the head block read',
    ],
    [
      'a head read that cannot connect',
      { host: 'odd.example', headErrors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] },
      { stage: 'head-block', failure: 'network' },
      'endpoint 2 of 2 (odd.example) could not be reached for the head block read',
    ],
    [
      'a head read that times out',
      { host: 'odd.example', headErrors: [{ code: 'TIMEOUT' }, { code: 'TIMEOUT' }] },
      { stage: 'head-block', failure: 'timeout' },
      'endpoint 2 of 2 (odd.example) timed out on the head block read',
    ],
    [
      'a block without a hash',
      { host: 'odd.example', hash: null },
      { stage: 'pinned-block', failure: 'incomplete-view' },
      'endpoint 2 of 2 (odd.example) returned an incomplete answer to the pinned block header read',
    ],
    [
      'a refused pinned read',
      { host: 'odd.example', readErrors: [{ code: 'SERVER_ERROR', status: 400 }, { code: 'SERVER_ERROR', status: 400 }] },
      { stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 },
      'endpoint 2 of 2 (odd.example) refused a block-pinned read (http 400)',
    ],
    [
      'a throttled pinned read',
      { host: 'odd.example', readErrors: [{ status: 429 }, { status: 429 }] },
      { stage: 'pinned-read', failure: 'http-throttled', httpStatus: 429 },
      'endpoint 2 of 2 (odd.example) throttled a block-pinned read (http 429)',
    ],
    [
      'a pinned read behind a failing gateway',
      { host: 'odd.example', readErrors: [{ status: 503 }, { status: 503 }] },
      { stage: 'pinned-read', failure: 'http-server-error', httpStatus: 503 },
      'endpoint 2 of 2 (odd.example) failed a block-pinned read (http 503)',
    ],
    [
      'a pinned read the node rejects',
      { host: 'odd.example', readErrors: [{ code: 'CALL_EXCEPTION' }] },
      { stage: 'pinned-read', failure: 'call-exception' },
      'endpoint 2 of 2 (odd.example) rejected a block-pinned read (call exception)',
    ],
    [
      'a view without its author',
      { host: 'odd.example', author: null },
      { stage: 'pinned-read', failure: 'incomplete-view' },
      'endpoint 2 of 2 (odd.example) returned an incomplete answer to a block-pinned read',
    ],
  ])('%s', async (_name, odd, expected, words) => {
    const { adapter } = adapterOverScripts([HEALTHY, odd]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'endpoints-failed',
      endpointCount: 2,
      endpoints: [{ position: 2, host: 'odd.example', ...expected }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(words);
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  });

  it('names every endpoint that gave no view, in configured order', async () => {
    const { adapter } = adapterOverScripts([
      { host: 'a.example', readErrors: [{ status: 401 }, { status: 401 }] },
      HEALTHY,
      { host: 'c.example', chainId: 1n },
    ]);

    const { reports } = await readWithReport(adapter);

    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'endpoint 1 of 3 (a.example) refused a block-pinned read (http 401); '
      + 'endpoint 3 of 3 (c.example) answered for a different chain',
    );
  });

  it('reports the last attempt when the in-place retry fails differently', async () => {
    // The first failure is transient and retried; the endpoint's second answer is the one
    // the poll is judged over, so it is the one reported.
    const { adapter } = adapterOverScripts([
      HEALTHY,
      { host: 'odd.example', readErrors: [{ status: 503 }, { code: 'SERVER_ERROR', status: 404 }] },
    ]);

    const { reports } = await readWithReport(adapter);

    expect(reports[0]!.endpoints).toEqual([
      { position: 2, host: 'odd.example', stage: 'pinned-read', failure: 'http-client-error', httpStatus: 404 },
    ]);
  });

  it('says nothing when a transient failure is followed by a view', async () => {
    const { adapter } = adapterOverScripts([
      HEALTHY,
      { host: 'blip.example', headErrors: [{ code: 'SERVER_ERROR' }] },
    ]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toMatchObject({ latestRoot: ROOT, blockNumber: 500 });
    expect(reports).toEqual([]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({ established: 1, unavailable: 0 });
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

describe('a null that no single endpoint explains', () => {
  it('different hashes at the same height', async () => {
    const { adapter } = adapterOverScripts([
      { host: 'a.example', hash: `0x${'01'.repeat(32)}` },
      { host: 'b.example', hash: `0x${'02'.repeat(32)}` },
    ]);

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{ reason: 'endpoints-disagree', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'the 2 endpoints returned different block hashes at the same height',
    );
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailable: 1,
      lastUnavailableReason: 'endpoints-disagree',
      failingEndpoints: [],
    });
  });

  it('no storage contract, or one without an address', async () => {
    for (const storage of [undefined, {}]) {
      const { adapter } = adapterOverScripts([HEALTHY]);
      adapter.contracts = { knowledgeAssetStorage: storage };

      const { view, reports } = await readWithReport(adapter);

      expect(view).toBeNull();
      expect(reports).toEqual([{ reason: 'no-storage-contract', endpointCount: 1, endpoints: [] }]);
      expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
        'the knowledge asset storage contract is not resolved',
      );
    }
  });

  it('a storage binding that changes while an endpoint is read', async () => {
    const { adapter } = adapterOverScripts([{ host: 'a.example' }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rebind = adapter.rebindContract;
    adapter.rebindContract = (...args: unknown[]) => {
      const bound = rebind(...args);
      const read = bound.getLatestMerkleRoot;
      bound.getLatestMerkleRoot = async () => { await gate; return read(); };
      return bound;
    };

    const pending = readWithReport(adapter);
    await Promise.resolve();
    adapter.knowledgeAssetStorageBindingGeneration += 1;
    release();
    const { view, reports } = await pending;

    expect(view).toBeNull();
    expect(reports[0]!.endpoints).toEqual([
      { position: 1, host: 'a.example', stage: 'storage-binding', failure: 'binding-changed' },
    ]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'endpoint 1 of 1 (a.example) was read while the storage contract binding changed',
    );
  });

  it('a storage binding that changes after every endpoint answered', async () => {
    const { adapter } = adapterOverScripts([{ host: 'a.example' }, { host: 'b.example' }]);
    // Each endpoint checks the binding once, then the read checks it a last time.
    let checks = 0;
    adapter.knowledgeAssetStorageBindingIsCurrent = () => { checks += 1; return checks <= 2; };

    const { view, reports } = await readWithReport(adapter);

    expect(view).toBeNull();
    expect(reports).toEqual([{ reason: 'storage-binding-changed', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'the storage contract binding changed during the read',
    );
  });
});

describe('a read the caller cancels', () => {
  it.each([
    ['head', 'head-block', 'the head block read'],
    ['read', 'pinned-read', 'a block-pinned read'],
  ] as const)('names the endpoint still waiting on its %s', async (stall, stage, read) => {
    const { adapter } = adapterOverScripts([HEALTHY, { host: 'slow.example', stall }]);
    const controller = new AbortController();

    const pending = readWithReport(adapter, controller.signal);
    // Long enough for the healthy endpoint to have answered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { view, reports } = await pending;

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [{ position: 2, host: 'slow.example', stage, failure: 'no-answer' }],
    }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      `endpoint 2 of 2 (slow.example) had not answered ${read} when the read was cancelled`,
    );
    // The other endpoint had answered, so this one is singled out and recorded.
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailable: 1,
      lastUnavailableReason: 'aborted',
      failingEndpoints: [{ position: 2, host: 'slow.example', stage, failure: 'no-answer', consecutive: 1 }],
    });
  });

  it('names no endpoint when the signal was aborted before the read began', async () => {
    const { adapter } = adapterOverScripts([HEALTHY, HEALTHY]);
    const controller = new AbortController();
    controller.abort();

    const { view, reports } = await readWithReport(adapter, controller.signal);

    expect(view).toBeNull();
    expect(reports).toEqual([{ reason: 'aborted', endpointCount: 2, endpoints: [] }]);
    expect(describeKnowledgeAssetVersionSnapshotUnavailable(reports[0]!)).toBe(
      'the read was cancelled before it completed',
    );
    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({ unavailable: 0, failingEndpoints: [] });
  });

  it('a cancellation that finds every endpoint in flight says nothing about any of them', async () => {
    // The caller is told what was pending. The process-wide record is not touched: it would
    // list healthy endpoints as failing until the next read came along.
    const { adapter } = adapterOverScripts([
      { host: 'a.example', stall: 'head' },
      { host: 'b.example', stall: 'read' },
    ]);
    const controller = new AbortController();

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { view, reports } = await pending;

    expect(view).toBeNull();
    expect(reports).toEqual([{
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [
        { position: 1, host: 'a.example', stage: 'head-block', failure: 'no-answer' },
        { position: 2, host: 'b.example', stage: 'pinned-read', failure: 'no-answer' },
      ],
    }]);
    expect(getKnowledgeAssetVersionSnapshotHealth()).toEqual({
      established: 0,
      unavailable: 0,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      lastUnavailableReason: null,
      failingEndpoints: [],
    });
  });

  it('an endpoint whose read stops at the cancellation is one that had not answered', async () => {
    // Its chain id arrives as the signal aborts, so its read returns at the next check without
    // having asked for a block. That is not an endpoint that returned an incomplete head.
    const { adapter } = adapterOverScripts([HEALTHY, { host: 'late.example' }]);
    const controller = new AbortController();
    let answer!: (network: { chainId: bigint }) => void;
    adapter.providers[1].getNetwork = () => new Promise((resolve) => { answer = resolve; });
    // Registered before the read attaches its own listener, so this one runs first.
    controller.signal.addEventListener('abort', () => answer({ chainId: 31337n }));

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const { reports } = await pending;

    expect(reports[0]).toMatchObject({ reason: 'aborted', endpointCount: 2 });
    expect(reports[0]!.endpoints).toHaveLength(1);
    expect(reports[0]!.endpoints[0]).toMatchObject({ position: 2, host: 'late.example', failure: 'no-answer' });
  });

  it('an endpoint that fails after the cancellation is one that had not answered', async () => {
    // Its error arrives once the signal is aborted: that is the cancellation, not a refusal.
    const { adapter } = adapterOverScripts([HEALTHY, { host: 'late.example' }]);
    const controller = new AbortController();
    let fail!: (error: unknown) => void;
    adapter.providers[1].getBlock = () => new Promise((_resolve, reject) => { fail = reject; });

    const pending = readWithReport(adapter, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    fail(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    const { reports } = await pending;

    expect(reports[0]!.endpoints).toEqual([
      { position: 2, host: 'late.example', stage: 'head-block', failure: 'no-answer' },
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
    const failing = adapterOverScripts([HEALTHY, { host: 'odd.example', head: null }]).adapter;
    await expect(failing.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toBeNull();

    const healthy = adapterOverScripts([HEALTHY, HEALTHY]).adapter;
    await expect(healthy.readKnowledgeAssetVersionSnapshot(KA_ID)).resolves.toMatchObject({
      knowledgeAssetId: KA_ID,
      latestRoot: ROOT,
      rootCount: 3n,
      blockNumber: 500,
      blockHash: hashForBlock(500),
    });
  });

  it('passes the per-endpoint error through unchanged', async () => {
    const trace = new KnowledgeAssetVersionSnapshotTrace(['p'], ['https://a.example/key'], {});
    const failure = Object.assign(new Error('boom'), { code: 'CALL_EXCEPTION' });

    await expect(trace.observe(async () => { throw failure; })('p')).rejects.toBe(failure);
    await expect(trace.observe(async () => 'view')('p')).resolves.toBe('view');
    expect(trace.established('same')).toBe('same');
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

  it('has words for a failed read that names no endpoint', () => {
    expect(describeKnowledgeAssetVersionSnapshotUnavailable({
      reason: 'endpoints-failed',
      endpointCount: 2,
      endpoints: [],
    })).toBe('not every endpoint returned a complete view');
  });
});

describe('the process-wide record', () => {
  const trace = (hosts: string[]) => new KnowledgeAssetVersionSnapshotTrace(
    hosts,
    hosts.map((host) => `https://${host}/${SECRET_PATH}`),
    {},
  );
  /** One read over `hosts` in which each endpoint in `failing` throws `error`. */
  async function read(hosts: string[], failing: Record<string, unknown>) {
    const poll = trace(hosts);
    const readOne = poll.observe(async (host: string, step) => {
      step('pinned-read');
      if (host in failing) throw failing[host];
      return 'view';
    });
    const settled = await Promise.allSettled(hosts.map(readOne));
    return settled.every((result) => result.status === 'fulfilled')
      ? poll.established('view')
      : poll.unavailable('endpoints-failed');
  }

  it('starts a new count when an endpoint fails in a different way', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await read(['a.example', 'b.example'], { 'b.example': { status: 400 } });
    now.mockReturnValue(2_000);
    await read(['a.example', 'b.example'], { 'b.example': { status: 400 } });

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      unavailableSince: 1_000,
      failingEndpoints: [{ host: 'b.example', httpStatus: 400, consecutive: 2, since: 1_000, last: 2_000 }],
    });

    now.mockReturnValue(3_000);
    await read(['a.example', 'b.example'], { 'b.example': { code: 'TIMEOUT' } });

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      consecutiveUnavailable: 3,
      unavailableSince: 1_000,
      failingEndpoints: [{ host: 'b.example', failure: 'timeout', consecutive: 1, since: 3_000, last: 3_000 }],
    });
  });

  it('drops an endpoint that answers while another still fails', async () => {
    await read(['a.example', 'b.example'], { 'a.example': { status: 400 }, 'b.example': { status: 400 } });
    await read(['a.example', 'b.example'], { 'b.example': { status: 400 } });

    expect(getKnowledgeAssetVersionSnapshotHealth().failingEndpoints.map((entry) => entry.host))
      .toEqual(['b.example']);
  });

  it('a view from one configuration does not clear another configuration\'s endpoint', async () => {
    await read(['a.example', 'b.example'], { 'b.example': { status: 400 } });
    await read(['c.example'], {});

    expect(getKnowledgeAssetVersionSnapshotHealth()).toMatchObject({
      established: 1,
      consecutiveUnavailable: 0,
      failingEndpoints: [{ host: 'b.example', position: 2, endpointCount: 2 }],
    });
  });

  it('keeps a bounded number of endpoints, most recently failing last', async () => {
    for (let index = 0; index < 70; index += 1) {
      await read([`host-${index}.example`, 'ok.example'], { [`host-${index}.example`]: { status: 400 } });
    }

    const hosts = getKnowledgeAssetVersionSnapshotHealth().failingEndpoints.map((entry) => entry.host);
    expect(hosts).toHaveLength(64);
    expect(hosts[0]).toBe('host-6.example');
    expect(hosts.at(-1)).toBe('host-69.example');
    expect(JSON.stringify(getKnowledgeAssetVersionSnapshotHealth())).not.toContain('SECRET');
  });
});
