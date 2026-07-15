import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_NS,
  IMPORT_T,
  IMPORT_P,
  importUri,
  partitionUri,
  loadImportManifest,
  pendingPartitions,
  defaultManifestAssertionName,
  partitionDeclared,
} from '../manifest.mjs';

test('importUri and partitionUri encode unsafe path characters', () => {
  assert.equal(importUri('with space/a'), 'urn:dkg:import:with%20space%2Fa');
  assert.equal(
    partitionUri('with space/a', 'src/foo bar.ts'),
    'urn:dkg:import:with%20space%2Fa#part:src%2Ffoo%20bar.ts',
  );
});

test('manifest ontology constants retain their public shape', () => {
  assert.equal(IMPORT_NS, 'https://ontology.dkg.io/import#');
  assert.equal(IMPORT_T.Import, 'https://ontology.dkg.io/import#Import');
  assert.equal(IMPORT_T.Partition, 'https://ontology.dkg.io/import#Partition');
  assert.equal(IMPORT_T.StatusEvent, 'https://ontology.dkg.io/import#StatusEvent');
  assert.equal(IMPORT_P.partition, 'https://ontology.dkg.io/import#partition');
  assert.equal(IMPORT_P.statusEvent, 'https://ontology.dkg.io/import#statusEvent');
});

test('defaultManifestAssertionName sanitizes unsafe and oversized import ids', () => {
  assert.equal(defaultManifestAssertionName('plain-id'), 'import-manifest-plain-id');
  assert.match(defaultManifestAssertionName('with/slash'), /^import-manifest-with-slash-[0-9a-f]{12}$/);
  assert.match(defaultManifestAssertionName('  trim me  '), /^import-manifest-trim-me-[0-9a-f]{12}$/);
  const oversized = defaultManifestAssertionName(`prefix-${'x'.repeat(300)}`);
  assert.ok(oversized.length <= 256);
  assert.match(oversized, /-[0-9a-f]{12}$/);
});

test('the primary manifest module is read-only and compatibility mutations fail before daemon access', async () => {
  const reader = await import('../manifest.mjs');
  assert.equal('createImportManifest' in reader, false);
  assert.equal('markPartitionStatus' in reader, false);
  assert.equal('buildInitialManifestTriples' in reader, false);
  assert.equal('statusEventUri' in reader, false);

  const {
    createImportManifest,
    markPartitionStatus,
  } = await import('../manifest-mutations-compat.mjs');
  const calls = [];
  const client = new Proxy({ cgId: 'atomic-cg' }, {
    get(target, property, receiver) {
      if (property !== 'cgId') calls.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const rejectsAsAtomicUnsupported = (err) => {
    assert.equal(err?.code, 'KA_ATOMIC_MANIFEST_UNSUPPORTED');
    assert.match(String(err?.message), /not compatible with atomic whole-KA sharing/i);
    return true;
  };

  await assert.rejects(() => createImportManifest(), rejectsAsAtomicUnsupported);
  await assert.rejects(() => markPartitionStatus(), rejectsAsAtomicUnsupported);
  await assert.rejects(
    () => createImportManifest({
      client,
      importId: 'legacy-import',
      partitions: ['part-1'],
      subGraphName: 'meta',
    }),
    rejectsAsAtomicUnsupported,
  );
  await assert.rejects(
    () => markPartitionStatus({
      client,
      importId: 'legacy-import',
      partitionKey: 'part-1',
      status: 'done',
      subGraphName: 'meta',
    }),
    rejectsAsAtomicUnsupported,
  );
  assert.deepEqual(calls, []);
});

function makeLegacyReadClient({ bindings = [], askResult } = {}) {
  const queries = [];
  return {
    cgId: 'legacy-cg',
    queries,
    async query(request) {
      queries.push(request);
      if (/\bASK\s*\{/.test(request.sparql)) {
        return askResult ?? { boolean: false };
      }
      return { result: { bindings } };
    },
  };
}

test('loadImportManifest preserves legacy flat bindings, literal escapes, and initial status', async () => {
  const importId = 'legacy-flat';
  const client = makeLegacyReadClient({
    bindings: [
      {
        part: partitionUri(importId, 'z-part'),
        key: '"z-part"',
        initial: '"pending"',
      },
      {
        part: partitionUri(importId, 'a-part'),
        key: '"a-part"',
        initial: '"pending"',
        latestStatus: '"backslash\\\\then-n"',
        latestRecordedAt: '"2026-01-15T09:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      },
    ],
  });

  const loaded = await loadImportManifest({ client, importId, subGraphName: 'meta' });

  assert.equal(loaded.importUri, importUri(importId));
  assert.deepEqual(loaded.partitions, [
    {
      key: 'a-part',
      status: 'backslash\\then-n',
      uri: partitionUri(importId, 'a-part'),
      recordedAt: '2026-01-15T09:00:00.000Z',
    },
    {
      key: 'z-part',
      status: 'pending',
      uri: partitionUri(importId, 'z-part'),
      recordedAt: null,
    },
  ]);
});

test('loadImportManifest decodes SPARQL results-JSON cells for legacy reads', async () => {
  const importId = 'legacy-cells';
  const client = makeLegacyReadClient({
    bindings: [{
      part: { type: 'uri', value: partitionUri(importId, 'part-1') },
      key: { type: 'literal', value: '"part-1"' },
      initial: { type: 'literal', value: '"pending"' },
      latestStatus: { type: 'literal', value: '"done"' },
      latestRecordedAt: {
        type: 'literal',
        value: '"2026-01-15T10:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      },
    }],
  });

  const loaded = await loadImportManifest({ client, importId, subGraphName: 'meta' });

  assert.deepEqual(loaded.partitions[0], {
    key: 'part-1',
    status: 'done',
    uri: partitionUri(importId, 'part-1'),
    recordedAt: '2026-01-15T10:00:00.000Z',
  });
});

test('loadImportManifest queries SWM and retains deterministic latest-event tie-break', async () => {
  const importId = 'legacy-routing';
  const client = makeLegacyReadClient({
    bindings: [{
      part: partitionUri(importId, 'part-1'),
      key: '"part-1"',
      initial: '"pending"',
      latestStatus: '"done"',
      latestRecordedAt: '"2026-01-15T10:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    }],
  });

  await loadImportManifest({ client, importId, subGraphName: 'meta' });

  assert.equal(client.queries.length, 1);
  assert.equal(client.queries[0].graphSuffix, '_shared_memory');
  assert.equal(client.queries[0].contextGraphId, 'legacy-cg');
  assert.equal(client.queries[0].subGraphName, 'meta');
  assert.match(client.queries[0].sparql, /\?ts2 = \?latestRecordedAt && STR\(\?ev2\) > STR\(\?ev\)/);
});

test('loadImportManifest fails loudly when the legacy manifest is missing from SWM', async () => {
  const client = makeLegacyReadClient();
  await assert.rejects(
    () => loadImportManifest({ client, importId: 'missing', subGraphName: 'meta' }),
    /No import manifest rows found/,
  );
});

test('partitionDeclared accepts both ASK response shapes and routes through SWM', async () => {
  for (const askResult of [{ boolean: true }, { result: { boolean: true } }]) {
    const client = makeLegacyReadClient({ askResult });
    assert.equal(await partitionDeclared({
      client,
      importId: 'legacy-ask',
      partitionKey: 'part-1',
      subGraphName: 'meta',
    }), true);
    assert.equal(client.queries[0].graphSuffix, '_shared_memory');
    assert.match(client.queries[0].sparql, /ASK/);
    assert.match(client.queries[0].sparql, /urn:dkg:import:legacy-ask#part:part-1/);
  }
});

test('pendingPartitions returns every non-terminal legacy partition', () => {
  const pending = pendingPartitions([
    { key: 'a', status: 'done' },
    { key: 'b', status: 'pending' },
    { key: 'c', status: 'failed' },
  ]);
  assert.deepEqual(pending.map((partition) => partition.key), ['b', 'c']);
});
