import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  Logger,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { verifySyncedData as verifyUtils } from '../src/dkg-agent-utils.js';
import {
  processDurableBatchForWire,
  verifySyncedData as verifyWorker,
} from '../src/sync-verify-worker-impl.js';
import { planPageApply } from '../src/sync/requester/changelog-sync.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const CONTEXT_GRAPH = 'sync-verify-rootless';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META = `${CONTEXT_GRAPH_URI}/_meta`;
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/19';
const UAL_B = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000cd/23';
const LEGACY_UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/29';
const ctx: OperationContext = { operationId: 'rootless-test', operationName: 'sync' };
const log = new Logger('sync-verify-rootless.test');

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function verifyBoth(dataQuads: Quad[], metaQuads: Quad[], acceptUnverified = false) {
  const main = verifyUtils(dataQuads, metaQuads, ctx, log, acceptUnverified);
  const worker = verifyWorker(dataQuads, metaQuads, acceptUnverified);
  expect(worker.rejected).toBe(main.rejected);
  expect(worker.data).toEqual(main.data);
  expect(worker.meta).toEqual(main.meta);
  return { ...main, logs: worker.logs };
}

function fixture(options: {
  payload?: Quad[];
  publicTripleCount?: number;
  merkleRoot?: Uint8Array;
  privateTripleCount?: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph?: string;
  assertionVersion?: string;
  subGraphName?: string;
  ual?: string;
} = {}) {
  const ual = options.ual ?? UAL;
  const assertionVersion = options.assertionVersion ?? '1';
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  const assertionGraph = options.assertionGraph ?? knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH,
    MemoryLayer.VerifiableMemory,
    scope,
    options.subGraphName,
  );
  const payload = options.payload ?? [
    quad('urn:rootless:alpha', 'urn:p:name', '"Alpha"', assertionGraph),
    quad('urn:disconnected:beta', 'urn:p:name', '"Beta"', assertionGraph),
    quad('urn:disconnected:gamma', 'urn:p:value', '"Gamma"', assertionGraph),
  ];
  const privateRoots = options.privateMerkleRoot ? [options.privateMerkleRoot] : [];
  const merkleRoot = options.merkleRoot ?? computeFlatKCRootV10(payload, privateRoots);
  const meta = generateGraphKnowledgeAssetMetadata(
    {
      ual,
      contextGraphId: CONTEXT_GRAPH,
      merkleRoot,
      publisherPeerId: 'publisher-peer',
      accessPolicy: options.privateTripleCount ? 'ownerOnly' : 'public',
      timestamp: new Date(0),
      assertionVersion,
      publicTripleCount: options.publicTripleCount ?? payload.length,
      privateTripleCount: options.privateTripleCount ?? 0,
      privateMerkleRoot: options.privateMerkleRoot,
      assertionGraph,
      subGraphName: options.subGraphName,
    },
    'tentative',
  );
  return { payload, meta, assertionGraph, ual };
}

describe('verifySyncedData — rootless graph scope', () => {
  it('verifies the complete exact graph with disconnected subjects and no root metadata', () => {
    const { payload, meta, assertionGraph } = fixture();

    const result = verifyBoth(payload, meta);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual(payload);
    expect(result.meta).toEqual(meta);
    expect(result.data.every((entry) => entry.graph === assertionGraph)).toBe(true);
    expect(meta.some((entry) => entry.predicate === `${DKG}rootEntity`)).toBe(false);
  });

  it('fails the whole mixed batch on an exact-graph Merkle mismatch', () => {
    const { payload, meta, assertionGraph } = fixture({
      merkleRoot: new Uint8Array(32).fill(9),
    });
    const unrelatedData = quad('urn:system:unrelated', 'urn:p', '"keep"', CONTEXT_GRAPH_URI);
    const unrelatedMeta = quad('urn:system:meta', 'urn:p', '"keep"', META);

    const result = verifyBoth(
      [...payload, unrelatedData],
      [...meta, unrelatedMeta],
    );

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.data.some((entry) => entry.graph === assertionGraph)).toBe(false);
    expect(result.meta).toEqual([]);
  });

  it('fails closed when a valid V2 batch contains unbound normal-CG data', () => {
    const generated = fixture();
    const unbound = quad(
      'urn:unbound:subject',
      'urn:p',
      '"must-not-pass"',
      `${CONTEXT_GRAPH_URI}/attacker`,
    );

    const result = verifyBoth([...generated.payload, unbound], generated.meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('not bound to a verified KA'))).toBe(true);
  });

  it('preserves the explicit system-graph override for otherwise-unbound data', () => {
    const generated = fixture();
    const unbound = quad('urn:system:extra', 'urn:p', '"accepted"', CONTEXT_GRAPH_URI);

    const result = verifyBoth([...generated.payload, unbound], generated.meta, true);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual([...generated.payload, unbound]);
    expect(result.meta).toEqual(generated.meta);
  });

  it('fails the whole batch when the exact graph is incomplete', () => {
    const { payload, meta } = fixture({ publicTripleCount: 4 });
    const unrelated = quad('urn:unowned', 'urn:p', '"must-not-slip-through"', CONTEXT_GRAPH_URI);

    const result = verifyBoth([...payload, unrelated], meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('public triple count mismatch'))).toBe(true);
  });

  it('fails closed when metadata points away from the UAL-derived VM graph', () => {
    const attackerGraph = `${CONTEXT_GRAPH_URI}/_verifiable_memory/attacker/19`;
    const { payload, meta } = fixture({ assertionGraph: attackerGraph });

    const result = verifyBoth(payload, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('assertionGraph mismatch'))).toBe(true);
  });

  it('binds one private commitment into the structured root without syncing private triples', () => {
    const privateRoot = new Uint8Array(32).fill(7);
    const { payload, meta } = fixture({
      privateTripleCount: 2,
      privateMerkleRoot: privateRoot,
    });

    const result = verifyBoth(payload, meta);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual(payload);
  });

  it('accepts a fully-private KA without a synthetic public anchor or meta-only retry loop', () => {
    const privateRoot = new Uint8Array(32).fill(8);
    const { meta } = fixture({
      payload: [],
      publicTripleCount: 0,
      privateTripleCount: 3,
      privateMerkleRoot: privateRoot,
    });

    const result = verifyBoth([], meta);
    const processed = processDurableBatchForWire([], meta, false);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual(meta);
    expect(processed.rejectedKcs).toBe(0);
    expect(processed.metaOnlyResponses).toBe(0);
    expect(processed.verifiedDataIndexes).toEqual([]);
    expect(processed.verifiedMetaIndexes).toEqual(meta.map((_, index) => index));
    expect(processed.verifiedPrivateOnlyResponses).toBe(1);
  });

  it('rejects a private count whose required commitment is missing', () => {
    const privateRoot = new Uint8Array(32).fill(7);
    const generated = fixture({
      privateTripleCount: 2,
      privateMerkleRoot: privateRoot,
    });
    const meta = generated.meta.filter((entry) => entry.predicate !== `${DKG}privateMerkleRoot`);

    const result = verifyBoth(generated.payload, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
  });

  it('rejects data accompanied only by a version-1 scope marker', () => {
    const data = [quad(
      'urn:unbound:legacy-marker',
      'urn:p',
      '"must-not-pass"',
      CONTEXT_GRAPH_URI,
    )];
    const meta = [quad(
      UAL,
      `${DKG}contentScopeVersion`,
      `"1"^^<${XSD_INTEGER}>`,
      META,
    )];

    const result = verifyBoth(data, meta);

    expect(result.rejected).toBeGreaterThan(0);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('missing merkleRoot metadata'))).toBe(true);
  });

  it('rejects graph-scoped metadata outside the context graph meta partition', () => {
    const generated = fixture();
    const poisonedMeta = generated.meta.map((entry) => ({
      ...entry,
      graph: 'urn:attacker:metadata',
    }));

    const result = verifyBoth(generated.payload, poisonedMeta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
  });

  it('rejects legacy root bindings attached to a V2 KA', () => {
    const generated = fixture();
    const meta = [
      ...generated.meta,
      quad(UAL, `${DKG}rootEntity`, 'urn:legacy:must-not-bind-v2', META),
    ];

    const result = verifyBoth(generated.payload, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('legacy root bindings'))).toBe(true);
  });

  it('rejects token-level legacy ownership bindings that point to a V2 KA', () => {
    const generated = fixture();
    const tokenSubject = `${UAL}/1`;
    const meta = [
      ...generated.meta,
      quad(tokenSubject, `${DKG}partOf`, UAL, META),
      quad(tokenSubject, `${DKG}rootEntity`, 'urn:legacy:token-root', META),
    ];

    const result = verifyBoth(generated.payload, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('token-level legacy ownership binding'))).toBe(true);
  });

  it('bridges a verified V2 changelog graph but defers unsafe shared metadata replacement', () => {
    const changed = fixture({ ual: UAL_B });
    const meta = changed.meta;

    const processed = processDurableBatchForWire(
      changed.payload,
      meta,
      false,
      {
        kind: 'changelogPage',
        changedDataGraphs: [changed.assertionGraph],
      },
    );

    expect(processed.rejectedKcs).toBe(0);
    expect(processed.verifiedDataIndexes).toEqual(changed.payload.map((_, index) => index));
    expect(processed.verifiedMetaIndexes).toEqual(meta.map((_, index) => index));
    expect(processed.verifiedGraphScopedDataGraphs).toEqual([changed.assertionGraph]);

    const verifiedByGraph = new Map<string, Quad[]>();
    for (const q of [
      ...processed.verifiedDataIndexes.map((index) => changed.payload[index]!),
      ...processed.verifiedMetaIndexes.map((index) => meta[index]!),
    ]) {
      const rows = verifiedByGraph.get(q.graph);
      if (rows) rows.push(q);
      else verifiedByGraph.set(q.graph, [q]);
    }
    const plan = planPageApply({
      records: [
        { seq: 2, graph: changed.assertionGraph, op: 'upsert', quads: 'changed' },
        { seq: 3, graph: META, op: 'upsert', quads: 'metadata' },
      ],
      nextSeq: 3,
      priorSeq: 1,
      isForeignGraph: () => false,
      verifiedByGraph,
      recordQuadCountByGraph: new Map([
        [changed.assertionGraph, changed.payload.length],
        [META, meta.length],
      ]),
      metaGraphsWithRoot: new Set([META]),
      verifiedGraphScopedDataGraphs: new Set(processed.verifiedGraphScopedDataGraphs),
      batchVerifiedCleanly: true,
    });

    expect(plan).toMatchObject({ deferred: true, advanceTo: 1, applied: 0 });
    expect(plan.ops).toEqual([]);
  });

  it('defers a shared metadata replacement containing unverified rows for an unchanged KA', () => {
    const unchanged = fixture();
    const changed = fixture({ ual: UAL_B });
    const poisonedUnchangedMeta = unchanged.meta.map((entry) => (
      entry.predicate === `${DKG}accessPolicy`
        ? { ...entry, object: '"attackerOnly"' }
        : entry
    ));
    const meta = [...poisonedUnchangedMeta, ...changed.meta];

    const processed = processDurableBatchForWire(
      changed.payload,
      meta,
      false,
      {
        kind: 'changelogPage',
        changedDataGraphs: [changed.assertionGraph],
      },
    );

    expect(processed.rejectedKcs).toBe(0);
    expect(processed.verifiedDataIndexes).toEqual(changed.payload.map((_, index) => index));
    expect(processed.verifiedMetaIndexes).toEqual(
      changed.meta.map((_, index) => poisonedUnchangedMeta.length + index),
    );

    const verifiedByGraph = new Map<string, Quad[]>();
    for (const quadIndex of processed.verifiedDataIndexes) {
      const entry = changed.payload[quadIndex]!;
      const rows = verifiedByGraph.get(entry.graph);
      if (rows) rows.push(entry); else verifiedByGraph.set(entry.graph, [entry]);
    }
    for (const quadIndex of processed.verifiedMetaIndexes) {
      const entry = meta[quadIndex]!;
      const rows = verifiedByGraph.get(entry.graph);
      if (rows) rows.push(entry); else verifiedByGraph.set(entry.graph, [entry]);
    }

    const plan = planPageApply({
      records: [
        { seq: 2, graph: changed.assertionGraph, op: 'upsert', quads: 'changed' },
        { seq: 3, graph: META, op: 'upsert', quads: 'metadata' },
      ],
      nextSeq: 3,
      priorSeq: 1,
      isForeignGraph: () => false,
      verifiedByGraph,
      recordQuadCountByGraph: new Map([
        [changed.assertionGraph, changed.payload.length],
        [META, meta.length],
      ]),
      metaGraphsWithRoot: new Set([META]),
      verifiedGraphScopedDataGraphs: new Set(processed.verifiedGraphScopedDataGraphs),
      batchVerifiedCleanly: true,
    });

    expect(plan).toMatchObject({ deferred: true, advanceTo: 1, applied: 0 });
    expect(plan.ops).toEqual([]);
  });

  it('keeps full durable snapshots strict when a multi-KA graph is absent', () => {
    const missing = fixture();
    const present = fixture({ ual: UAL_B });
    const meta = [...missing.meta, ...present.meta];

    const processed = processDurableBatchForWire(present.payload, meta, false);

    expect(processed.rejectedKcs).toBe(1);
    expect(processed.verifiedDataIndexes).toEqual([]);
    expect(processed.verifiedMetaIndexes).toEqual([]);
  });

  it('scopes a V2 changelog delta past unchanged legacy metadata while full sync stays strict', () => {
    const legacyRoot = 'urn:legacy:mixed-page-root';
    const legacyPayload = [
      quad(legacyRoot, 'urn:p:name', '"Legacy"', CONTEXT_GRAPH_URI),
    ];
    const legacyMeta = [
      quad(
        LEGACY_UAL,
        `${DKG}merkleRoot`,
        `"${toHex(computeFlatKCRootV10(legacyPayload, []))}"`,
        META,
      ),
      quad(LEGACY_UAL, `${DKG}rootEntity`, legacyRoot, META),
    ];
    const changed = fixture({ ual: UAL_B });
    const meta = [...legacyMeta, ...changed.meta];

    const page = processDurableBatchForWire(
      changed.payload,
      meta,
      false,
      {
        kind: 'changelogPage',
        changedDataGraphs: [changed.assertionGraph],
      },
    );

    expect(page.rejectedKcs).toBe(0);
    expect(page.verifiedDataIndexes).toEqual(changed.payload.map((_, index) => index));
    expect(page.verifiedMetaIndexes).toEqual(
      changed.meta.map((_, index) => legacyMeta.length + index),
    );
    expect(page.verifiedGraphScopedDataGraphs).toEqual([changed.assertionGraph]);

    const fullSnapshot = processDurableBatchForWire(changed.payload, meta, false);
    expect(fullSnapshot.rejectedKcs).toBe(1);
  });

  it('rejects even non-scope UAL metadata placed outside the CG meta graph', () => {
    const generated = fixture();
    const meta = generated.meta.map((entry) => (
      entry.predicate === `${DKG}status`
        ? { ...entry, graph: `${CONTEXT_GRAPH_URI}/attacker` }
        : entry
    ));

    const result = verifyBoth(generated.payload, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
  });

  it('does not hide an unsupported V2 marker behind legacy root metadata', () => {
    const root = 'urn:legacy:poison';
    const data = [quad(root, 'urn:p', '"must-not-pass"', CONTEXT_GRAPH_URI)];
    const meta = [
      quad(UAL, `${DKG}merkleRoot`, `"${'11'.repeat(32)}"`, META),
      quad(UAL, `${DKG}contentScopeVersion`, `"3"^^<${XSD_INTEGER}>`, META),
      quad(UAL, `${DKG}rootEntity`, root, META),
    ];

    const result = verifyBoth(data, meta);

    expect(result.rejected).toBe(1);
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual([]);
    expect(result.logs.some(({ message }) => message.includes('unsupported contentScopeVersion'))).toBe(true);
  });

  it('keeps the explicit system-graph override for malformed graph metadata', () => {
    const data = [quad('urn:system:data', 'urn:p', '"accepted"', CONTEXT_GRAPH_URI)];
    const meta = [
      quad(UAL, `${DKG}merkleRoot`, `"${'22'.repeat(32)}"`, META),
      quad(UAL, `${DKG}contentScopeVersion`, `"2"^^<${XSD_INTEGER}>`, META),
    ];

    const result = verifyBoth(data, meta, true);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual(data);
    expect(result.meta).toEqual(meta);
  });

  it('uses the registered subgraph in the derived exact graph', () => {
    const { payload, meta, assertionGraph } = fixture({
      assertionVersion: '2',
      subGraphName: 'updates',
    });

    const result = verifyBoth(payload, meta);

    expect(result.rejected).toBe(0);
    expect(result.data).toEqual(payload);
    expect(assertionGraph).toContain('/updates/_verifiable_memory/');
  });

  it('pins the marker version used by the writer', () => {
    const { meta } = fixture();
    const scopeRows = meta.filter((entry) => entry.predicate === `${DKG}contentScopeVersion`);
    expect(scopeRows).toEqual([
      expect.objectContaining({
        subject: UAL,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
        graph: META,
      }),
    ]);
  });
});
