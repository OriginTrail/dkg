/**
 * The SWM public-quads digest names a snapshot and is recomputed by every node
 * that reads it. Until every node writes the locale-independent (code-unit)
 * form, a node meets digests in more than one form for byte-identical quads:
 * its own default-collator digest, the code-unit digest, and the digest an
 * en-US node recorded. Every place that checks a peer-advertised or persisted
 * digest against the quads it has must accept any of them and still reject
 * content that differs.
 *
 * A digest form is simulated with `useAmbientCollation`; the digests come from
 * an independent oracle (`referenceDigest`), so these rows also fail on a base
 * commit that accepts only the verifier's own form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { materializeGraphScopedSwmRecoveryAsset, parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { verifyExactGraphContent } from '../src/exact-graph-content-verifier.js';
import { syncPublicSnapshotsForMeta } from '../src/sync/requester/shared-memory-sync.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { UNRESTRICTED_SYNC_WORK } from '../src/sync/work-admission.js';
import {
  CG,
  CTX as ctx,
  DKG,
  MemorySnapshotStore,
  WS_META,
  XSD_INTEGER,
  recoveryPage as page,
} from './_helpers/swm-recovery-fixture.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import {
  divergentObjectQuads,
  referenceDigest,
  useAmbientCollation,
} from '../../../scripts/testing/digest-locale.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type Form = 'en-US' | 'da-DK' | 'code-unit';

/**
 * [form the sender/recorder used, locale of the verifying node]. A da-DK
 * sender is only accepted by a da-DK verifier: another node's non-en-US legacy
 * collation is the documented residual until producers move to code-unit.
 */
const ACCEPTED: ReadonlyArray<readonly [Form, string | undefined]> = [
  ['en-US', undefined],
  ['en-US', 'da-DK'],
  ['da-DK', 'da-DK'],
  ['code-unit', undefined],
  ['code-unit', 'da-DK'],
];

const quads = divergentObjectQuads('urn:snapshot:divergent');
const label = ([form, locale]: readonly [Form, string | undefined]) =>
  `${form} digest verified on a ${locale ?? 'en-US'} node`;

describe('syncPublicSnapshotsForMeta accepts any digest form the sender advertised', () => {
  function metaFor(digest: string): Quad[] {
    const subject = 'urn:dkg:share:digest-form';
    return [
      { subject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
      { subject, predicate: `${DKG}publicQuadsCount`, object: `"${quads.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
    ];
  }

  it.each(ACCEPTED.map((row) => [label(row), ...row] as const))(
    'fetches and stores a snapshot: %s',
    async (_name, form, locale) => {
      const digest = referenceDigest(quads, form);
      const store = new MemorySnapshotStore();
      const restore = locale ? useAmbientCollation(locale) : undefined;
      try {
        const result = await syncPublicSnapshotsForMeta({
          ctx, remotePeerId: 'peer-source', contextGraphId: CG,
          deadline: Number.MAX_SAFE_INTEGER, workAdmission: UNRESTRICTED_SYNC_WORK,
          metaQuads: metaFor(digest),
          publicSnapshotStore: store,
          fetchSyncPages: async () => ({ ...page(quads), checkpointKey: `snapshot:${digest}` }),
          deleteCheckpoint: () => {}, setCheckpoint: () => {},
        });
        expect(result).toMatchObject({ completed: true, readySnapshots: 1, totalSnapshots: 1 });
      } finally {
        restore?.();
      }
      // Stored under the digest the sender advertised, so metadata and file agree.
      expect(store.snapshots.get(digest)).toHaveLength(quads.length);
    },
  );

  it.each(ACCEPTED.map((row) => [label(row), ...row] as const))(
    'skips the fetch for a cached snapshot: %s',
    async (_name, form, locale) => {
      const digest = referenceDigest(quads, form);
      const store = new MemorySnapshotStore();
      store.snapshots.set(digest, quads.map((quad) => ({ ...quad })));
      const fetchSyncPages = vi.fn(async () => page(quads));
      const restore = locale ? useAmbientCollation(locale) : undefined;
      try {
        const result = await syncPublicSnapshotsForMeta({
          ctx, remotePeerId: 'peer-source', contextGraphId: CG,
          deadline: Number.MAX_SAFE_INTEGER, workAdmission: UNRESTRICTED_SYNC_WORK,
          metaQuads: metaFor(digest),
          publicSnapshotStore: store,
          fetchSyncPages, deleteCheckpoint: () => {}, setCheckpoint: () => {},
        });
        expect(result).toMatchObject({ completed: true, readySnapshots: 1 });
      } finally {
        restore?.();
      }
      expect(fetchSyncPages).not.toHaveBeenCalled();
    },
  );

  it('still fails the whole round on content that matches no accepted form', async () => {
    const digest = referenceDigest(quads, 'en-US');
    const tampered = [...quads.slice(1), { ...quads[0]!, object: '"tampered"' }];
    const restore = useAmbientCollation('da-DK');
    try {
      await expect(syncPublicSnapshotsForMeta({
        ctx, remotePeerId: 'peer-source', contextGraphId: CG,
        deadline: Number.MAX_SAFE_INTEGER, workAdmission: UNRESTRICTED_SYNC_WORK,
        metaQuads: metaFor(digest),
        publicSnapshotStore: new MemorySnapshotStore(),
        fetchSyncPages: async () => ({ ...page(tampered), checkpointKey: `snapshot:${digest}` }),
        deleteCheckpoint: () => {}, setCheckpoint: () => {},
      })).rejects.toThrow(`expected ${digest}/${quads.length}, got ${referenceDigest(tampered, 'da-DK')}/${quads.length}`);
    } finally {
      restore();
    }
  });

  it('does not accept a cached snapshot whose bytes differ from every accepted form', async () => {
    const digest = referenceDigest(quads, 'code-unit');
    const store = new MemorySnapshotStore();
    store.snapshots.set(digest, [...quads.slice(1), { ...quads[0]!, object: '"tampered"' }]);
    const fetchSyncPages = vi.fn(async () => ({ ...page(quads), checkpointKey: `snapshot:${digest}` }));
    const result = await syncPublicSnapshotsForMeta({
      ctx, remotePeerId: 'peer-source', contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER, workAdmission: UNRESTRICTED_SYNC_WORK,
      metaQuads: metaFor(digest),
      publicSnapshotStore: store,
      fetchSyncPages, deleteCheckpoint: () => {}, setCheckpoint: () => {},
    });
    // The corrupt copy is not trusted: the snapshot is fetched again.
    expect(fetchSyncPages).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completed: true, readySnapshots: 1 });
  });
});

describe('graph-scoped SWM descriptors advertised in another digest form', () => {
  const MATERIALIZER_CG = 'ws00-digest-form-materializer';
  const UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/31';
  const fixtures = swmFixtures(MATERIALIZER_CG);
  const payload = divergentObjectQuads('urn:snap:divergent');

  /** A complete share whose recorded digest is `form`, over the divergent payload. */
  function share(form: Form, operationId = `op-${form}`) {
    const base = fixtures.share({
      version: 1, operationId, marker: 'divergent', ual: UAL, payloadCount: payload.length,
    });
    const digest = referenceDigest(payload, form);
    const meta = base.meta.map((row) => (
      row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef`
        ? { ...row, object: `"${digest}"` }
        : row
    ));
    return { ...base, payload, digest, meta };
  }

  function descriptorFor(fixture: ReturnType<typeof share>) {
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: MATERIALIZER_CG, metaQuads: fixture.meta,
    });
    if (!descriptor) throw new Error('fixture must parse to one descriptor');
    return descriptor;
  }

  function inGraph(rows: readonly Quad[], graph: string): Quad[] {
    return rows.map((row) => ({ ...row, graph }));
  }

  describe.each(ACCEPTED.map((row) => [label(row), ...row] as const))('%s', (_name, form, locale) => {
    it('recognises the stored graph as already materialized', async () => {
      const fixture = share(form);
      const store = new OxigraphStore();
      await store.insert(inGraph(fixture.payload, fixture.assertionGraph));
      const materializer = createSharedMemorySnapshotMaterializer({
        store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {},
      });
      const restore = locale ? useAmbientCollation(locale) : undefined;
      try {
        expect(await materializer.isGraphAssetMaterialized(descriptorFor(fixture))).toBe(true);
      } finally {
        restore?.();
      }
    });

    it('reads back the exact materialized graph', async () => {
      const fixture = share(form);
      const store = new OxigraphStore();
      await store.insert(inGraph(fixture.payload, fixture.assertionGraph));
      const materializer = createSharedMemorySnapshotMaterializer({
        store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {},
      });
      const restore = locale ? useAmbientCollation(locale) : undefined;
      try {
        const exact = await materializer.readExactMaterializedGraph(descriptorFor(fixture));
        expect(exact).toHaveLength(payload.length);
      } finally {
        restore?.();
      }
    });

    it('re-verifies the stored snapshot before stamping its SWM graph', async () => {
      const fixture = share(form);
      const store = new MemorySnapshotStore();
      store.snapshots.set(fixture.digest, payload.map((row) => ({ ...row })));
      const restore = locale ? useAmbientCollation(locale) : undefined;
      try {
        const asset = await materializeGraphScopedSwmRecoveryAsset({
          descriptor: descriptorFor(fixture), fetchedDataQuads: [], publicSnapshotStore: store,
        });
        expect(asset.quads).toHaveLength(payload.length);
        expect(asset.quads.every((row) => row.graph === fixture.assertionGraph)).toBe(true);
      } finally {
        restore?.();
      }
    });
  });

  it('does not treat a graph with other content as materialized, exact or intact', async () => {
    const fixture = share('en-US');
    const tampered = [...payload.slice(1), { ...payload[0]!, object: '"tampered"' }];
    const store = new OxigraphStore();
    await store.insert(inGraph(tampered, fixture.assertionGraph));
    const materializer = createSharedMemorySnapshotMaterializer({
      store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {},
    });
    const restore = useAmbientCollation('da-DK');
    try {
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(fixture))).toBe(false);
      expect(await materializer.readExactMaterializedGraph(descriptorFor(fixture))).toBeNull();
      const snapshots = new MemorySnapshotStore();
      snapshots.snapshots.set(fixture.digest, tampered);
      await expect(materializeGraphScopedSwmRecoveryAsset({
        descriptor: descriptorFor(fixture), fetchedDataQuads: [], publicSnapshotStore: snapshots,
      })).rejects.toThrow(/failed integrity/u);
    } finally {
      restore();
    }
  });
});

describe('verifyExactGraphContent with a head digest in another form', () => {
  const graphUri = 'urn:graph:digest-form-exact';
  const expectedMerkleRoot = computeFlatKCRootV10(quads.map((row) => ({ ...row, graph: '' })), []);

  async function verify(expectedPublicQuadsDigest: string | undefined, rows: readonly Quad[] = quads) {
    const store = new OxigraphStore();
    await store.insert(rows.map((row) => ({ ...row, graph: graphUri })));
    return verifyExactGraphContent(store, {
      graphUri,
      publicTripleCount: rows.length,
      expectedMerkleRoot: computeFlatKCRootV10(rows.map((row) => ({ ...row, graph: '' })), []),
      ...(expectedPublicQuadsDigest === undefined ? {} : { expectedPublicQuadsDigest }),
      source: 'test.digestForm',
    });
  }

  it.each(ACCEPTED.map((row) => [label(row), ...row] as const))('verifies: %s', async (_name, form, locale) => {
    const restore = locale ? useAmbientCollation(locale) : undefined;
    try {
      await expect(verify(referenceDigest(quads, form))).resolves.toMatchObject({ status: 'verified' });
    } finally {
      restore?.();
    }
  });

  it('verifies without a head digest and reports a mismatching one as a head mismatch', async () => {
    await expect(verify(undefined)).resolves.toMatchObject({ status: 'verified' });
    await expect(verify(`sha256:${'0'.repeat(64)}`)).resolves.toMatchObject({ status: 'head-mismatch' });
    expect(expectedMerkleRoot).toHaveLength(32);
  });
});
