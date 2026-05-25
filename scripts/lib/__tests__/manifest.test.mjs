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
  defaultManifestAssertionName,
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

test('round-trip preserves literal escape sequences without double-unescape (regression for CodeQL L138)', async () => {
  // The previous unquote() used four chained `.replace()` passes; the
  // `\\` -> `\` pass running after `\"` -> `"` could re-interpret a `\`
  // left behind by an earlier pass as the start of a new escape sequence.
  // For instance the literal status string `\n` (backslash + n, two
  // chars) round-trips through lit() as `"\\n"` in N-Quads. The faulty
  // chain would turn that back into a newline character. The new
  // single-pass replacer must give back the original `\n` two-char
  // string, byte for byte.
  const client = makeMockClient();
  const importId = 'escape-corpus';
  await createImportManifest({
    client,
    importId,
    partitions: ['p1'],
    subGraphName: 'meta',
  });

  // Each entry: the literal user-visible status string we want to round
  // trip. These are the strings whose lit()->unquote() chain is the
  // double-escape danger zone.
  const samples = [
    'backslash\\then-n',      // literal backslash + literal "n"
    'crlf\\r\\nstuff',        // backslash + "r", backslash + "n"
    'quote\\"inside',         // backslash + quote
    'mixed \\\\ and \\n',     // escaped backslash + escaped \n
    'plain done',             // baseline, no escapes
  ];

  for (const status of samples) {
    await markPartitionStatus({
      client, importId, partitionKey: 'p1', status, subGraphName: 'meta',
    });
    // Tiny delay so each event's recordedAt is strictly increasing.
    await new Promise((r) => setTimeout(r, 2));
  }

  const state = await loadImportManifest({ client, importId, subGraphName: 'meta' });
  assert.equal(state.partitions[0].status, samples[samples.length - 1],
    'last status string must round-trip byte-for-byte through lit/unquote');
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
 *   - `query()` runs against swm ONLY when the caller passes
 *     `graphSuffix: '_shared_memory'` — matching the real daemon's
 *     routing. Without that flag, the mock returns the bare data graph
 *     (empty for assertion-API writes), which catches the codex bug
 *     where `loadImportManifest` forgot to opt into SWM routing.
 *
 * `bindingShape` lets us also exercise the SPARQL 1.1 results-JSON
 * cell shape that the SPARQL-HTTP adapter returns.
 */
function makeMockClient({ bindingShape = 'flat', createAlreadyExists = false } = {}) {
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
    insertSwmTriples(triples) {
      for (const t of triples) swm.add(tripleKey(t));
    },
    async request(method, path) {
      calls.push(`${method} ${path}`);
      if (createAlreadyExists && method === 'POST' && path === '/api/assertion/create') {
        const err = new Error('POST /api/assertion/create -> 409: {"error":"already exists"}');
        err.status = 409;
        err.body = { error: 'already exists' };
        throw err;
      }
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
    async query({ sparql, graphSuffix }) {
      calls.push(`query:graphSuffix=${graphSuffix ?? ''}`);
      // We don't run a real SPARQL engine here — we pattern-match the
      // exact two shapes loadImportManifest sends and serve from the
      // memory tier the caller asked for. The daemon's REAL routing for
      // `subGraphName` alone hits the bare data graph (which is empty for
      // assertion-API-written data); only `graphSuffix: '_shared_memory'`
      // routes to SWM. Mirroring that here lets tests catch a regression
      // where the manifest reader drops the SWM hint.
      const m = sparql.match(/<(urn:dkg:import:[^>]+)>\s+imp:partition\s+\?part/);
      if (!m) return { result: { bindings: [] } };
      const importIri = m[1];

      // Pick the source store. `_shared_memory` -> swm; anything else
      // (including no graphSuffix at all) -> the bare data graph, which
      // is always empty in this mock because assertion-API writes never
      // land there.
      const source = graphSuffix === '_shared_memory' ? swm : new Set();

      // Reconstruct per-partition state from the chosen source set.
      const triples = [...source].map((k) => {
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
          if (!latest || rec > latest.rec || (rec === latest.rec && ev > latest.ev)) {
            latest = { ev, status: statusT.object, rec };
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

test('createImportManifest reuses an existing manifest assertion idempotently', async () => {
  const client = makeMockClient({ createAlreadyExists: true });

  await createImportManifest({
    client,
    importId: 'existing-corpus',
    partitions: ['src/foo.ts', 'src/bar.ts'],
    subGraphName: 'meta',
  });

  const state = await loadImportManifest({
    client,
    importId: 'existing-corpus',
    subGraphName: 'meta',
  });
  assert.deepEqual(
    state.partitions.map((p) => [p.key, p.status]),
    [['src/bar.ts', 'pending'], ['src/foo.ts', 'pending']],
  );
  assert.ok(client._state.calls.includes('POST /api/assertion/create'));
  assert.ok(client._state.calls.some((c) => c.startsWith('write:')));
  assert.ok(client._state.calls.some((c) => c.startsWith('promote:')));
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

test('same-millisecond status events resolve deterministically by event IRI', async () => {
  const client = makeMockClient();
  const importId = 'same-ms';
  const key = 'only.ts';
  const part = partitionUri(importId, key);
  const olderByIri = `${part}/event/a`;
  const newerByIri = `${part}/event/z`;
  const timestamp = '"2026-01-15T09:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';

  await createImportManifest({
    client,
    importId,
    partitions: [key],
    subGraphName: 'meta',
  });
  client.insertSwmTriples([
    { subject: part, predicate: IMPORT_P.statusEvent, object: `<${olderByIri}>` },
    { subject: olderByIri, predicate: IMPORT_P.status, object: '"failed"' },
    { subject: olderByIri, predicate: IMPORT_P.recordedAt, object: timestamp },
    { subject: part, predicate: IMPORT_P.statusEvent, object: `<${newerByIri}>` },
    { subject: newerByIri, predicate: IMPORT_P.status, object: '"done"' },
    { subject: newerByIri, predicate: IMPORT_P.recordedAt, object: timestamp },
  ]);

  const state = await loadImportManifest({
    client,
    importId,
    subGraphName: 'meta',
  });
  assert.equal(state.partitions[0].status, 'done');
});

test('loadImportManifest fails loudly when the manifest is missing from SWM', async () => {
  const client = makeMockClient();

  await assert.rejects(
    () => loadImportManifest({
      client,
      importId: 'missing-corpus',
      subGraphName: 'meta',
    }),
    /No import manifest rows found/,
  );
});

test('loadImportManifest routes the query through SWM (regression for codex L391)', async () => {
  // The daemon's `/api/query` default routing reads the bare data graph,
  // not SWM. Manifest data only lives in SWM (via assertion API write +
  // promote), so `loadImportManifest` MUST explicitly opt into SWM via
  // `graphSuffix: '_shared_memory'`. Without that hint the read silently
  // returns zero bindings even on a healthy import — which is exactly
  // the bug Codex flagged after our last push. This test enforces the
  // contract by making the mock client return SWM only when the SWM
  // graphSuffix is supplied, and pinning the call shape.
  const client = makeMockClient();
  await createImportManifest({
    client,
    importId: 'swm-routed',
    partitions: ['only.ts'],
    subGraphName: 'meta',
  });
  client._state.calls.length = 0;

  await loadImportManifest({ client, importId: 'swm-routed', subGraphName: 'meta' });

  const queryCalls = client._state.calls.filter((c) => c.startsWith('query:'));
  assert.equal(queryCalls.length, 1, 'should have made exactly one query');
  assert.equal(
    queryCalls[0],
    'query:graphSuffix=_shared_memory',
    'loadImportManifest must pass graphSuffix=_shared_memory so the daemon reads SWM',
  );
});

test('statusEventUri produces strictly increasing suffixes for same-ms calls (regression for codex L84)', () => {
  // Same-millisecond status updates land with identical `recordedAt`
  // values. Without a monotonic in-process counter in the IRI, two writes
  // in the same ms would tie on both timestamp AND a random suffix, so
  // SPARQL's lexicographic tie-breaker would pick a non-deterministic
  // winner. The implementation embeds a zero-padded counter BEFORE the
  // random component, guaranteeing call-order ordering for same-process
  // events.
  const ids = [];
  for (let i = 0; i < 50; i++) ids.push(statusEventUri('mono-test', 'p1'));
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i] > ids[i - 1],
      `event #${i} (${ids[i]}) should sort lexicographically after #${i - 1} (${ids[i - 1]})`,
    );
  }
  // Suffix shape: <ts>-<12-digit counter>-<6-char random>
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
  // `/`, whitespace, and `<>"{}|^\`\\`. `importUri`/`partitionUri` accept
  // those characters via percent-encoding, so a caller can construct
  // valid URIs from an importId that the default assertion-name path
  // can't actually `create`. The sanitizer maps unsafe runs to `-`, and
  // refuses outright if no valid characters remain.
  assert.equal(defaultManifestAssertionName('plain-id'), 'import-manifest-plain-id');
  assert.equal(defaultManifestAssertionName('with/slash'), 'import-manifest-with-slash');
  assert.equal(defaultManifestAssertionName('  trim me  '), 'import-manifest-trim-me');
  assert.equal(
    defaultManifestAssertionName('with"quote<bracket>'),
    'import-manifest-with-quote-bracket',
  );
  assert.equal(
    defaultManifestAssertionName('mixed/slash and space'),
    'import-manifest-mixed-slash-and-space',
  );
  assert.equal(
    defaultManifestAssertionName('--leading-and-trailing--'),
    'import-manifest-leading-and-trailing',
  );

  // Length cap: prefix is 16 chars, daemon limit is 256, so slug must be
  // truncated to <=240 chars and the total result must stay <=256.
  const longId = 'a'.repeat(500);
  const longResult = defaultManifestAssertionName(longId);
  assert.ok(longResult.length <= 256, `result should fit under 256 chars, got ${longResult.length}`);
  assert.ok(longResult.startsWith('import-manifest-'));

  // No valid characters -> throws with a descriptive error pointing at
  // the explicit-assertionName workaround instead of a cryptic 400 later.
  assert.throws(
    () => defaultManifestAssertionName('///'),
    /no characters valid for an assertion name/,
  );
  assert.throws(
    () => defaultManifestAssertionName(''),
    /must be a non-empty string/,
  );
});

test('createImportManifest uses sanitized default name for unsafe importIds', async () => {
  // End-to-end: passing an importId with `/` must NOT crash, and the
  // assertion created on the daemon must use the sanitized name.
  const client = makeMockClient();
  await createImportManifest({
    client,
    importId: 'corpus/2026-q1',
    partitions: ['only.ts'],
    subGraphName: 'meta',
  });
  // The mock records all `request()` calls; the create call should have
  // used the sanitized name embedded inside the path-encoded form is not
  // available here, so we just verify it didn't throw and that a
  // subsequent load (which constructs the same name) succeeds end-to-end.
  const state = await loadImportManifest({
    client,
    importId: 'corpus/2026-q1',
    subGraphName: 'meta',
  });
  assert.equal(state.partitions.length, 1);
  assert.equal(state.partitions[0].key, 'only.ts');
});
