import assert from 'node:assert/strict';
import test from 'node:test';

import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import {
  auditTestnetHealth,
  createIntegrityDataQuery,
  createIntegrityHeadQuery,
  createSeedManifestRow,
  createSeedSummary,
  createWorkloadPlan,
  publicQuadsDigestFromPayload,
  validateIntegrityDataResponse,
  validateIntegrityHeadResponse,
} from '../private-cg-recovery.mjs';

const publicQuads = [
  {
    subject: 'urn:test:asset',
    predicate: 'http://schema.org/name',
    object: '"second"',
    graph: 'did:dkg:context-graph:test',
  },
  {
    subject: 'urn:test:asset',
    predicate: 'http://schema.org/name',
    object: '"first"',
    graph: 'did:dkg:context-graph:test',
  },
];
const expectedDigest = workspacePublicQuadsDigest(publicQuads);
const manifest = {
  ordinal: 2,
  lane: 'subgraph',
  kaUal: 'did:dkg:base:8453/0xabc/1',
  assertionVersion: 1,
  assertionGraph: 'did:dkg:context-graph:test/_shared_memory/0xabc',
  shareOperationId: 'share-1',
  triplesExpected: 2,
  publicQuadsDigest: expectedDigest,
};

test('smoke workload is represented by the original root and subgraph rows', () => {
  const plan = createWorkloadPlan({
    profile: 'smoke',
    rootTriples: 3,
    subgraphTriples: 5,
    loadKaCount: 50,
    loadTriplesPerKa: 1000,
  });

  assert.deepEqual(plan.entries, [
    { ordinal: 1, lane: 'root', label: 'root', triples: 3 },
    { ordinal: 2, lane: 'subgraph', label: 'sub', triples: 5 },
  ]);
  assert.deepEqual(plan.planned, {
    kaCount: 2,
    triplesPerKa: null,
    rootKaCount: 1,
    subgraphKaCount: 1,
    rootTriples: 3,
    subgraphTriples: 5,
    totalTriples: 8,
  });
  assert.deepEqual(plan.timeoutDefaults, {
    recoverySeconds: 150,
    postRestartSeconds: 120,
    apiSeconds: 30,
  });
});

test('sync-load workload derives lanes, labels, and totals from the plan rows', () => {
  const plan = createWorkloadPlan({
    profile: 'sync-load',
    rootTriples: 3,
    subgraphTriples: 5,
    loadKaCount: 5,
    loadTriplesPerKa: 1000,
  });

  assert.deepEqual(plan.entries.map(({ ordinal, lane, label }) => ({ ordinal, lane, label })), [
    { ordinal: 1, lane: 'root', label: 'root-ka-001' },
    { ordinal: 2, lane: 'subgraph', label: 'subgraph-ka-002' },
    { ordinal: 3, lane: 'root', label: 'root-ka-003' },
    { ordinal: 4, lane: 'subgraph', label: 'subgraph-ka-004' },
    { ordinal: 5, lane: 'root', label: 'root-ka-005' },
  ]);
  assert.deepEqual(plan.planned, {
    kaCount: 5,
    triplesPerKa: 1000,
    rootKaCount: 3,
    subgraphKaCount: 2,
    rootTriples: 3000,
    subgraphTriples: 2000,
    totalTriples: 5000,
  });
  assert.deepEqual(plan.timeoutDefaults, {
    recoverySeconds: 1800,
    postRestartSeconds: 600,
    apiSeconds: 180,
  });
});

test('payload and integrity validation reuse the publisher digest implementation', () => {
  assert.equal(publicQuadsDigestFromPayload({ quads: publicQuads }), expectedDigest);

  const result = validateIntegrityDataResponse(manifest, {
    result: {
      bindings: publicQuads.map((quad) => ({
        s: { value: quad.subject },
        p: { value: quad.predicate },
        o: { value: quad.object },
      })),
    },
  });
  assert.deepEqual(result, { publicTripleCount: 2, publicQuadsDigest: expectedDigest });
  assert.throws(
    () => validateIntegrityDataResponse({ ...manifest, publicQuadsDigest: 'sha256:deadbeef' }, {
      bindings: publicQuads.map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object })),
    }),
    /assertion graph digest/,
  );
});

test('integrity query construction and head validation are explicit module inputs', () => {
  const headQuery = createIntegrityHeadQuery({
    contextGraphId: 'test',
    subGraphName: 'ai-tools',
    manifest,
  });
  assert.equal(headQuery.contextGraphId, 'test');
  assert.equal(headQuery.subGraphName, 'ai-tools');
  assert.match(headQuery.sparql, /did:dkg:context-graph:test\/ai-tools\/_shared_memory_meta/);
  assert.match(headQuery.sparql, /did:dkg:base:8453\/0xabc\/1/);

  const dataQuery = createIntegrityDataQuery({
    contextGraphId: 'test',
    subGraphName: 'ai-tools',
    manifest,
  });
  assert.equal(dataQuery.includeContextGraphPartitions, true);
  assert.match(dataQuery.sparql, /did:dkg:context-graph:test\/_shared_memory\/0xabc/);

  const head = validateIntegrityHeadResponse(manifest, {
    bindings: [{
      scopeVersion: { value: '2' },
      kaUal: { value: manifest.kaUal },
      assertionVersion: { value: '1' },
      assertionGraph: { value: manifest.assertionGraph },
      shareOperationId: { value: manifest.shareOperationId },
      digest: { value: manifest.publicQuadsDigest },
      publicCount: { value: '2' },
      privateCount: { value: '0' },
    }],
  });
  assert.equal(head.publicQuadsDigest, expectedDigest);
});

test('manifest and seed summary shaping preserve the harness artifact contracts', () => {
  const row = createSeedManifestRow({
    ordinal: 1,
    lane: 'root',
    label: 'root',
    triples: 2,
    payloadBytes: 123,
    durationMs: 45,
    expectedDigest,
    descriptor: {
      reservedUal: manifest.kaUal,
      assertionGraph: manifest.assertionGraph,
      currentShareOperationId: 'fallback-share',
      swmCurrentAssertion: 'fallback-root',
    },
    writeResponse: {
      names: ['asset-1'],
      triplesWritten: 2,
      responses: [{
        shareOperationId: 'share-1',
        merkleRoot: 'root-1',
        swmShared: true,
        publishReady: true,
        promotedCount: 2,
      }],
    },
  });
  assert.equal(row.kaUal, manifest.kaUal);
  assert.equal(row.shareOperationId, 'share-1');
  assert.equal(row.responses[0].promotedCount, 2);

  const plan = createWorkloadPlan({
    profile: 'smoke',
    rootTriples: 3,
    subgraphTriples: 5,
    loadKaCount: 50,
    loadTriplesPerKa: 1000,
  });
  const summary = createSeedSummary(plan, {
    kaCount: 2,
    rootKaCount: 1,
    subgraphKaCount: 1,
    totalTriples: 8,
    totalPayloadBytes: 500,
    maxKaPayloadBytes: 300,
    durationMs: 100,
  });
  assert.equal(summary.completed, true);
  assert.deepEqual(summary.planned, plan.planned);
});

test('health audit reports sustained saturation and allows one planned restart', () => {
  const baseline = {
    node: 5,
    mainPid: 10,
    nRestarts: 0,
    oxigraphPid: 20,
    oomEvents: 0,
    oomKillEvents: 0,
    oxigraphOomEvents: 0,
    oxigraphOomKillEvents: 0,
  };
  const sample = (phase, overrides = {}) => ({
    node: 5,
    phase,
    mainPid: 11,
    nRestarts: 0,
    oxigraphPid: 21,
    oxigraphWatchdogPid: 22,
    acceptQueue: 0,
    cpuCount: 4,
    loadOne: 1,
    hostMemoryUsedPercent: 50,
    oomEvents: 0,
    oomKillEvents: 0,
    oxigraphOomEvents: 0,
    oxigraphOomKillEvents: 0,
    ...overrides,
  });
  const thresholds = {
    maxAcceptQueue: 128,
    maxHostMemoryUsedPercent: 90,
    maxLoadPerCpuPercent: 200,
    consecutiveSamples: 2,
  };

  const passing = auditTestnetHealth({
    baselines: [baseline],
    samples: [sample('restart'), sample('ready')],
    thresholds,
    restartNodes: [5],
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.nodes[5].daemonPidChanges, 1);

  const saturated = auditTestnetHealth({
    baselines: [baseline],
    samples: [sample('hot-1', { acceptQueue: 129 }), sample('hot-2', { acceptQueue: 129 })],
    thresholds,
    restartNodes: [5],
  });
  assert.equal(saturated.passed, false);
  assert.match(saturated.failures.join('\n'), /sustained saturation for 2 samples/);
});
