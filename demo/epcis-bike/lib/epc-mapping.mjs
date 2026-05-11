// Stable mapping rules: assembly cycle records → EPCIS 2.0 ObjectEvent fields.
//
// All rules are intentionally simple two-bucket / lookup-table style, so the
// design doc's mapping table matches what the code does, line for line.

import { createHash } from 'node:crypto';

// DNS namespace UUID — used as the v5 namespace for deriving deterministic event IDs.
// Pinned so regenerating the fixture from the same source yields identical eventIDs.
const UUID_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export const BIKE_URN_PREFIX = 'urn:acme:bike';

export const CBV_BIZSTEP_BASE = 'https://ref.gs1.org/cbv/BizStep-';
export const CBV_DISP_BASE = 'https://ref.gs1.org/cbv/Disp-';

export const EPCIS_CONTEXT = {
  '@vocab': 'https://gs1.github.io/EPCIS/',
  epcis: 'https://gs1.github.io/EPCIS/',
  cbv: 'https://ref.gs1.org/cbv/',
  type: '@type',
  id: '@id',
  eventID: '@id',
};

// Encode a value for use as a URN local segment. We use percent-encoding
// (`encodeURIComponent`) so the result is BOTH a valid URN segment AND
// reversible — distinct source identifiers like `BIKE/A` vs `BIKE A`
// vs `Paint-É` no longer collapse to the same EPC, which a lossy
// `[^A-Za-z0-9_-] → _` substitution would do (and silently merge two
// separate items or stations into one graph entity for any non-trivial
// real-world export). `encodeURIComponent` leaves alphanumerics,
// `-`, `_`, `.`, `!`, `~`, `*`, `'`, `(`, `)` untouched and percent-
// encodes everything else (including space, slash, accented chars),
// which is the standard `pchar` set in RFC 3986 / RFC 8141.
//
// Note: this URN segment no longer matches `etl.mjs#safeName` (which
// stays lossy because filesystem segments can use `_` freely without
// collision risk for THIS demo's deterministic source). For arbitrary
// `BIKE_SOURCE` exports the URN remains unique even when the on-disk
// filename collapses similar-looking process names into one.
function safeUrnSegment(value) {
  return encodeURIComponent(String(value));
}

export function itemEpc(itemId) {
  if (!itemId) throw new Error('itemEpc: itemId is required');
  return `${BIKE_URN_PREFIX}:item:${safeUrnSegment(itemId)}`;
}

export function stationUri(processName) {
  if (!processName) throw new Error('stationUri: processName is required');
  return `${BIKE_URN_PREFIX}:station:${safeUrnSegment(processName)}`;
}

// Two-bucket bizStep rule: anything that names an inspection/test → CBV `inspecting`,
// everything else → CBV `assembling`.
const INSPECTION_PATTERN = /inspection|test|inspecting/i;

export function bizStepFor(processName) {
  return INSPECTION_PATTERN.test(processName ?? '')
    ? `${CBV_BIZSTEP_BASE}inspecting`
    : `${CBV_BIZSTEP_BASE}assembling`;
}

const STATUS_TO_DISPOSITION = {
  Passed: `${CBV_DISP_BASE}in_progress`,
  Rejected: `${CBV_DISP_BASE}damaged`,
  Skipped: `${CBV_DISP_BASE}unknown`,
};

export function dispositionFor(status) {
  return STATUS_TO_DISPOSITION[status] ?? `${CBV_DISP_BASE}unknown`;
}

// Deterministic UUIDv5 from (trace_id, unit_id, process_name, ended
// [, groupKey]). Same inputs → same output. `processName` is part of the
// seed because real `BIKE_SOURCE` exports often use per-station cycle
// counters where two records can share `unit_id` and `ended` but differ
// in station — without `processName` in the seed those records would
// hash to the same eventID and trip the publisher's duplicate-root
// rejection on the second one. The synthesized fixture's `unit_id` is
// already station-unique (`cycle-W18-001`..`cycle-W18-007`), so adding
// `processName` doesn't change its eventIDs in practice — the seed
// gains a new component but every record's component is unique anyway.
// `groupKey` is included only when one source record splits into
// multiple sibling EPCIS docs (mixed statuses, mixed first-seen actions).
export function eventId(traceId, unitId, processName, ended, groupKey) {
  if (!traceId || !unitId || !processName || !ended) {
    throw new Error('eventId: traceId, unitId, processName, ended all required');
  }
  const seed = groupKey
    ? `acme-bike|${traceId}|${unitId}|${processName}|${ended}|${groupKey}`
    : `acme-bike|${traceId}|${unitId}|${processName}|${ended}`;
  return `urn:uuid:${uuidv5(seed, UUID_DNS_NAMESPACE)}`;
}

function uuidv5(name, namespace) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Derive `eventTimeZoneOffset` from an ISO 8601 timestamp's trailing
// offset. `eventTime` is copied verbatim from the source's `ended`
// field, so its offset and `eventTimeZoneOffset` must agree — hard-
// coding `+00:00` would silently mis-attribute non-UTC source data
// (e.g. `2026-05-12T08:00:00-05:00` would round-trip as 8 AM UTC,
// not 8 AM US Eastern).
//
// REJECT naive timestamps (no `Z` and no `±HH:MM`/`±HHMM` suffix)
// rather than silently rewriting them as `+00:00`. The previous
// default created a divergence with the ETL's `Date.parse()` sort,
// which interprets naive timestamps in the host machine's LOCAL
// timezone — so on a non-UTC host, the source could be ordered as
// local time but published as UTC, shifting the recorded instant by
// hours. Failing here makes that ambiguity loud (the ETL's pre-sort
// validator is the actual gate; this throw is the secondary
// defensive check should any caller bypass it).
function extractTzOffset(ended) {
  const s = String(ended);
  if (/Z$/.test(s)) return '+00:00';
  const m = s.match(/([+-])(\d{2}):?(\d{2})$/);
  if (m) return `${m[1]}${m[2]}:${m[3]}`;
  throw new Error(
    `eventTime requires an explicit timezone offset (Z or ±HH:MM); got naive timestamp ${JSON.stringify(s)}`,
  );
}

// Build one EPCIS 2.0 Document containing exactly one ObjectEvent.
// The plugin expects a JSON-LD-compatible shape; we keep the @context tight.
// `groupKey` is forwarded to eventId() so sibling docs from a single source
// record (mixed-status grouping) get distinct eventIDs; pass undefined when
// the source record yields a single doc (eventID stays back-compat).
export function buildEpcisDocument({
  traceId,
  unitId,
  unitName,
  processName,
  ended,
  itemIds,
  status,
  groupKey,
  isFirstInTrace,
  creationDate,
}) {
  const event = {
    eventID: eventId(traceId, unitId, processName, ended, groupKey),
    type: 'ObjectEvent',
    eventTime: ended,
    eventTimeZoneOffset: extractTzOffset(ended),
    epcList: itemIds.map(itemEpc),
    action: isFirstInTrace ? 'ADD' : 'OBSERVE',
    bizStep: bizStepFor(processName),
    disposition: dispositionFor(status),
    readPoint: { id: stationUri(processName) },
    bizLocation: { id: stationUri(processName) },
  };

  return {
    '@context': EPCIS_CONTEXT,
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: creationDate ?? new Date().toISOString(),
    epcisBody: {
      eventList: [event],
    },
  };
}
