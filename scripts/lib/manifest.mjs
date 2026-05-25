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
 * a partition is the latest event by `recordedAt`, with the event IRI as a
 * deterministic tie-breaker when two writes land in the same millisecond.
 * This avoids needing SPARQL DELETE/INSERT (which the daemon doesn't expose)
 * and gives a complete history "for free".
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

/**
 * Derive the default manifest assertion name from an `importId`.
 *
 * `importUri()` / `partitionUri()` accept any string (they percent-encode it
 * into the URI), so a caller can legitimately pass `importId="my corpus/v1"`
 * and get a valid IRI back. But the daemon's `validateAssertionName`
 * (`packages/core/src/constants.ts`) rejects `/`, whitespace, and other
 * IRI-unsafe characters from assertion names — so the SAME `importId` would
 * crash `/api/assertion/create` with a 400 if we passed it through verbatim.
 *
 * This helper:
 *   - replaces any character outside `[A-Za-z0-9._-]` with `-`
 *   - collapses runs of `-` and trims leading/trailing dashes
 *   - prefixes with `import-manifest-` and truncates so the total length
 *     stays under the daemon's 256-char limit
 *   - throws a descriptive error if the `importId` reduces to an empty slug
 *     (e.g. `importId = "///"`), so callers don't get a cryptic 400 later
 *
 * Exported for tests + callers who want the same sanitization rule.
 */
export function defaultManifestAssertionName(importId) {
  if (typeof importId !== 'string' || importId.length === 0) {
    throw new Error('defaultManifestAssertionName: `importId` must be a non-empty string.');
  }
  const prefix = 'import-manifest-';
  const maxSlugLen = 256 - prefix.length;
  const slug = importId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxSlugLen);
  if (slug.length === 0) {
    throw new Error(
      `defaultManifestAssertionName: importId '${importId}' contains no characters ` +
      `valid for an assertion name (must include at least one of [A-Za-z0-9._-]). ` +
      `Pass an explicit \`assertionName\` to createImportManifest, or pick a simpler importId.`,
    );
  }
  return `${prefix}${slug}`;
}

/** Stable URI for a Partition within an Import. */
export function partitionUri(importId, key) {
  return `${importUri(importId)}#part:${encodeURIComponent(key)}`;
}

// Per-process monotonic counter for StatusEvent IRIs. Two events that land in
// the same millisecond would otherwise tie on `recordedAt` AND tie on a random
// suffix, leaving the SPARQL "latest event" lookup non-deterministic. Putting
// a zero-padded counter BEFORE the random suffix in the IRI guarantees
// lexicographic ordering matches call order for same-ms events within this
// process. Across processes the millisecond timestamp + cross-process random
// suffix remain the disambiguators; in practice two daemons promoting the same
// manifest in the same ms is a pathological case the random suffix is already
// the right answer for.
let _statusEventCounter = 0;

/** Stable URI for one StatusEvent. Exported so callers can promote it. */
export function statusEventUri(importId, key) {
  const ts = Date.now();
  const seq = String(++_statusEventCounter).padStart(12, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${partitionUri(importId, key)}/event/${ts}-${seq}-${rand}`;
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
 * Normalise a SELECT-binding term to a plain string value.
 *
 * The daemon's `/api/query` returns bindings in TWO shapes today,
 * depending on which storage backend is configured:
 *
 *   1. Oxigraph (default, in-process): bindings are flat objects of
 *      `{ varName: jsonEncodedTerm }` — literals come out as
 *      `"\"some text\""` or `"\"42\"^^<xsd:integer>"`, URIs as bare
 *      strings. Other importer scripts in this repo
 *      (`seed-dkg-code-project.mjs`, `drain-swm-duplicates.mjs`,
 *      `redistribute-memory.mjs`) all assume this shape.
 *
 *   2. SPARQL-HTTP adapter (external triplestore): bindings can come
 *      back as SPARQL 1.1 results-JSON cells:
 *      `{ value, type, datatype?, "xml:lang"? }`. The daemon's own
 *      `bindingValue` helper (packages/cli/src/daemon/manifest.ts)
 *      already handles both shapes; Codex flagged this library for
 *      assuming only shape (1), so `unquote` now collapses cells to
 *      their `.value` before applying literal-unquoting.
 */
function unquote(v) {
  // SPARQL 1.1 results-JSON cell — unwrap to .value first, then keep going.
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
    const inner = /** @type {{value: unknown}} */ (v).value;
    v = typeof inner === 'string' ? inner : String(inner ?? '');
  }
  if (typeof v !== 'string') return v;
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) {
      // Single-pass escape-sequence decode. The previous version chained four
      // `.replace()` calls, which CodeQL flagged as a double-unescape risk:
      // running `.replace(/\\\\/g, '\\')` after `.replace(/\\"/g, '"')` can
      // corrupt input like `\\\\n` (escaped backslash + literal `n`) into a
      // newline because the second pass sees the `\` left behind by the first
      // pass as the start of a new escape sequence. This regex matches each
      // escape exactly once and dispatches via a replacer, so no byte is
      // unescaped twice.
      return m[1].replace(/\\(["\\nr])/g, (_, ch) => {
        switch (ch) {
          case '"': return '"';
          case '\\': return '\\';
          case 'n': return '\n';
          case 'r': return '\r';
          default: return ch;
        }
      });
    }
  }
  return v;
}

/**
 * Pull the raw IRI string out of a binding cell or flat string. Used
 * for URI bindings (e.g. `?part`) where we want the bare IRI, not the
 * literal-unquoted form.
 */
function bareUri(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
    const inner = /** @type {{value: unknown}} */ (v).value;
    return typeof inner === 'string' ? inner : String(inner ?? '');
  }
  return typeof v === 'string' ? v : String(v ?? '');
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
  const assertion = assertionName ?? defaultManifestAssertionName(importId);
  try {
    await client.request('POST', '/api/assertion/create', {
      contextGraphId: cgId,
      name: assertion,
      subGraphName,
    });
  } catch (err) {
    // `/api/assertion/create` is intentionally idempotent on the daemon
    // side. A retry after a transient failure, or a second process resuming
    // the same import, may find the manifest assertion already staged. Treat
    // that as success and continue with the additive write/promote below so
    // a partially-created manifest can be healed.
    if (!String(err?.message ?? '').includes('already exists')) {
      throw err;
    }
  }
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
  const assertion = assertionName ?? defaultManifestAssertionName(importId);
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
  // Promote BOTH roots so peers see the status update:
  //
  //   - `evIri` carries the StatusEvent's own triples (rdf:type, status,
  //     recordedAt).
  //   - `partIri` is the subject of the NEW `partIri imp:statusEvent
  //     evIri` triple we just wrote — `assertion.promote({entities})`
  //     only moves quads whose SUBJECT is in `entities`. If we promoted
  //     `evIri` alone, the partition→event edge would stay in WM and
  //     `loadImportManifest` running against SWM (or on a peer node)
  //     would never see this event, treating the partition as still on
  //     its previous status.
  //
  // `partIri`'s prior triples (rdf:type, imp:key, imp:initialStatus)
  // are already in SWM from `createImportManifest`; re-promoting it is
  // idempotent for those and ships the new `imp:statusEvent` edge.
  await client.promote({
    contextGraphId: cgId,
    assertionName: assertion,
    subGraphName,
    entities: [partIri, evIri],
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
  // "max row" idiom: bind the event whose `(recordedAt, event IRI)` tuple is
  // greater than no other event tuple. The event IRI tie-breaker matters
  // because `recordedAt` is millisecond precision, so two status writes can
  // legitimately share the same timestamp. Avoids the SAMPLE+MAX
  // decorrelation problem where SAMPLE can pick the status from one row and
  // MAX the timestamp from another.
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
          FILTER (
            ?ts2 > ?latestRecordedAt ||
            (?ts2 = ?latestRecordedAt && STR(?ev2) > STR(?ev))
          )
        }
      }
    }
  `;
  // Query the SWM tier, not the bare data graph. The manifest is created via
  // the assertion API (create -> write -> promote), so the only place a
  // resume-from-restart or peer-side load will see it is the per-sub-graph
  // SWM graph (`did:dkg:context-graph:<cg>/<subgraph>/_shared_memory`). The
  // daemon's default `/api/query` routing for `subGraphName` alone hits the
  // bare data graph (`did:dkg:context-graph:<cg>/<subgraph>`), which is
  // empty for assertion-API-written data — so without `graphSuffix` this
  // query would silently return zero bindings even on a healthy import.
  // See AGENTS.md §7b query gotchas + the existing
  // scripts/devnet-test-rfc38-*.sh scripts that use the same pattern.
  const res = await client.query({
    sparql,
    contextGraphId: cgId,
    subGraphName,
    graphSuffix: '_shared_memory',
  });
  const bindings = res?.result?.bindings ?? res?.bindings ?? [];
  if (bindings.length === 0) {
    throw new Error(
      `No import manifest rows found for '${importId}' in context graph '${cgId}' ` +
      `sub-graph '${subGraphName}'. The manifest is missing or not visible in shared memory.`,
    );
  }

  const partitions = bindings.map((row) => {
    const key = unquote(row.key);
    const initial = unquote(row.initial);
    const latestStatus = row.latestStatus != null ? unquote(row.latestStatus) : null;
    const latestRecordedAt = row.latestRecordedAt != null
      ? unquote(row.latestRecordedAt).replace(/\^\^.*$/, '')
      : null;
    return {
      key,
      status: latestStatus ?? initial ?? 'pending',
      uri: bareUri(row.part),
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
