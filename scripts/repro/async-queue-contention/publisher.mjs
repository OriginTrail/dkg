// The publisher stream of the async queue contention benchmark (OT-RFC-73 P2b, ported from harness 0.6-0.9 lift.mjs):
// open-loop publish-async submissions (the route's preflight reads, then the real enqueue) into the REAL
// TripleStoreAsyncLiftPublisher, and the REAL AsyncLiftRunner claiming them with a synthetic knowledgeAssetVmPublishHandler
// in place of the chain (no chain, wallets or funds). The product comes in through `deps` (backend.mjs loadDist), so
// this file is import-safe.
//
// Store-operation mix per publication (the harness's A2 audit): the control and journal operations of the real
// publisher (about 30 + 14), the route's 16 admission reads (3 context-graph probe + 8 intent resolution + 5 snapshot
// preflight, replayed before the enqueue), the handler's two pre-send verification passes (5 reads each, issued by the
// product) and a lifecycle-pointer read, and 16 executor-tail operations (receipt, head read, drops, deletes, lifecycle
// stamps) replayed by the handler after a simulated chain wait during which the job's wallet stays locked.
//
// Chain-side time is scaled by the model's faster store operations, as in the harness: the wallet is held 3 s (the
// production hold is about 36 s, #3252) and the idle runner polls every 1 s (the CLI default is 12 s). Both are flags.
//
// Not modelled: the real vm-publish handler (it needs a chain), the readiness wait and the chain rescue, retries (the
// synthetic handler never fails, so a retried or recovered job is a run defect, see the reclaim check in verdict.mjs).
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENT, ASSET_POOL, CG_ID, assetOf, metaGraph, swmMetaGraph } from './fixture.mjs';
import { OBSERVER_CALLS, poissonArrivals, startArrivals, within } from './workload.mjs';

export const AUTHOR = '0x1111111111111111111111111111111111111111';
/** The harness's chain-time scaling: wallets, wallet hold (ms) and idle poll (ms). */
export const LIFT_DEFAULTS = Object.freeze({
  wallets: 6,
  walletHoldMs: 3000,
  pollMs: 1000,
});
const DKG = 'http://dkg.io/ontology/';
const q = (graph, subject, predicate, object) => ({
  graph,
  subject,
  predicate,
  object,
});
const lit = (s) => JSON.stringify(String(s));

/** The fixed timestamp (ms) the tail's lifecycle stamps carry, plus the asset slot: same size as a clock reading. */
const STAMP_MS = 1_700_000_000_000;

export const walletIdsOf = (n) => Array.from({ length: n }, (_, i) => `aqc-wallet-${i}`);

/** The publisher stream's arrival schedule (the harness's: seed * 31 + 7, so a seed is the same schedule in every build). */
export const publishArrivals = (cfg) =>
  poissonArrivals(cfg.seed * 31 + 7, cfg.mu, cfg.warmupMs + cfg.measureMs + cfg.cooldownMs);

/** The graph-scoped publish request of publication i; every request is distinct (name, share operation, intent key). */
export function makeVmRequest(i, tag, core) {
  const kaNumber = BigInt(1000 + i);
  const ual = `did:dkg:31337/${AUTHOR}/${kaNumber}`;
  const root = `0x${createHash('sha256').update(`${tag}-${i}`).digest('hex')}`;
  return {
    contextGraphId: CG_ID,
    name: `pub-${tag}-${i}`,
    shareOperationId: `so-${tag}-${i}`,
    roots: [],
    contentScopeVersion: core.GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    seal: {
      merkleRoot: root,
      authorAddress: AUTHOR,
      signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
      schemeVersion: 1,
      reservedKaId: ((BigInt(AUTHOR) << 96n) | kaNumber).toString(),
    },
    sealChainId: '31337',
    sealKav10Address: '0x2222222222222222222222222222222222222222',
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: root,
    intentKey: `sha256:${createHash('sha256').update(`intent-${tag}-${i}`).digest('hex')}`,
    wmCurrentAssertion: root.slice(2),
    swmCurrentAssertion: root.slice(2),
    kaNumber: kaNumber.toString(),
    reservedUal: ual,
  };
}

/**
 * The publish-async route's reads before the enqueue: the context-graph write probe (the share route's real one,
 * `shareProbe`), intent resolution (8 sequential reads) and the snapshot preflight (5). A degraded probe is the route's
 * 503, returned as a rejection record.
 */
export function createPublishPreflight(world, shareProbe) {
  const { store } = world;
  const read = (name, sparql) => store.query(sparql, { source: `bench.pre.${name}` });
  return async function publishPreflight(n) {
    const a = assetOf(n);
    const M = metaGraph();
    const S = swmMetaGraph();
    const pf = await shareProbe();
    if (pf.reject) return pf;
    await read(
      'intent.slots',
      `SELECT ?s WHERE { GRAPH <${M}> { ?s <${DKG}state> ?o . FILTER(STRSTARTS(STR(?s), "urn:dkg:assertion:${CG_ID}:") && STRENDS(STR(?s), ":asset-${n % ASSET_POOL}")) } } LIMIT 100`,
    );
    await read('intent.seal', `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${M}> { VALUES ?s { <${a}> } ?s ?p ?o } }`);
    await read('intent.state', `SELECT ?state WHERE { GRAPH <${M}> { <${a}> <${DKG}state> ?state } }`);
    await read('intent.events', `SELECT ?p ?o WHERE { GRAPH <${M}> { <${a}> ?p ?o } } LIMIT 100`);
    await read('intent.roots', `SELECT ?o WHERE { GRAPH <${M}> { <${a}> <${DKG}rootEntity> ?o } }`);
    await read('intent.complete', `ASK { GRAPH <${M}> { <${a}> <${DKG}swmShareComplete> ?v } }`);
    await read('intent.seal2', `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${M}> { VALUES ?s { <${a}> } ?s ?p ?o } }`);
    await read('intent.head', `SELECT ?head WHERE { GRAPH <${S}> { ?head <${DKG}assertionVersion> ?v } } LIMIT 5`);
    await read('snapshot.share', `SELECT ?p ?o WHERE { GRAPH <${S}> { <urn:dkg:share:${CG_ID}:${n}> ?p ?o } }`);
    await read('snapshot.count1', `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${M}/private-${n % 4}> { ?s ?p ?o } }`);
    await read('snapshot.select', `SELECT ?s ?p ?o WHERE { GRAPH <${M}/private-${n % 4}> { ?s ?p ?o } } LIMIT 256`);
    await read('snapshot.count2', `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${M}/private-${n % 4}> { ?s ?p ?o } }`);
    await read(
      'snapshot.chain',
      `SELECT ?id WHERE { GRAPH <${M}> { <did:dkg:context-graph:${CG_ID}> <${DKG}onChainId> ?id } }`,
    );
    return { ok: true };
  };
}

/**
 * The synthetic named-KA handler: the verification reads before the send, a wallet hold standing for the chain, and the
 * executor tail after it. `state` counts what it did, the evidence that the run replayed the publication body.
 */
export function createLiftHandler(world, deps) {
  const { store, cfg } = world;
  const { deleteByPatternWithoutCount } = deps.storage;
  const state = { preflights: 0, executions: 0, tailOps: 0 };
  let nonce = 0;
  const jnOf = (input) => {
    const m = /-(\d+)$/.exec(String(input.request?.name));
    return m ? Number(m[1]) : 0;
  };
  const verify = async (jn) => {
    const a = assetOf(jn);
    const M = metaGraph();
    const S = swmMetaGraph();
    const read = (name, sparql) => store.query(sparql, { source: `bench.vr.${name}` });
    await read('state', `SELECT ?state WHERE { GRAPH <${M}> { <${a}> <${DKG}state> ?state } }`);
    await read('events', `SELECT ?p ?o WHERE { GRAPH <${M}> { <${a}> ?p ?o } } LIMIT 100`);
    await read('roots', `SELECT ?o WHERE { GRAPH <${M}> { <${a}> <${DKG}rootEntity> ?o } }`);
    await read('complete', `ASK { GRAPH <${M}> { <${a}> <${DKG}swmShareComplete> ?v } }`);
    await read('head', `SELECT ?head WHERE { GRAPH <${S}> { ?head <${DKG}assertionVersion> ?v } } LIMIT 5`);
  };
  // What the tail writes on the asset subject belongs to the asset slot, not to the publication: publications reuse
  // ASSET_POOL subjects, so a value carrying the publication number or the wall clock would pile up on them (each
  // completed publication growing every later preflight and verification read of the subject, and with it the cost of
  // the run's own reads). The fixture's share replay does the same (fixture.mjs PROVENANCE).
  const tail = async (jn) => {
    const a = assetOf(jn);
    const slot = jn % ASSET_POOL;
    const M = metaGraph();
    const S = swmMetaGraph();
    const o = (name) => ({ source: `bench.dp.lift.${name}` });
    const op = async (call) => {
      state.tailOps++;
      await call();
    };
    const drop = (name, spec) => op(() => deleteByPatternWithoutCount(store, spec, o(name)));
    await op(() => store.insert([q(M, a, `${DKG}publishReceipt`, lit(`r${slot}`))], o('receipt')));
    await op(() =>
      store.query(`SELECT ?h WHERE { GRAPH <${S}> { ?h <${DKG}assertionVersion> ?v } } LIMIT 5`, o('swmHead')),
    );
    await op(() =>
      store.query(`SELECT ?o WHERE { GRAPH <${S}> { <urn:dkg:share:${CG_ID}:so${jn}> ?p ?o } }`, o('opSubject')),
    );
    await op(() => store.insert([q(M, a, `${DKG}retireAt`, lit(STAMP_MS + slot))], o('retireSchedule')));
    await op(() => store.listGraphs(o('scopeGraphs')));
    await op(() => store.dropGraph(`did:dkg:context-graph:${CG_ID}/_shared_memory/pub${jn}`, o('dropSwm')));
    await op(() =>
      store.dropGraph(`did:dkg:context-graph:${CG_ID}/_shared_memory_snapshots/pub${jn}`, o('dropSnapshot')),
    );
    await drop('ackCopy', { graph: S, subject: `urn:dkg:ackcopy:${jn}` });
    await drop('headDelete', { graph: S, subject: `urn:dkg:head:${jn}` });
    await drop('opDelete1', {
      graph: S,
      subject: `urn:dkg:share:${CG_ID}:so${jn}`,
    });
    await drop('opDelete2', {
      graph: M,
      subject: a,
      predicate: `${DKG}swmShareComplete`,
    });
    await op(() => store.delete([q(M, a, `${DKG}state`, lit('shared'))], o('lifecycleDelete')));
    await op(() =>
      store.insert(
        [q(M, a, `${DKG}state`, lit('published')), q(M, a, `${DKG}publishedAt`, lit(STAMP_MS + slot))],
        o('lifecycleInsert'),
      ),
    );
    await op(() => store.insert([q(M, a, `${DKG}vmTwin`, lit(`vm${slot}`))], o('vmTwin')));
    await op(() => store.insert([q(M, a, `${DKG}catalogObligation`, lit(`c${slot}`))], o('catalog')));
    await drop('clearShareComplete', { graph: M, subject: `${a}#swmComplete` });
  };
  return {
    state,
    async preflight(input) {
      state.preflights++;
      await verify(jnOf(input));
      return { action: 'execute' };
    },
    async execute(input) {
      state.executions++;
      const jn = jnOf(input);
      await store.query(`SELECT ?o WHERE { GRAPH <${metaGraph()}> { <${assetOf(jn)}> <${DKG}lifecyclePointer> ?o } }`, {
        source: 'bench.vr.lifecyclePointer',
      });
      const txHash = `0x${randomBytes(32).toString('hex')}`;
      const n = ++nonce;
      await input.publishOptions.onBeforeBroadcast?.({ txHash, nonce: n });
      await input.publishOptions.onBroadcastAccepted?.({ txHash, nonce: n });
      await sleep(cfg.walletHoldMs); // the chain: signing, mempool, inclusion, receipt; the wallet stays held
      input.publishOptions.onPublishConfirmed?.({ txHash });
      await tail(jn);
      const kaId = BigInt(1000 + jn);
      return {
        kaId,
        ual: input.request.kaUal,
        merkleRoot: new Uint8Array(32),
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: kaId,
          startKAId: kaId,
          endKAId: kaId,
          txHash,
          blockNumber: 1000 + jn,
          blockTimestamp: 1_700_000_000 + jn,
          publisherAddress: AUTHOR,
        },
      };
    },
  };
}

/**
 * Records the wallet-lock writes and deletes of the claim coordinator, the busy intervals of the worker-free pick-up
 * (D-16), by wrapping the product's claim-trace emit: the original still runs, and the wrapper never changes behaviour.
 * Events carry the wall clock (`at`, Date.now()), the clock the publisher stamps its jobs with.
 */
export function installWalletTrace(claimTrace) {
  const events = [];
  const hadOwn = Object.prototype.hasOwnProperty.call(claimTrace, 'emit');
  const original = claimTrace.emit;
  if (typeof original !== 'function')
    throw new Error('wallet trace: claimTrace.emit not found (product code changed?)');
  claimTrace.emit = function walletTracingEmit(event, fields, walletId, claimToken) {
    try {
      if (event === 'wallet_lock_written')
        events.push({
          at: Date.now(),
          ev: 'written',
          walletId,
          jobId: fields?.jobId ?? null,
        });
      else if (event === 'wallet_lock_deleted') events.push({ at: Date.now(), ev: 'deleted', walletId });
    } catch {
      /* instrumentation must never change behaviour */
    }
    return original.call(this, event, fields, walletId, claimToken);
  };
  return {
    events,
    uninstall() {
      if (hadOwn) claimTrace.emit = original;
      else delete claimTrace.emit;
    },
  };
}

/**
 * The daemon's publisher: an admission instance and a runtime instance (the one with the handler) on one store, the
 * runner over `cfg.wallets` wallets, and the wallet-lock trace. `stage(n)` stores publication n's share snapshot (the
 * share step precedes the publish call in the real cycle) through the unscheduled seed store, so staging stays off
 * the measured scheduler. Any runner error is counted and gates validity.
 */
export function createLiftSide(world, deps, { stageStore, graphManager }) {
  const { store, cfg } = world;
  const { pub, core } = deps;
  const state = {
    errors: 0,
    first: null,
    bootBackfill: null,
    stopTimedOut: null,
  };
  const note = (e) => {
    state.errors++;
    state.first ??= String(e?.message ?? e).slice(0, 200);
  };
  const handler = createLiftHandler(world, deps);
  const base = { journalWrites: true };
  const admission = new pub.TripleStoreAsyncLiftPublisher(store, base);
  const runtime = new pub.TripleStoreAsyncLiftPublisher(store, {
    ...base,
    knowledgeAssetVmPublishHandler: handler,
  });
  const walletIds = walletIdsOf(cfg.wallets);
  const runner = new pub.AsyncLiftRunner({
    publisher: runtime,
    walletIds,
    pollIntervalMs: cfg.liftPollMs,
    errorBackoffMs: 5000,
    recoveryIntervalMs: 60_000,
    onError: note,
  });
  const trace = installWalletTrace(deps.liftClaimTrace.claimTrace);
  return {
    admission,
    runtime,
    runner,
    handler,
    walletIds,
    state,
    trace,
    request: (n) => makeVmRequest(n, cfg.runTag, core),
    async stage(n) {
      const req = makeVmRequest(n, cfg.runTag, core);
      await pub.storeKnowledgeAssetOperationPublicQuads({
        store: stageStore,
        graphManager,
        contextGraphId: CG_ID,
        shareOperationId: req.shareOperationId,
        kaUal: req.kaUal,
        assertionVersion: '1',
        publisherPeerId: 'aqc-peer',
        quads: [
          {
            subject: `urn:aqc:ka:${n}:a`,
            predicate: 'http://schema.org/name',
            object: '"One"',
            graph: '',
          },
          {
            subject: `urn:aqc:ka:${n}:b`,
            predicate: 'http://schema.org/name',
            object: '"Two"',
            graph: '',
          },
        ],
      });
    },
    async start() {
      try {
        await admission.ensureVmPublishIntentIndex?.();
        state.bootBackfill = { ok: true };
      } catch (e) {
        state.bootBackfill = {
          ok: false,
          err: String(e?.message ?? e).slice(0, 160),
        };
      } // fail-open like the daemon's boot backfill
      await runner.start();
    },
    /** Resolves true when the runner stopped within the cap. */
    async stop() {
      state.stopTimedOut =
        (await within(
          runner.stop().then(() => 'stopped'),
          25_000,
        )) !== 'stopped';
      trace.uninstall();
      return !state.stopTimedOut;
    },
  };
}

/** The publish stream: the route's preflight reads, then the real enqueue; `preflight` is createPublishPreflight(...). */
export function startPublishProducers(world, liftSide, preflight, arrivals) {
  const { cfg } = world;
  world.pubArrivalCount = arrivals.length;
  return startArrivals(world, {
    arrivals,
    requests: world.pubRequests,
    keyOf: (n) => `pub-${cfg.runTag}-${n}`,
    issue: async (rec, n) => {
      const pf0 = performance.now();
      const pf = await preflight(n);
      rec.preMs = performance.now() - pf0;
      if (pf.reject) {
        Object.assign(rec, pf.reject);
        return;
      }
      const e0 = performance.now();
      rec.enqStart = e0 - world.t0;
      rec.jobId = await liftSide.admission.enqueueKnowledgeAssetVmPublish(liftSide.request(n), {
        admittedByAgentAddress: AGENT,
      });
      rec.enqMs = performance.now() - e0;
      rec.outcome = 'success';
    },
  });
}

/**
 * The ground truth of the publisher stream: this run's persisted jobs by publication name (several under one name would
 * be a double admission). Read off the queue graph with the unscheduled seed store, whose rows are decoded with the
 * product's own payload codec; a row that does not decode throws, so a half-readable queue is never a measurement.
 */
export async function readLiftJobs(store, deps, runTag) {
  const CP = deps.liftControl;
  const rs = await store.query(
    `SELECT ?payload WHERE { GRAPH <${CP.DEFAULT_CONTROL_GRAPH_URI}> { ` +
      `?job <${CP.CONTROL_HAS_REQUEST}> ?req ; <${CP.CONTROL_PAYLOAD}> ?payload . ` +
      `?req <${CP.CONTROL_SHARE_OPERATION_ID}> ?so . FILTER(STRSTARTS(?so, "so-${runTag}-")) } }`,
  );
  const byName = new Map();
  for (const b of rs.bindings ?? []) {
    const decoded = deps.liftCodec.decodeLiftJobPayload(b.payload);
    if (decoded.kind !== 'canonical' && decoded.kind !== 'compatibility')
      throw new Error(`unreadable publisher row (${decoded.kind})`);
    const name = decoded.job.request.knowledgeAssetVmPublish.name;
    byName.set(name, [...(byName.get(name) ?? []), decoded.job]);
  }
  return byName;
}

/**
 * What the publisher's list observer polls: the public list without a filter, a full read. `paged` stays null until the
 * publisher's keyset list exists (P9a / P9b): that PR adds its entry beside the share queue's (workload.mjs).
 */
export const LIFT_OBSERVER_CALLS = {
  default: async (publisher) => ({ rows: (await publisher.list()).length }),
  paged: null,
};

/**
 * Why a run cannot use the `paged` list observer (null when it can). Every stream that runs has its own observer: the
 * share queue's in a share or mixed run, the publisher's in a lift or mixed run, so a stream's missing paged call
 * refuses the run only when that stream is in it. A `--queue lift` run polls no share queue, so the share queue's
 * missing paged call (P8a / P9b) is no reason to refuse it. The calls default to the real tables; tests pass their own.
 */
export function pagedObserverProblem(
  { withShare, withLift },
  { shareCalls = OBSERVER_CALLS, liftCalls = LIFT_OBSERVER_CALLS } = {},
) {
  if (withShare && !shareCalls.paged)
    return "the share queue's paged listing is not available in this build (needs P8a/P9b)";
  if (withLift && !liftCalls.paged)
    return "the publisher's paged listing is not available in this build (needs P9a/P9b)";
  return null;
}
