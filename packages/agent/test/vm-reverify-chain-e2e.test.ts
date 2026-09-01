/**
 * W2 (#2435) — chain-triggered re-verification of an ALREADY-HELD Knowledge
 * Asset whose on-chain Merkle root changed. Two real agents, one real chain.
 *
 * THE DEFECT THIS FILE EXISTS TO CATCH
 * ------------------------------------
 * When a KA's root changes on chain, a node that already holds that KA
 * converges only if a *delivery* reaches it: best-effort gossip on the CG
 * update topic, or a durable-sync round that happens to re-touch the asset
 * from a peer that already has the new version. Nothing chain-triggered ever
 * re-examines a held KA — the only chain-driven sweep walks the append-only
 * registration ordinal and short-circuits at `watermark >= head`, and an
 * UPDATE does not append an ordinal. A node that misses the delivery serves
 * the old version indefinitely while reporting the CG `current`.
 *
 * Worst hit, and what agent B is here: a HOST-ONLY core. It signed a
 * StorageACK for a public CG (`recordCoreHostedPublicCg`) and holds the KA,
 * but it is not a member, so it is not on the update topic at all. For B the
 * missed delivery is not bad luck — it is the steady state.
 *
 * WHY THE ORACLES LOOK THE WAY THEY DO
 * ------------------------------------
 * A query-only assertion ("B now serves the new triple") would go green for
 * the WRONG reason the moment any other repair lane — gossip, sync-on-connect,
 * durable sync — happened to deliver the update. So:
 *
 *   1. B is built with `syncOnConnectEnabled: false, durableSyncEnabled: false`
 *      and is UNSUBSCRIBED from the CG before the update, so the chain lane is
 *      the only remaining route by construction.
 *   2. The primary oracle is the DRAIN RESULT, not the query: the re-verify
 *      worker must return an item for X with `status ∈ {fetched, materialized}`
 *      and `peerAttempts >= 1`, and the lane cursor must have advanced past the
 *      update's block. That is "the chain lane did this", not "something did".
 *   3. STATE AT EVENT: between the poll and the drain, B must still serve the
 *      OLD triple and hold exactly one pending intent. A repair that had
 *      already happened by then came from somewhere else.
 *
 * The first `it()` is a POSITIVE CONTROL: cross-node CREATE. It must be green
 * on the same head the fail-before red is captured on. Without it, a red here
 * is indistinguishable from "the two-agent harness does not work".
 *
 * Ports: self-spawned Hardhat on 8555 (the shared agent-lane node is 9547;
 * 8547–8554 are taken by other self-spawning agent e2e files).
 *
 * KNOWN INSTABILITY ON WINDOWS DEV BOXES — read before diagnosing a failure.
 *
 * On Windows this file (and other agent e2es that start real nodes) can abort
 * its vitest worker instead of failing a test: "Worker exited unexpectedly",
 * with either NO test output at all (`tests 0ms`, aborted during `beforeAll`
 * agent startup) or a partial run (3 of 4 pass, then the worker exits during
 * SC-2's restart). Measured here at roughly one clean run in seven.
 *
 * It is NOT specific to this file and NOT caused by the code under test:
 * `rfc49-catalog-parity.e2e.test.ts`, which this file has never touched, aborts
 * identically on a loaded box and passes on a quiet one. It matches this
 * repository's known Windows + vitest-forks + oxigraph-native-worker pattern.
 * CI runs Linux, where these suites have been stable.
 *
 * Two mitigations are in place and BOTH are known insufficient on their own:
 * `afterAll` removes the data directories this file creates (a test that
 * litters eventually lies about something else), and a settle after
 * `host.stop()` lets the persistent store release its handles before the
 * restart re-opens the same directory. Measured effect of the settle: green on
 * the next attempt, then 0 of 3.
 *
 * WHAT THIS MEANS FOR READING A RESULT. The aborts are worker-exit-shaped,
 * never false-pass-shaped, so a run whose assertions actually EXECUTED is
 * trustworthy however many sibling runs crashed. Gate on "the run reached the
 * rows" — a count of reported tests — not on the exit code, because an abort
 * also exits non-zero and would otherwise fabricate a passing mutant kill.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers, Wallet } from 'ethers';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  AUTHOR_SCHEME_VERSION_V1,
  MemoryLayer,
  buildUpdateAuthorAttestationTypedData,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type PrecomputedUpdateAttestation,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  readMaterializedVersion,
  skolemizeKnowledgeAssetParts,
} from '../../publisher/src/index.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  ContextGraphSubscriptionRecord,
} from '../src/dkg-agent-types.js';
import {
  spawnHardhatEnv,
  killHardhat,
  HARDHAT_KEYS,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

// The re-verify worker owns two timers: a poll interval and a post-ingest
// `kick()` debounce. Both are deliberately pushed out of this test's lifetime
// so that EVERY drain in this file is one we asked for explicitly. Without
// this the kicked drain (250 ms after ingest) races the state-at-event oracle
// below and would make a real repair look like a flaky assertion — and, worse,
// would make `peerAttempts` unattributable to the call under test.
process.env.DKG_VM_REVERIFY_POLL_INTERVAL_MS = '3600000';
process.env.DKG_VM_REVERIFY_KICK_DEBOUNCE_MS = '3600000';

const HARDHAT_PORT = 8555;
const CG = 'w2r-reverify-public';
const SUBJECT = 'did:dkg:w2r:Widget';
const NAME_PREDICATE = 'http://schema.org/name';
const NAME_V1 = 'Widget v1';
const NAME_V2 = 'Widget v2';
const NAME_V3 = 'Widget v3';
/** The lane's own cursor key. Renamed from `collectionUpdates` in PR-A. */
const LANE = 'kaRootMutations';
/** `ChainEventPoller.MAX_RANGE`; a head-seeded lane cannot see further back. */
const MAX_RANGE_BLOCKS = 9_000;

let ctx: HardhatContext;
const liveAgents = new Set<DKGAgent>();

/**
 * Data directories created by this file, removed in `afterAll`.
 *
 * Each one holds a persistent triple store. Left behind, a few dozen runs'
 * worth accumulate in the temp directory and the suite starts aborting its
 * worker before any test executes — which reads exactly like a product failure
 * and is not one. A test that litters is a test that eventually lies about
 * something else.
 */
const dataDirs: string[] = [];
const mkDataDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `w2r-reverify-${name}-`));
  dataDirs.push(dir);
  return dir;
};

function chainConfig(opKey: string, adminKey: string) {
  return {
    rpcUrl: ctx.rpcUrl,
    adminPrivateKey: adminKey,
    operationalKeys: [opKey],
    hubAddress: ctx.hubAddress,
    chainId: 'evm:31337',
  };
}

/**
 * In-memory lane cursor store that also RECORDS every write.
 *
 * `saveLane` is the restart-backfill witness: SC-2 is only proven if the lane
 * actually persisted a cursor under its own key, not if B merely happened to
 * hold the new triple after a restart.
 */
function makeCursorStore() {
  const cursors = new Map<string, number>();
  const saves: Array<{ lane: string; blockNumber: number }> = [];
  return {
    saves,
    peek: (lane: string) => cursors.get(lane),
    store: {
      async loadLane(lane: string): Promise<number | undefined> {
        return cursors.get(lane);
      },
      async saveLane(lane: string, blockNumber: number): Promise<void> {
        cursors.set(lane, blockNumber);
        saves.push({ lane, blockNumber });
      },
    },
  };
}

/** In-memory durable subscription store, shared across B's restart. */
function makeSubscriptionStore() {
  const rows = new Map<string, ContextGraphSubscriptionRecord>();
  return {
    rows,
    store: {
      async loadAll(): Promise<ContextGraphSubscriptionRecord[]> {
        return [...rows.values()];
      },
      async load(contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null> {
        return rows.get(contextGraphId) ?? null;
      },
      async save(record: ContextGraphSubscriptionRecord): Promise<void> {
        rows.set(record.id, { ...record });
      },
      async delete(contextGraphId: string): Promise<void> {
        rows.delete(contextGraphId);
      },
    },
  };
}

const cursorStore = makeCursorStore();
const subscriptionStore = makeSubscriptionStore();

/**
 * The V10 update author seal. Mirrors `buildUpdateSeal` in `e2e-chain.test.ts`
 * (and `publisher/test/_helpers/seal.ts`), inlined so agent tests do not reach
 * into publisher test helpers.
 */
async function buildUpdateSeal(opts: {
  kaId: bigint;
  quads: Quad[];
  author: Wallet;
  provider: ethers.JsonRpcProvider;
  kav10Address: string;
}): Promise<PrecomputedUpdateAttestation> {
  const canonical = await skolemizeKnowledgeAssetParts(opts.quads, []);
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  const newMerkleRoot = computeFlatKCRootV10(
    canonical.publicQuads,
    privateRoot ? [privateRoot] : [],
  );
  const chainId = await opts.provider.getNetwork().then((n) => n.chainId);
  const td = buildUpdateAuthorAttestationTypedData({
    chainId: BigInt(chainId),
    kav10Address: opts.kav10Address,
    kaId: opts.kaId,
    newMerkleRoot,
    authorAddress: opts.author.address,
  });
  const sigHex = await opts.author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedNewMerkleRoot: newMerkleRoot,
    authorAddress: opts.author.address,
    signature: { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

/**
 * Lexical form of an RDF literal term.
 *
 * The store returns the full term (`"Widget v1"`, with the quotes, plus any
 * `^^datatype` or `@lang` tail). Comparing against that raw string would make
 * every assertion below depend on the term serialization rather than on what
 * the node actually serves.
 */
function literalText(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const closing = raw.lastIndexOf('"');
  if (closing <= 0) return raw;
  return raw.slice(1, closing).replace(/\\(.)/g, '$1');
}

/** Every value this node can serve for `<SUBJECT> schema:name ?o`, any graph. */
async function heldNames(agent: DKGAgent): Promise<string[]> {
  const result: any = await (agent as any).store.query(
    `SELECT ?o WHERE { GRAPH ?g { <${SUBJECT}> <${NAME_PREDICATE}> ?o } }`,
    { source: 'test.w2r.heldNames' },
  );
  const bindings: any[] = result?.bindings ?? [];
  return [...new Set(
    bindings.map((b) => literalText(String(b.o?.value ?? b.o))),
  )].sort();
}

/**
 * Names served from the Knowledge Asset's own VERIFIABLE-memory graph.
 *
 * That graph is keyed by (agentAddress, kaNumber) and NOT by assertion version
 * — `contextGraphLayerUri` takes no version — so an update REPLACES its content
 * in place rather than creating a second graph. An earlier revision of this file
 * asked whether "the version-2 VM graph" existed yet; both versions resolve to
 * the SAME URI, so that question could not be answered and the assertion was
 * measuring a distinction the data model does not have. It also never ran until
 * the oracles above it started passing, which is how it survived every red.
 *
 * The honest observable is CONTENT: what does verifiable memory say the name is.
 * That is also strictly stronger than a quad count, which one triple satisfies
 * whichever version it holds.
 */
async function vmNames(agent: DKGAgent, kaUal: string): Promise<string[]> {
  const graph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    // The version argument builds the scope; it does not reach the URI.
    createGraphKnowledgeAssetScope(kaUal, '1'),
  );
  const result: any = await (agent as any).store.query(
    `SELECT ?o WHERE { GRAPH <${graph}> { <${SUBJECT}> <${NAME_PREDICATE}> ?o } }`,
    { source: 'test.w2r.vmNames' },
  );
  const bindings: any[] = result?.bindings ?? [];
  return [...new Set(
    bindings.map((b) => literalText(String(b.o?.value ?? b.o))),
  )].sort();
}

/**
 * Drive one lane scan — the force-scan seam that replaced the deleted public
 * `pollNow()` (PR #2436 review r17: zero production callers). The plain
 * `poll()` re-arms `nextRunAtMs` after a caught-up scan, so the lane schedules
 * are cleared first to force a scan regardless of cadence. Optional-chained on
 * purpose — on a head WITHOUT the poller this degrades to `undefined` instead
 * of throwing, so the fail-before red lands on the intent / drain oracle (the
 * actual missing behaviour) rather than on a TypeError.
 */
async function drivePoll(agent: DKGAgent): Promise<void> {
  const poller = (agent as any).chainPoller;
  poller?.laneRunner?.clearActiveLaneSchedules?.();
  await poller?.poll?.();
}

/** Run exactly one drain pass. Undefined on a head without the worker. */
async function drainOnce(agent: DKGAgent): Promise<any> {
  return (agent as any).vmReverifyWorker?.runOnce?.();
}

/** Pending intents for a CG; `-1` when the store does not exist on this head. */
async function countPending(agent: DKGAgent, localCgId: string): Promise<number> {
  const store = (agent as any).vmReverifyIntents;
  if (typeof store?.countPending !== 'function') return -1;
  return store.countPending(localCgId);
}

async function waitUntil(
  probe: () => Promise<boolean>,
  timeoutMs = 30_000,
  stepMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await probe()) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** The version stamp the drain must NOT advance on an already-current KA. */
async function materializedStamp(
  agent: DKGAgent,
): Promise<{ blockNumber: number; txIndex: number } | undefined> {
  return readMaterializedVersion((agent as any).store, contextGraphMetaUri(CG), ual) as any;
}

let hostDataDir: string;
let publisher: DKGAgent;
let host: DKGAgent;
let curator: string;
let onChainCgId: string;
let kaId: bigint;
let ual: string;
let kav10Address: string;
let updateBlock: number;

async function createHostCore(): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name: 'W2RHostCore',
    nodeRole: 'core',
    listenPort: 0,
    skills: [],
    dataDir: hostDataDir,
    chainConfig: chainConfig(HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC1_ADMIN),
    chainEventCursorStore: cursorStore.store,
    contextGraphSubscriptionStore: subscriptionStore.store,
    // Close every AUTOMATIC repair route while leaving the durable plane the
    // drain itself depends on switched ON (ADR-W2R-10).
    //
    // `durableSyncEnabled: false` was the original isolation and it was wrong
    // in an instructive way: the exact-asset fetch carries no SWM, so the
    // drain's own repair needs `recoverContextGraphSwmFromPeer`, which that
    // switch disables. The isolation would have disabled the thing under test
    // and the resulting red would have looked exactly like a missing feature.
    //
    // Single-path attribution survives without it: `syncOnConnectEnabled:false`
    // removes the connect trigger, an EMPTY `syncContextGraphs` removes the
    // ambient durable/VM scope (that list IS the automatic scope), and the node
    // is unsubscribed from the CG so no member gossip reaches it. The only SWM
    // recovery in the window is therefore the drain's own call.
    syncOnConnectEnabled: false,
    durableSyncEnabled: true,
    syncContextGraphs: [],
    syncReconcilerIntervalMs: 3_600_000,
    syncStalenessThresholdMs: 3_600_000,
  } as any);
  liveAgents.add(agent);
  return agent;
}

describe('W2 #2435 — a held KA converges to its new on-chain root via the chain event lane', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(HARDHAT_PORT);
    hostDataDir = mkDataDir('host');

    publisher = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'W2RPublisher',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      dataDir: mkDataDir('pub'),
      chainConfig: chainConfig(HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN),
    });
    liveAgents.add(publisher);

    host = await createHostCore();

    await publisher.start();
    await host.start();
    await host.connectTo(publisher.multiaddrs[0]!);
    await new Promise((r) => setTimeout(r, 2000));

    curator = publisher.defaultAgentAddress ?? publisher.peerId;
    kav10Address = await (publisher as any).chain.getKnowledgeAssetsLifecycleAddress();
  }, 300_000);

  afterAll(async () => {
    for (const agent of liveAgents) {
      try { await agent.stop(); } catch { /* teardown best-effort */ }
    }
    killHardhat(ctx);
    for (const dir of dataDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POSITIVE CONTROL — cross-node CREATE.
  //
  // Must be GREEN on the head the fail-before red is captured on. It proves
  // the harness itself works: two agents on a real chain, a public CG, a
  // confirmed publish, and delivery of a NEW asset into the second node. If
  // this is red, nothing below is evidence of anything.
  // ─────────────────────────────────────────────────────────────────────────
  it('positive control: a cross-node CREATE reaches the second node', async () => {
    await publisher.createContextGraph({
      id: CG,
      name: 'W2R Reverify Public',
      accessPolicy: 0,
      callerAgentAddress: curator,
    });
    const registration = await publisher.registerContextGraph(CG, {
      callerAgentAddress: curator,
    });
    onChainCgId = registration.onChainId;
    expect(onChainCgId, 'the CG must be registered on chain').toBeTruthy();

    // The host may ALREADY know this Context Graph: registering it on chain
    // emits `ContextGraphCreated`, and the host's own chain poller binds and
    // bootstraps it locally without being asked. That is production behaviour —
    // a receiver learns a public CG from chain — so create it only if the node
    // has not already discovered it, rather than assuming this test is the
    // first writer.
    if (!(await (host as any).contextGraphExists(CG))) {
      await host.createContextGraph({ id: CG, name: 'W2R Reverify Public' });
    }
    publisher.subscribeToContextGraph(CG);
    host.subscribeToContextGraph(CG);
    for (const agent of [publisher, host]) {
      const sub = (agent as any).subscribedContextGraphs.get(CG);
      if (sub) sub.onChainId = onChainCgId;
    }
    await new Promise((r) => setTimeout(r, 1000));

    const published: any = await publisher.publish(CG, [
      { subject: SUBJECT, predicate: NAME_PREDICATE, object: `"${NAME_V1}"`, graph: '' },
    ]);
    expect(published.status, 'the baseline publish must confirm on chain').toBe('confirmed');
    kaId = published.kaId ?? published.onChainResult.batchId;
    ual = published.ual;
    expect(published.assertionVersion).toBe('1');

    await waitUntil(async () => (await heldNames(host)).includes(NAME_V1));
    expect(
      await heldNames(host),
      'POSITIVE CONTROL: the second node must receive a newly CREATED asset — '
      + 'if this fails the harness is broken, not the feature under test',
    ).toContain(NAME_V1);
  }, 300_000);

  // ─────────────────────────────────────────────────────────────────────────
  // SC-1 — the defect itself.
  // ─────────────────────────────────────────────────────────────────────────
  it('SC-1: host-only node converges to the updated root, and the chain lane is what did it', async () => {
    // ── Turn the node into a pure HOST-ONLY core. ──
    // `recordCoreHostedPublicCg` is the StorageACK pre-sign chokepoint; the
    // unsubscribe then removes all four member topics while KEEPING
    // `coreHosted`. After this the node holds X but is on no topic that could
    // ever carry X's update — the exact production shape of the defect.
    await host.recordCoreHostedPublicCg(onChainCgId, CG);
    host.unsubscribeFromContextGraph(CG);
    const sub = (host as any).subscribedContextGraphs.get(CG);
    expect(
      { subscribed: sub?.subscribed, coreHosted: sub?.coreHosted },
      'the node must be host-only: no member subscription, still hosting',
    ).toEqual({ subscribed: false, coreHosted: true });
    expect(
      (host as any).gossipRegistered.has(CG),
      'the member gossip topics (incl. the CG update topic) must be gone',
    ).toBe(false);

    expect(
      await heldNames(host),
      'precondition: the host still serves the OLD version before the update',
    ).toEqual([NAME_V1]);
    const stampBeforeRepair = await materializedStamp(host);

    // ── The on-chain UPDATE. ──
    const author = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    const updateQuads: Quad[] = [
      { subject: SUBJECT, predicate: NAME_PREDICATE, object: `"${NAME_V2}"`, graph: '' },
    ];
    const updateResult: any = await publisher.update(
      kaId,
      CG,
      updateQuads,
      undefined,
      {
        precomputedUpdateAttestation: await buildUpdateSeal({
          kaId,
          quads: updateQuads,
          author,
          provider: ctx.provider,
          kav10Address,
        }),
      },
    );
    expect(updateResult.status, 'the on-chain update must confirm').toBe('confirmed');
    const updateReceipt =
      (await ctx.provider.getTransactionReceipt(updateResult.onChainResult.txHash))!;
    updateBlock = Number(updateReceipt.blockNumber);

    // The publisher moved; the host has not, and nothing will tell it.
    await new Promise((r) => setTimeout(r, 3000));
    expect(
      await heldNames(host),
      'the defect: without a chain-triggered re-check the host serves the OLD root forever',
    ).toEqual([NAME_V1]);

    // ── Drive ONE lane scan. ──
    await drivePoll(host);

    // ── STATE AT EVENT ──
    // The event has been ingested and durably recorded, and NOTHING has been
    // repaired yet. If the count is 0 here and the content is already new, the
    // repair came from a route this test was supposed to have closed.
    expect(
      await countPending(host, CG),
      'the lane must have turned the root-mutation event into exactly one durable '
      + 're-verification intent for this CG (-1 = no intent store on this head)',
    ).toBe(1);
    expect(
      await heldNames(host),
      'state-at-event: ingest alone must not repair anything — a new value here '
      + 'means some OTHER lane delivered the update',
    ).toEqual([NAME_V1]);
    expect(
      await vmNames(host, ual),
      'state-at-event: verifiable memory must still say the OLD name',
    ).toEqual([NAME_V1]);

    // The position the lane DECODED and PERSISTED must be the position of the
    // transaction that actually emitted the event. Everything downstream orders
    // on this triple — "is this newer than what I recorded", and the
    // `versionBlock >= observedBlock` resolve rule — so a decode that drifted
    // from the receipt by one field would silently corrupt both, and no content
    // assertion here would notice.
    const pendingRows = await (host as unknown as {
      vmReverifyIntents?: { listDue(now: number, limit: number): Promise<any[]> };
    }).vmReverifyIntents!.listDue(Date.now(), 10);
    const recorded = pendingRows.find((row) => row.ual === ual);
    expect(recorded?.observed, 'the recorded position must match the emitting receipt')
      .toMatchObject({
        blockNumber: Number(updateReceipt.blockNumber),
        transactionIndex: Number(updateReceipt.index),
      });

    // ── Drain: the repair, through the shipped exact-asset fetch. ──
    const run = await drainOnce(host);
    const item = run?.items?.find((entry: any) => entry.ual === ual);

    // PRIMARY ORACLE: the DRAIN repaired X — not some other lane that happened
    // to deliver. Attribution rests on three facts together, because no single
    // status can carry it:
    //
    //  - the state-at-event block above already proved the asset was NOT
    //    current immediately before this call (VM still said the old name);
    //  - the drain performed its own whole-CG SWM recovery (ADR-W2R-10);
    //  - the asset resolved on this call.
    //
    // `already-present` is an EXPECTED terminal status here, not a weakening.
    // The paired recovery is what makes the asset current, so the confirming
    // re-fetch inspects an asset that is already correct and says so. Demanding
    // `fetched|materialized` would reject the very repair shape ADR-W2R-10
    // creates — and would have kept this file red while the feature worked.
    expect(
      ['fetched', 'materialized', 'already-present'],
      'the drain must have resolved X on this call',
    ).toContain(item?.status);
    expect(
      run?.swmRecoveries ?? 0,
      'and it must have done the repairing itself: a host-only core needs the '
      + 'the SWM recovery the drain performs, since the exact fetch carries none',
    ).toBeGreaterThanOrEqual(1);
    expect(
      run?.peerAttempts ?? 0,
      'the repair must have actually contacted a peer that holds the new version',
    ).toBeGreaterThanOrEqual(1);
    expect(
      cursorStore.peek(LANE) ?? -1,
      `the ${LANE} lane cursor must have advanced past the update block ${updateBlock}`,
    ).toBeGreaterThanOrEqual(updateBlock);

    // ── Convergence. ──
    expect(
      await heldNames(host),
      'the host must now serve the NEW root',
    ).toContain(NAME_V2);
    expect(
      await vmNames(host, ual),
      'the new content must be in VERIFIABLE memory, not merely staged',
    ).toContain(NAME_V2);
    expect(
      await countPending(host, CG),
      'a resolved intent must be deleted, not left to retry forever',
    ).toBe(0);

    // ADR-W2R-8, the OTHER polarity. `inspectOnly` is passed on every drain
    // call, and it must suppress the version stamp ONLY on the already-current
    // path. A genuine PROMOTION still has to record its version — otherwise the
    // node would materialize new content while claiming, forever, to be at the
    // older version, and the next ordering decision would be made on a lie.
    // SC-3 below asserts the same flag does NOT stamp when nothing was
    // promoted; measuring only that side would leave "inspectOnly suppresses
    // everything" indistinguishable from correct.
    const stampAfterRepair = await materializedStamp(host);
    expect(
      stampAfterRepair?.blockNumber ?? -1,
      'a repair that PROMOTED content must still advance the materialization stamp',
    ).toBeGreaterThan(stampBeforeRepair?.blockNumber ?? -1);
  }, 300_000);

  // ─────────────────────────────────────────────────────────────────────────
  // SC-3 — no-op on a current KA.
  // ─────────────────────────────────────────────────────────────────────────
  it('SC-3: a second drive on an already-current KA costs no peer contact and stamps nothing', async () => {
    const stampBefore = await materializedStamp(host);

    // Re-raise the SAME event at a strictly later position WITHIN THE SAME
    // BLOCK — that is what a duplicate/re-scanned log looks like, and it keeps
    // `observedBlock` equal to the block the current version was committed at,
    // so the `versionBlock >= observedBlock` resolve rule is satisfied and the
    // no-op path (not the snapshot-behind-event retry) is the one under test.
    const store = (host as any).vmReverifyIntents;
    if (typeof store?.upsert === 'function') {
      await store.upsert({
        ual,
        localCgId: CG,
        kaId: kaId.toString(),
        kind: 'lifecycle-update',
        position: {
          blockNumber: updateBlock,
          blockHash: `0x${'0'.repeat(64)}`,
          transactionHash: `0x${'0'.repeat(64)}`,
          transactionIndex: 0,
          logIndex: 999,
        },
      });
    }
    expect(
      await countPending(host, CG),
      'a strictly-later position must re-raise the intent',
    ).toBe(1);

    const run = await drainOnce(host);
    const item = run?.items?.find((entry: any) => entry.ual === ual);
    expect(
      item?.status,
      'a KA that is already at its current on-chain root must be recognised locally',
    ).toBe('already-present');
    expect(
      run?.networkAttempted,
      'an already-current KA must cost ZERO peer contact — otherwise every '
      + 'duplicate or reorged event becomes network amplification',
    ).toBe(false);
    expect(
      await countPending(host, CG),
      'the re-raised intent must resolve without work',
    ).toBe(0);

    // ADR-W2R-8's stamp property is deliberately NOT asserted here.
    //
    // It cannot be measured in this file. `advanceExactGraphScopedVersion`
    // writes only when the new version is strictly greater, and by this point
    // SC-1's promotion has already stored exactly the value the already-current
    // path would write — so removing the `inspectOnly` guard changes nothing
    // observable, and a solo-removal mutant SURVIVES 4/4 here. Forcing a lower
    // stamp to create the gap does not rescue it either: this node also runs the
    // ordinary chain-driven VM reconcile sweep, which writes the same stamp on
    // its own timer, so the assertion becomes non-deterministic rather than
    // discriminating.
    //
    // An assertion that cannot fail is worse than none — it reports the guard
    // as covered. What IS proven here: the drain passes `inspectOnly` on every
    // call (unit mutant, killed). What is NOT: that the handler honours it.
    // That needs a fixture where nothing else can write the stamp, and is
    // recorded as owed rather than faked.
    void stampBefore;
  }, 300_000);

  // ─────────────────────────────────────────────────────────────────────────
  // SC-2 — restart backfill from the persisted lane cursor.
  // ─────────────────────────────────────────────────────────────────────────
  it('SC-2: an update the node never observed is backfilled from the persisted cursor', async () => {
    expect(
      await countPending(host, CG),
      'precondition: nothing outstanding before the node goes down',
    ).toBe(0);

    // The update is issued while the node is still running but has NOT polled
    // since — so it observes nothing — and the node is then down across the
    // whole rest of the window.
    //
    // The obvious ordering (stop first, then update) cannot work in a two-node
    // network: the publisher needs a connected core peer to collect a
    // StorageACK, so stopping the only other node makes the UPDATE fail with
    // `QuorumUnmetError` and the scenario never happens. A third "witness" core
    // would also solve it; this ordering is preferred because it keeps the file
    // at two agents and needs no node whose only job is to be counted.
    //
    // Nothing this scenario measures is weakened. What SC-2 proves is that a
    // node which never saw the event recovers it from its PERSISTED CURSOR
    // across a gap wider than a head seed can reach. Both halves stay asserted:
    // the cursor at stop is strictly behind the update block, and the gap
    // exceeds MAX_RANGE.
    const cursorAtStop = cursorStore.peek(LANE) ?? -1;

    // ── The update the node never observes. ──
    const author = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    const updateQuads: Quad[] = [
      { subject: SUBJECT, predicate: NAME_PREDICATE, object: `"${NAME_V3}"`, graph: '' },
    ];
    const updateResult: any = await publisher.update(
      kaId,
      CG,
      updateQuads,
      undefined,
      {
        precomputedUpdateAttestation: await buildUpdateSeal({
          kaId,
          quads: updateQuads,
          author,
          provider: ctx.provider,
          kav10Address,
        }),
      },
    );
    expect(updateResult.status, 'the second on-chain update must confirm').toBe('confirmed');
    const missedBlock = Number(
      (await ctx.provider.getTransactionReceipt(updateResult.onChainResult.txHash))!.blockNumber,
    );
    expect(
      missedBlock,
      'the missed update must be strictly ahead of the cursor the node saved',
    ).toBeGreaterThan(cursorAtStop);

    // Down for the rest of the window: the mining, and everything after it.
    await host.stop();
    liveAgents.delete(host);
    // Let the persistent store's worker thread actually release the data
    // directory before the restart re-opens it. `stop()` resolves when the
    // agent has torn down, but the Oxigraph worker and its file handles are
    // reclaimed asynchronously on Windows, and re-opening the same directory
    // underneath that can abort the whole vitest fork — which surfaces as a
    // worker exit with no test output at all, not as an error this file could
    // catch and report.
    await new Promise((r) => setTimeout(r, 5000));

    // Bury the event deeper than a head seed can reach. A lane that seeded at
    // `head - MAX_RANGE` on restart instead of restoring its cursor would scan
    // straight past this and the node would never converge.
    await ctx.provider.send('hardhat_mine', ['0x' + (MAX_RANGE_BLOCKS + 51).toString(16)]);
    const head = await ctx.provider.getBlockNumber();
    expect(
      head - missedBlock,
      'the update must now be further back than a head-seeded lane could see',
    ).toBeGreaterThan(MAX_RANGE_BLOCKS);

    // ── Restart against the SAME dataDir and the SAME durable stores. ──
    const savesBefore = cursorStore.saves.length;
    host = await createHostCore();
    await host.start();
    await host.connectTo(publisher.multiaddrs[0]!);
    await new Promise((r) => setTimeout(r, 2000));

    expect(
      (host as any).subscribedContextGraphs.get(CG)?.coreHosted,
      'the host-only row must have been rehydrated from the durable store',
    ).toBe(true);
    expect(
      await heldNames(host),
      'the restarted node still serves the version it had when it went down',
    ).toContain(NAME_V2);

    // Catching up ~9,051 blocks takes more than one MAX_RANGE window.
    for (let i = 0; i < 6 && (await countPending(host, CG)) <= 0; i += 1) {
      await drivePoll(host);
    }
    expect(
      await countPending(host, CG),
      'the restored cursor must have replayed the window containing the missed update',
    ).toBe(1);

    const run = await drainOnce(host);
    const item = run?.items?.find((entry: any) => entry.ual === ual);
    // Same terminal-status set as SC-1, for the same reason: the paired SWM
    // recovery is what makes the asset current, so the confirming re-fetch
    // reports `already-present`. Attribution here does not rest on the status
    // at all — it rests on the intent existing ONLY because the restored cursor
    // replayed a window buried deeper than a head seed can reach, which the
    // assertions above and below this one establish.
    expect(
      ['fetched', 'materialized', 'already-present'],
      'the backfilled intent must be repaired through the same drain path',
    ).toContain(item?.status);
    expect(
      run?.swmRecoveries ?? 0,
      'and through the same SWM pairing the exact fetch cannot do on its own',
    ).toBeGreaterThanOrEqual(1);
    expect(
      await heldNames(host),
      'the node must converge to the root it never heard about',
    ).toContain(NAME_V3);
    expect(
      cursorStore.saves.slice(savesBefore).some((entry) => entry.lane === LANE),
      `the ${LANE} lane must PERSIST its cursor after the restart scan — otherwise `
      + 'the next restart replays the same window forever',
    ).toBe(true);
    expect(
      await countPending(host, CG),
      'the backfilled intent must resolve',
    ).toBe(0);
  }, 600_000);
});
