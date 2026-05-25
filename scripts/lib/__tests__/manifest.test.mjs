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
  buildInitialManifestTriples,
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
