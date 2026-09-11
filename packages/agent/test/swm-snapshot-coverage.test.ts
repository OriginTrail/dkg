import { describe, expect, it } from 'vitest';
import { type Quad } from '@origintrail-official/dkg-storage';
import { type SharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { collectPublicSnapshotMetadata, selectSwmSnapshotCoverage } from '../src/sync/requester/shared-memory-sync.js';
import type { SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import { ctx, quad } from './sync-requester-fixtures.js';
import {
  makeEntityShareSwmHarnessFixture,
  runManagedSwmSyncHarness,
} from './_helpers/swm-sync-harness.js';

describe('public SWM snapshot coverage (#2050)', () => {
  const COVERAGE_CG = 'coverage-swm';
  const META_GRAPH = `did:dkg:context-graph:${COVERAGE_CG}/_shared_memory_meta`;

  function snapshotMeta(subject: string, digest: string, count: number): Quad[] {
    return [
      {
        subject,
        predicate: 'http://dkg.io/ontology/publicQuadsDigest',
        object: `"${digest}"`,
        graph: META_GRAPH,
      } as Quad,
      {
        subject,
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: `"${count}"`,
        graph: META_GRAPH,
      } as Quad,
    ];
  }

  it('carries the round coverage onto the summary when the snapshot phase does not finish', async () => {
    const cachedQuads = [quad('cached-snapshot-row')];
    const cachedDigest = workspacePublicQuadsDigest(cachedQuads);
    const meta = [
      ...snapshotMeta('did:dkg:assertion:cached', cachedDigest, cachedQuads.length),
      ...snapshotMeta('did:dkg:assertion:unreachable', 'digest-never-served', 5),
    ];

    const { summary } = await runManagedSwmSyncHarness({
      ctx,
      remotePeerId: 'peer-coverage-abcd1234',
      contextGraphId: COVERAGE_CG,
      servedMeta: meta,
      cachedSnapshots: new Map([[cachedDigest, cachedQuads]]),
      materializer: false,
      fetchPage: async ({ phase }, fallback) => phase === 'snapshot'
        ? { ...fallback, completed: false, timedOut: true }
        : fallback,
    });

    // One cached snapshot resolved, one never served, and the manifest itself
    // paged cleanly — so the shortfall is real rather than an artefact of a
    // truncated denominator.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: 'abcd1234',
      snapshotsResolved: 0,
      snapshotsTotal: 2,
      manifestComplete: true,
      descriptorsAuthoritative: true,
      missingCount: 2,
      // The ref that was never served, named — not an empty placeholder. The
      // sample and the count come from the same walk, so they cannot disagree.
      missingSample: ['digest-never-served'],
      // Fetch shortfall only — every ref that DID arrive was written.
      materializationFailures: 0,
    });
  });

  it('counts a complete manifest ref with NO descriptor as resolved, so a fully synced peer stops being capable', async () => {
    // The defect behind this row is NON-TERMINATION, not a cosmetically wrong
    // number. `snapshotsTotal` counts refs in the PEER'S MANIFEST
    // (`collectPublicSnapshotMetadata` over the round's verified meta);
    // `snapshotsResolved` counts refs this node MATERIALIZED. A manifest ref
    // that the round's verified metadata does not DESCRIBE has no descriptor,
    // so it could never enter `materializedRefs` — and `snapshotsResolved <
    // snapshotsTotal` is exactly the predicate `capablePeersForNextPass`
    // (packages/cli/src/catchup-runner-worker-impl.ts) uses to decide a peer
    // still owes us Knowledge Assets. It therefore held FOREVER: every later
    // catch-up job spent its whole pass budget re-walking a Context Graph that
    // was already complete, at O(KA size) per cached ref, and no number of
    // passes could ever clear it.
    //
    // THE MANIFEST MUST BE MIXED, and that is the whole difficulty of this
    // fixture. `onSnapshotReady` USED TO BE wired only when
    // `snapshotDescriptorsByRef` was non-empty, so on the pre-fix tree a
    // manifest in which NO ref had a descriptor never called
    // `materializeReadySnapshot` at all: it would report `0/N` for a reason
    // that has nothing to do with the code under test, and would read green
    // both with the fix and without it. At least one described ref is what
    // opened the hook the undescribed ref then had to travel through — which is
    // why THIS row, and not an all-undescribed one, is the row that fails on
    // the pre-fix tree. The hook is now wired unconditionally, and the
    // all-undescribed manifest that guard hid — the entity-share shape, which
    // is most Context Graphs — is pinned by the entity-share scenario.
    //
    // The two halves are the real production shape rather than two invented
    // rows: ONE Knowledge Asset shared TWICE. `replaceHeadMetadata` is
    // head-subject scoped, so a peer that re-shares a KA keeps the SUPERSEDED
    // share-operation row in its metadata graph while its head names the
    // current operation. `parseGraphScopedSwmRecoveryDescriptors` only visits
    // operation subjects a head names, so the superseded row yields no
    // descriptor — while still carrying `publicQuadsDigest`/`publicQuadsCount`,
    // which is all `collectPublicSnapshotMetadata` needs to put it in the
    // manifest. That asymmetry between the two readers IS the bug.
    //
    // Only the CURRENT share's head rows are kept. Both versions share one head
    // subject (`<ual>#dkg-swm-head`), so including both would merge their rows
    // and `requirePositiveInteger(assertionVersion)` would throw; the surrounding
    // catch clears ALL descriptors and materialization is silently disabled for
    // the whole Context Graph — the fixture would stop testing rather than fail.
    //
    // Both halves come from ONE `swmFixtures(COVERAGE_CG)` call, so every
    // metadata-graph URI agrees with the Context Graph under sync by
    // construction instead of by a hand-matched constant.
    //
    // What this row does NOT pin: the `manifestComplete` half of the gate. A
    // truncated meta phase parses no descriptors at all, so "no descriptor"
    // there means "not known yet" and must NOT count — that boundary needs its
    // own row and is deliberately not smuggled into this one.
    const { share } = swmFixtures(COVERAGE_CG);
    const RESHARED_UAL = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/1';
    const superseded = share({
      version: 1, operationId: 'op-superseded', marker: 'superseded', ual: RESHARED_UAL, payloadCount: 2,
    });
    const current = share({
      version: 2, operationId: 'op-current', marker: 'current', ual: RESHARED_UAL, payloadCount: 3,
    });
    const meta = [
      ...current.meta,
      ...superseded.meta.filter((quadRow) => quadRow.subject === superseded.operationSubject),
    ];

    // Both snapshots already cached: this is the state of a node whose earlier
    // passes did the work. Distinct payload sizes give distinct digests, so the
    // manifest really carries two refs (as the coverage assertion records).
    const cached = new Map<string, Quad[]>([
      [current.digest, current.payload],
      [superseded.digest, superseded.payload],
    ]);
    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({
      ctx,
      remotePeerId: 'peer-resharing-5a5a5a5a',
      contextGraphId: COVERAGE_CG,
      servedMeta: meta,
      cachedSnapshots: cached,
    });

    // Fixture integrity first, so a broken fixture names itself instead of
    // surfacing as an unexplained count: both refs are pre-cached, so neither
    // may touch the transport. A digest that stopped matching would turn a
    // cache hit into a fetch and quietly change what the row measures.
    expect(snapshotFetches).toEqual([]);
    // The DESCRIBED half genuinely WROTE — which is what makes this manifest
    // mixed rather than two vacuous resolutions. If the described half ever
    // stopped materializing (a fixture the parser silently rejects, a
    // `replaceGraph` that no-ops, wiring that drops the materializer), the
    // coverage record could still read `2/2` by counting two undescribed refs
    // while nothing at all was written; the counters alone cannot see that.
    // `verifiedData` is empty here, so in-lock materialization is the only
    // possible source of data triples.
    expect(summary.insertedDataTriples).toBeGreaterThanOrEqual(current.payload.length);
    expect(summary.failedPhases).toBe(0);
    // Pre-fix this record was `1/2` with `missingCount: 1` — a peer that owed
    // this node nothing, reported as still owing it one Knowledge Asset, on
    // every pass forever. `snapshotsTotal: 2` doubles as the anti-vacuity
    // guard: if the two payloads ever collided on a digest, `byRef` would fold
    // them into a single ref and the manifest would stop being mixed while the
    // row went on passing.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: '5a5a5a5a',
      snapshotsResolved: 2,
      snapshotsTotal: 2,
      manifestComplete: true,
      descriptorsAuthoritative: true,
      missingCount: 0,
      missingSample: [],
      materializationFailures: 0,
    });
  });

  it('counts a complete manifest with NO descriptor on ANY ref as resolved, so an entity-share Context Graph stops nominating its peer', async () => {
    // The mixed-manifest scenario has to build one described and one
    // undescribed — because the old `snapshotDescriptorsByRef.size > 0` guard
    // wired `onSnapshotReady` only when SOMETHING was described. That guard hid
    // the larger case: a Context Graph in which NOTHING is described.
    //
    // That case is not a corner, it is the primary shared-memory write API.
    // `storeWorkspaceOperationPublicQuads` (packages/publisher/src/
    // workspace-resolution.ts) — the entity-level share — writes each root's
    // public slice under a `urn:dkg:public-stage:<cg>:<subGraph>:<op>:<root>`
    // subject carrying `dkg:publicQuadsDigest` + `dkg:publicQuadsCount`, and
    // writes NO `#dkg-swm-head` row at all; heads belong to the graph-scoped KA
    // path (`storeKnowledgeAssetOperationPublicQuads`). The two readers then
    // disagree about the very same metadata: `collectPublicSnapshotMetadata`
    // accepts ANY subject with digest+count, so the slice IS a manifest ref,
    // while `parseGraphScopedSwmRecoveryDescriptors` anchors ONLY on head
    // subjects, so it yields nothing. A Context Graph written entirely by
    // entity shares therefore advertises refs and produces zero descriptors —
    // for EVERY ref, not just one.
    //
    // Pre-fix such a graph could not reach `snapshotsResolved ===
    // snapshotsTotal` by ANY path: the hook was never wired, so
    // `materializeReadySnapshot` — and with it the vacuity branch the mixed-
    // manifest scenario pins — never ran. `snapshotsResolved < snapshotsTotal`
    // is exactly the predicate `capablePeersForNextPass` (packages/cli/src/
    // catchup-runner-worker-impl.ts) reads as "this peer still owes us
    // Knowledge Assets", so it nominated a peer that owed nothing on every pass
    // of every catch-up job, at O(KA size) per cached ref, for ever.
    //
    // BOTH writers are wired here, and that is the whole difference from
    // 'carries the round coverage onto the summary when the snapshot phase does
    // not finish', which asserts `0/2` with NO materializer. The two must
    // stay distinct: missing WIRING means nothing CAN be written, so those refs
    // are unresolved; no DESCRIPTOR under a COMPLETE manifest means there is
    // nothing to write, so these are resolved. Wiring the hook unconditionally
    // must not collapse that.
    //
    const SHARE_OP = 'op-entity-share-1';
    const ROOT = 'https://example.org/thing/1';
    // One root's public slice, as `filterQuadsForRoot` hands it to
    // `putSnapshot`. Digest and count are taken FROM this payload because
    // `hasValidSnapshot` re-checks both against the cached blob: a hand-written
    // count would turn a cache hit into a network fetch and quietly move the
    // row onto a different branch of the walk.
    const payload: Quad[] = [
      { subject: ROOT, predicate: 'https://schema.org/name', object: '"Thing One"', graph: '' } as Quad,
      { subject: ROOT, predicate: 'https://schema.org/color', object: '"blue"', graph: '' } as Quad,
    ];
    // The real publisher owns the slice subject, complete metadata schema,
    // snapshot digest/count, and metadata-graph placement. This fixture cannot
    // remain green if production entity-share metadata changes underneath it.
    const { digest, meta, sliceSubject } = await makeEntityShareSwmHarnessFixture({
      contextGraphId: COVERAGE_CG,
      shareOperationId: SHARE_OP,
      rootEntity: ROOT,
      payload,
      publisherPeerId: 'peer-source',
    });

    // Fixture integrity across BOTH readers, asserted before the sync so a
    // fixture that drifted names itself instead of surfacing as an unexplained
    // count. The manifest must really carry this one ref (or `snapshotsTotal:
    // 1` in the coverage assertion would be measuring something else), and
    // NOTHING may be described (or this scenario would silently become a
    // second copy of the mixed-manifest scenario, travelling the described
    // path it is meant to avoid).
    expect(meta.some((row) => row.subject === sliceSubject)).toBe(true);
    expect(collectPublicSnapshotMetadata(meta)).toEqual([{
      ref: digest,
      digest,
      count: payload.length,
      publishedAtMs: 0,
    }]);
    expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: COVERAGE_CG, metaQuads: meta })).toEqual([]);

    // The blob is already cached: the state of a node whose earlier pass
    // fetched it. Nothing here is missing — the peer owes this node nothing.
    const cached = new Map<string, Quad[]>([[digest, payload]]);
    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({
      ctx,
      remotePeerId: 'peer-entity-share-1a2b3c4d',
      contextGraphId: COVERAGE_CG,
      servedMeta: meta,
      cachedSnapshots: cached,
    });

    // Pre-cached, so the ref must not touch the transport; a digest that
    // stopped matching the payload would turn this into a fetch.
    expect(snapshotFetches).toEqual([]);
    expect(summary.failedPhases).toBe(0);
    // The vacuity witness, and what separates this scenario from the mixed-
    // manifest one, where the described half genuinely writes: here there is
    // nothing to write, so nothing IS written. The ref is resolved because a
    // complete manifest does not describe it — not because a materializer ran.
    expect(summary.insertedDataTriples).toBe(0);
    // Pre-fix: `0/1`, `missingCount: 1`, permanently — for a peer this node
    // was fully synced with, and for EVERY Context Graph written by entity
    // shares. `snapshotsResolved === snapshotsTotal` is what makes
    // `capablePeersForNextPass`'s `resolved < total` false and finally stops
    // the nomination.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: '1a2b3c4d',
      snapshotsResolved: 1,
      snapshotsTotal: 1,
      manifestComplete: true,
      descriptorsAuthoritative: true,
      missingCount: 0,
      missingSample: [],
      materializationFailures: 0,
    });
  });

  it('does NOT resolve a manifest ref when the descriptors failed to PARSE, so a round that wrote nothing cannot report full coverage', async () => {
    // THE THIRD STATE, and the one neither complete-manifest scenario can see.
    // Both reach the vacuity branch of `materializeReadySnapshot` with an EMPTY
    // descriptor map under a COMPLETE manifest, and both are right to count the
    // ref resolved: nothing was described because there was nothing to
    // describe. A parse FAILURE lands on the same branch with the same two
    // observables — and there "no descriptor" means the round never learned
    // what it was supposed to write.
    //
    // `manifestComplete` cannot discriminate, and that is the whole defect.
    // `parseGraphScopedSwmRecoveryDescriptors` is called inside a block whose
    // entry condition is `wsMetaResult.completed` — the same value that becomes
    // `manifestComplete` — so on the failure path it is guaranteed TRUE exactly
    // where the map is guaranteed empty for the wrong reason. With the hook now
    // wired unconditionally (the mixed-manifest scenario opened this path
    // to every ref), the consequences compounded: every manifest ref took the
    // vacuity branch, a round that wrote ZERO Knowledge Assets reported FULL
    // coverage, `materializationFailures` stayed 0 because nothing was ever
    // ATTEMPTED, `snapshotPhaseUsable` therefore read true, the bulk
    // `storeInsert(processed.verifiedMeta)` landed head rows certifying
    // assertion graphs that hold nothing, the peer was dropped as satisfied,
    // and the next round's `isGraphAssetMaterialized` sees those markers and
    // skips the Knowledge Assets for good. Every one of those is wrong in the
    // FLATTERING direction, which is the direction no downstream reader can
    // detect — the operator is told the graph is complete.
    //
    // THE POISON IS PRODUCTION-REACHABLE, which is why it is this shape and not
    // an invented malformed row. Two `dkg:assertionVersion` rows on one
    // `#dkg-swm-head` subject is union-insert residue: what a pass that
    // replaced a graph and stopped before the metadata swap leaves behind. This
    // branch's own materializer names and REPAIRS that state
    // (`storedHead.needsRepair`), so it demonstrably occurs — and any peer
    // still running the pre-repair code serves it to us verbatim. (A head at a
    // `contentScopeVersion` greater than `GRAPH_KA_CONTENT_SCOPE_VERSION`,
    // written by a newer node, is the other reachable trigger for the same catch and
    // produces these same numbers by the same path.)
    //
    // The residue sits on the SECOND Knowledge Asset deliberately. The first
    // one's rows are impeccable and it is STILL not written, because the parser
    // builds its whole array before returning: one malformed head discards the
    // descriptors of every valid KA alongside it. On the first KA the counters
    // would come out identical while pinning none of that.
    const { manifest, metaGraph } = swmFixtures(COVERAGE_CG);
    const [validKa, residueKa] = manifest(2);
    const meta: Quad[] = [
      ...validKa.meta,
      ...residueKa.meta,
      {
        subject: residueKa.headSubject,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      } as Quad,
    ];

    // Fixture integrity BY MESSAGE and before the sync, because every counter
    // in this scenario is `0` and a fixture that started throwing for an
    // unrelated reason (a meta-graph URI the parser refuses to visit, a drifted operation
    // subject) would reproduce all of them while testing nothing — the "a wrong
    // fixture stops testing rather than failing" trap `swm-descriptor-fixtures`
    // documents. Called the way production calls it: no `registeredSubGraphNames`,
    // since both Knowledge Assets are root-lane.
    expect(() => parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: COVERAGE_CG,
      metaQuads: meta,
    })).toThrow(/ambiguous assertionVersion/);
    // ...and the manifest really carries TWO refs, so `snapshotsTotal: 2` in
    // the coverage assertion is measuring what it claims. `manifest()` gives the two KAs different
    // payload sizes precisely so their digests cannot collide; a collision
    // would fold them into one ref and `snapshotsResolved: 0` would go on
    // passing against a one-ref manifest.
    expect(collectPublicSnapshotMetadata(meta).map((entry) => entry.ref).sort())
      .toEqual([validKa.digest, residueKa.digest].sort());

    // Both blobs already cached — the state of a node whose earlier passes
    // fetched them. Nothing here is missing from the TRANSPORT's point of view,
    // so the asserted shortfall can only come from the parse failure.
    const cached = new Map<string, Quad[]>([
      [validKa.digest, validKa.payload],
      [residueKa.digest, residueKa.payload],
    ]);
    // The real materializer over a real store, as the complete-manifest
    // scenarios use it — a hand-rolled stub that silently writes nothing would reproduce
    // `resolved: 0` for a NEW reason and look identical to a pass. Wrapped in
    // an explicitly delegating counter rather than a spread: `withKaWriteLock`
    // is the gate everything else runs behind, and a wrapper that broke it
    // would make "nothing was written" true for the wrong reason.
    const replacedGraphs: string[] = [];
    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({
      ctx,
      remotePeerId: 'peer-head-residue-7c7c7c7c',
      contextGraphId: COVERAGE_CG,
      servedMeta: meta,
      cachedSnapshots: cached,
      materializer: (real): SharedMemorySnapshotMaterializer => ({
        withKaWriteLock: (contextGraphId, subGraphName, kaUal, fn) => (
          real.withKaWriteLock(contextGraphId, subGraphName, kaUal, fn)
        ),
        readStoredHead: (descriptor) => real.readStoredHead(descriptor),
        isGraphAssetMaterialized: (descriptor) => real.isGraphAssetMaterialized(descriptor),
        replaceGraph: async (graphUri, quads) => {
          replacedGraphs.push(graphUri);
          await real.replaceGraph(graphUri, quads);
        },
        replaceHeadMetadata: (contextGraphId, descriptor) => (
          real.replaceHeadMetadata(contextGraphId, descriptor)
        ),
        selectRepairIdentity: (contextGraphId, descriptor) => (
          real.selectRepairIdentity(contextGraphId, descriptor)
        ),
        repairHeadPreservingIdentity: (contextGraphId, descriptor, winnerShareOperationId) => (
          real.repairHeadPreservingIdentity(contextGraphId, descriptor, winnerShareOperationId)
        ),
        preserveStoredIdentityForSkippedAsset: (contextGraphId, descriptor) => (
          real.preserveStoredIdentityForSkippedAsset(contextGraphId, descriptor)
        ),
        replaceMetaForGraphAssets: (assets) => real.replaceMetaForGraphAssets(assets),
      }),
    });

    // Both refs were served from cache, so the snapshot plane completed and
    // the transport is exonerated: a digest that stopped matching its payload
    // would turn a cache hit into a fetch and move this scenario onto the
    // fetch-shortfall branch that the first coverage scenario already owns.
    expect(snapshotFetches).toEqual([]);
    // THE ANTI-VACUITY WITNESS, and the reason this scenario cannot pass under
    // an implementation that writes everything correctly: not one assertion
    // graph was replaced. Without it, `snapshotsResolved: 0` alone would also
    // be satisfied by a materializer that ran and wrote all of them, and the
    // coverage number would have nothing to agree WITH.
    //
    // That the builder's descriptors are MATERIALIZABLE at all is the one
    // property this scenario cannot self-witness. It is pinned by
    // swm-snapshot-throw-progress.test.ts, which shares this builder and asserts
    // two Knowledge Assets written against a real store. An empty list here is
    // therefore attributable to the parse failure rather than to a fixture that
    // could never have written anything — the `/ambiguous assertionVersion/`
    // fixture-integrity guard constrains the parser, not the materializer.
    expect(replacedGraphs).toEqual([]);
    // Corroboration from the summary's own ledger: `verifiedData` is empty
    // here, so in-lock materialization is the only possible source of data
    // triples, and there were none.
    expect(summary.insertedDataTriples).toBe(0);
    // Pre-fix this record read `2/2` with `missingCount: 0` for a round that
    // wrote nothing at all. `manifestComplete: true` is the discriminator and
    // is pinned deliberately: if it ever came out `false`, these counts would
    // be right for the fetch-shortfall scenario's reason (a truncated meta
    // phase) and this scenario would silently stop testing the flag.
    // `missingSample` is empty because the sample is only populated on the
    // materialization-FAILURE path, and here nothing was ever attempted — a
    // known diagnostics residual, not a disagreement with `missingCount`.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: '7c7c7c7c',
      snapshotsResolved: 0,
      snapshotsTotal: 2,
      manifestComplete: true,
      descriptorsAuthoritative: false,
      missingCount: 2,
      missingSample: [],
      materializationFailures: 0,
    });
    // The second half of the flag, and an INDEPENDENT one: coverage is what
    // the continuation loop reads, `failedPhases` is what stops the round
    // being stamped as caught up. A parse failure produces no
    // `materializationFailures` — nothing was attempted — so
    // `snapshotPhaseUsable` needs `descriptorsAuthoritative` in its
    // conjunction or the phase reads usable on a round that wrote nothing.
    expect(summary.failedPhases).toBeGreaterThanOrEqual(1);
    // ...which is what withholds the CERTIFICATION, the durable half of the
    // harm: the bulk `storeInsert(processed.verifiedMeta)` is skipped by the
    // unusable-phase `continue`, so no head row landed claiming an assertion
    // graph that holds nothing. Had it landed, the next round's
    // `isGraphAssetMaterialized` would see the marker and skip these
    // Knowledge Assets permanently.
    expect(summary.insertedMetaTriples).toBe(0);
  });
});

/** Ranking operates on whole records: counts and missing samples must stay together. */
describe('SWM snapshot coverage selection', () => {
  const shortfall: SwmSnapshotCoverage = {
    contextGraphId: 'coverage-swm', peerIdSuffix: 'aaaa1111',
    snapshotsResolved: 178, snapshotsTotal: 250, manifestComplete: true,
    missingCount: 72, missingSample: ['did:dkg:ka:from-the-large-manifest'], materializationFailures: 0,
  };
  const smaller: SwmSnapshotCoverage = {
    ...shortfall, peerIdSuffix: 'bbbb2222', snapshotsResolved: 200, snapshotsTotal: 200,
    missingCount: 0, missingSample: [],
  };
  const tiny: SwmSnapshotCoverage = { ...smaller, peerIdSuffix: 'cccc3333', snapshotsResolved: 1, snapshotsTotal: 1 };
  const truncated: SwmSnapshotCoverage = {
    ...shortfall, peerIdSuffix: 'dddd4444', snapshotsResolved: 250, snapshotsTotal: 400,
    manifestComplete: false, missingCount: 150,
  };
  const authority: SwmSnapshotCoverage = {
    ...tiny, peerIdSuffix: '9999cccc', snapshotsResolved: 5, snapshotsTotal: 5, fromAuthority: true,
  };
  const behind: SwmSnapshotCoverage = { ...shortfall, peerIdSuffix: 'eeee5555', snapshotsResolved: 12, missingCount: 238 };
  const later: SwmSnapshotCoverage = { ...shortfall, peerIdSuffix: 'zzzz9999' };
  const cases: { name: string; a: SwmSnapshotCoverage | undefined; b: SwmSnapshotCoverage | undefined; expected: SwmSnapshotCoverage | undefined }[] = [
    { name: 'largest manifest over a better fraction', a: shortfall, b: smaller, expected: shortfall },
    { name: 'large partial manifest over a tiny complete one', a: shortfall, b: tiny, expected: shortfall },
    { name: 'authority evidence before manifest size', a: authority, b: shortfall, expected: authority },
    { name: 'complete manifest before a larger lower bound', a: shortfall, b: truncated, expected: shortfall },
    { name: 'most resolved within the same manifest size', a: shortfall, b: behind, expected: shortfall },
    { name: 'deterministic peer suffix on a tie', a: shortfall, b: later, expected: shortfall },
    { name: 'known record with an absent operand', a: shortfall, b: undefined, expected: shortfall },
    { name: 'both operands absent', a: undefined, b: undefined, expected: undefined },
  ];
  it.each(cases)('$name', ({ a, b, expected }) => {
    for (const [first, second] of [[a, b], [b, a]]) {
      // Identity pins the entire input record; synthesized counts cannot pass.
      expect(selectSwmSnapshotCoverage(first, second)).toBe(expected);
    }
  });

  it('is order-independent across the distinct peer suffixes in the original matrix', () => {
    const records = [shortfall, smaller, tiny, truncated];
    for (const a of records) {
      for (const b of records) {
        expect(selectSwmSnapshotCoverage(a, b)).toBe(selectSwmSnapshotCoverage(b, a));
      }
    }
  });
});
