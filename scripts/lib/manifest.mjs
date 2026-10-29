/**
 * Resumable-import manifest helpers.
 *
 * Implements the manifest pattern from
 * `docs/adr/0002-importer-chunking-contract.md` against the daemon's
 * Knowledge Asset API (via `DkgClient` from `./dkg-daemon.mjs`).
 *
 * An "Import" is a logical bulk-write operation that splits itself into
 * "Partitions" — typically one partition per source artefact (e.g. one
 * file in a code import, one PR in a GitHub import). The manifest is
 * itself RDF in the project's `meta` sub-graph, shared to Shared Working
 * Memory (SWM) so it can be queried, gossiped, and resumed from any node.
 *
 * A share covers a whole Knowledge Asset and seals it, and a peer that holds
 * a shared asset does not take an edited copy of it. So the manifest is a set
 * of small Knowledge Assets, each written and shared exactly once:
 *
 *   - the import head (`defaultManifestAssertionName(importId)`): the
 *     Import node, its `startedAt`, its partition count and a hash of its
 *     partition keys;
 *   - partition pages (`<head>-part-<n>-<hash>`): each declares a
 *     size-bounded batch of the partitions, in key order, well under the
 *     share size cap of one Knowledge Asset;
 *   - status batches (`<head>-status-<hash>`): one per `markPartitionStatus`
 *     or `markPartitionStatuses` call.
 *
 * Every asset is its own named graph in SWM, and a sub-graph query is
 * answered one asset graph at a time, so a SPARQL join across assets finds
 * nothing. The readers below match each pattern inside `GRAPH ?g` and join
 * partitions to their status events here.
 *
 * Status events are append-only: the "current" status of a partition is its
 * latest event by `recordedAt`, with the event IRI as a deterministic
 * tie-breaker when two writes land in the same millisecond. This avoids
 * needing SPARQL DELETE/INSERT and gives a complete history "for free".
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

import { createHash } from 'node:crypto';

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
  partitionCount: IMPORT_NS + 'partitionCount',
  partitionSetHash: IMPORT_NS + 'partitionSetHash',
  key: IMPORT_NS + 'key',
  initialStatus: IMPORT_NS + 'initialStatus',
  statusEvent: IMPORT_NS + 'statusEvent',
  status: IMPORT_NS + 'status',
  recordedAt: IMPORT_NS + 'recordedAt',
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const MAX_ASSERTION_NAME_LENGTH = 256;

/**
 * Size bounds of one partition page: its N-Quads estimate and its partition
 * count. One Knowledge Asset is shared in one gossip message, capped at
 * 4 MiB, so a page stays well under it.
 */
export const PAGE_MAX_BYTES = 1024 * 1024;
export const PAGE_MAX_PARTITIONS = 2000;

/**
 * Size bound of one status batch: the estimated JSON body of the single
 * create-and-share request that writes it.
 */
export const STATUS_BATCH_MAX_BYTES = 192 * 1024;

/**
 * Rows per read. The daemon refuses a query answer above 10 MiB, and the
 * declarations and the status history of a large import go well past that,
 * so they are read in keyset pages of this many rows.
 */
export const QUERY_PAGE_ROWS = 1000;

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
 * crash `/api/knowledge-assets` (create) with a 400 if we passed it through verbatim.
 *
 * This helper:
 *   - replaces any character outside `[A-Za-z0-9._-]` with `-`
 *   - collapses runs of `-` and trims leading/trailing dashes
 *   - prefixes with `import-manifest-`
 *   - appends a stable hash whenever sanitization or truncation changes
 *     the caller's raw id, so `a/b` and `a b` cannot collide
 *   - truncates the human-readable slug segment so the total length stays
 *     under the daemon's 256-char limit
 *   - throws a descriptive error if the `importId` reduces to an empty slug
 *     (e.g. `importId = "///"`), so callers don't get a cryptic 400 later
 *
 * The name is the import head's Knowledge Asset; the manifest's other assets
 * are named after it. Exported for tests + callers who want the same
 * sanitization rule.
 */
export function defaultManifestAssertionName(importId) {
  if (typeof importId !== 'string' || importId.length === 0) {
    throw new Error('defaultManifestAssertionName: `importId` must be a non-empty string.');
  }
  const prefix = 'import-manifest-';
  const maxSlugLen = 256 - prefix.length;
  const rawSlug = importId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (rawSlug.length === 0) {
    throw new Error(
      `defaultManifestAssertionName: importId '${importId}' contains no characters ` +
      `valid for an assertion name (must include at least one of [A-Za-z0-9._-]). ` +
      `Pass an explicit \`assertionName\` to createImportManifest, or pick a simpler importId.`,
    );
  }
  const needsHash = rawSlug !== importId || rawSlug.length > maxSlugLen;
  if (!needsHash) return `${prefix}${rawSlug}`;

  const hash = createHash('sha256').update(importId).digest('hex').slice(0, 12);
  const maxSlugWithHash = maxSlugLen - hash.length - 1;
  const slug = rawSlug
    .slice(0, maxSlugWithHash)
    .replace(/-+$/g, '');
  if (slug.length === 0) {
    throw new Error(
      `defaultManifestAssertionName: importId '${importId}' sanitizes to an empty assertion-name slug. ` +
      `Pass an explicit \`assertionName\` to createImportManifest, or pick a simpler importId.`,
    );
  }
  return `${prefix}${slug}-${hash}`;
}

function shortHash(value, length) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * `<head>-<suffix>`. When that is too long for an assertion name, the head is
 * shortened and a hash of the `importId` keeps names of different imports apart.
 */
function manifestPartAssertionName(importId, suffix) {
  const head = defaultManifestAssertionName(importId);
  const name = `${head}-${suffix}`;
  if (name.length <= MAX_ASSERTION_NAME_LENGTH) return name;
  const tail = `-${shortHash(importId, 12)}-${suffix}`;
  return `${head.slice(0, MAX_ASSERTION_NAME_LENGTH - tail.length)}${tail}`;
}

/** A hash of a set of partition keys, independent of their order. */
export function partitionSetHash(keys) {
  return shortHash(JSON.stringify([...keys].sort(compareStrings)), 32);
}

/**
 * Knowledge Asset name of a partition page: its index, and a hash of its
 * partition keys, so a page that declares other keys never reuses the name.
 */
export function partitionPageAssertionName(importId, pageIndex, keys) {
  return manifestPartAssertionName(importId, `part-${pageIndex}-${partitionSetHash(keys).slice(0, 12)}`);
}

/** Knowledge Asset name of a status batch, from the IRI of its first event. */
export function statusBatchAssertionName(importId, firstEventIri) {
  return manifestPartAssertionName(importId, `status-${shortHash(firstEventIri, 24)}`);
}

/** Stable URI for a Partition within an Import. */
export function partitionUri(importId, key) {
  return `${importUri(importId)}#part:${encodeURIComponent(key)}`;
}

/**
 * Single-round-trip existence check: does the manifest for `importId` declare
 * `partitionKey` as one of its partitions?
 *
 * The link lives in the partition page that declares the partition, so the
 * `ASK` matches it inside `GRAPH ?g`: each shared Knowledge Asset is its own
 * graph in the sub-graph's SWM.
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client
 * @param {string} opts.importId
 * @param {string} opts.partitionKey
 * @param {string} opts.subGraphName
 * @returns {Promise<boolean>}
 */
export async function partitionDeclared({
  client,
  importId,
  partitionKey,
  subGraphName,
}) {
  if (!client?.cgId) {
    throw new Error('partitionDeclared requires a DkgClient with `cgId` set.');
  }
  if (!partitionKey) throw new Error('partitionDeclared requires `partitionKey`.');
  if (!subGraphName) throw new Error('partitionDeclared requires `subGraphName`.');
  const importIri = importUri(importId);
  const partIri = partitionUri(importId, partitionKey);
  const sparql = `
    PREFIX imp: <${IMPORT_NS}>
    ASK {
      GRAPH ?g { <${importIri}> imp:partition <${partIri}> . }
    }
  `;
  const res = await querySharedMemory(client, subGraphName, sparql);
  // The daemon's ASK response shape is the same as `/api/query`: either
  // `{boolean: true}` (Oxigraph) or `{result: {boolean: true}}` (SPARQL HTTP).
  // Tolerate both.
  if (typeof res?.boolean === 'boolean') return res.boolean;
  if (typeof res?.result?.boolean === 'boolean') return res.result.boolean;
  // Belt-and-braces fallback: some test mocks return bindings even for an
  // ASK-shaped query. Treat any non-empty binding set as `true`.
  return bindingsOf(res).length > 0;
}

// Per-process monotonic counter for StatusEvent IRIs. Two events that land in
// the same millisecond would otherwise tie on `recordedAt` AND tie on a random
// suffix, leaving the "latest event" choice non-deterministic. Putting a
// zero-padded counter BEFORE the random suffix in the IRI guarantees
// lexicographic ordering matches call order for same-ms events within this
// process. Across processes the millisecond timestamp + cross-process random
// suffix remain the disambiguators; in practice two processes recording the
// same partition in the same ms is a pathological case the random suffix is
// already the right answer for.
let _statusEventCounter = 0;

/** Stable URI for one StatusEvent. */
export function statusEventUri(importId, key) {
  const ts = Date.now();
  const seq = String(++_statusEventCounter).padStart(12, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${partitionUri(importId, key)}/event/${ts}-${seq}-${rand}`;
}

function lit(value) {
  const s = String(value).replace(/["\\\t\b\n\r\f]|[\u0000-\u001F\u007F]/g, (ch) => {
    switch (ch) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\f': return '\\f';
      default: {
        const code = ch.codePointAt(0) ?? 0;
        return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
      }
    }
  });
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
      return m[1].replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|["'\\tbnrf])/g, (_, esc) => {
        switch (esc) {
          case '"': return '"';
          case "'": return "'";
          case '\\': return '\\';
          case 't': return '\t';
          case 'b': return '\b';
          case 'n': return '\n';
          case 'r': return '\r';
          case 'f': return '\f';
          default: {
            if (esc.startsWith('u') || esc.startsWith('U')) {
              return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
            }
            return esc;
          }
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

function bindingsOf(res) {
  return res?.result?.bindings ?? res?.bindings ?? [];
}

// Query the SWM tier, not the bare data graph. The manifest is written
// through the Knowledge Asset API (create -> write -> share), so the only
// place a resume-from-restart or peer-side load will see it is the
// sub-graph's SWM (`did:dkg:context-graph:<cg>/<subgraph>/_shared_memory`).
// The daemon's default `/api/query` routing for `subGraphName` alone hits the
// bare data graph, which is empty for Knowledge Asset data — so without
// `graphSuffix` these queries would silently return nothing even on a healthy
// import. See AGENTS.md §7b query gotchas.
function querySharedMemory(client, subGraphName, sparql) {
  return client.query({
    sparql,
    contextGraphId: client.cgId,
    subGraphName,
    graphSuffix: '_shared_memory',
  });
}

/**
 * Every distinct row of `<pattern>` matched inside `GRAPH ?g`, yielded page
 * by page, ordered by the IRI variable `key`, each page after the last key of
 * the page before (a keyset cursor: a page reads only what follows it, and a
 * row written in between cannot shift the pages). The callers' keys name one
 * subject each, so the rows of one key are never split by a page boundary.
 */
async function* selectAllRows(client, subGraphName, { select, pattern, key }) {
  let after;
  for (;;) {
    const cursor = after === undefined ? '' : `FILTER(STR(${key}) > ${JSON.stringify(after)})`;
    const page = bindingsOf(await querySharedMemory(client, subGraphName, `
      PREFIX imp: <${IMPORT_NS}>
      SELECT DISTINCT ${select} WHERE {
        GRAPH ?g {
          ${pattern}
          ${cursor}
        }
      }
      ORDER BY STR(${key}) LIMIT ${QUERY_PAGE_ROWS}
    `));
    const last = page.length > 0 ? bareUri(page[page.length - 1][key.slice(1)]) : undefined;
    // A store that ignored LIMIT or the cursor would keep this loop reading for ever.
    if (page.length > QUERY_PAGE_ROWS || (after !== undefined && last === after)) {
      throw new Error('The query answer ignored its LIMIT or its cursor, so the manifest cannot be read in pages.');
    }
    yield* page;
    if (page.length < QUERY_PAGE_ROWS) return;
    after = last;
  }
}

function nquadsBytes(triples) {
  let bytes = 0;
  for (const t of triples) {
    bytes += Buffer.byteLength(`<${t.subject}> <${t.predicate}> ${t.object} .\n`, 'utf8');
  }
  return bytes;
}

/** The head of a fresh manifest: the Import node, `startedAt`, the partition count and the partition set's hash. */
export function buildImportHeadTriples(importId, partitions, startedAtIso) {
  const importIri = importUri(importId);
  return [
    { subject: importIri, predicate: RDF_TYPE, object: uri(IMPORT_T.Import) },
    { subject: importIri, predicate: IMPORT_P.startedAt, object: dt(startedAtIso) },
    { subject: importIri, predicate: IMPORT_P.partitionCount, object: `${lit(partitions.length)}^^<${XSD_INTEGER}>` },
    { subject: importIri, predicate: IMPORT_P.partitionSetHash, object: lit(partitionSetHash(partitions)) },
  ];
}

/** One partition's declaration, as its page holds it: the Import's link to it, then its own triples. */
export function buildPartitionTriples(importId, key) {
  const importIri = importUri(importId);
  const partIri = partitionUri(importId, key);
  return [
    { subject: importIri, predicate: IMPORT_P.partition, object: partIri },
    { subject: partIri, predicate: RDF_TYPE, object: uri(IMPORT_T.Partition) },
    { subject: partIri, predicate: IMPORT_P.key, object: lit(key) },
    { subject: partIri, predicate: IMPORT_P.initialStatus, object: lit('pending') },
  ];
}

/**
 * Build the initial set of triples for a fresh Import manifest: the head,
 * then every partition. `createImportManifest` shares the head and each
 * partition page as its own Knowledge Asset.
 *
 * @param {string} importId
 * @param {string[]} partitions  Partition keys (caller-defined, e.g. file paths)
 * @param {string} startedAtIso  ISO-8601 timestamp
 * @returns {{subject:string,predicate:string,object:string}[]}
 */
export function buildInitialManifestTriples(importId, partitions, startedAtIso) {
  return [
    ...buildImportHeadTriples(importId, partitions, startedAtIso),
    ...partitions.flatMap((key) => buildPartitionTriples(importId, key)),
  ];
}

/** One status event: the partition's link to it, then the event's own triples. */
export function buildStatusEventTriples(importId, partitionKey, eventIri, status, recordedAtIso) {
  return [
    { subject: partitionUri(importId, partitionKey), predicate: IMPORT_P.statusEvent, object: eventIri },
    { subject: eventIri, predicate: RDF_TYPE, object: uri(IMPORT_T.StatusEvent) },
    { subject: eventIri, predicate: IMPORT_P.status, object: lit(status) },
    { subject: eventIri, predicate: IMPORT_P.recordedAt, object: dt(recordedAtIso) },
  ];
}

/**
 * Split the partition keys into pages: sorted, so the same set always gives
 * the same pages, and each page within `maxBytes` (N-Quads estimate) and
 * `maxPartitions`. A single partition larger than `maxBytes` gets a page of
 * its own.
 *
 * @param {string} importId
 * @param {string[]} partitions
 * @param {{ maxBytes?: number, maxPartitions?: number }} [limits]
 * @returns {string[][]}
 */
export function partitionPages(importId, partitions, { maxBytes = PAGE_MAX_BYTES, maxPartitions = PAGE_MAX_PARTITIONS } = {}) {
  const pages = [];
  let page = [];
  let bytes = 0;
  for (const key of [...partitions].sort(compareStrings)) {
    const size = nquadsBytes(buildPartitionTriples(importId, key));
    if (page.length > 0 && (page.length >= maxPartitions || bytes + size > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(key);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Write one manifest part into its own Knowledge Asset and share the whole
 * asset. A re-run finds the asset where an earlier run left it: shared
 * (nothing to do), sealed by a share that did not complete (share it), or
 * still open (write again: a triple the draft already holds is not added
 * twice, then share).
 *
 * `triples` is the part's triples, or a function that gets what the earlier
 * run left in the asset (none for a new one), returns what to write, and may
 * refuse to go on. Answers whether the asset was shared already.
 */
async function shareManifestPart(client, { contextGraphId, subGraphName, name, triples }) {
  const created = await client.request('POST', '/api/knowledge-assets', { contextGraphId, name, subGraphName });
  if (created?.status === 'swm-shared') return { alreadyShared: true };
  const left = typeof triples === 'function' && created?.alreadyExists === true
    ? await readDraftTriples(client, { contextGraphId, subGraphName, name })
    : [];
  const toWrite = typeof triples === 'function' ? triples(left) : triples;
  if (created?.status !== 'wm-sealed') {
    await client.writeAssertion({ contextGraphId, assertionName: name, subGraphName, triples: toWrite });
  }
  const shared = await client.promote({ contextGraphId, assertionName: name, subGraphName });
  assertShared(shared, name);
  return { alreadyShared: false };
}

/** The triples of a Knowledge Asset's Working Memory draft. */
async function readDraftTriples(client, { contextGraphId, subGraphName, name }) {
  const params = new URLSearchParams({ contextGraphId, subGraphName });
  const res = await client.request('GET', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads?${params}`);
  return Array.isArray(res?.quads) ? res.quads : [];
}

function assertShared(result, name) {
  if (result?.swmShared === true) return;
  const errors = Array.isArray(result?.errors) ? result.errors.map((e) => e?.error ?? JSON.stringify(e)).join('; ') : '';
  const recovery = result?.recoveryJobId ? ` Its recovery job is ${result.recoveryJobId}.` : '';
  throw new Error(`Knowledge Asset '${name}' was not shared to shared memory${errors ? `: ${errors}` : ''}.${recovery}`);
}

/**
 * What of a manifest is already visible in SWM: the head (undefined when it
 * is not visible), with its partition count and partition-set hash, and
 * every declared partition.
 */
async function readManifestDeclarations({ client, importId, subGraphName }) {
  const [head, partitions] = await Promise.all([
    readManifestHead({ client, importId, subGraphName }),
    readDeclaredPartitions({ client, importId, subGraphName }),
  ]);
  return { head, partitions };
}

/** The visible head's partition count and partition-set hash, or undefined. */
async function readManifestHead({ client, importId, subGraphName }) {
  const rows = bindingsOf(await querySharedMemory(client, subGraphName, `
    PREFIX imp: <${IMPORT_NS}>
    SELECT ?count ?hash WHERE {
      GRAPH ?g {
        <${importUri(importId)}> imp:partitionCount ?count ;
                                 imp:partitionSetHash ?hash .
      }
    }
  `));
  return rows.length > 0
    ? { count: Number(unquote(rows[0].count)), hash: String(unquote(rows[0].hash)) }
    : undefined;
}

/** Every partition the manifest's visible pages declare, keyed by partition IRI. */
async function readDeclaredPartitions({ client, importId, subGraphName }) {
  const rows = selectAllRows(client, subGraphName, {
    select: '?part ?key ?initial',
    pattern: `<${importUri(importId)}> imp:partition ?part .
          ?part imp:key ?key ;
                imp:initialStatus ?initial .`,
    key: '?part',
  });
  const partitions = new Map();
  for await (const row of rows) {
    const part = bareUri(row.part);
    if (!partitions.has(part)) partitions.set(part, { key: unquote(row.key), initial: unquote(row.initial) });
  }
  return partitions;
}

/** The latest status event of each partition of the import that has one, keyed by partition IRI. */
async function readLatestStatusEvents({ client, importId, subGraphName }) {
  const rows = selectAllRows(client, subGraphName, {
    select: '?part ?ev ?status ?recordedAt',
    pattern: `?part imp:statusEvent ?ev .
          ?ev imp:status ?status ;
              imp:recordedAt ?recordedAt .
          FILTER(STRSTARTS(STR(?part), "${importUri(importId)}#part:"))`,
    key: '?ev',
  });
  const latest = new Map();
  for await (const row of rows) {
    const event = {
      part: bareUri(row.part),
      ev: bareUri(row.ev),
      status: unquote(row.status),
      recordedAt: String(unquote(row.recordedAt)).replace(/\^\^.*$/, ''),
    };
    const current = latest.get(event.part);
    if (!current || compareEvents(event, current) > 0) latest.set(event.part, event);
  }
  return latest;
}

/**
 * Event order: `recordedAt` (millisecond precision), then the event IRI,
 * whose zero-padded counter follows call order within one process.
 */
function compareEvents(a, b) {
  const at = timestamp(a.recordedAt);
  const bt = timestamp(b.recordedAt);
  if (at !== bt) return at > bt ? 1 : -1;
  return compareStrings(a.ev, b.ev);
}

function timestamp(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function differentPartitionSet(importId) {
  return new Error(
    `createImportManifest: manifest '${importId}' already exists with a different partition set. ` +
    `Refusing to merge old and new partitions; pass a new importId for a new import run.`,
  );
}

/**
 * Create an Import manifest that lists every partition this import will
 * write. All partitions start with `initialStatus = "pending"`; use
 * {@link markPartitionStatus} to record progress.
 *
 * The head and each partition page are written and shared as Knowledge
 * Assets of their own. Per ADR 0002 each write goes through
 * `DkgClient.writeAssertion` (which chunks at 500 quads/call by default —
 * well below the daemon's 10 MB body limit), and each page stays well under
 * the 4 MiB share cap.
 *
 * Calling it again for the same `importId` resumes: an asset that is already
 * shared is left as it is, an interrupted one is completed. A manifest that
 * already declares a different partition set is refused.
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client  Daemon client (with `cgId` set by `ensureProject`)
 * @param {string} opts.importId        Stable id for this import run (slug-safe)
 * @param {string[]} opts.partitions    Caller-defined partition keys, unique
 * @param {string} opts.subGraphName    Sub-graph that owns the manifest (typically `"meta"`)
 * @param {number} [opts.maxPartitionsPerPage]  Page size bound; defaults to `PAGE_MAX_PARTITIONS`
 * @returns {Promise<{ assertionName: string, importUri: string, pageAssertionNames: string[] }>}
 */
export async function createImportManifest({
  client,
  importId,
  partitions,
  subGraphName,
  assertionName,
  maxPartitionsPerPage = PAGE_MAX_PARTITIONS,
}) {
  if (assertionName !== undefined) {
    throw new Error(
      'createImportManifest no longer accepts `assertionName`: manifest assertion names are derived from importId so resume/status writes target the same assertion.',
    );
  }
  if (!client?.cgId) {
    throw new Error(
      'createImportManifest requires a DkgClient with `cgId` set (call client.ensureProject first).',
    );
  }
  if (!Array.isArray(partitions) || partitions.length === 0) {
    throw new Error('createImportManifest requires a non-empty `partitions` array.');
  }
  if (new Set(partitions).size !== partitions.length) {
    throw new Error('createImportManifest requires unique partition keys.');
  }
  if (!subGraphName) {
    throw new Error('createImportManifest requires `subGraphName` (typically "meta").');
  }
  const cgId = client.cgId;
  const head = defaultManifestAssertionName(importId);
  const importIri = importUri(importId);

  // A manifest that is already visible must declare exactly these partitions.
  // Anything it already shares is left as it is.
  const existing = await readManifestDeclarations({ client, importId, subGraphName });
  const requested = new Set(partitions);
  const visibleKeys = new Set([...existing.partitions.values()].map((p) => p.key));
  if (
    (existing.head !== undefined && existing.head.hash !== partitionSetHash(partitions)) ||
    [...visibleKeys].some((key) => !requested.has(key))
  ) {
    throw differentPartitionSet(importId);
  }

  if (existing.head === undefined) {
    const headTriples = buildImportHeadTriples(importId, partitions, new Date().toISOString());
    const hash = partitionSetHash(partitions);
    const { alreadyShared } = await shareManifestPart(client, {
      contextGraphId: cgId,
      subGraphName,
      name: head,
      // A head an interrupted run left unshared must be for these partitions, and keeps its `startedAt`.
      triples: (left) => {
        const leftHash = left.find((t) => t.predicate === IMPORT_P.partitionSetHash);
        if (leftHash && unquote(leftHash.object) !== hash) throw differentPartitionSet(importId);
        const hasStartedAt = left.some((t) => t.predicate === IMPORT_P.startedAt);
        return headTriples.filter((t) => !hasStartedAt || t.predicate !== IMPORT_P.startedAt);
      },
    });
    // Another run shared the head after the first read: it must be for these partitions too.
    if (alreadyShared) {
      const shared = await readManifestHead({ client, importId, subGraphName });
      if (shared === undefined) {
        throw new Error(`createImportManifest: the head of manifest '${importId}' is shared but not visible yet; try again.`);
      }
      if (shared.hash !== hash) throw differentPartitionSet(importId);
    }
  }
  const pageAssertionNames = [];
  for (const [index, keys] of partitionPages(importId, partitions, { maxPartitions: maxPartitionsPerPage }).entries()) {
    const name = partitionPageAssertionName(importId, index, keys);
    pageAssertionNames.push(name);
    if (keys.every((key) => visibleKeys.has(key))) continue;
    await shareManifestPart(client, {
      contextGraphId: cgId,
      subGraphName,
      name,
      triples: keys.flatMap((key) => buildPartitionTriples(importId, key)),
    });
  }
  return { assertionName: head, importUri: importIri, pageAssertionNames };
}

// Declarations never change once shared, so a process reads a manifest's
// partitions once and again only for a key it has not seen: a read per
// status write would cost a query over every asset of the sub-graph each time.
const declaredPartitionKeys = new WeakMap();

async function assertPartitionsDeclared({ client, importId, subGraphName }, keys, caller) {
  let byManifest = declaredPartitionKeys.get(client);
  if (!byManifest) {
    byManifest = new Map();
    declaredPartitionKeys.set(client, byManifest);
  }
  const manifestKey = JSON.stringify([client.cgId, subGraphName, importId]);
  let declared = byManifest.get(manifestKey);
  if (!declared || keys.some((key) => !declared.has(key))) {
    const partitions = await readDeclaredPartitions({ client, importId, subGraphName });
    declared = new Set([...partitions.values()].map((p) => p.key));
    byManifest.set(manifestKey, declared);
  }
  const undeclared = keys.find((key) => !declared.has(key));
  if (undeclared !== undefined) {
    throw new Error(
      `${caller}: partition '${undeclared}' is not declared in manifest '${importId}'. ` +
      `Call createImportManifest with the complete partition set before recording status events.`,
    );
  }
}

/** Body of the one request that creates, writes, seals and shares a status batch. */
function statusBatchBody({ contextGraphId, subGraphName, name, triples }) {
  return { contextGraphId, name, subGraphName, quads: triples, alsoShareSwm: true };
}

/** Bytes a batch body takes beyond its quads, with room for the longest name. */
const STATUS_BATCH_BODY_OVERHEAD_BYTES = 1024;

/**
 * Write status events as Knowledge Assets of their own: each batch is
 * created, written, sealed and shared in a single request and never changed
 * afterwards. A batch holds as many events as fit in `STATUS_BATCH_MAX_BYTES`.
 */
async function recordStatusEvents({ client, importId, subGraphName, statuses }, caller) {
  await assertPartitionsDeclared({ client, importId, subGraphName }, statuses.map((s) => s.partitionKey), caller);

  const contextGraphId = client.cgId;
  const recordedAt = new Date().toISOString();
  const recorded = [];
  let batch = [];
  let batchBytes = STATUS_BATCH_BODY_OVERHEAD_BYTES;
  const flush = async () => {
    const name = statusBatchAssertionName(importId, batch[0].eventUri);
    const shared = await client.request('POST', '/api/knowledge-assets', statusBatchBody({
      contextGraphId,
      subGraphName,
      name,
      triples: batch.flatMap((event) => event.triples),
    }));
    assertShared(shared, name);
    for (const { partitionKey, status, eventUri } of batch) recorded.push({ partitionKey, status, eventUri, assertionName: name });
    batch = [];
    batchBytes = STATUS_BATCH_BODY_OVERHEAD_BYTES;
  };
  for (const { partitionKey, status } of statuses) {
    const eventUri = statusEventUri(importId, partitionKey);
    const triples = buildStatusEventTriples(importId, partitionKey, eventUri, status, recordedAt);
    const bytes = Buffer.byteLength(JSON.stringify(triples), 'utf8');
    if (batch.length > 0 && batchBytes + bytes > STATUS_BATCH_MAX_BYTES) await flush();
    batch.push({ partitionKey, status, eventUri, triples });
    batchBytes += bytes;
  }
  await flush();
  return recorded;
}

/**
 * Record status events for several partitions at once, in as few Knowledge
 * Assets as their size allows (one for an ordinary batch). Events of one call
 * share their `recordedAt`; for the same partition, a later entry wins.
 *
 * `status` is caller-defined. Conventional values are `"pending"`,
 * `"in_progress"`, `"done"`, `"failed"`, `"skipped"`. The library does
 * not validate the value.
 *
 * @param {object} opts
 * @param {import('./dkg-daemon.mjs').DkgClient} opts.client
 * @param {string} opts.importId
 * @param {Array<{ partitionKey: string, status: string }>} opts.statuses
 * @param {string} opts.subGraphName
 * @returns {Promise<Array<{ partitionKey: string, status: string, eventUri: string, assertionName: string }>>}
 */
export async function markPartitionStatuses({
  client,
  importId,
  statuses,
  subGraphName,
  assertionName,
}) {
  if (assertionName !== undefined) {
    throw new Error(
      'markPartitionStatuses does not accept `assertionName`: manifest assertion names are derived from importId so resume/status writes target the same assertion.',
    );
  }
  if (!client?.cgId) {
    throw new Error('markPartitionStatuses requires a DkgClient with `cgId` set.');
  }
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error('markPartitionStatuses requires a non-empty `statuses` array.');
  }
  if (statuses.some((entry) => !entry?.partitionKey || !entry.status)) {
    throw new Error('markPartitionStatuses requires `partitionKey` and `status` in every entry.');
  }
  if (!subGraphName) throw new Error('markPartitionStatuses requires `subGraphName`.');
  return recordStatusEvents({ client, importId, subGraphName, statuses }, 'markPartitionStatuses');
}

/**
 * Append a StatusEvent for a partition. Status events are append-only;
 * `loadImportManifest` resolves the "current" status by taking the latest
 * event per partition. Each call writes one small Knowledge Asset; use
 * {@link markPartitionStatuses} to record many partitions in one.
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
 * @returns {Promise<{ partitionKey: string, status: string, eventUri: string, assertionName: string }>}
 */
export async function markPartitionStatus({
  client,
  importId,
  partitionKey,
  status,
  subGraphName,
  assertionName,
}) {
  if (assertionName !== undefined) {
    throw new Error(
      'markPartitionStatus no longer accepts `assertionName`: manifest assertion names are derived from importId so resume/status writes target the same assertion.',
    );
  }
  if (!client?.cgId) {
    throw new Error('markPartitionStatus requires a DkgClient with `cgId` set.');
  }
  if (!partitionKey) throw new Error('markPartitionStatus requires `partitionKey`.');
  if (!status) throw new Error('markPartitionStatus requires `status`.');
  if (!subGraphName) throw new Error('markPartitionStatus requires `subGraphName`.');
  const [event] = await recordStatusEvents(
    { client, importId, subGraphName, statuses: [{ partitionKey, status }] },
    'markPartitionStatus',
  );
  return event;
}

/**
 * Read back the manifest and resolve each partition's current status as
 * the latest StatusEvent (falling back to `initialStatus = "pending"` if
 * no events have been recorded for that partition).
 *
 * Returns `{ importUri, partitions: [{ key, status, uri, recordedAt }] }`
 * sorted by partition key. `recordedAt` is `null` for partitions still on
 * the initial status (no events). Fails when the head or any declared
 * partition is not visible yet, so a resume never skips a partition it
 * cannot see.
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
  const [{ head, partitions: declared }, latest] = await Promise.all([
    readManifestDeclarations({ client, importId, subGraphName }),
    readLatestStatusEvents({ client, importId, subGraphName }),
  ]);
  if (head === undefined) {
    throw new Error(
      `No import manifest rows found for '${importId}' in context graph '${cgId}' ` +
      `sub-graph '${subGraphName}'. The manifest is missing or not visible in shared memory.`,
    );
  }
  if (declared.size < head.count) {
    throw new Error(
      `Import manifest '${importId}' in context graph '${cgId}' sub-graph '${subGraphName}' is incomplete in ` +
      `shared memory: ${declared.size} of ${head.count} partitions are visible. Run createImportManifest ` +
      `again with the same partitions to finish it, or wait until this node has received all of it.`,
    );
  }
  if (partitionSetHash([...declared.values()].map((p) => p.key)) !== head.hash) {
    throw new Error(
      `Import manifest '${importId}' in context graph '${cgId}' sub-graph '${subGraphName}' declares partitions ` +
      `its head does not list: another partition set was written under the same importId. ` +
      `Pass a new importId for a new import run.`,
    );
  }
  const partitions = [...declared].map(([part, { key, initial }]) => {
    const event = latest.get(part);
    return {
      key,
      status: event?.status ?? initial ?? 'pending',
      uri: part,
      recordedAt: event?.recordedAt ?? null,
    };
  });
  partitions.sort((a, b) => compareStrings(a.key, b.key));
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
