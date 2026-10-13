/**
 * Pure OKF v0.2 trust / lifecycle helpers (SPEC §5, §7) — the consumer-side
 * derivations the spec asks for ("consumers derive a trust tier from
 * `verified`", "a concept is stale when `now >= stale_after`"). No RDF here:
 * these operate on parsed frontmatter and are reused by the mapper, the
 * validator, the exporter and the CLI summary.
 */

import { OKF_STATUS_VALUES } from './constants.js';
import { VERIFIED, definedKeys } from './families/specs.js';
import { parseList, type ParsedEntry } from './families/parse.js';
import { safeString } from './utils.js';
import { yamlLexicalOf } from './yaml-lexical.js';
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
    // A date-only or offset-less YAML timestamp is read as written, as its
    // quoted form would be: no invented UTC offset, no date turned into a time.
    const lexical = yamlLexicalOf(value);
    if (lexical !== undefined && !hasExplicitOffset(lexical)) return lexical;
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

/** The `verified` family (§5.2) as one parse: the shape, every entry as written, and the usable events. */
export interface ParsedVerification {
  /** `absent`: no `verified` key. `invalid`: neither a mapping nor a list (kept verbatim). */
  readonly shape: 'absent' | 'list' | 'mapping' | 'invalid';
  /** Every entry with its index, usable or not (diagnostics report the unusable ones). */
  readonly entries: readonly ParsedEntry[];
  /** The entries that name a verifier, normalised, each keeping its original index. */
  readonly events: readonly VerificationEvent[];
}

/**
 * The single interpretation of `verified` (§5.2). A bare `{ by, at }` mapping
 * is a one-element list; an entry that is not a mapping, or has no `by`,
 * names no verifier and is not an event. Which entries are usable is decided
 * by the `verified` family spec (`families/specs.ts`) through `parseList`, the
 * same classification the RDF mapping, the diagnostics and the summary counts
 * read, so an event keeps the index of its node IRI.
 */
export function parseVerified(value: unknown): ParsedVerification {
  if (value === undefined || value === null) return { shape: 'absent', entries: [], events: [] };
  const parsed = parseList(VERIFIED, value);
  const known = definedKeys(VERIFIED);
  const events = parsed.entries.flatMap((entry): VerificationEvent[] => {
    if (!entry.usable || entry.mapping === null) return [];
    // A plain object for the public `extra`, built by defining properties
    // (`Object.fromEntries`), so a `__proto__` or `constructor` key is an
    // ordinary own key, in the order it was written.
    const extra = Object.fromEntries(Object.entries(entry.mapping).filter(([k]) => !known.has(k)));
    return [{ index: entry.index, by: safeString(entry.mapping.by).trim(), at: dateTimeLexical(entry.mapping.at), extra }];
  });
  return { shape: parsed.shape, entries: parsed.entries, events };
}

/** The usable verification events of a `verified` value (§5.2): `parseVerified(value).events`. */
export function normalizeVerified(value: unknown): VerificationEvent[] {
  return [...parseVerified(value).events];
}

/**
 * Trust tier (§5.3), lowest to highest: no verifier ⇒ `unverified`;
 * non-`human:` verifiers only ⇒ `machine-confirmed`; any `human:<id>` verifier
 * ⇒ `human-reviewed`. Advisory, not access control.
 */
export function trustTierOf(events: readonly Pick<VerificationEvent, 'by'>[]): TrustTier {
  if (events.length === 0) return 'unverified';
  return events.some((e) => actorKind(e.by) === 'human') ? 'human-reviewed' : 'machine-confirmed';
}

/** The §5.3 trust tier of a `verified` value. */
export function deriveTrustTier(verified: unknown): TrustTier {
  return trustTierOf(parseVerified(verified).events);
}

/** Lifecycle status (§5.4). Absent ⇒ `stable`. An unknown value is returned verbatim (tolerated). */
export function conceptStatus(frontmatter: Record<string, unknown>): OkfStatus | string {
  const v = frontmatter.status;
  if (v === undefined || v === null || safeString(v).trim() === '') return 'stable';
  return safeString(v).trim();
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
  // `Date.parse` reads an offset-less date-time as *local* time; read it as UTC
  // so staleness does not depend on the machine's time zone.
  const t = Date.parse(isXsdDateTime(lexical) && !hasExplicitOffset(lexical) ? `${lexical}Z` : lexical);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}
