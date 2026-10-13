/**
 * Pure OKF v0.2 trust / lifecycle helpers (SPEC §5, §7) — the consumer-side
 * derivations the spec asks for ("consumers derive a trust tier from
 * `verified`", "a concept is stale when `now >= stale_after`"). No RDF here:
 * these operate on parsed frontmatter and are reused by the mapper, the
 * validator, the exporter and the CLI summary.
 */

import { OKF_STATUS_VALUES } from './constants.js';
import type { OkfStatus, TrustTier, VerificationEvent } from './types.js';

/** XSD `dateTime` lexical form (`YYYY-MM-DDThh:mm:ss[.s+][Z|±hh:mm]`). The zone is optional in XSD; OKF wants it explicit (§5). */
const XSD_DATE_TIME_RE = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
/** XSD `date` lexical form (`YYYY-MM-DD[Z|±hh:mm]`). */
const XSD_DATE_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const EXPLICIT_OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Calendar check: month 1–12, day within that month (Gregorian, proleptic). */
function isValidCalendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1) return false;
  const days = m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return d <= days;
}

/** Time check: `hh` 0–23, `mm` / `ss` 0–59; XSD also allows the end-of-day instant `24:00:00[.0+]`. */
function isValidTime(hour: string, minute: string, second: string, fraction?: string): boolean {
  const h = Number(hour);
  const mi = Number(minute);
  const se = Number(second);
  if (h === 24) return mi === 0 && se === 0 && (fraction === undefined || /^\.0+$/.test(fraction));
  return h <= 23 && mi <= 59 && se <= 59;
}

/** Zone check: `Z`, or an offset between −14:00 and +14:00 inclusive (minutes 0–59). */
function isValidZone(zone?: string): boolean {
  if (zone === undefined || zone === 'Z') return true;
  const hh = Number(zone.slice(1, 3));
  const mm = Number(zone.slice(4, 6));
  return hh < 14 ? mm <= 59 : hh === 14 && mm === 0;
}

/**
 * The lexical form of a timestamp-valued frontmatter field.
 *
 * YAML parsers (js-yaml here, PyYAML in the reference agent) turn an unquoted
 * `2026-06-30T14:00:00Z` into a native datetime; a quoted one stays a string.
 * A native `Date` is rendered in the XSD *canonical* form (`Z`, no `.000`),
 * so `2026-06-30T14:00:00Z` round-trips byte-for-byte and an offset-bearing
 * value folds to UTC (same instant — the deployed store canonicalises
 * xsd:dateTime the same way). A string is kept exactly as written.
 */
export function dateTimeLexical(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString(); // always `YYYY-MM-DDThh:mm:ss.sssZ`
    return value.getUTCMilliseconds() === 0 ? iso.replace('.000Z', 'Z') : iso;
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * True when `lexical` is a valid xsd:dateTime value — shape AND calendar / time /
 * zone ranges. Shape alone would let `2026-02-30T00:00:00Z` or
 * `2026-13-40T25:70:70Z` through as typed literals, which the store keeps
 * verbatim and which then make `YEAR()` and every date comparison unbound.
 */
export function isXsdDateTime(lexical: string): boolean {
  const m = XSD_DATE_TIME_RE.exec(lexical);
  if (!m) return false;
  return isValidCalendarDate(m[1], m[2], m[3]) && isValidTime(m[4], m[5], m[6], m[7]) && isValidZone(m[8]);
}

/** True when `lexical` is a valid xsd:date value (date-only), with the same calendar / zone checks. */
export function isXsdDate(lexical: string): boolean {
  const m = XSD_DATE_RE.exec(lexical);
  if (!m) return false;
  return isValidCalendarDate(m[1], m[2], m[3]) && isValidZone(m[4]);
}

/** True when a dateTime lexical carries the explicit UTC offset OKF requires (§5). */
export function hasExplicitOffset(lexical: string): boolean {
  return EXPLICIT_OFFSET_RE.test(lexical);
}

/** Actor convention (§7): `human:<id>`, `process:<id>`, else `<producer>/<version>` (an agent/tool). */
export function actorKind(actor: string): 'human' | 'process' | 'agent' {
  if (actor.startsWith('human:')) return 'human';
  if (actor.startsWith('process:')) return 'process';
  return 'agent';
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Normalise a `verified` value into a list of events (§5.2): a bare `{ by, at }`
 * mapping MUST be treated as a one-element list; a list is taken as-is;
 * anything else (absent, scalar) yields no events. Entries that are not
 * mappings or lack `by` are dropped — they carry no verifier and so cannot
 * contribute to a tier (§5.3). The raw entry count is reported separately by
 * the validator so malformed entries are surfaced, never silently lost.
 */
export function normalizeVerified(value: unknown): VerificationEvent[] {
  const raw: unknown[] = Array.isArray(value) ? value : isMapping(value) ? [value] : [];
  const out: VerificationEvent[] = [];
  for (const entry of raw) {
    if (!isMapping(entry)) continue;
    const by = entry.by;
    if (by === undefined || by === null || String(by).trim() === '') continue;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) if (k !== 'by' && k !== 'at') extra[k] = v;
    out.push({ by: String(by).trim(), at: dateTimeLexical(entry.at), extra });
  }
  return out;
}

/**
 * Trust tier (§5.3), lowest to highest: no verifier ⇒ `unverified`;
 * non-`human:` verifiers only ⇒ `machine-confirmed`; any `human:<id>` verifier
 * ⇒ `human-reviewed`. Advisory, not access control.
 */
export function deriveTrustTier(verified: unknown): TrustTier {
  const events = normalizeVerified(verified);
  if (events.length === 0) return 'unverified';
  return events.some((e) => actorKind(e.by) === 'human') ? 'human-reviewed' : 'machine-confirmed';
}

/** Lifecycle status (§5.4). Absent ⇒ `stable`. An unknown value is returned verbatim (tolerated). */
export function conceptStatus(frontmatter: Record<string, unknown>): OkfStatus | string {
  const v = frontmatter.status;
  if (v === undefined || v === null || String(v).trim() === '') return 'stable';
  return String(v).trim();
}

/** True when `value` is one of the three spec'd status values. */
export function isKnownStatus(value: string): value is OkfStatus {
  return (OKF_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Staleness (§5.5): `now >= stale_after`. Absent or invalid ⇒ not stale.
 * Deliberately a plain instant comparison — never a TTL relative to read time.
 */
export function isStale(staleAfter: unknown, now: Date = new Date()): boolean {
  const lexical = dateTimeLexical(staleAfter);
  if (lexical === null) return false;
  // Only a valid XSD value can be stale: `Date.parse` would silently roll an
  // impossible `2026-02-30` over to March and report it stale.
  if (!isXsdDateTime(lexical) && !isXsdDate(lexical)) return false;
  const t = Date.parse(lexical);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}
