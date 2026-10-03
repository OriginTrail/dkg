import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '@origintrail-official/dkg-core';
import type { Network } from '@origintrail-official/dkg-core';
import type { PeerResolver } from '@origintrail-official/dkg-core';
import { ProtocolRouter, rebuildMetrics } from '@origintrail-official/dkg-core';
import {
  exchangeExperimentalExactBatch, registerExperimentalExactBatchResponder,
  type ExactBatchTransportOptions,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import {
  EXACT_BATCH_FRAME_KIND as K, ExactBatchReceiveWindow, ExactBatchSendWindow,
  decodeExactBatchAsset, type ExactBatchFrame,
} from '../src/sync/exact-batch-stream-contract.js';
import {
  exactBatchStartFrame, exactBatchTransportOptions, exchangeExactBatchVerified,
  type ExactBatchVerifiedReceiverOptions,
} from '../src/sync/requester/exact-batch-stream.js';
import { createExactBatchResponderBinding } from '../src/sync/responder/exact-batch-stream.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { encodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_ENCODING } from '../src/sync/wire-compression.js';

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const UALS = Array.from({ length: 10 }, (_, i) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i + 1}`).sort();
const text = new TextEncoder();
const options: ExactBatchTransportOptions = { timeoutMs: 2000, windowSize: 2,
  maxReadBufferBytes: 65552, maxRequestBytes: 8192, maxFrameBytes: 65552, maxResponseBytes: 64 * 1024 * 1024 };
const frame = (kind: number, assetIndex = 255, sequence = 0, payload: Uint8Array = new Uint8Array()): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const start = () => frame(K.REQUEST, 255, 0, text.encode('existing signed START fixture'));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** In-memory duplex only; no real node, socket, Noise handshake or backend. */
class MemoryStream extends EventTarget {
  peer!: MemoryStream;
  status = 'open'; writeStatus = 'writable'; writableNeedsDrain = false;
  maxReadBufferLength = 1024 * 1024; maxWriteBufferLength = 1024 * 1024;
  chunks: Uint8Array[] = []; pending?: { resolve: (item: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void };
  ended = false; failure?: Error; iteratorCount = 0; sentKinds: number[] = []; closes = 0;
  aborts = 0; forceDrain = false; drainGate = gate(); drainEntered = gate();
  push(bytes: Uint8Array) {
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending.resolve({ done: false, value: bytes }); }
    else this.chunks.push(bytes);
  }
  send(bytes: Uint8Array) {
    if (this.writeStatus !== 'writable') throw new Error('write side closed');
    this.sentKinds.push(bytes[4]!);
    // Split both START and controls: parser must survive arbitrary boundaries.
    for (let n = 0; n < bytes.length; n += 7) this.peer.push(bytes.slice(n, n + 7));
    this.writableNeedsDrain = this.forceDrain;
    return !this.forceDrain;
  }
  async onDrain({ signal }: { signal?: AbortSignal } = {}) {
    this.drainEntered.resolve();
    await Promise.race([this.drainGate.promise, new Promise<void>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
    this.writableNeedsDrain = false;
  }
  async close() {
    this.closes++; this.writeStatus = 'closed'; this.peer.ended = true;
    this.peer.pending?.resolve({ done: true, value: undefined }); this.peer.pending = undefined;
    if (this.ended) {
      this.status = this.peer.status = 'closed';
      this.dispatchEvent(new Event('close')); this.peer.dispatchEvent(new Event('close'));
    }
  }
  abort(error: Error) {
    if (this.status === 'aborted' || this.status === 'closed') return;
    this.aborts++; this.status = 'aborted'; this.writeStatus = 'closed'; this.failure = error;
    this.pending?.reject(error); this.pending = undefined;
    this.peer.status = 'aborted'; this.peer.writeStatus = 'closed'; this.peer.failure = error;
    this.peer.pending?.reject(error); this.peer.pending = undefined;
    this.dispatchEvent(new Event('close')); this.peer.dispatchEvent(new Event('close'));
  }
  [Symbol.asyncIterator]() {
    this.iteratorCount++;
    return { next: async (): Promise<IteratorResult<Uint8Array>> => {
      if (this.failure) throw this.failure;
      const chunk = this.chunks.shift();
      if (chunk) return { done: false, value: chunk };
      if (this.ended) return { done: true, value: undefined };
      return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    }, return: async () => ({ done: true as const, value: undefined }) };
  }
}

function fixture() {
  const client = new MemoryStream(), server = new MemoryStream(); client.peer = server; server.peer = client;
  const clientStop = new AbortController(), serverStop = new AbortController();
  const connectionEvents = new EventTarget();
  let inbound!: (stream: Stream, connection: { remotePeer: { toString(): string } }) => Promise<void>;
  let inboundDone: Promise<void> = Promise.resolve();
  const admission = vi.fn(async (..._args: unknown[]) => true), rejected = vi.fn(() => false);
  const resolved = vi.fn(async (_peer: string, _options?: { signal?: AbortSignal; perStepTimeoutMs?: number }) => [] as string[]);
  const connections: unknown[] = [], addresses: { multiaddr: { toString(): string } }[] = [];
  const node = (stop: AbortController, handle: (...args: unknown[]) => void) => ({ stopSignal: stop.signal,
    libp2p: { getConnections: () => connections, peerStore: { get: async () => ({ addresses }) }, handle,
      addEventListener: connectionEvents.addEventListener.bind(connectionEvents),
      removeEventListener: connectionEvents.removeEventListener.bind(connectionEvents) } }) as unknown as DKGNode;
  const open = async () => {
    inboundDone = inbound(server as unknown as Stream, { remotePeer: { toString: () => PEER } });
    return client as unknown as Stream;
  };
  const dial = vi.fn(open);
  const routerClient = new ProtocolRouter(node(clientStop, () => {}), { network: { dialProtocol: dial } as unknown as Network,
    peerResolver: { resolve: resolved } as unknown as PeerResolver, isPeerAccepted: admission, isPeerKnownRejected: rejected });
  const routerServer = new ProtocolRouter(node(serverStop, (_protocol, handler) => { inbound = handler as typeof inbound; }),
    { isPeerAccepted: admission, isPeerKnownRejected: rejected });
  return { client, server, clientStop, serverStop, connectionEvents, admission, rejected, resolved, dial, open, connections, addresses, routerClient, routerServer,
    settled: () => inboundDone };
}

describe('experimental exact-batch dedicated duplex transport', () => {
  it('streams ten gzip KAs on one duplex stream, downloads next while committing previous, ACKs only after commit', async () => {
    const f = fixture(), releaseFirst = gate(), secondReceived = gate();
    const written = new Map<string, Uint8Array>(), exported = new Map<string, number>();
    const bodies = UALS.map((_, i) => text.encode(`<urn:${i}> <urn:p> "${'same body '.repeat(3000)}" .\n`));
    const zipped: Uint8Array[] = [];
    for (let i = 0; i < bodies.length; i++) zipped.push(await encodeNegotiatedExactSyncResponse(bodies[i]!,
      { request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, phase: 'data', assetUals: [UALS[i]!] } }));
    expect(zipped.every((bytes, i) => bytes.length < bodies[i]!.length)).toBe(true);
    registerExperimentalExactBatchResponder(f.routerServer, options,
      async (request) => { expect(request).toEqual(start().payload); return { assetUals: UALS, context: undefined }; },
      async (_request, session) => {
        expect(session.windowSize).toBe(2);
        const window = new ExactBatchSendWindow({ assetCount: session.assetUals.length, windowSize: 2 });
        const ack = async () => window.acceptAck((await session.next())!);
        for (let index = 0; index < UALS.length; index++) {
          while (!window.canStartAsset) await ack();
          exported.set(UALS[index]!, (exported.get(UALS[index]!) ?? 0) + 1);
          const proof = text.encode(JSON.stringify({ assetUal: UALS[index], root: createHash('sha256').update(bodies[index]!).digest('hex') }));
          for (const item of [frame(K.META, index, 0, proof), frame(K.DATA, index, 0, zipped[index]), frame(K.ASSET_END, index, 1)]) {
            window.acceptSent(item); await session.send(item);
          }
        }
        while (window.acknowledgedCount < UALS.length) await ack();
        const end = frame(K.BATCH_END, 255, UALS.length); window.acceptSent(end); await session.send(end);
        expect(window.complete).toBe(true);
      });
    const operation = exchangeExperimentalExactBatch(f.routerClient, PEER, start(), { ...options, assetUals: UALS },
      async (session) => {
        const window = new ExactBatchReceiveWindow({ assetUals: session.assetUals, windowSize: 2 });
        let committing: Promise<void> | undefined;
        const kick = () => {
          if (committing) return;
          const asset = window.takeReady(); if (!asset) return;
          committing = window.commitAsset(asset, async (owned) => {
            if (owned.assetIndex === 0) await releaseFirst.promise;
            const decoded = await decodeExactBatchAsset(owned, { signal: session.signal });
            const proof = JSON.parse(new TextDecoder().decode(owned.metadataBytes));
            expect(proof.assetUal).toBe(owned.assetUal);
            expect(proof.root).toBe(createHash('sha256').update(decoded.bytes).digest('hex'));
            written.set(owned.assetUal, decoded.bytes);
          }, { signal: session.signal }).then(ack => session.send(ack)).finally(() => { committing = undefined; kick(); });
        };
        while (true) {
          const item = await session.next(); expect(item).toBeDefined(); window.accept(item!);
          if (item!.kind === K.META && item!.assetIndex === 1) {
            expect(written.size).toBe(0); expect(f.client.sentKinds).toEqual([K.REQUEST]);
            secondReceived.resolve(); releaseFirst.resolve();
          }
          kick();
          if (item!.kind === K.BATCH_END) break;
        }
        await committing; expect(window.complete).toBe(true); await window.close();
        return window.committedCount;
      });
    await secondReceived.promise;
    expect(await operation).toBe(10); await f.settled();
    expect(written.size).toBe(10); expect([...exported.values()]).toEqual(Array(10).fill(1));
    expect(f.dial).toHaveBeenCalledOnce(); expect(f.client.iteratorCount).toBe(1); expect(f.server.iteratorCount).toBe(1);
    expect(f.client.sentKinds).toEqual([K.REQUEST, ...Array(10).fill(K.ACK)]);
    expect(getEventListeners(f.clientStop.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(f.serverStop.signal, 'abort')).toHaveLength(0);
    expect(f.resolved).toHaveBeenCalledBefore(f.dial);
  });

});

const BUSY_CG = 'busy-responder-public';
/** `SYNC_RESPONDER_MAX_QUEUE_WAIT_MS` of the responder limiter. */
const QUEUE_WAIT_MS = 10_000;
type Stage = 'pre-authorization' | 'response';

/**
 * The real responder limiter and stream binding behind the real routers. The
 * requester is the real verified receiver. Authorization and the public-graph
 * read are fixture ports, and the store is a stub no test here may reach.
 */
async function busyFixture() {
  const info = vi.fn((_context: unknown, _message: string) => {});
  const store = { queryResponseLimitMode: 'pre-materialization',
    query: async () => { throw new Error('Fixture store must not be read'); } } as unknown as TripleStore;
  const parse = (bytes: Uint8Array) => ContextGraphResolveMethods.prototype.parseSyncRequest.call({
    parsePipeDelimitedSyncRequest: ContextGraphResolveMethods.prototype.parsePipeDelimitedSyncRequest,
  } as never, bytes);
  const authorize = vi.fn(async () => true), isPublic = vi.fn(async () => true);
  let resources!: ExperimentalExactBatchResponderResources;
  registerSyncHandler({ register: () => {}, protocolSync: '/fixture/legacy-sync', syncDeniedResponse: 'denied', syncPageSize: 500,
    sharedMemoryTtlMs: 0, store, peerId: 'source', parseSyncRequest: parse, authorizeSyncRequest: authorize,
    logWarn: () => {}, logInfo: info, logDebug: () => {}, onExperimentalExactBatchResources: captured => { resources = captured; } });
  // Each stage asks the limiter synchronously, so a recorded stage is already running or queued.
  const asked: Stage[] = [];
  const binding = createExactBatchResponderBinding({ localPeerId: 'source', store, exportCache: resources.exportCache,
    parseSyncRequest: parse, authorizeSyncRequest: authorize, isPublicContextGraph: isPublic,
    admission: {
      withPreAuthorizationAdmission: (peer, signal, work) => {
        asked.push('pre-authorization'); return resources.withPreAuthorizationAdmission(peer, signal, work);
      },
      withAuthorizedResponseAdmission: (peer, graph, signal, work) => {
        asked.push('response'); return resources.withAuthorizedResponseAdmission(peer, graph, signal, work);
      },
    } });
  const assetUals = [UALS[0]!];
  const unused = async () => { throw new Error('A refused START needs no identity, signature or verification'); };
  const request = await buildSyncRequestEnvelope({ contextGraphId: BUSY_CG, offset: 0, limit: 500, includeSharedMemory: false,
    targetPeerId: 'source', requesterPeerId: PEER, phase: 'data', assetUals, needsAuth: false,
    getIdentityId: unused, computeSyncDigest: () => { throw new Error('unused'); }, signMessage: unused });
  const receiver = { contextGraphId: BUSY_CG, assetUals, ctx: { operationId: 'busy-fixture', operationName: 'sync' },
    parseAndFilter: unused, processDurableBatchInWorker: unused, storeGraphScopedAsset: unused,
    authenticationDeadline: () => Date.now() + 30_000 } as unknown as ExactBatchVerifiedReceiverOptions;
  /** One real exchange over its own stream; `settled` resolves with how the requester saw it end. */
  const exchange = () => {
    const wire = fixture();
    registerExperimentalExactBatchResponder(wire.routerServer, exactBatchTransportOptions(120_000), binding.authorizeRequest, binding.respond);
    const settled = exchangeExactBatchVerified(consume => exchangeExperimentalExactBatch(wire.routerClient, PEER,
      exactBatchStartFrame(request), { ...exactBatchTransportOptions(120_000), assetUals }, consume), receiver)
      .then(() => 'complete' as const, (error: unknown) => error);
    return { wire, settled };
  };
  /** Take one responder slot for `peer` until released. */
  const hold = (peer: string) => {
    const held = gate();
    const running = resources.withPreAuthorizationAdmission(peer, new AbortController().signal, () => held.promise);
    return async () => { held.resolve(); await running; };
  };
  /**
   * Let real asynchronous work run, also while the timers are faked, until
   * `stage` has asked the limiter. Bounded by the wall clock, which is never
   * faked here: a turn count would run out on a loaded machine.
   */
  const untilAsked = async (stage: Stage) => {
    const startedAt = performance.now();
    while (!asked.includes(stage) && performance.now() - startedAt < 30_000) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(asked).toContain(stage);
  };
  const busyLines = () => info.mock.calls.map(([, message]) => message);
  return { resources, authorize, isPublic, exchange, hold, untilAsked, busyLines };
}

/** `dkg.sync.response.total{outcome="busy"}`, read through a real in-memory exporter. */
function busyResponseMetric() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  metrics.setGlobalMeterProvider(provider); rebuildMetrics();
  return { provider, async read() {
    await provider.forceFlush();
    let count = 0;
    // Cumulative: the last export carries the running total.
    for (const scope of exporter.getMetrics().at(-1)?.scopeMetrics ?? [])
      for (const metric of scope.metrics)
        if (metric.descriptor.name === 'dkg.sync.response.total')
          for (const point of metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: number }>)
            if (point.attributes.outcome === 'busy') count += point.value;
    return count;
  } };
}

describe('exact-batch stream request the responder limiter does not admit', () => {
  let provider: MeterProvider | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await provider?.shutdown().catch(() => {}); provider = undefined;
    metrics.disable(); rebuildMetrics();
  });

  it('is answered BUSY once the queue wait is over, logged and counted once, and the next request is admitted when a slot frees', async () => {
    const metric = busyResponseMetric(); provider = metric.provider;
    const f = await busyFixture();
    // Three other peers hold every responder slot for longer than the queue wait.
    const releases = ['peer-a', 'peer-b', 'peer-c'].map(f.hold);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const refused = f.exchange();
    void refused.settled.finally(() => { settled = true; });
    await f.untilAsked('pre-authorization');
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_MS - 1);
    expect(settled).toBe(false); expect(refused.wire.server.sentKinds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await refused.settled; await refused.wire.settled();
    vi.useRealTimers();

    // The requester reads a refusal, not a broken stream.
    expect(failure).toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [], streamInterrupted: false,
      refusalObservation: { code: 'BUSY', startedAssets: 0, committedAssets: 0 } });
    expect(refused.wire.server.sentKinds).toEqual([K.REFUSE]);
    // Nothing of the request was worked on, and nothing of it is logged.
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.isPublic).not.toHaveBeenCalled();
    expect(f.busyLines()).toEqual([
      `Exact batch responder busy stage=pre-authorization peer=${PEER.slice(-8)} reason="sync responder queue wait exceeded" running=3 queued=0`,
    ]);
    expect(await metric.read()).toBe(1);

    for (const release of releases) await release();
    f.authorize.mockResolvedValueOnce(false);
    // Admitted now: it reaches authorization, which this fixture denies.
    expect(await f.exchange().settled).toMatchObject({ code: 'EXACT_BATCH_PARTIAL', refusalObservation: undefined });
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.busyLines()).toHaveLength(1); expect(await metric.read()).toBe(1);
  });

  it('is answered BUSY when the response, after an admitted authorization, finds no slot', async () => {
    const metric = busyResponseMetric(); provider = metric.provider;
    const f = await busyFixture();
    const releases: Array<() => Promise<void>> = [];
    // While this request is being authorized, three other peers ask for slots:
    // two run beside it and the third takes its slot when authorization ends.
    f.isPublic.mockImplementationOnce(async () => { releases.push(...['peer-a', 'peer-b', 'peer-c'].map(f.hold)); return true; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const refused = f.exchange();
    await f.untilAsked('response');
    await vi.advanceTimersByTimeAsync(QUEUE_WAIT_MS);
    expect(await refused.settled).toMatchObject({ code: 'EXACT_BATCH_PARTIAL', streamInterrupted: false, refusalObservation: { code: 'BUSY' } });
    await refused.wire.settled();
    vi.useRealTimers();
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(refused.wire.server.sentKinds).toEqual([K.REFUSE]);
    expect(f.busyLines()).toEqual([
      `Exact batch responder busy stage=response peer=${PEER.slice(-8)} reason="sync responder queue wait exceeded" running=3 queued=0`,
    ]);
    expect(await metric.read()).toBe(1);
    for (const release of releases) await release();
  });

  it('is answered BUSY at once when the peer already has its share of the queue', async () => {
    const metric = busyResponseMetric(); provider = metric.provider;
    const f = await busyFixture();
    // One request of this peer runs and four wait: its queue share is used up.
    const releases = Array.from({ length: 5 }, () => f.hold(PEER));
    const refused = f.exchange();
    expect(await refused.settled).toMatchObject({ code: 'EXACT_BATCH_PARTIAL', refusalObservation: { code: 'BUSY' } });
    await refused.wire.settled();
    expect(f.busyLines()).toEqual([
      `Exact batch responder busy stage=pre-authorization peer=${PEER.slice(-8)} reason="sync responder peer queue full" running=1 queued=4`,
    ]);
    expect(await metric.read()).toBe(1);
    for (const release of releases) await release();
  });

  it('leaves a failure of the admitted work what it was', async () => {
    const metric = busyResponseMetric(); provider = metric.provider;
    const f = await busyFixture();
    const failure = new Error('Fixture failure inside the admitted stage');
    await expect(f.resources.withPreAuthorizationAdmission('peer-a', new AbortController().signal, async () => { throw failure; }))
      .rejects.toBe(failure);
    await expect(f.resources.withAuthorizedResponseAdmission('peer-a', BUSY_CG, new AbortController().signal, async () => { throw failure; }))
      .rejects.toBe(failure);
    expect(f.busyLines()).toEqual([]); expect(await metric.read()).toBe(0);
  });
});
