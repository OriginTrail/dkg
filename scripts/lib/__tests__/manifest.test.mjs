/**
 * Tests for `scripts/lib/manifest.mjs`: the pure helpers, and the helper
 * flows against a mock daemon that keeps the daemon's current Knowledge
 * Asset rules (see `makeMockDaemon`). The flows also run against a real
 * daemon in packages/cli/test/import-manifest-live.test.ts.
 *
 * Run via:  node --test scripts/lib/__tests__/manifest.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMPORT_NS,
  IMPORT_T,
  IMPORT_P,
  PAGE_MAX_PARTITIONS,
  STATUS_BATCH_MAX_BYTES,
  importUri,
  partitionUri,
  statusEventUri,
  buildInitialManifestTriples,
  createImportManifest,
  markPartitionStatus,
  markPartitionStatuses,
  loadImportManifest,
  pendingPartitions,
  defaultManifestAssertionName,
  partitionDeclared,
  partitionPages,
  partitionPageAssertionName,
  partitionSetHash,
  statusBatchAssertionName,
} from '../manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// A real SPARQL engine for the mock daemon's shared memory (the storage package's dependency).
const oxigraph = createRequire(path.join(REPO_ROOT, 'packages/storage/package.json'))('oxigraph');

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

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
  assert.equal(IMPORT_P.partitionCount, 'https://ontology.dkg.io/import#partitionCount');
  assert.equal(IMPORT_P.partitionSetHash, 'https://ontology.dkg.io/import#partitionSetHash');
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

  // The import node itself: rdf:type, startedAt, partition count and set hash.
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
  assert.equal(
    triples.find((t) => t.subject === importIri && t.predicate === IMPORT_P.partitionCount)?.object,
    '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
  );
  assert.equal(
    triples.find((t) => t.subject === importIri && t.predicate === IMPORT_P.partitionSetHash)?.object,
    `"${partitionSetHash(['b.ts', 'a.ts'])}"`,
  );

  // Each partition should appear with its link from the import, key and initialStatus.
  for (const key of ['a.ts', 'b.ts']) {
    const partIri = partitionUri('my-corpus', key);
    assert.ok(triples.some((t) => t.subject === importIri && t.predicate === IMPORT_P.partition && t.object === partIri));
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

test('partitionPages sorts the keys and bounds each page by count and size', () => {
  const keys = ['c', 'a', 'e', 'b', 'd'];
  assert.deepEqual(partitionPages('pages', keys, { maxPartitions: 2 }), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(partitionPages('pages', keys), [['a', 'b', 'c', 'd', 'e']], 'small sets fit one page');
  const long = ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400)];
  const pages = partitionPages('pages', long, { maxBytes: 2_500 });
  assert.equal(pages.length, 3, 'each partition of about 1.7 KB of N-Quads gets its own page under 2.5 KB');
  assert.deepEqual(partitionPages('pages', long, { maxBytes: 10 }), long.map((key) => [key]),
    'a partition larger than the bound still gets a page of its own');
});

test('manifest asset names are valid, bounded and distinct', () => {
  const longId = 'corpus/'.repeat(60);
  const names = [
    defaultManifestAssertionName(longId),
    partitionPageAssertionName(longId, 0, ['a']),
    partitionPageAssertionName(longId, 0, ['b']),
    partitionPageAssertionName(longId, 1, ['a']),
    statusBatchAssertionName(longId, statusEventUri(longId, 'a')),
    statusBatchAssertionName(longId, statusEventUri(longId, 'a')),
    partitionPageAssertionName(`${longId}x`, 0, ['a']),
  ];
  for (const name of names) {
    assert.ok(name.length <= 256, `${name} is longer than 256 characters`);
    assert.match(name, /^[A-Za-z0-9._-]+$/);
  }
  assert.equal(new Set(names).size, names.length);
  assert.equal(partitionPageAssertionName('short', 3, ['k']).startsWith('import-manifest-short-part-3-'), true);
});

// ---------------------------------------------------------------------------
// The helper flows against a mock daemon
// ---------------------------------------------------------------------------

function httpError(status, body) {
  return Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(body)}`), { status, body });
}

/**
 * A stand-in for the daemon behind `DkgClient`, keeping the Knowledge Asset
 * rules the helper has to live with
 * (`packages/cli/src/daemon/routes/knowledge-assets.ts`):
 *
 *   - `swm/share` refuses an `entities` array (400 `KA_ATOMIC_SHARE_REQUIRED`)
 *     and shares the whole asset;
 *   - a share seals the asset and empties its draft: a later write is
 *     refused (409 `KA_WM_LIFECYCLE_REQUIRED`), a second share is a no-op,
 *     and a create of the same name answers `alreadyExists` with the
 *     asset's status (a create that carries quads is refused);
 *   - a create with quads seals them, and with `alsoShareSwm` also shares;
 *   - every shared asset is its own named graph in shared memory. A query
 *     without `GRAPH` is answered one asset graph at a time, so a join
 *     across assets finds nothing, and one with a `UNION` finds nothing at
 *     all; `GRAPH ?g` ranges over the sub-graph's assets;
 *   - only `graphSuffix: '_shared_memory'` reads shared memory.
 *
 * Shared memory is a real SPARQL store, so the helper's queries run as
 * written. `bindingShape: 'cell'` returns SPARQL 1.1 results-JSON cells, as
 * the SPARQL-HTTP adapter does; the default is the flat N-Triples form.
 */
function makeMockDaemon({ bindingShape = 'flat' } = {}) {
  const store = new oxigraph.Store();
  /** @type {Map<string, { subGraphName: string, graph: string, draft: Set<string>, status: string }>} */
  const assets = new Map();
  /** @type {Array<{ method: string, path: string, body: any }>} */
  const requests = [];
  /** @type {Array<{ sparql: string, graphSuffix?: string, subGraphName?: string }>} */
  const queries = [];
  /** Failures to inject: the first entry whose `match` accepts a request throws `error` instead. */
  const failures = [];
  let kaNumber = 0;

  function record(method, path, body) {
    const request = { method, path, body };
    requests.push(request);
    const index = failures.findIndex((failure) => failure.match(request));
    if (index >= 0) throw failures.splice(index, 1)[0].error;
  }

  const term = (value) => (/^["<_]/.test(value) ? value : `<${value}>`);
  function write(asset, triples) {
    if (asset.status !== 'draft-open') {
      throw httpError(409, { code: 'KA_WM_LIFECYCLE_REQUIRED', error: 'not an active Working Memory draft' });
    }
    for (const t of triples) asset.draft.add(`<${t.subject}> <${t.predicate}> ${term(t.object)}`);
  }
  function share(asset) {
    if (asset.status === 'swm-shared') return { swmShared: true, promotedCount: 0, sealed: true };
    store.load([...asset.draft].map((line) => `${line} <${asset.graph}> .\n`).join(''), { format: 'application/n-quads' });
    const promotedCount = asset.draft.size;
    asset.draft.clear();
    asset.status = 'swm-shared';
    return { swmShared: true, promotedCount, sealed: true };
  }
  function binding(value) {
    if (value.termType === 'NamedNode') return bindingShape === 'cell' ? { value: value.value, type: 'uri' } : value.value;
    if (bindingShape !== 'cell') return value.toString();
    return {
      value: value.value,
      type: 'literal',
      ...(value.datatype && value.datatype.value !== XSD_STRING ? { datatype: value.datatype.value } : {}),
    };
  }
  function answer(results) {
    if (results.every((r) => typeof r === 'boolean')) return { result: { boolean: results.some(Boolean) } };
    const bindings = results.flat().map((row) => Object.fromEntries([...row].map(([name, value]) => [name, binding(value)])));
    return { result: { bindings } };
  }

  return {
    cgId: 'urn:test:cg',
    assets,
    requests,
    queries,
    failures,
    store,
    async request(method, path, body) {
      record(method, path, body);
      if (method !== 'POST' || path !== '/api/knowledge-assets') throw new Error(`unexpected request ${method} ${path}`);
      const existing = assets.get(body.name);
      if (existing) {
        if (body.quads) {
          throw httpError(409, {
            code: existing.status === 'swm-shared' ? 'KA_WM_LIFECYCLE_REQUIRED' : 'KA_ASSERTION_ALREADY_FINALIZED',
          });
        }
        return { name: body.name, alreadyExists: true, status: existing.status };
      }
      const asset = {
        subGraphName: body.subGraphName,
        graph: `did:dkg:context-graph:${this.cgId}/${body.subGraphName}/_shared_memory/0xagent/${++kaNumber}`,
        draft: new Set(),
        status: 'draft-open',
      };
      assets.set(body.name, asset);
      if (body.quads) {
        write(asset, body.quads);
        asset.status = 'wm-sealed';
      }
      if (body.alsoShareSwm) return { name: body.name, alreadyExists: false, status: 'swm-shared', ...share(asset) };
      return { name: body.name, alreadyExists: false, status: asset.status };
    },
    async writeAssertion({ assertionName, triples }) {
      record('POST', `/api/knowledge-assets/${assertionName}/wm/write`, { quads: triples });
      const asset = assets.get(assertionName);
      if (!asset) throw httpError(404, { error: `Assertion "${assertionName}" not found` });
      write(asset, triples);
      return triples.length;
    },
    async promote(payload) {
      const asset = assets.get(payload.assertionName);
      // A share seals the draft before it shares, so even a share that then fails leaves the asset sealed.
      if (asset?.status === 'draft-open' && !Array.isArray(payload.entities)) asset.status = 'wm-sealed';
      record('POST', `/api/knowledge-assets/${payload.assertionName}/swm/share`, payload);
      if (Array.isArray(payload.entities)) {
        throw httpError(400, {
          code: 'KA_ATOMIC_SHARE_REQUIRED',
          error: '"entities" selection is not supported; graph-scoped Knowledge Assets are shared atomically',
        });
      }
      if (!asset) throw httpError(404, { error: `Assertion "${payload.assertionName}" not found` });
      return share(asset);
    },
    async query({ sparql, graphSuffix, subGraphName }) {
      queries.push({ sparql, graphSuffix, subGraphName });
      const graphs = graphSuffix !== '_shared_memory' ? [] : [...assets.values()]
        .filter((asset) => asset.status === 'swm-shared' && asset.subGraphName === subGraphName)
        .map((asset) => oxigraph.namedNode(asset.graph));
      if (/\bGRAPH\b/i.test(sparql)) return answer([store.query(sparql, { named_graphs: graphs })]);
      if (/\bUNION\b/i.test(sparql)) return answer([]);
      return answer(graphs.map((graph) => store.query(sparql, { default_graph: [graph] })));
    },
  };
}

async function createManifest(client, importId, partitions, extra = {}) {
  return createImportManifest({ client, importId, partitions, subGraphName: 'meta', ...extra });
}

async function load(client, importId) {
  return loadImportManifest({ client, importId, subGraphName: 'meta' });
}

async function mark(client, importId, partitionKey, status) {
  return markPartitionStatus({ client, importId, partitionKey, status, subGraphName: 'meta' });
}

const statuses = (state) => state.partitions.map((p) => [p.key, p.status]);
const shares = (client) => client.requests.filter((r) => r.path.endsWith('/swm/share') || r.body?.alsoShareSwm === true);

test('full round-trip: create, mark, reload — every share is atomic and no asset is shared twice', async () => {
  const client = makeMockDaemon();
  const importId = 'corpus-2026-01-15';

  await createManifest(client, importId, ['src/foo.ts', 'src/bar.ts', 'src/baz.ts']);
  assert.deepEqual(statuses(await load(client, importId)), [
    ['src/bar.ts', 'pending'], ['src/baz.ts', 'pending'], ['src/foo.ts', 'pending'],
  ]);

  // Two status changes of one partition: the second can no longer go to an asset that was shared before.
  await mark(client, importId, 'src/bar.ts', 'in_progress');
  await new Promise((r) => setTimeout(r, 5));
  await mark(client, importId, 'src/bar.ts', 'done');

  const state = await load(client, importId);
  assert.deepEqual(statuses(state), [['src/bar.ts', 'done'], ['src/baz.ts', 'pending'], ['src/foo.ts', 'pending']]);
  assert.ok(state.partitions.find((p) => p.key === 'src/bar.ts').recordedAt);
  assert.equal(state.partitions.find((p) => p.key === 'src/foo.ts').recordedAt, null);
  assert.deepEqual(pendingPartitions(state.partitions).map((p) => p.key), ['src/baz.ts', 'src/foo.ts']);

  for (const request of client.requests) {
    assert.equal(Array.isArray(request.body?.entities), false, `${request.path} must not select root entities`);
  }
  const shared = shares(client).map((r) => r.body.assertionName ?? r.body.name);
  assert.equal(new Set(shared).size, shared.length, 'each asset is shared exactly once');
  assert.equal(shared.length, 4, 'head + one page + two status assets');
});

test('the manifest is a head, partition pages and status assets, each in its own shared graph', async () => {
  const client = makeMockDaemon();
  const importId = 'layout';
  const { assertionName, pageAssertionNames } = await createManifest(client, importId, ['c', 'a', 'b', 'e', 'd'], { maxPartitionsPerPage: 2 });
  assert.equal(assertionName, defaultManifestAssertionName(importId));
  assert.deepEqual(pageAssertionNames, [
    partitionPageAssertionName(importId, 0, ['a', 'b']),
    partitionPageAssertionName(importId, 1, ['c', 'd']),
    partitionPageAssertionName(importId, 2, ['e']),
  ]);
  const event = await mark(client, importId, 'c', 'done');
  assert.equal(event.assertionName, statusBatchAssertionName(importId, event.eventUri));
  assert.deepEqual([...client.assets.keys()], [assertionName, ...pageAssertionNames, event.assertionName]);
  assert.ok([...client.assets.values()].every((asset) => asset.status === 'swm-shared'));
  assert.deepEqual(statuses(await load(client, importId)), [['a', 'pending'], ['b', 'pending'], ['c', 'done'], ['d', 'pending'], ['e', 'pending']]);
});

test('round-trip preserves N-Triples literal escapes without double-unescape (regression for CodeQL L138)', async () => {
  // unquote() decodes each escape exactly once: the literal status string
  // `\n` (backslash + n) must not come back as a newline.
  const client = makeMockDaemon();
  const importId = 'escape-corpus';
  await createManifest(client, importId, ['p1']);

  const samples = [
    'backslash\\then-n',      // literal backslash + literal "n"
    'crlf\\r\\nstuff',        // backslash + "r", backslash + "n"
    'quote\\"inside',         // backslash + quote
    'mixed \\\\ and \\n',     // escaped backslash + escaped \n
    'tab\tinside',            // tab must be escaped as \t, not emitted raw
    'backspace\binside',      // valid N-Triples \b escape
    'formfeed\finside',       // valid N-Triples \f escape
    'nul\u0000inside',        // remaining controls use \uXXXX
    'plain done',             // baseline, no escapes
  ];

  for (const status of samples) {
    await mark(client, importId, 'p1', status);
    await new Promise((r) => setTimeout(r, 2));
    const state = await load(client, importId);
    assert.equal(state.partitions[0].status, status, 'latest status string must round-trip byte-for-byte through lit/unquote');
  }
});

test('round-trip works with SPARQL 1.1 results-JSON cell bindings too', async () => {
  const client = makeMockDaemon({ bindingShape: 'cell' });
  await createManifest(client, 'cell-corpus', ['a.ts', 'b.ts']);
  await mark(client, 'cell-corpus', 'a.ts', 'done');

  const state = await load(client, 'cell-corpus');
  const byKey = Object.fromEntries(state.partitions.map((p) => [p.key, p]));
  assert.equal(typeof byKey['a.ts'].status, 'string', 'status should be unwrapped to a plain string');
  assert.equal(byKey['a.ts'].status, 'done');
  assert.equal(byKey['b.ts'].status, 'pending');
  assert.equal(typeof byKey['a.ts'].uri, 'string');
  assert.ok(byKey['a.ts'].uri.startsWith('urn:dkg:import:cell-corpus#part:'));
});

test('the latest status wins when a partition has multiple events', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'multi-event', ['only.ts']);
  for (const status of ['in_progress', 'failed', 'done']) {
    await mark(client, 'multi-event', 'only.ts', status);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal((await load(client, 'multi-event')).partitions[0].status, 'done');
});

test('same-millisecond status events resolve deterministically by event IRI', async () => {
  const client = makeMockDaemon();
  const importId = 'same-ms';
  const part = partitionUri(importId, 'only.ts');
  const timestamp = '"2026-01-15T09:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';
  await createManifest(client, importId, ['only.ts']);
  // Two assets written by other processes, with the same `recordedAt`.
  for (const [suffix, status] of [['z', 'done'], ['a', 'failed']]) {
    const event = `${part}/event/${suffix}`;
    await client.request('POST', '/api/knowledge-assets', {
      contextGraphId: client.cgId, name: `other-${suffix}`, subGraphName: 'meta', alsoShareSwm: true,
      quads: [
        { subject: part, predicate: IMPORT_P.statusEvent, object: event },
        { subject: event, predicate: IMPORT_P.status, object: `"${status}"` },
        { subject: event, predicate: IMPORT_P.recordedAt, object: timestamp },
      ],
    });
  }
  assert.equal((await load(client, importId)).partitions[0].status, 'done');
});

test('markPartitionStatuses records a batch in one asset, a later entry winning for the same partition', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'batch', ['a', 'b', 'c']);
  const before = shares(client).length;
  const recorded = await markPartitionStatuses({
    client, importId: 'batch', subGraphName: 'meta',
    statuses: [{ partitionKey: 'a', status: 'in_progress' }, { partitionKey: 'b', status: 'done' }, { partitionKey: 'a', status: 'done' }],
  });
  assert.equal(shares(client).length - before, 1);
  assert.equal(new Set(recorded.map((r) => r.assertionName)).size, 1);
  assert.deepEqual(statuses(await load(client, 'batch')), [['a', 'done'], ['b', 'done'], ['c', 'pending']]);
});

test('markPartitionStatuses splits a large batch into assets within the size bound', async () => {
  const client = makeMockDaemon();
  const keys = Array.from({ length: 300 }, (_, i) => `deep/path/${String(i).padStart(3, '0')}/${'x'.repeat(120)}`);
  await createManifest(client, 'big-batch', keys);
  const recorded = await markPartitionStatuses({
    client, importId: 'big-batch', subGraphName: 'meta', statuses: keys.map((partitionKey) => ({ partitionKey, status: 'done' })),
  });
  const batches = client.requests.filter((r) => r.body?.alsoShareSwm === true);
  assert.ok(batches.length > 1, 'expected more than one status asset');
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch.body), 'utf8') <= STATUS_BATCH_MAX_BYTES);
  }
  assert.equal(new Set(recorded.map((r) => r.assertionName)).size, batches.length);
  assert.ok((await load(client, 'big-batch')).partitions.every((p) => p.status === 'done'));
});

test('a status write whose share did not complete fails instead of looking recorded', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'share-failed', ['a']);
  // The daemon answers a create whose share failed after the seal with 207, which is not an HTTP error.
  const request = client.request.bind(client);
  client.request = async (method, path, body) => (body?.alsoShareSwm
    ? { created: true, status: 'wm-sealed', errors: [{ phase: 'swm-share', error: 'store busy' }], recoveryJobId: 'job-1' }
    : request(method, path, body));
  await assert.rejects(() => mark(client, 'share-failed', 'a', 'done'), /was not shared to shared memory: store busy\. Its recovery job is job-1\./);
});

test('createImportManifest is a no-op once the manifest is shared', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'again', ['a', 'b']);
  const before = client.requests.length;
  const again = await createManifest(client, 'again', ['b', 'a']);
  assert.equal(client.requests.length, before, 'a complete manifest is left as it is');
  assert.equal(again.assertionName, defaultManifestAssertionName('again'));
});

test('createImportManifest resumes an interrupted run and finishes only what is missing', async () => {
  const client = makeMockDaemon();
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const second = partitionPageAssertionName('resume', 1, ['c', 'd']);
  client.failures.push({ match: (r) => r.path === `/api/knowledge-assets/${second}/swm/share`, error: httpError(503, { code: 'STORE_SCHEDULER_BUSY' }) });
  await assert.rejects(() => createManifest(client, 'resume', keys, { maxPartitionsPerPage: 2 }), /503/);
  await assert.rejects(() => load(client, 'resume'), /incomplete in shared memory: 2 of 5 partitions are visible/);

  client.requests.length = 0;
  await createManifest(client, 'resume', keys, { maxPartitionsPerPage: 2 });
  assert.deepEqual(client.requests.map((r) => r.path), [
    '/api/knowledge-assets',
    `/api/knowledge-assets/${second}/swm/share`,
    '/api/knowledge-assets',
    `/api/knowledge-assets/${partitionPageAssertionName('resume', 2, ['e'])}/wm/write`,
    `/api/knowledge-assets/${partitionPageAssertionName('resume', 2, ['e'])}/swm/share`,
  ], 'the sealed second page is shared without a write; the head and the first page are left alone');
  assert.deepEqual(statuses(await load(client, 'resume')), keys.map((key) => [key, 'pending']));
});

test('createImportManifest preserves the original startedAt when it resumes the head', async () => {
  const client = makeMockDaemon();
  const importId = 'started-at-reuse';
  const head = defaultManifestAssertionName(importId);
  client.failures.push({ match: (r) => r.path === `/api/knowledge-assets/${head}/swm/share`, error: httpError(503, { code: 'STORE_OPERATION_TIMEOUT' }) });
  await assert.rejects(() => createManifest(client, importId, ['src/foo.ts']));
  // The interrupted head is sealed with one startedAt; open it again as a crash before its share would leave it.
  client.assets.get(head).status = 'draft-open';
  await new Promise((r) => setTimeout(r, 2));
  await createManifest(client, importId, ['src/foo.ts']);
  const startedAt = client.store.match(oxigraph.namedNode(importUri(importId)), oxigraph.namedNode(IMPORT_P.startedAt), null, null);
  assert.equal(startedAt.length, 1, 'a resumed head must not gain a second imp:startedAt');
});

test('createImportManifest rejects reuse with a different partition set', async () => {
  const client = makeMockDaemon();
  const importId = 'partition-set-reuse';
  await createManifest(client, importId, ['src/a.ts', 'src/b.ts']);
  for (const partitions of [['src/a.ts', 'src/c.ts'], ['src/a.ts'], ['src/a.ts', 'src/b.ts', 'src/c.ts']]) {
    await assert.rejects(() => createManifest(client, importId, partitions), /different partition set/);
  }
  assert.deepEqual((await load(client, importId)).partitions.map((p) => p.key), ['src/a.ts', 'src/b.ts'],
    'failed reuse must not union new partitions into the existing manifest');
});

test('createImportManifest rejects duplicate partition keys', async () => {
  await assert.rejects(() => createManifest(makeMockDaemon(), 'dupes', ['a', 'b', 'a']), /unique partition keys/);
});

test('createImportManifest uses sanitized default name for unsafe importIds', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'corpus/2026-q1', ['only.ts']);
  const creates = client.requests.filter((r) => r.path === '/api/knowledge-assets');
  assert.equal(creates[0].body.name, defaultManifestAssertionName('corpus/2026-q1'),
    'createImportManifest must send the sanitized assertion name to the daemon');
  const state = await load(client, 'corpus/2026-q1');
  assert.deepEqual(statuses(state), [['only.ts', 'pending']]);
});

test('markPartitionStatus rejects undeclared partition keys', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'declared-partitions-only', ['src/a.ts']);
  await assert.rejects(() => mark(client, 'declared-partitions-only', 'src/typo.ts', 'done'),
    /markPartitionStatus: partition 'src\/typo\.ts' is not declared in manifest 'declared-partitions-only'/);
  await assert.rejects(() => markPartitionStatuses({
    client, importId: 'declared-partitions-only', subGraphName: 'meta',
    statuses: [{ partitionKey: 'src/a.ts', status: 'done' }, { partitionKey: 'src/typo.ts', status: 'done' }],
  }), /markPartitionStatuses: partition 'src\/typo\.ts' is not declared/);
  assert.deepEqual(statuses(await load(client, 'declared-partitions-only')), [['src/a.ts', 'pending']]);
});

test('status writes read the declarations once per manifest, not on every call', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'declarations-once', ['a.ts', 'b.ts', 'c.ts']);
  client.queries.length = 0;
  for (const key of ['a.ts', 'b.ts', 'c.ts', 'a.ts']) await mark(client, 'declarations-once', key, 'done');
  assert.equal(client.queries.length, 1, 'one read of the declared partitions for four status writes');
  // A key it has not seen is read again before it is refused.
  await assert.rejects(() => mark(client, 'declarations-once', 'z.ts', 'done'), /not declared/);
  assert.equal(client.queries.length, 2);
});

test('loadImportManifest fails loudly when the manifest is missing from SWM', async () => {
  await assert.rejects(() => load(makeMockDaemon(), 'missing-corpus'), /No import manifest rows found/);
});

test('every read goes through SWM and matches inside one asset graph', async () => {
  // The daemon's default `/api/query` routing reads the bare data graph, and
  // answers a sub-graph query one asset graph at a time: a read without
  // `graphSuffix: '_shared_memory'` or without `GRAPH ?g` finds nothing.
  const client = makeMockDaemon();
  await createManifest(client, 'swm-routed', ['only.ts']);
  await mark(client, 'swm-routed', 'only.ts', 'done');
  await partitionDeclared({ client, importId: 'swm-routed', partitionKey: 'only.ts', subGraphName: 'meta' });
  await load(client, 'swm-routed');
  assert.ok(client.queries.length > 0);
  for (const { sparql, graphSuffix } of client.queries) {
    assert.equal(graphSuffix, '_shared_memory');
    assert.match(sparql, /GRAPH \?g \{/);
  }
});

test('statusEventUri produces strictly increasing suffixes for same-ms calls (regression for codex L84)', () => {
  // Same-millisecond status updates land with identical `recordedAt`
  // values. The zero-padded counter BEFORE the random component keeps the
  // event-IRI tie-breaker in call order for same-process events.
  const ids = [];
  for (let i = 0; i < 50; i++) ids.push(statusEventUri('mono-test', 'p1'));
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i] > ids[i - 1],
      `event #${i} (${ids[i]}) should sort lexicographically after #${i - 1} (${ids[i - 1]})`,
    );
  }
  for (const id of ids) {
    assert.match(
      id,
      /\/event\/\d+-\d{12}-[a-z0-9]{1,6}$/,
      `statusEventUri should embed a zero-padded monotonic counter: ${id}`,
    );
  }
});

test('defaultManifestAssertionName sanitizes IRI-unsafe importIds (regression for codex L222)', () => {
  // `validateAssertionName` in packages/core/src/constants.ts rejects
  // `/`, whitespace, and `<>"{}|^\`\\`. The sanitizer maps unsafe runs to
  // `-`, appends a stable hash when the raw id changed, and refuses
  // outright if no valid characters remain.
  assert.equal(defaultManifestAssertionName('plain-id'), 'import-manifest-plain-id');
  assert.match(defaultManifestAssertionName('with/slash'), /^import-manifest-with-slash-[0-9a-f]{12}$/);
  assert.match(defaultManifestAssertionName('  trim me  '), /^import-manifest-trim-me-[0-9a-f]{12}$/);
  assert.match(
    defaultManifestAssertionName('with"quote<bracket>'),
    /^import-manifest-with-quote-bracket-[0-9a-f]{12}$/,
  );
  assert.match(
    defaultManifestAssertionName('mixed/slash and space'),
    /^import-manifest-mixed-slash-and-space-[0-9a-f]{12}$/,
  );
  assert.match(
    defaultManifestAssertionName('--leading-and-trailing--'),
    /^import-manifest-leading-and-trailing-[0-9a-f]{12}$/,
  );
  assert.notEqual(
    defaultManifestAssertionName('a/b'),
    defaultManifestAssertionName('a b'),
    'different unsafe importIds that sanitize to the same slug must not collide',
  );

  const longId = 'a'.repeat(500);
  const longResult = defaultManifestAssertionName(longId);
  assert.ok(longResult.length <= 256, `result should fit under 256 chars, got ${longResult.length}`);
  assert.ok(longResult.startsWith('import-manifest-'));
  assert.match(longResult, /-[0-9a-f]{12}$/);
  assert.notEqual(
    defaultManifestAssertionName(`${'a'.repeat(500)}x`),
    defaultManifestAssertionName(`${'a'.repeat(500)}y`),
    'long importIds that only differ after the visible cutoff must not collide',
  );

  assert.throws(
    () => defaultManifestAssertionName('///'),
    /no characters valid for an assertion name/,
  );
  assert.throws(
    () => defaultManifestAssertionName(''),
    /must be a non-empty string/,
  );
});

test('manifest helpers reject custom assertionName overrides', async () => {
  const client = makeMockDaemon();
  await assert.rejects(
    () => createManifest(client, 'custom-name', ['a'], { assertionName: 'custom-assertion' }),
    /no longer accepts `assertionName`/,
  );
  await assert.rejects(
    () => markPartitionStatus({
      client, importId: 'custom-name', partitionKey: 'a', status: 'done', subGraphName: 'meta', assertionName: 'custom-assertion',
    }),
    /no longer accepts `assertionName`/,
  );
  await assert.rejects(
    () => markPartitionStatuses({
      client, importId: 'custom-name', statuses: [{ partitionKey: 'a', status: 'done' }], subGraphName: 'meta', assertionName: 'x',
    }),
    /no longer accepts `assertionName`/,
  );
});

test('partitionDeclared returns true for declared partitions, false otherwise', async () => {
  const client = makeMockDaemon();
  await createManifest(client, 'pq-test', ['a.ts', 'b.ts']);
  const declared = (partitionKey) => partitionDeclared({ client, importId: 'pq-test', partitionKey, subGraphName: 'meta' });
  assert.equal(await declared('a.ts'), true);
  assert.equal(await declared('not-declared.ts'), false);
});

test('the page size bound defaults to PAGE_MAX_PARTITIONS', async () => {
  const client = makeMockDaemon();
  const keys = Array.from({ length: PAGE_MAX_PARTITIONS + 1 }, (_, i) => `k${String(i).padStart(5, '0')}`);
  const { pageAssertionNames } = await createManifest(client, 'default-pages', keys);
  assert.equal(pageAssertionNames.length, 2);
  assert.equal((await load(client, 'default-pages')).partitions.length, keys.length);
});
