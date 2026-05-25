/**
 * Unit tests for the pure helpers in `scripts/lib/manifest.mjs`.
 *
 * Daemon-roundtrip behaviour (createImportManifest / markPartitionStatus /
 * loadImportManifest) is covered by the smoke runs in
 * scripts/repro/wm-persistence-regression.mjs — those need a live DKG node
 * and live in the repro suite. This file only tests deterministic pieces.
 *
 * Run via:  node --test scripts/lib/__tests__/manifest.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_NS,
  IMPORT_T,
  IMPORT_P,
  importUri,
  partitionUri,
  statusEventUri,
  buildInitialManifestTriples,
  createImportManifest,
  markPartitionStatus,
  loadImportManifest,
  pendingPartitions,
} from '../manifest.mjs';

test('importUri encodes special characters', () => {
  assert.equal(importUri('my-corpus'), 'urn:dkg:import:my-corpus');
  assert.equal(importUri('with space'), 'urn:dkg:import:with%20space');
  assert.equal(importUri('a/b'), 'urn:dkg:import:a%2Fb');
});

test('partitionUri encodes both id and key', () => {
  assert.equal(
    partitionUri('my-corpus', 'src/foo.ts'),
    'urn:dkg:import:my-corpus#part:src%2Ffoo.ts',
  );
  assert.equal(
    partitionUri('a b', 'c d'),
    'urn:dkg:import:a%20b#part:c%20d',
  );
});

test('IMPORT_NS / IMPORT_T / IMPORT_P shape', () => {
  assert.equal(IMPORT_NS, 'https://ontology.dkg.io/import#');
  assert.equal(IMPORT_T.Import, 'https://ontology.dkg.io/import#Import');
  assert.equal(IMPORT_T.Partition, 'https://ontology.dkg.io/import#Partition');
  assert.equal(IMPORT_T.StatusEvent, 'https://ontology.dkg.io/import#StatusEvent');
  assert.equal(IMPORT_P.startedAt, 'https://ontology.dkg.io/import#startedAt');
  assert.equal(IMPORT_P.partition, 'https://ontology.dkg.io/import#partition');
  assert.equal(IMPORT_P.key, 'https://ontology.dkg.io/import#key');
  assert.equal(IMPORT_P.statusEvent, 'https://ontology.dkg.io/import#statusEvent');
});

test('buildInitialManifestTriples emits all expected predicates', () => {
  const triples = buildInitialManifestTriples(
    'my-corpus',
    ['a.ts', 'b.ts'],
    '2026-01-15T09:00:00.000Z',
  );
  const importIri = 'urn:dkg:import:my-corpus';

  // The import node itself: rdf:type + startedAt.
  const importTypeTriple = triples.find(
    (t) => t.subject === importIri && t.predicate.endsWith('#type'),
  );
  assert.ok(importTypeTriple, 'import node should have rdf:type');
  assert.equal(importTypeTriple.object, '<https://ontology.dkg.io/import#Import>');

  const startedAtTriple = triples.find(
    (t) => t.subject === importIri && t.predicate === IMPORT_P.startedAt,
  );
  assert.ok(startedAtTriple, 'import node should have startedAt');
  assert.match(startedAtTriple.object, /^"2026-01-15T09:00:00\.000Z"\^\^/);

  // Each partition should appear with at least key + initialStatus.
  for (const key of ['a.ts', 'b.ts']) {
    const partIri = partitionUri('my-corpus', key);
    const keyTriple = triples.find(
      (t) => t.subject === partIri && t.predicate === IMPORT_P.key,
    );
    assert.ok(keyTriple, `partition ${key} should have a key triple`);
    assert.equal(keyTriple.object, `"${key}"`);

    const statusTriple = triples.find(
      (t) => t.subject === partIri && t.predicate === IMPORT_P.initialStatus,
    );
    assert.ok(statusTriple, `partition ${key} should have initialStatus`);
    assert.equal(statusTriple.object, '"pending"');
  }
});

test('buildInitialManifestTriples is deterministic', () => {
  const t1 = buildInitialManifestTriples('id', ['a', 'b'], '2026-01-15T09:00:00.000Z');
  const t2 = buildInitialManifestTriples('id', ['a', 'b'], '2026-01-15T09:00:00.000Z');
  assert.deepEqual(t1, t2);
});

test('statusEventUri nests under partitionUri and is unique', () => {
  const a = statusEventUri('my-corpus', 'src/foo.ts');
  const b = statusEventUri('my-corpus', 'src/foo.ts');
  assert.match(a, /^urn:dkg:import:my-corpus#part:src%2Ffoo\.ts\/event\//);
  assert.notEqual(a, b, 'two events on the same partition should differ');
});

test('pendingPartitions filters out done', () => {
  const state = [
    { key: 'a', status: 'done' },
    { key: 'b', status: 'pending' },
    { key: 'c', status: 'in_progress' },
    { key: 'd', status: 'failed' },
    { key: 'e', status: 'done' },
  ];
  const pending = pendingPartitions(state);
  assert.equal(pending.length, 3);
  assert.deepEqual(pending.map((p) => p.key).sort(), ['b', 'c', 'd']);
});

// ---------------------------------------------------------------------------
// Integration-style tests with a mock DkgClient
//
// Codex's PR #642 review correctly noted that a regression in promote-root
// selection (e.g. omitting `partIri` from `markPartitionStatus.promote`)
// would never be caught by the pure-helper tests above. These tests model
// the WM/SWM split as two in-memory triple stores and verify that
// `loadImportManifest()` reading the SWM store sees the latest status —
// which it CAN'T unless `markPartitionStatus` promotes the partition root
// alongside the event root.
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for the daemon and `DkgClient`:
 *   - `wm` holds triples that are visible only to direct write callers.
 *   - `swm` holds triples that have been promoted (= visible to peers /
 *     resumes from another node).
 *   - `promote({entities})` moves all triples whose SUBJECT is in
 *     `entities` from wm to swm — exactly the daemon's contract.
 *   - `query()` runs against swm by default (the source-of-truth path
 *     for "what does another node see?") and returns Oxigraph-style
 *     flat-string bindings.
 *
 * `bindingShape` lets us also exercise the SPARQL 1.1 results-JSON
 * cell shape that the SPARQL-HTTP adapter returns.
 */
function makeMockClient({ bindingShape = 'flat' } = {}) {
  /** @type {Set<string>} */
  const wm = new Set();
  /** @type {Set<string>} */
  const swm = new Set();
  /** @type {string[]} */
  const calls = [];

  const tripleKey = (t) => `${t.subject}\u0001${t.predicate}\u0001${t.object}`;

  return {
    cgId: 'urn:test:cg',
    _state: { wm, swm, calls },
    async request(method, path) {
      calls.push(`${method} ${path}`);
      return { ok: true };
    },
    async writeAssertion({ triples }) {
      calls.push(`write:${triples.length}`);
      for (const t of triples) wm.add(tripleKey(t));
    },
    async promote({ entities }) {
      calls.push(`promote:${entities.length}`);
      for (const key of [...wm]) {
        const subject = key.split('\u0001')[0];
        if (entities.includes(subject)) {
          swm.add(key);
          wm.delete(key);
        }
      }
    },
    async query({ sparql }) {
      // We don't run a real SPARQL engine here — we pattern-match the
      // exact two shapes loadImportManifest sends and serve from `swm`.
      // That's enough to verify the promote-root semantics without
      // pulling oxigraph into this test file.
      const m = sparql.match(/<(urn:dkg:import:[^>]+)>\s+imp:partition\s+\?part/);
      if (!m) return { result: { bindings: [] } };
      const importIri = m[1];

      // Reconstruct per-partition state from the swm set.
      const triples = [...swm].map((k) => {
        const [subject, predicate, object] = k.split('\u0001');
        return { subject, predicate, object };
      });
      // Build the rows the query would produce.
      const partitionRoots = triples
        .filter((t) => t.subject === importIri && t.predicate === IMPORT_P.partition)
        .map((t) => t.object.replace(/^<|>$/g, ''));
      const rows = [];
      for (const part of partitionRoots) {
        const keyTriple = triples.find(
          (t) => t.subject === part && t.predicate === IMPORT_P.key,
        );
        const initialTriple = triples.find(
          (t) => t.subject === part && t.predicate === IMPORT_P.initialStatus,
        );
        if (!keyTriple || !initialTriple) continue;
        const eventEdges = triples.filter(
          (t) => t.subject === part && t.predicate === IMPORT_P.statusEvent,
        );
        let latest = null;
        for (const edge of eventEdges) {
          const ev = edge.object.replace(/^<|>$/g, '');
          const statusT = triples.find(
            (t) => t.subject === ev && t.predicate === IMPORT_P.status,
          );
          const recT = triples.find(
            (t) => t.subject === ev && t.predicate === IMPORT_P.recordedAt,
          );
          if (!statusT || !recT) continue;
          const rec = recT.object;
          if (!latest || rec > latest.rec) {
            latest = { status: statusT.object, rec };
          }
        }
        const wrap = (s) => (bindingShape === 'cell' ? { value: s, type: 'literal' } : s);
        rows.push({
          part: bindingShape === 'cell' ? { value: part, type: 'uri' } : part,
          key: wrap(keyTriple.object),
          initial: wrap(initialTriple.object),
          ...(latest
            ? { latestStatus: wrap(latest.status), latestRecordedAt: wrap(latest.rec) }
            : {}),
        });
      }
      return { result: { bindings: rows } };
    },
  };
}

test('full round-trip: create, mark done, promote, reload — flat bindings', async () => {
  const client = makeMockClient({ bindingShape: 'flat' });

  await createImportManifest({
    client,
    importId: 'corpus-2026-01-15',
    partitions: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
    subGraphName: 'meta',
  });

  // After create, all three partitions should be visible in SWM with
  // their `pending` initial status.
  let state = await loadImportManifest({
    client,
    importId: 'corpus-2026-01-15',
    subGraphName: 'meta',
  });
  assert.equal(state.partitions.length, 3, 'all partitions should be in SWM');
  assert.deepEqual(
    state.partitions.map((p) => p.status).sort(),
    ['pending', 'pending', 'pending'],
  );

  // Mark one partition done. THIS is the bug Codex flagged: if
  // markPartitionStatus only promoted the event root and not the
  // partition root, the `partIri imp:statusEvent evIri` triple would
  // stay in WM, and `loadImportManifest()` reading SWM would still
  // see this partition as "pending".
  await markPartitionStatus({
    client,
    importId: 'corpus-2026-01-15',
    partitionKey: 'src/bar.ts',
    status: 'done',
    subGraphName: 'meta',
  });

  state = await loadImportManifest({
    client,
    importId: 'corpus-2026-01-15',
    subGraphName: 'meta',
  });
  const byKey = Object.fromEntries(state.partitions.map((p) => [p.key, p]));
  assert.equal(byKey['src/bar.ts'].status, 'done', 'marked partition must read back as done from SWM');
  assert.equal(byKey['src/foo.ts'].status, 'pending');
  assert.equal(byKey['src/baz.ts'].status, 'pending');

  // pendingPartitions sugar should now exclude bar.ts.
  const remaining = pendingPartitions(state.partitions);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((p) => p.key !== 'src/bar.ts'));
});

test('round-trip works with SPARQL 1.1 results-JSON cell bindings too', async () => {
  // Same flow, but the mock returns `{value, type}` cells instead of
  // flat strings (mimics the SPARQL-HTTP adapter). loadImportManifest()
  // must collapse them via unquote()/bareUri() to a usable result.
  const client = makeMockClient({ bindingShape: 'cell' });

  await createImportManifest({
    client,
    importId: 'cell-corpus',
    partitions: ['a.ts', 'b.ts'],
    subGraphName: 'meta',
  });

  await markPartitionStatus({
    client,
    importId: 'cell-corpus',
    partitionKey: 'a.ts',
    status: 'done',
    subGraphName: 'meta',
  });

  const state = await loadImportManifest({
    client,
    importId: 'cell-corpus',
    subGraphName: 'meta',
  });
  const byKey = Object.fromEntries(state.partitions.map((p) => [p.key, p]));
  assert.equal(typeof byKey['a.ts'].status, 'string', 'status should be unwrapped to a plain string');
  assert.equal(byKey['a.ts'].status, 'done');
  assert.equal(byKey['b.ts'].status, 'pending');
  // URI binding (`?part`) should also be a plain string, not a cell object.
  assert.equal(typeof byKey['a.ts'].uri, 'string');
  assert.ok(byKey['a.ts'].uri.startsWith('urn:dkg:import:cell-corpus#part:'));
});

test('the latest status wins when a partition has multiple events', async () => {
  const client = makeMockClient();

  await createImportManifest({
    client,
    importId: 'multi-event',
    partitions: ['only.ts'],
    subGraphName: 'meta',
  });

  // Three events in order: in_progress → failed (transient) → done.
  // The SPARQL "max row" pattern in loadImportManifest must return
  // `done`, not the earlier statuses.
  await markPartitionStatus({
    client,
    importId: 'multi-event',
    partitionKey: 'only.ts',
    status: 'in_progress',
    subGraphName: 'meta',
  });
  // Tiny delay so the ISO timestamps differ.
  await new Promise((r) => setTimeout(r, 5));
  await markPartitionStatus({
    client,
    importId: 'multi-event',
    partitionKey: 'only.ts',
    status: 'failed',
    subGraphName: 'meta',
  });
  await new Promise((r) => setTimeout(r, 5));
  await markPartitionStatus({
    client,
    importId: 'multi-event',
    partitionKey: 'only.ts',
    status: 'done',
    subGraphName: 'meta',
  });

  const state = await loadImportManifest({
    client,
    importId: 'multi-event',
    subGraphName: 'meta',
  });
  assert.equal(state.partitions[0].status, 'done');
});
