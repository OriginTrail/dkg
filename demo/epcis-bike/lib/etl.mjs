#!/usr/bin/env node
// ETL: assembly-line cycle records JSON → EPCIS 2.0 documents (one per station event).
//
// Reads a raw `acme-bikes-line-w18.json` array (or any file with the same
// shape — `[ { trace_id, unit_id, unit_name, process_name, ended, product_id,
// items: { <id>: { status } } }, ... ]`), filters to a single trace_id,
// sorts ascending by `ended`, and emits one EPCIS document per cycle record
// into the fixtures directory.
//
// Usage:
//   node lib/etl.mjs                      # uses committed synthesized source
//   node lib/etl.mjs \
//     --source ./fixtures/source-raw/acme-bikes-line-w18.json \
//     --trace-id 7c4f8d2a-9e3b-4a6d-b517-8f9e0a1b2c3d \
//     --out ./fixtures
//
// Defaults pick the canonical demo trace and write to ../fixtures.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpcisDocument } from './epc-mapping.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(SELF_DIR, '..', 'fixtures');
const DEFAULT_TRACE_ID = '7c4f8d2a-9e3b-4a6d-b517-8f9e0a1b2c3d';
// The synthesized source is committed in this repo (it's fully fictional, no
// partner data). Default the ETL to read from that committed path so
// `node lib/etl.mjs` works zero-config from a clean clone. Override with
// `--source <path>` (or `BIKE_SOURCE` env var) to point at an alternate
// source file with the same shape.
const DEFAULT_SOURCE =
  process.env.BIKE_SOURCE
  ?? resolve(SELF_DIR, '..', 'fixtures', 'source-raw', 'acme-bikes-line-w18.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    // Split on the FIRST `=` only — `argv[i].split('=')` truncates
    // values that themselves contain `=` (e.g. `--source=/tmp/a=b.json`
    // would lose `=b.json`). indexOf+slice keeps the value lossless.
    const eqIdx = argv[i].indexOf('=');
    const [key, val] = eqIdx >= 0
      ? [argv[i].slice(0, eqIdx), argv[i].slice(eqIdx + 1)]
      : [argv[i], argv[i + 1]];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = val;
    if (eqIdx < 0) i += 1;
  }
  return args;
}

// Encode a value for use as a filename segment. Use percent-encoding so
// distinct source values (`Paint/QA`, `Paint QA`, `Paint_QA`, `Paint-É`)
// stay distinct in the resulting filename. The earlier lossy
// `[^A-Za-z0-9_-] → _` substitution silently collapsed all of those to
// `Paint_QA` and would let a fresh `BIKE_SOURCE` overwrite one event's
// document with another's mid-ETL. `encodeURIComponent` outputs `%XX`
// sequences which are valid in filenames on every major filesystem
// (macOS HFS+/APFS, Linux ext4/btrfs/xfs, Windows NTFS, ZFS) and survives
// `Object.fromEntries` / round-trip use cases via `decodeURIComponent`.
function safeName(processName) {
  return encodeURIComponent(String(processName ?? 'unknown'));
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

export async function runEtl({
  source = DEFAULT_SOURCE,
  traceId = DEFAULT_TRACE_ID,
  outDir = DEFAULT_OUT,
} = {}) {
  const sourceContent = await readFile(source, 'utf-8');
  const sourceHash = `sha256:${createHash('sha256').update(sourceContent).digest('hex')}`;
  const allRecords = JSON.parse(sourceContent);

  if (!Array.isArray(allRecords)) {
    throw new Error(`Source ${source} is not an array of cycle records`);
  }

  // Lexical (`.localeCompare`) sort on `ended` only produces correct
  // chronological order when every timestamp shares the same offset
  // suffix. With arbitrary BIKE_SOURCE inputs that allow mixed offsets
  // (e.g. `08:00:00-05:00` next to `09:00:00Z`), lexical comparison
  // mis-orders records — which then changes ADD/OBSERVE assignment
  // (first-seen tracking depends on iteration order) and the manifest's
  // `time_range`. Pre-validate every timestamp via `Date.parse` so the
  // ETL fails loudly on bad input instead of silently producing
  // wrong-order events, then sort on the parsed instant.
  const filteredRecords = allRecords.filter((r) => r?.trace_id === traceId);
  // Pre-validate timestamps with TWO checks:
  //   (a) parseable by Date.parse — catches malformed inputs
  //   (b) explicit timezone offset — Date.parse interprets naive
  //       timestamps in the host's LOCAL timezone, so sorting them
  //       lexicographically next to UTC values mis-orders records on
  //       non-UTC hosts. EPCIS event documents also require an
  //       explicit offset (`extractTzOffset` in epc-mapping.mjs
  //       rejects naive inputs as a secondary defense). Failing here
  //       makes the ambiguity loud at ETL time rather than at
  //       publish time.
  const isoOffsetSuffix = /(?:Z|[+-]\d{2}:?\d{2})$/;
  for (const r of filteredRecords) {
    if (Number.isNaN(Date.parse(r?.ended))) {
      throw new Error(
        `Source contains invalid timestamp: trace_id=${r?.trace_id} ` +
          `unit_id=${r?.unit_id} ended=${JSON.stringify(r?.ended)}`,
      );
    }
    if (typeof r?.ended !== 'string' || !isoOffsetSuffix.test(r.ended)) {
      throw new Error(
        `Source timestamp lacks an explicit timezone offset (Z or ±HH:MM): ` +
          `trace_id=${r?.trace_id} unit_id=${r?.unit_id} ended=${JSON.stringify(r?.ended)}`,
      );
    }
  }
  const traceRecords = filteredRecords.sort(
    (a, b) => Date.parse(a.ended) - Date.parse(b.ended),
  );

  if (traceRecords.length === 0) {
    throw new Error(`No records found for trace_id ${traceId} in ${source}`);
  }

  await mkdir(outDir, { recursive: true });

  const existingEntries = await readdir(outDir).catch(() => []);
  const currentManifestName = `trace-${traceId}-bike-line.json`;
  // Enforce single-trace-per-outDir. Two traces can't coexist safely in
  // the same dir because the event-NN-*.json filenames are scoped only
  // by ordinal + station, so a regen of trace B with the same outDir as
  // trace A would silently overwrite A's `event-01-StationA.json` with
  // B's `event-01-StationA.json` while leaving A's `trace-<A>-bike-line.json`
  // pointing at the now-corrupted file. Reject the second trace upfront
  // with a clear remediation pointer instead of producing a quietly-
  // broken fixture set.
  const manifestShape = /^trace-([^/\\]+?)-bike-line\.json$/;
  const otherManifests = existingEntries.filter(
    (f) => manifestShape.test(f) && f !== currentManifestName,
  );
  if (otherManifests.length > 0) {
    throw new Error(
      `outDir ${outDir} already contains a different trace's manifest(s): ${otherManifests.join(', ')}. ` +
        'The demo enforces single-trace-per-outDir to prevent event-NN-*.json filename collisions ' +
        'between traces (different traces share the same event-NN-<station>.json shape). ' +
        `Use a different --out for trace_id=${traceId}, or remove the stale manifest(s) and their listed events first.`,
    );
  }

  // Clean prior fixture files for THIS traceId — files listed in the
  // previous manifest, plus the prior manifest itself. The single-trace-
  // per-outDir rule above guarantees no sibling traces' files exist
  // here, so the cleanup is straightforward: remove everything THIS
  // trace wrote on the previous run, then write the new fixtures.
  if (existingEntries.includes(currentManifestName)) {
    const filesToRemove = new Set();
    try {
      const prev = JSON.parse(
        await readFile(join(outDir, currentManifestName), 'utf-8'),
      );
      if (Array.isArray(prev?.events)) {
        for (const ev of prev.events) {
          if (typeof ev?.file === 'string') filesToRemove.add(ev.file);
        }
      }
      // Remove THIS trace's prior manifest so a regen leaves only the
      // freshly-written one.
      filesToRemove.add(currentManifestName);
    } catch {
      // Malformed prior manifest — skip cleanup; we'd rather leak a
      // stale file than delete files based on a partial parse.
    }
    // Resolve each candidate to an absolute path and verify it stays
    // INSIDE outDir before deleting. A corrupted or hand-edited
    // manifest with `../` segments in `events[].file` could otherwise
    // make a regen unlink files outside the demo's fixtures dir
    // (worst case: anywhere on the filesystem the user has write
    // access). Use `path.relative(outDir, target)` for the containment
    // check rather than a hardcoded slash prefix — the previous
    // `${outDir}/` approach broke on Windows where `path.resolve`
    // returns `C:\\fixtures\\event.json` and `${outDir}/` is
    // `C:\\fixtures/`, so `startsWith` always returned false and
    // cleanup was silently skipped on Windows hosts. `relative()`
    // returns a string starting with `..` (or absolute on different
    // drives) when the target escapes the base, which works on every
    // platform.
    const outDirResolved = resolve(outDir);
    for (const entry of filesToRemove) {
      const target = resolve(outDir, entry);
      const rel = relative(outDirResolved, target);
      // Inside outDir: `relative` is a non-empty path that doesn't
      // start with `..` and isn't absolute. Reject anything else:
      //   - `..`-prefixed → POSIX/Windows directory traversal up.
      //   - Absolute → on Windows, `path.relative` returns the
      //     absolute target when it lives on a different drive
      //     (`relative('C:\\fixtures', 'D:\\foo\\bar')` = `'D:\\foo\\bar'`).
      //     Without this guard, `resolve(outDirResolved, rel)` equals
      //     target (since `resolve` accepts absolute segments) and the
      //     containment check would falsely pass — letting unlink
      //     touch an arbitrary file on another drive.
      //   - The `resolve()` round-trip equality check catches edge
      //     cases where `relative` would silently normalize away a
      //     traversal (defense-in-depth).
      if (rel.startsWith('..') || isAbsolute(rel) || resolve(outDirResolved, rel) !== target) {
        // Suspect path-traversal — skip silently (we'd rather leak a
        // stale file than execute a path that escapes outDir).
        continue;
      }
      await unlink(target).catch(() => {});
    }
  }

  // Use the latest source-record timestamp as the document's
  // `creationDate` (and as `source-snapshot.json`'s `extracted_at`)
  // instead of `new Date().toISOString()`. Wall-clock time would
  // rewrite every committed `event-NN-*.json` plus `source-snapshot.json`
  // on every regeneration even when the source file hasn't changed,
  // contradicting the "regenerate unchanged" guarantee the README
  // advertises and producing noisy diffs that obscure real changes.
  // The latest `ended` is a reasonable proxy for "when this trace was
  // collected" — and it's deterministic for a fixed source.
  const creationDate = traceRecords.at(-1).ended;
  const events = [];
  const stations = new Set();
  const products = new Set();
  // EPCIS `action: ADD` means "first observation of these EPCs in the
  // trace". Track first-seen per item rather than per-record-index so
  // that when a single source record splits into multiple status groups,
  // EVERY sibling doc whose items haven't appeared yet gets ADD —
  // not just the first sibling. For the current uniform-status trace
  // this still produces "doc 1: ADD, docs 2..N: OBSERVE" identically.
  const seenEpcs = new Set();

  for (let i = 0; i < traceRecords.length; i += 1) {
    const rec = traceRecords[i];
    // Validate `items` is a plain object whose values are item objects.
    // `BIKE_SOURCE` is external input, so accept-anything-truthy +
    // `Object.keys(rec.items ?? {})` would silently turn arrays into
    // synthetic numeric EPC IDs (`"0"`, `"1"`...) and strings into
    // per-character ones. The downstream EPCIS document is malformed
    // either way; failing here points at the actual cause (a malformed
    // source record) instead of leaving a stack trace at the publisher.
    if (rec.items === undefined || rec.items === null) continue;
    if (typeof rec.items !== 'object' || Array.isArray(rec.items)) {
      throw new Error(
        `Source record has malformed \`items\`: expected a plain object, ` +
          `got ${Array.isArray(rec.items) ? 'array' : typeof rec.items} ` +
          `(trace_id=${rec.trace_id} unit_id=${rec.unit_id} ended=${JSON.stringify(rec.ended)})`,
      );
    }
    for (const [itemId, itemVal] of Object.entries(rec.items)) {
      if (itemVal === null || typeof itemVal !== 'object' || Array.isArray(itemVal)) {
        throw new Error(
          `Source record has malformed \`items.${itemId}\`: expected a plain object ` +
            `(with at least an optional \`status\` field), got ${Array.isArray(itemVal) ? 'array' : typeof itemVal} ` +
            `(trace_id=${rec.trace_id} unit_id=${rec.unit_id} ended=${JSON.stringify(rec.ended)})`,
        );
      }
    }
    const itemIds = Object.keys(rec.items);
    if (itemIds.length === 0) continue;

    // If items have heterogeneous statuses, group them so each EPCIS event
    // has a single disposition. In practice for this trace they're uniform,
    // but we don't want to lie about disposition if multiple statuses appear.
    // Use Object.create(null) so a status string of `__proto__`,
    // `constructor`, etc. doesn't walk the prototype chain. With a
    // plain `{}`, `byStatus['__proto__']` resolves to Object.prototype
    // and `(byStatus[status] ??= []).push(itemId)` either fails (the
    // prototype isn't an array) or pollutes the object's prototype
    // chain. A null-prototype object has no inherited properties so
    // any string key is safe.
    const byStatus = Object.create(null);
    for (const itemId of itemIds) {
      const status = rec.items[itemId]?.status ?? 'Skipped';
      (byStatus[status] ??= []).push(itemId);
    }

    const groupCount = Object.keys(byStatus).length;
    for (const [status, ids] of Object.entries(byStatus)) {
      // EPCIS `action` is a per-item semantic: ADD = first observation
      // of these EPCs, OBSERVE = subsequent observation. When a single
      // status bucket holds BOTH first-seen and already-seen items, no
      // single action is correct for the bucket as a whole:
      //   - `some(unseen)` (was) → bucket = ADD → already-seen items
      //     get re-added, violating spec.
      //   - `every(unseen)` (was) → bucket = OBSERVE → first-seen items
      //     lose their first-observation semantic.
      // Splitting the bucket is the EPCIS-correct option: emit one doc
      // per (status, action) sub-bucket. For the synthesized uniform-
      // status fixture only one of the sub-buckets is ever populated
      // per record, so the committed event-*.json files regenerate
      // identically (single sub-bucket → no `groupKey` suffix → eventID
      // seed unchanged from the back-compat shape).
      const firstSeen = ids.filter((id) => !seenEpcs.has(id));
      const observed = ids.filter((id) => seenEpcs.has(id));
      for (const id of ids) seenEpcs.add(id);

      const actionSubBuckets = [];
      if (firstSeen.length > 0) actionSubBuckets.push({ ids: firstSeen, action: 'ADD' });
      if (observed.length > 0) actionSubBuckets.push({ ids: observed, action: 'OBSERVE' });

      for (const sub of actionSubBuckets) {
        // Disambiguate sibling docs from a single source record. When a
        // record yields multiple status buckets (`groupCount > 1`) OR a
        // bucket itself splits into ADD/OBSERVE sub-buckets, every
        // sibling needs a distinct eventID. The publisher's duplicate-
        // root validator rejects collisions on the second-onward sibling
        // otherwise. When neither split applies, leave `groupKey`
        // undefined so the eventID seed matches the back-compat
        // `(trace, unit, ended)` shape and the committed fixtures
        // regenerate unchanged.
        // Encode the (status, action) pair structurally, not as
        // `<status>-<action>`. A source status that itself contains
        // a hyphen (e.g. `In-Progress` or worse, a literal `Passed-add`)
        // would collide with the split key for `(status='Passed',
        // action='ADD')` under hyphen-join — both seeds become
        // `Passed-add` and the publisher's duplicate-root validator
        // rejects the second sibling. JSON.stringify of a fixed-key
        // object guarantees unique encoding for distinct (status,
        // action) inputs (status is JSON-string-escaped, key order
        // is the insertion order JS preserves for non-numeric keys).
        const groupKeyParts = {};
        if (groupCount > 1) groupKeyParts.status = status;
        if (actionSubBuckets.length > 1) groupKeyParts.action = sub.action.toLowerCase();
        const groupKey = Object.keys(groupKeyParts).length > 0
          ? JSON.stringify(groupKeyParts)
          : undefined;
        const isFirstInTrace = sub.action === 'ADD';

        const doc = buildEpcisDocument({
          traceId: rec.trace_id,
          unitId: rec.unit_id,
          unitName: rec.unit_name,
          processName: rec.process_name,
          ended: rec.ended,
          itemIds: sub.ids,
          status,
          groupKey,
          isFirstInTrace,
          creationDate,
        });

        const fileNum = events.length + 1;
        // Filename suffixes mirror the same two split axes. `safeName`
        // covers multi-word / slashed / non-ASCII statuses (`In Progress`,
        // `Hold/Recheck`) that would otherwise create nested paths or
        // fail `writeFile`. The action suffix appears only when an
        // ADD/OBSERVE split fires.
        const statusSuffix = groupCount > 1 ? `-${safeName(status).toLowerCase()}` : '';
        const actionSuffix = actionSubBuckets.length > 1 ? `-${sub.action.toLowerCase()}` : '';
        const filename = `event-${pad(fileNum)}-${safeName(rec.process_name)}${statusSuffix}${actionSuffix}.json`;
        const fullPath = join(outDir, filename);
        await writeFile(fullPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');

        events.push({
          file: filename,
          eventID: doc.epcisBody.eventList[0].eventID,
          eventTime: rec.ended,
          process_name: rec.process_name,
          unit_name: rec.unit_name,
          unit_id: rec.unit_id,
          item_ids: sub.ids,
          status,
          action: doc.epcisBody.eventList[0].action,
          bizStep: doc.epcisBody.eventList[0].bizStep,
          disposition: doc.epcisBody.eventList[0].disposition,
        });

        stations.add(rec.process_name);
        products.add(rec.product_id);
      }
    }
  }

  // Guard against the all-skipped case before reading events[0]/at(-1).
  // If every traceRecord has an empty `items` map (or no usable items), we
  // exit the inner loop with `events` still empty. Indexing `events[0]` then
  // throws "Cannot read properties of undefined", masking the real cause
  // (the source dump filtered to nothing). Throw a precise error instead so
  // the demo's Phase 1 fail message points at the input, not a stack trace.
  if (events.length === 0) {
    throw new Error(
      `No EPCIS events extracted for trace_id ${traceId}: ` +
        `${traceRecords.length} record(s) matched but none yielded items ` +
        '(check the `items` map is populated in the source dump).',
    );
  }

  const traceManifest = {
    trace_id: traceId,
    event_count: events.length,
    products: Array.from(products),
    stations: Array.from(stations),
    time_range: [events[0].eventTime, events.at(-1).eventTime],
    events,
  };
  await writeFile(
    join(outDir, `trace-${traceId}-bike-line.json`),
    `${JSON.stringify(traceManifest, null, 2)}\n`,
    'utf-8',
  );

  // Persist only the source file's basename to avoid baking a developer's
  // absolute path (e.g. /Users/<name>/...) into committed fixtures. The
  // hash + trace_id are sufficient to identify which source produced these
  // events; the full path is kept in uncommitted local state if needed.
  // `source_max_event_time` is named honestly: it's the max `ended`
  // timestamp from the source records, NOT the wall-clock time the ETL
  // ran. Earlier this field was named `extracted_at`, which implied a
  // real extraction-time stamp — but the value is deterministically
  // derived from input data (so committed fixtures regenerate byte-
  // identically) and consumers that audit/sort on a true ETL-run time
  // would be misled. Renaming makes the semantics match the value.
  const sourceSnapshot = {
    source_basename: basename(source),
    source_hash: sourceHash,
    source_max_event_time: creationDate,
    trace_id: traceId,
    records_in_trace: traceRecords.length,
    events_emitted: events.length,
  };
  await writeFile(
    join(outDir, 'source-snapshot.json'),
    `${JSON.stringify(sourceSnapshot, null, 2)}\n`,
    'utf-8',
  );

  return { traceManifest, sourceSnapshot, outDir };
}

// Resolve both sides through `fileURLToPath` + `resolve` rather than the
// naive string compare `import.meta.url === \`file://${process.argv[1]}\``.
// Naive concat breaks on URL-encoded paths (spaces, unicode), Windows
// drive letters (`C:\…` → `file://C:\…` is not a valid URL — the canonical
// form is `file:///C:/…`), and any path Node normalises (e.g. `./foo.mjs`
// run from the cwd). Both sides go through the same canonicalisation here
// so the entry-point check fires when expected on every platform.
const isMain =
  process.argv[1] !== undefined
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source ?? DEFAULT_SOURCE;
  if (!source) {
    process.stderr.write(
      'ETL needs a source: pass `--source <path-to-bike-json>` or set BIKE_SOURCE.\n' +
        'The committed default points at `fixtures/source-raw/acme-bikes-line-w18.json`,\n' +
        'which holds the synthesized 7-station trace this demo uses.\n',
    );
    process.exit(2);
  }
  try {
    const result = await runEtl({
      source,
      traceId: args['trace-id'] ?? DEFAULT_TRACE_ID,
      outDir: args.out ?? DEFAULT_OUT,
    });
    process.stdout.write(
      `Wrote ${result.traceManifest.event_count} EPCIS documents to ${result.outDir}\n`,
    );
    process.stdout.write(
      `Stations: ${result.traceManifest.stations.join(', ')}\n`,
    );
  } catch (err) {
    process.stderr.write(`ETL failed: ${err.message}\n`);
    process.exit(1);
  }
}
