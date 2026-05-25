/**
 * Resumable-import manifest helpers.
 *
 * Implements the manifest pattern from
 * `docs/adr/0002-importer-chunking-contract.md` against the daemon's
 * own assertion API (via `DkgClient` from `./dkg-daemon.mjs`).
 *
 * An "Import" is a logical bulk-write operation that splits itself into
 * "Partitions" — typically one partition per source artefact (e.g. one
 * file in a code import, one PR in a GitHub import). The manifest is
 * itself an RDF assertion in the project's `meta` sub-graph so it can
 * be queried, gossiped, and resumed from any node.
 *
 * Status events are append-only: each `markPartitionStatus` call writes
 * a new `StatusEvent` triple with a timestamp; the "current" status of
 * a partition is the latest event by `recordedAt`. This avoids needing
 * SPARQL DELETE/INSERT (which the daemon doesn't expose) and gives a
 * complete history "for free".
 *
 * Usage (TypeScript / JS):
 *
 *   import { createImportManifest, markPartitionStatus, loadImportManifest }
 *     from './lib/manifest.mjs';
 *   import { makeClient } from './lib/dkg-daemon.mjs';
 *
 *   const client = makeClient({ token: '...' });
 *   await client.ensureProject({ id: 'my-corpus', name: 'My Corpus' });
 *   await client.ensureSubGraph(client.cgId, 'meta');
 *
 *   const partitions = ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'];
 *   const { assertionName } = await createImportManifest({
 *     client, importId: 'corpus-2026-01-15', partitions, subGraphName: 'meta',
 *   });
 *
 *   // ... do work for each partition ...
 *   await markPartitionStatus({
 *     client, importId: 'corpus-2026-01-15',
 *     partitionKey: 'src/foo.ts', status: 'done', subGraphName: 'meta',
 *   });
 *
 *   // On resume:
 *   const { partitions: state } = await loadImportManifest({
 *     client, importId: 'corpus-2026-01-15', subGraphName: 'meta',
 *   });
 *   const pending = state.filter((p) => p.status !== 'done');
 */

export const IMPORT_NS = 'https://ontology.dkg.io/import#';

export const IMPORT_T = {
  Import: IMPORT_NS + 'Import',
  Partition: IMPORT_NS + 'Partition',
  StatusEvent: IMPORT_NS + 'StatusEvent',
};

export const IMPORT_P = {
  startedAt: IMPORT_NS + 'startedAt',
  finishedAt: IMPORT_NS + 'finishedAt',
  partition: IMPORT_NS + 'partition',
  key: IMPORT_NS + 'key',
  initialStatus: IMPORT_NS + 'initialStatus',
  statusEvent: IMPORT_NS + 'statusEvent',
  status: IMPORT_NS + 'status',
  recordedAt: IMPORT_NS + 'recordedAt',
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

/** Stable URI for an Import. Slug is `encodeURIComponent`'d. */
export function importUri(importId) {
  return `urn:dkg:import:${encodeURIComponent(importId)}`;
}

/** Stable URI for a Partition within an Import. */
export function partitionUri(importId, key) {
  return `${importUri(importId)}#part:${encodeURIComponent(key)}`;
}

/** Stable-ish URI for one StatusEvent. Exported so callers can promote it. */
export function statusEventUri(importId, key) {
  // Random-ish suffix keeps multiple events on the same partition unique.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${partitionUri(importId, key)}/event/${suffix}`;
}

function lit(value) {
  const s = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${s}"`;
}

function dt(iso) {
  return `${lit(iso)}^^<${XSD_DATETIME}>`;
}

function uri(s) {
  return `<${s}>`;
}

/**
 * Strip enclosing double quotes from a SELECT-binding literal.
 *
 * NB: the daemon's `/api/query` route returns bindings as a flat object
 * of `{ varName: jsonEncodedTerm }` — literals come out as
 * `"\"some text\""` or `"\"42\"^^<xsd:integer>"`, URIs as bare
 * strings. This is **not** the SPARQL 1.1 results-JSON format (with
 * `{ value, type, datatype, ... }` cells). Other importer scripts in
 * this repo (`seed-dkg-code-project.mjs`, `drain-swm-duplicates.mjs`,
 * `redistribute-memory.mjs`) all rely on the same shape via their own
 * `bareIri()` / `unquote()` helpers; if you change one, update them
 * all together.
 */
function unquote(s) {
  if (typeof s !== 'string') return s;
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) {
      return m[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r');
    }
  }
  return s;
}

/**
 * Build the initial set of triples for a fresh Import manifest.
 *
 * @param {string} importId
 * @param {string[]} partitions  Partition keys (caller-defined, e.g. file paths)
 * @param {string} startedAtIso  ISO-8601 timestamp
 * @returns {{subject:string,predicate:string,object:string}[]}
 */
export function buildInitialManifestTriples(importId, partitions, startedAtIso) {
  const importIri = importUri(importId);
  const triples = [
    { subject: importIri, predicate: RDF_TYPE, object: uri(IMPORT_T.Import) },
    { subject: importIri, predicate: IMPORT_P.startedAt, object: dt(startedAtIso) },
  ];
  for (const key of partitions) {
    const partIri = partitionUri(importId, key);
    triples.push(
      { subject: importIri, predicate: IMPORT_P.partition, object: partIri },
      { subject: partIri, predicate: RDF_TYPE, object: uri(IMPORT_T.Partition) },
      { subject: partIri, predicate: IMPORT_P.key, object: lit(key) },
      { subject: partIri, predicate: IMPORT_P.initialStatus, object: lit('pending') },
    );
  }
  return triples;
}

/**
 * Create an Import manifest assertion that lists every partition this
 * import will write. All partitions start with `initialStatus = "pending"`;
 * use {@link markPartitionStatus} to record progress.
 *
 * Per ADR 0002 the manifest itself respects the importer chunking contract:
 * the helper batches writes through `DkgClient.writeAssertion` (which itself
 * chunks at 500 quads/call by default — well below the daemon's 10 MB body
 * limit).
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client  Daemon client (with `cgId` set by `ensureProject`)
 * @param {string} opts.importId        Stable id for this import run (slug-safe)
 * @param {string[]} opts.partitions    Caller-defined partition keys
 * @param {string} opts.subGraphName    Sub-graph that owns the manifest (typically `"meta"`)
 * @param {string} [opts.assertionName] Override the manifest assertion name (default: `"import-manifest-<importId>"`)
 * @returns {Promise<{ assertionName: string, importUri: string }>}
 */
export async function createImportManifest({
  client,
  importId,
  partitions,
  subGraphName,
  assertionName,
}) {
  if (!client?.cgId) {
    throw new Error(
      'createImportManifest requires a DkgClient with `cgId` set (call client.ensureProject first).',
    );
  }
  if (!Array.isArray(partitions) || partitions.length === 0) {
    throw new Error('createImportManifest requires a non-empty `partitions` array.');
  }
  if (!subGraphName) {
    throw new Error('createImportManifest requires `subGraphName` (typically "meta").');
  }
  const cgId = client.cgId;
  const assertion = assertionName ?? `import-manifest-${importId}`;
  await client.request('POST', '/api/assertion/create', {
    contextGraphId: cgId,
    name: assertion,
    subGraphName,
  });
  const triples = buildInitialManifestTriples(importId, partitions, new Date().toISOString());
  await client.writeAssertion({
    contextGraphId: cgId,
    assertionName: assertion,
    subGraphName,
    triples,
  });
  // Promote the import root AND every partition URI. Promoting only the
  // root leaves partition subjects in WM, which means `loadImportManifest`
  // running against SWM on another node can't see `imp:key` /
  // `imp:initialStatus` and resume can't recover. Chunk by `ROOT_CHUNK` so
  // very-large imports stay within the daemon's body-size budget — see
  // ADR 0002.
  const ROOT_CHUNK = 1000;
  const allRoots = [importUri(importId), ...partitions.map((k) => partitionUri(importId, k))];
  for (let i = 0; i < allRoots.length; i += ROOT_CHUNK) {
    await client.promote({
      contextGraphId: cgId,
      assertionName: assertion,
      subGraphName,
      entities: allRoots.slice(i, i + ROOT_CHUNK),
    });
  }
  return { assertionName: assertion, importUri: importUri(importId) };
}

/**
 * Append a StatusEvent triple for a partition. Status events are
 * append-only; `loadImportManifest` resolves the "current" status by
 * taking the latest event per partition.
 *
 * `status` is caller-defined. Conventional values are `"pending"`,
 * `"in_progress"`, `"done"`, `"failed"`, `"skipped"`. The library does
 * not validate the value.
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client
 * @param {string} opts.importId
 * @param {string} opts.partitionKey
 * @param {string} opts.status
 * @param {string} opts.subGraphName
 * @param {string} [opts.assertionName]
 * @returns {Promise<void>}
 */
export async function markPartitionStatus({
  client,
  importId,
  partitionKey,
  status,
  subGraphName,
  assertionName,
}) {
  if (!client?.cgId) {
    throw new Error('markPartitionStatus requires a DkgClient with `cgId` set.');
  }
  if (!partitionKey) throw new Error('markPartitionStatus requires `partitionKey`.');
  if (!status) throw new Error('markPartitionStatus requires `status`.');
  if (!subGraphName) throw new Error('markPartitionStatus requires `subGraphName`.');

  const cgId = client.cgId;
  const assertion = assertionName ?? `import-manifest-${importId}`;
  const partIri = partitionUri(importId, partitionKey);
  const evIri = statusEventUri(importId, partitionKey);
  const nowIso = new Date().toISOString();
  const triples = [
    { subject: partIri, predicate: IMPORT_P.statusEvent, object: evIri },
    { subject: evIri, predicate: RDF_TYPE, object: uri(IMPORT_T.StatusEvent) },
    { subject: evIri, predicate: IMPORT_P.status, object: lit(status) },
    { subject: evIri, predicate: IMPORT_P.recordedAt, object: dt(nowIso) },
  ];
  await client.writeAssertion({
    contextGraphId: cgId,
    assertionName: assertion,
    subGraphName,
    triples,
  });
  // Promote the new event so peers (and future resumes from any node)
  // see the status update — otherwise the event sits in WM only and
  // `loadImportManifest` against SWM still reports the prior status.
  // The partition URI is already in SWM from `createImportManifest`, so
  // we only need to promote the new event root here.
  await client.promote({
    contextGraphId: cgId,
    assertionName: assertion,
    subGraphName,
    entities: [evIri],
  });
}

/**
 * Read back the manifest and resolve each partition's current status as
 * the latest StatusEvent (falling back to `initialStatus = "pending"` if
 * no events have been recorded for that partition).
 *
 * Returns `{ importUri, partitions: [{ key, status, uri, recordedAt }] }`
 * sorted by partition key. `recordedAt` is `null` for partitions still on
 * the initial status (no events).
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client
 * @param {string} opts.importId
 * @param {string} opts.subGraphName
 * @returns {Promise<{ importUri: string, partitions: Array<{ key: string, status: string, uri: string, recordedAt: string | null }> }>}
 */
export async function loadImportManifest({ client, importId, subGraphName }) {
  if (!client?.cgId) {
    throw new Error('loadImportManifest requires a DkgClient with `cgId` set.');
  }
  if (!subGraphName) throw new Error('loadImportManifest requires `subGraphName`.');

  const cgId = client.cgId;
  const importIri = importUri(importId);

  // Pick the latest StatusEvent per partition using the standard SPARQL
  // "max row" idiom: bind the event whose recordedAt is greater than no
  // other event's recordedAt. Avoids the SAMPLE+MAX decorrelation
  // problem where SAMPLE can pick the status from one row and MAX the
  // timestamp from another.
  const sparql = `
    PREFIX imp: <${IMPORT_NS}>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?part ?key ?initial ?latestStatus ?latestRecordedAt WHERE {
      <${importIri}> imp:partition ?part .
      ?part imp:key ?key ;
            imp:initialStatus ?initial .
      OPTIONAL {
        ?part imp:statusEvent ?ev .
        ?ev imp:status ?latestStatus ;
            imp:recordedAt ?latestRecordedAt .
        FILTER NOT EXISTS {
          ?part imp:statusEvent ?ev2 .
          ?ev2 imp:recordedAt ?ts2 .
          FILTER (?ts2 > ?latestRecordedAt)
        }
      }
    }
  `;
  const res = await client.query({ sparql, contextGraphId: cgId, subGraphName });
  const bindings = res?.result?.bindings ?? res?.bindings ?? [];

  const partitions = bindings.map((row) => {
    const key = unquote(row.key);
    const initial = unquote(row.initial);
    const latestStatus = row.latestStatus ? unquote(row.latestStatus) : null;
    const latestRecordedAt = row.latestRecordedAt
      ? unquote(row.latestRecordedAt).replace(/\^\^.*$/, '')
      : null;
    return {
      key,
      status: latestStatus ?? initial ?? 'pending',
      uri: row.part,
      recordedAt: latestRecordedAt,
    };
  });
  partitions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { importUri: importIri, partitions };
}

/**
 * Convenience: filter a `loadImportManifest` result down to the
 * partitions that still need work (anything other than `"done"`).
 *
 * @param {Array<{ key: string, status: string }>} partitions
 * @returns {Array<{ key: string, status: string }>}
 */
export function pendingPartitions(partitions) {
  return partitions.filter((p) => p.status !== 'done');
}
