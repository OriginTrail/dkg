/**
 * Read-only compatibility helpers for legacy resumable-import manifests.
 *
 * Atomic whole-KA sharing cannot safely update the original monolithic
 * selector-based manifest. This module therefore exposes only URI, parsing,
 * query, and `loadImportManifest` helpers for inspecting manifests created by
 * older nodes. Deprecated mutation names live in
 * `manifest-mutations-compat.mjs` and always fail before daemon access.
 *
 * An "Import" is a logical bulk-write operation that splits itself into
 * "Partitions" — typically one partition per source artefact (e.g. one
 * file in a code import, one PR in a GitHub import). The manifest is
 * itself an RDF assertion in the project's `meta` sub-graph so it can
 * be queried, gossiped, and resumed from any node.
 *
 * Historically, status events were append-only: each `markPartitionStatus` call wrote
 * a new `StatusEvent` triple with a timestamp; the "current" status of
 * a partition is the latest event by `recordedAt`, with the event IRI as a
 * deterministic tie-breaker when two writes land in the same millisecond.
 * This avoids needing SPARQL DELETE/INSERT (which the daemon doesn't expose)
 * and gives a complete history "for free".
 *
 * New importers must keep resumability state in an external durable store
 * until the manifest is redesigned as independently shareable, size-bounded
 * Knowledge Assets.
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
  key: IMPORT_NS + 'key',
  initialStatus: IMPORT_NS + 'initialStatus',
  statusEvent: IMPORT_NS + 'statusEvent',
  status: IMPORT_NS + 'status',
  recordedAt: IMPORT_NS + 'recordedAt',
};

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
 * Retained for legacy readers and migration tooling that must reproduce the
 * historical assertion-name mapping. It does not enable manifest mutation.
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
      `Pick an importId containing at least one valid character.`,
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
      `Pick a simpler importId for legacy read or migration tooling.`,
    );
  }
  return `${prefix}${slug}-${hash}`;
}

/** Stable URI for a Partition within an Import. */
export function partitionUri(importId, key) {
  return `${importUri(importId)}#part:${encodeURIComponent(key)}`;
}

/**
 * Single-round-trip existence check: does the manifest for `importId` declare
 * `partitionKey` as one of its partitions?
 *
 * `markPartitionStatus` used to validate the partition by loading the entire
 * manifest, but that turns status-tracking quadratic for bulk imports: a
 * 10k-partition import marking each one twice (in_progress + done) ran 20k
 * full SWM materialisations, each several round-trips. This helper replaces
 * that with a SPARQL `ASK` against the SWM tier — one row, one network call.
 *
 * Resolves Codex comment on PR #642 (quadratic validation).
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
      <${importIri}> imp:partition <${partIri}> .
    }
  `;
  const res = await client.query({
    sparql,
    contextGraphId: client.cgId,
    subGraphName,
    graphSuffix: '_shared_memory',
  });
  // The daemon's ASK response shape is the same as `/api/query`: either
  // `{boolean: true}` (Oxigraph) or `{result: {boolean: true}}` (SPARQL HTTP).
  // Tolerate both.
  if (typeof res?.boolean === 'boolean') return res.boolean;
  if (typeof res?.result?.boolean === 'boolean') return res.result.boolean;
  // Belt-and-braces fallback: some test mocks return bindings even for an
  // ASK-shaped query. Treat any non-empty binding set as `true`.
  const bindings = res?.result?.bindings ?? res?.bindings ?? [];
  return bindings.length > 0;
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
