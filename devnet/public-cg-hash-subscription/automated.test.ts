/**
 * Public Context Graph subscribed by its on-chain name hash - devnet coverage, on a
 * real Hardhat chain with real libp2p, daemons and stores (no mocks).
 *
 * Tests, in declaration order. The narrative, each test's arrangement and the
 * reasons for the structure are in README.md next to this file.
 *
 *   1. The chain commits only keccak256 of each registered graph id; the author
 *      holds what it published and shared.
 *   2. An edge subscribed by name hash alone adopts the verified cleartext id and
 *      converges on the finalized VM data (before the fix for #2744 it synced 0
 *      quads); its catch-up job is classified and asserted (catchup-jobs.ts).
 *   3. A second edge subscribed by numeric on-chain id lands on the same graph (#2758).
 *   4. A forced catch-up mints a replacement job that both aliases follow.
 *   5. The SWM a holder shared backfills on both edges (side by side, flows.ts),
 *      the one scenario that recovers explicitly.
 *   6. A graph registered on chain whose cleartext no peer holds stays hash-only.
 *   7. A job created under a hash no peer could reveal is still found by that hash
 *      once a holder appears and the hash resolves (#2779).
 *
 * Every test runs correctly alone or after any other. The graphs are created once
 * in `beforeAll` (fixture.ts) and never change; each test arranges the edge state
 * it needs, and no (edge, graph) pair is used by two tests. Scenario arrangement and
 * its assertions stay together here; how to talk to a daemon (typed reads, polls,
 * recovery) is daemon.ts, which reads every reply through the validators of wire.ts.
 *
 * Run: see README.md ("Run"); one test alone with `-t "<part of its name>"`.
 *
 * Node 1 is a core and the author; nodes 5 and 6 are edges. The suite mutates only
 * the Context Graphs it creates itself (ISOLATION INVARIANT in
 * devnet/_bootstrap/harness.ts) and stops and restarts no node; test 7 leaves one
 * connection behind, from edge 5 to edge 6.
 *
 * Unit tests that need no devnet: wire.test.ts, daemon.test.ts, catchup-jobs.test.ts,
 * flows.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { detectDevnet, ensureAllIdentities, sleep, waitFor, type DevnetNode, type DevnetState } from '../_bootstrap/harness.js';
// The catch-up job vocabulary and its terminal-state check are the CLI's own
// (catchup-status.ts has only type imports, so this loads neither the agent nor the
// CLI runtime).
import { isTerminalCatchupJobState } from '../../packages/cli/src/catchup-status.js';
import { createDaemon, queuedJobId } from './daemon.js';
import { buildFixture, contextGraphStorage, keccak, type Fixture } from './fixture.js';
import { runLabeledFlows } from './flows.js';
import type { CatchupContextGraphIdentity, CatchupJobState } from './wire.js';

const NAME_PREDICATE = 'https://schema.org/name';
const STAMP = Date.now().toString(36);
const daemon = createDaemon();
const {
  catchupJob,
  catchupStatus,
  dial,
  dialTarget,
  connectedPeerIds,
  ensureConverged,
  expectByHashLookupResolved,
  expectLatestJobNamed,
  expectNoRowFor,
  findLatestJob,
  forceCatchup,
  listSubscriptions,
  recoverUntilContent,
  subjectContent,
  subscribeWhenAdmitted,
  tryRowCount,
  waitForAdoption,
  waitForContent,
  waitUntilChainSlotObserved,
} = daemon;

/** One edge of a scenario that treats two edges alike: how it subscribes, and what a failure calls it. */
interface EdgeScenario {
  readonly node: DevnetNode;
  readonly requestedId: string;
  readonly label: string;
}

// The devnet handles, found once in `beforeAll` and never reassigned.
let state: DevnetState;
let author: DevnetNode;
let edgeA: DevnetNode;
let edgeB: DevnetNode;
/** The graphs, created once in `beforeAll`. */
let fixture: Fixture;

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error('Live 6-node devnet not detected. Run ./scripts/devnet.sh start 6 first.');
  }
  state = detected;
  author = state.nodes[1]!;
  edgeA = state.nodes[5]!;
  edgeB = state.nodes[6]!;
  await ensureAllIdentities(state, 4);
  expect(author.identityId, 'core node1 must have a registered identity').toBeGreaterThan(0n);
}, 240_000);

describe('public Context Graph subscribed by on-chain name hash on devnet', () => {
  // FIXTURE: every graph the tests use, created once and never changed again.
  beforeAll(async () => {
    fixture = await buildFixture({ state, author, stamp: STAMP, artifactDir: import.meta.dirname }, daemon);
  }, 900_000);

  it('the real chain commits only keccak256 of each registered graph id, and the author holds what it published and shared', async () => {
    const storage = await contextGraphStorage(state);
    for (const graph of [fixture.vm, fixture.forced, fixture.swm]) {
      // The contract commits exactly the preimage's keccak: the property every
      // verifying edge relies on.
      const committed = String(await storage.getNameHash(BigInt(graph.onChainId))).toLowerCase();
      expect(committed, `on-chain name hash of ${graph.id}`).toBe(keccak(graph.id));
    }
    for (const [graph, view] of [
      [fixture.vm, 'verifiable-memory'],
      [fixture.forced, 'verifiable-memory'],
      [fixture.swm, 'shared-working-memory'],
    ] as const) {
      const content = await subjectContent(author, graph.id, graph.subject, view);
      expect(content.some((entry) => entry.includes(graph.value)), `author ${view} content of ${graph.id}`).toBe(true);
    }
  }, 300_000);

  it('an edge subscribed by name hash alone adopts the verified cleartext id and converges on the finalized VM data', async () => {
    const vmGraph = fixture.vm;
    // The edge knows nothing of the graph but what the chain says.
    await expectNoRowFor(edgeA, vmGraph);
    expect(await tryRowCount(edgeA, vmGraph.id, vmGraph.subject, NAME_PREDICATE, 'verifiable-memory')).toBe(0);

    await waitUntilChainSlotObserved(edgeA, vmGraph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeA, vmGraph.nameHash);
    // The route reports the id it subscribed: the cleartext one when a peer
    // revealed it within the request, else the hash (which the resolver then
    // promotes in the background).
    expect([vmGraph.id, vmGraph.nameHash]).toContain(subscribed.subscribed);
    // eslint-disable-next-line no-console
    console.log(`hash-sub: subscribe by hash answered with subscribed=${subscribed.subscribed} identity=${JSON.stringify(subscribed.identity ?? null)}`);

    const row = await waitForAdoption(edgeA, vmGraph);
    expect(keccak(row.contextGraphId), 'the adopted id is the preimage of the on-chain hash').toBe(vmGraph.nameHash);
    expect(row.identity, 'a resolved row carries no name-hash-only note').toBeUndefined();

    // What the hash could never reach: the finalized VM copy, published before
    // the edge subscribed, byte-identical to the author's.
    const vmExpected = await subjectContent(author, vmGraph.id, vmGraph.subject, 'verifiable-memory');
    expect(vmExpected.some((entry) => entry.includes(vmGraph.value))).toBe(true);
    await waitForContent(edgeA, vmGraph.id, vmGraph.subject, 'verifiable-memory', vmExpected, 'name-hash subscribe');

    // The catch-up job the subscribe minted is still the latest one (the wait above
    // only reads, so nothing has replaced it) and is reachable by its id. Which names
    // find it depends on how it came about, so it is classified first (see
    // expectLatestJobNamed): made under the cleartext id, or continued under it, the
    // cleartext and on-chain ids name it; settled under the hash before the hash
    // resolved, only the hash does.
    const jobId = queuedJobId(subscribed);
    expect(jobId, JSON.stringify(subscribed)).toEqual(expect.any(String));
    if (subscribed.subscribed === vmGraph.id) {
      // The subscribe request resolved the hash itself (the usual case with a
      // connected holder), so its job is keyed by the cleartext id and a lookup by
      // the hash finds no job (404 "No catch-up job found"). The by-hash lookup
      // (#2779) therefore needs a job created under the hash, which depends on a
      // race the devnet cannot control here: test 7 arranges it and pins it. Say so
      // rather than pass silently.
      // eslint-disable-next-line no-console
      console.log(`hash-sub: the by-hash catch-up lookup was NOT exercised here: the subscribe resolved the hash within the request (subscribed=${subscribed.subscribed}), so its job is keyed by the cleartext id. Test 7 (late holder) pins it.`);
    } else {
      // The subscribe answered under the hash (no holder answered within the
      // request), so the job is keyed by the hash. It is the job the hash names
      // (#2779).
      await expectByHashLookupResolved(edgeA, vmGraph, jobId!, 'name-hash subscribe');
    }
    await expectLatestJobNamed(edgeA, vmGraph, jobId!, 'name-hash subscribe');
  }, 900_000);

  it('a second edge subscribed by numeric on-chain id lands on the same cleartext graph and converges on VM (#2758)', async () => {
    const vmGraph = fixture.vm;
    await expectNoRowFor(edgeB, vmGraph);
    await waitUntilChainSlotObserved(edgeB, vmGraph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeB, `#${vmGraph.onChainId}`);
    expect(subscribed.onChainReference, JSON.stringify(subscribed)).toMatchObject({ onChainId: vmGraph.onChainId });
    // The numeric id names the same slot; the row is never keyed by the number.
    await waitForAdoption(edgeB, vmGraph);
    expect((await listSubscriptions(edgeB)).map((row) => row.contextGraphId)).not.toContain(vmGraph.onChainId);

    const vmExpected = await subjectContent(author, vmGraph.id, vmGraph.subject, 'verifiable-memory');
    await waitForContent(edgeB, vmGraph.id, vmGraph.subject, 'verifiable-memory', vmExpected, 'numeric-id subscribe');
  }, 900_000);

  // The operator's recovery for a catch-up job that did not deliver: a forced
  // catch-up replaces the graph's latest job. The recovery step of the SWM
  // scenario below depends on that, so it is pinned here on its own, on a graph
  // that has already converged and so needs no fault to be injected. The graph is
  // this test's own (`fixture.forced`), converged here by the arrange step, so
  // the test neither needs nor disturbs the edges' state in the tests around it.
  it('a forced catch-up mints a replacement job that both aliases follow, keeps the superseded job readable, and leaves the content intact', async () => {
    const graph = fixture.forced;
    const arranged = await ensureConverged(edgeA, author, graph, graph.nameHash, 'arranging the converged edge');

    // The job the graph has before the forced catch-up. The arrange step's own job is
    // polled by its id: when the subscribe answered under the hash and its job settled
    // before the hash resolved, the cleartext id never names it, only the hash does.
    // When a subscribe made earlier left the row (no job id here), whichever job the
    // cleartext id or the hash names.
    const first = await waitFor(`node${edgeA.num} has a settled catch-up job for ${graph.id}`, 120_000, 3_000, async () => {
      const found = arranged.jobId === undefined
        ? await findLatestJob(edgeA, graph)
        : await catchupJob(edgeA, arranged.jobId, 'the arranged catch-up job by its id');
      return found !== null && isTerminalCatchupJobState(found.jobStatus) ? found : null;
    });
    await expectLatestJobNamed(edgeA, graph, first.jobId, 'before the forced catch-up');

    const forced = await forceCatchup(edgeA, graph.id);
    expect(forced.status, forced.detail).toBe(200);
    expect(forced.jobId, forced.detail).toEqual(expect.any(String));
    expect(forced.jobId, 'a settled graph gets a REPLACEMENT job, not the old one back').not.toBe(first.jobId);

    // Both aliases now name the replacement (made under the cleartext id, whatever
    // the first job was keyed by); the superseded job is still there by its id.
    const replacement = await expectLatestJobNamed(edgeA, graph, forced.jobId!, 'forced catch-up');
    expect(replacement, 'the forced job is made under the cleartext id').toMatchObject({ kind: 'continued', how: 'created-under-cleartext-id' });
    const superseded = await catchupJob(edgeA, first.jobId, 'the superseded job');
    expect(superseded.jobId).toBe(first.jobId);

    // The replacement runs to a verdict, and the content is exactly what it was.
    // The verdict itself is not what this test pins: this graph has no shared
    // working memory, so a catch-up that also asks for it can settle as
    // `unreachable` (the SWM plane stalls on empty answers) while the VM content
    // is intact, and the aliases follow that latest job all the same.
    const settled = await waitFor(`node${edgeA.num} replacement catch-up job settles`, 240_000, 3_000, async () => {
      const found = await catchupStatus(edgeA, graph.id);
      return found !== null && found.jobId === forced.jobId && isTerminalCatchupJobState(found.jobStatus) ? found : null;
    });
    // eslint-disable-next-line no-console
    console.log(`hash-sub: forced catch-up job ${settled.jobId} settled as ${settled.jobStatus}`);
    const vmExpected = await subjectContent(author, graph.id, graph.subject, 'verifiable-memory');
    await waitForContent(edgeA, graph.id, graph.subject, 'verifiable-memory', vmExpected, 'after the forced catch-up');
  }, 900_000);

  // Kept apart from the tests above on purpose, on a graph that was only shared.
  // Holders serve a graph's shared working memory only once their RFC-64
  // authority pipeline has accepted it (a finalized authority index polled every
  // few minutes), and that pipeline can lag or trip its RPC circuit for many
  // minutes after a devnet starts (`chain event log moved`, `RFC-64 authority
  // RPC circuit is open`). This is the one scenario that recovers explicitly.
  it('the SWM a holder shared before the edges subscribed backfills on both, subscribed by hash and by numeric id', async () => {
    const swmGraph = fixture.swm;
    const swmExpected = await subjectContent(author, swmGraph.id, swmGraph.subject, 'shared-working-memory');
    expect(swmExpected.some((entry) => entry.includes(swmGraph.value))).toBe(true);

    // Two scenarios from the start: the same flow, run for each edge side by side.
    // Nothing in one depends on the other, so a slow recovery on one edge does not
    // spend the other's budget.
    const scenarios: readonly EdgeScenario[] = [
      { node: edgeA, requestedId: swmGraph.nameHash, label: 'name-hash subscribe' },
      { node: edgeB, requestedId: `#${swmGraph.onChainId}`, label: 'numeric-id subscribe' },
    ];
    for (const { node } of scenarios) await expectNoRowFor(node, swmGraph);

    await runLabeledFlows(scenarios.map(({ node, requestedId, label }) => ({
      label,
      run: async () => {
        await waitUntilChainSlotObserved(node, swmGraph.onChainId);
        const subscribed = await subscribeWhenAdmitted(node, requestedId);
        await waitForAdoption(node, swmGraph);

        // The job the subscribe minted, checked before any recovery can replace
        // it. A subscribe that answered under the hash keyed its job by the hash, so
        // it is classified only once it has settled: the check of the latest job below
        // covers it.
        const firstJobId = queuedJobId(subscribed);
        expect(firstJobId, JSON.stringify(subscribed)).toEqual(expect.any(String));
        if (subscribed.subscribed === swmGraph.id) {
          await expectLatestJobNamed(node, swmGraph, firstJobId!, `${label} (first job)`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`hash-sub: ${label}: node${node.num}: the first job ${firstJobId} is keyed by the hash (subscribed=${subscribed.subscribed}): it is classified once it has settled, with the latest job.`);
        }

        // Recover explicitly, then assert what is true of whichever job is latest: the
        // forced job (made under the cleartext id) or, when content arrived without
        // one, the first job, which may have settled under the hash and never gained a
        // cleartext alias although the content converged.
        const latestJobId = await recoverUntilContent(
          node, swmGraph.id, swmGraph.subject, 'shared-working-memory', swmExpected, label,
          firstJobId!, 600_000,
        );
        await expectLatestJobNamed(node, swmGraph, latestJobId, `${label} (latest job)`);
      },
    })));
  }, 1_800_000);

  it('a graph registered on chain whose cleartext no peer holds stays hash-only: nothing is invented', async () => {
    const { nameHash, onChainId } = fixture.unheld;

    await waitUntilChainSlotObserved(edgeB, onChainId);
    const before = (await listSubscriptions(edgeB)).map((row) => row.contextGraphId);
    expect(before, `node${edgeB.num} must not yet be subscribed to the unheld graph`).not.toContain(nameHash);
    const subscribed = await subscribeWhenAdmitted(edgeB, nameHash);
    expect(subscribed.subscribed).toBe(nameHash);
    expect(subscribed.identity, JSON.stringify(subscribed)).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);

    // Give the resolver several rounds against every connected peer; it must
    // still find nothing, and must not have made up an id.
    await sleep(30_000);
    const after = await listSubscriptions(edgeB);
    const row = after.find((candidate) => candidate.contextGraphId === nameHash);
    expect(row, 'the hash-keyed row stays').toBeDefined();
    expect(row!.subscribed).toBe(true);
    expect(row!.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);
    const added = after.map((candidate) => candidate.contextGraphId).filter((id) => !before.includes(id));
    expect(added, 'no other row appeared for the unknown graph').toEqual([nameHash]);

    // Catch-up cannot succeed under a name nobody holds; it says so instead of asking for a retry.
    const status = await waitFor(`node${edgeB.num} catch-up settles for the hash-only graph`, 120_000, 3_000, async () => {
      const found = await catchupStatus(edgeB, nameHash);
      return found !== null && isTerminalCatchupJobState(found.jobStatus) ? found : null;
    });
    expect(status.jobStatus).toBe('unreachable' satisfies CatchupJobState);
    expect(status.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);
    // The verdict is the name-hash-only note, not the generic "no peer could deliver" one.
    expect(status.error).toBe(status.identity?.message);
    expect(status.error).toContain('on-chain name hash');
  }, 900_000);

  // Pins #2779 deterministically, where test 2 can only reach it by a race. Nothing
  // is stopped or restarted: the name is unknowable until this test reveals it, and
  // the holder is an edge that the subscriber is not connected to (or has already
  // asked, see below) until the test makes the subscriber ask it again. See README.md
  // (item 7) for the order and for what it does not reach.
  it('a job created under a name hash no peer could reveal is still found by that hash once a holder appears and the hash resolves (#2779)', async () => {
    const graph = fixture.late;
    await expectNoRowFor(edgeA, graph);
    await expectNoRowFor(edgeB, graph);
    // The devnet's edges dial only the cores, so on a devnet that has not run this
    // test yet, edge A has no connection to edge B. Nothing can undo the dial this
    // test makes (there is no disconnect), so a second run finds them connected; that
    // matters because edge A asks each peer once per hash and does not ask it again
    // for ten minutes unless asked explicitly. Decided here, once, from the state.
    const holder = await dialTarget(edgeB);
    const alreadyConnected = (await connectedPeerIds(edgeA)).includes(holder.peerId);

    // Subscribed by the hash while no peer holds the name: nothing to resolve it, so
    // the route reports the hash and keys the job by it.
    await waitUntilChainSlotObserved(edgeA, graph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeA, graph.nameHash);
    expect(subscribed.subscribed, JSON.stringify(subscribed)).toBe(graph.nameHash);
    expect(subscribed.identity, JSON.stringify(subscribed)).toMatchObject(
      { state: 'name-hash-only', nameHash: graph.nameHash, onChainId: graph.onChainId } satisfies Partial<CatchupContextGraphIdentity>,
    );
    const jobId = queuedJobId(subscribed);
    expect(jobId, JSON.stringify(subscribed)).toEqual(expect.any(String));

    // The job settles under the hash, as unreachable, and the hash finds it. Waiting
    // for that first fixes the order: the hash resolves AFTER the job settled.
    const settled = await waitFor(`node${edgeA.num} catch-up settles for the hash-keyed job`, 120_000, 3_000, async () => {
      const found = await catchupStatus(edgeA, graph.nameHash);
      return found !== null && isTerminalCatchupJobState(found.jobStatus) ? found : null;
    });
    expect(settled.jobId, 'the hash names the job the subscribe returned').toBe(jobId);
    expect(settled.jobStatus).toBe('unreachable' satisfies CatchupJobState);
    expect(settled.identity).toMatchObject(
      { state: 'name-hash-only', nameHash: graph.nameHash, onChainId: graph.onChainId } satisfies Partial<CatchupContextGraphIdentity>,
    );

    // A holder appears: a user who knows the name subscribes it on edge B, and that
    // node then answers the name protocol for the hash.
    await waitUntilChainSlotObserved(edgeB, graph.onChainId);
    const revealed = await subscribeWhenAdmitted(edgeB, graph.id);
    expect(revealed.subscribed, JSON.stringify(revealed)).toBe(graph.id);

    // Edge A now has to ask that peer.
    let successorJobId: string | undefined;
    if (!alreadyConnected) {
      // A new connection makes edge A's resolver ask the new peer at once, and the
      // hash resolves in the background, with no request from anyone.
      await dial(edgeA, edgeB);
    } else {
      // Edge A asked edge B when it subscribed (B knew nothing then), so it would not
      // ask again for ten minutes. An explicit request skips that: it is what a
      // repeated `dkg subscribe <hash>` is, and the route resolves the hash inside
      // the request. That subscribe mints its own job, keyed by the cleartext id;
      // the job under the hash is untouched, which is what is asserted below.
      // eslint-disable-next-line no-console
      console.log(`hash-sub: late holder: node${edgeA.num} is already connected to node${edgeB.num} (an earlier run dialed it), so it would not ask again for ten minutes; resolving through an explicit second subscribe instead of a new connection.`);
      const again = await subscribeWhenAdmitted(edgeA, graph.nameHash);
      expect(again.subscribed, `an explicit subscribe resolves the hash within the request: ${JSON.stringify(again)}`).toBe(graph.id);
      successorJobId = queuedJobId(again);
    }

    const row = await waitForAdoption(edgeA, graph);
    expect(row.identity, 'a resolved row carries no name-hash-only note').toBeUndefined();
    expect(keccak(row.contextGraphId), 'the adopted id is the preimage of the on-chain hash').toBe(graph.nameHash);

    // The job made under the hash is still the one the hash names, with the verdict
    // it settled with (adopting the name did not rewrite it), and now says whom the
    // hash resolved to.
    const byHash = await expectByHashLookupResolved(edgeA, graph, jobId!, 'late holder');
    expect(byHash.jobStatus, 'adopting the name does not rewrite the settled job').toBe(settled.jobStatus);
    // This arrangement fixes what the job is: it settled under the hash before the hash
    // resolved, so it never continued. With no second subscribe (a new connection) it is
    // the hash-keyed settled job: only the hash, and the on-chain id through it, name it
    // and the cleartext id names no job. With the second subscribe, that job under the
    // cleartext id has replaced it as the cleartext id's and the on-chain id's latest.
    const latest = await expectLatestJobNamed(edgeA, graph, jobId!, 'late holder');
    expect(latest.kind, 'the late-adopted job settled under the hash and never continued').toBe(successorJobId === undefined ? 'hash-keyed-settled' : 'replaced');
    if (successorJobId !== undefined) {
      // The second subscribe's job is the cleartext id's latest; it did not take the hash's job over.
      expect(successorJobId, 'the explicit subscribe minted its own job').not.toBe(jobId);
      expect((await catchupStatus(edgeA, graph.id))?.jobId, 'the cleartext id names the job of the second subscribe').toBe(successorJobId);
    }
  }, 900_000);
});
