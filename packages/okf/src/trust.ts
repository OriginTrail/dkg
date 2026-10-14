/**
 * Pure OKF v0.2 trust / lifecycle helpers (SPEC §5, §7) — the consumer-side
 * derivations the spec asks for ("consumers derive a trust tier from
 * `verified`", "a concept is stale when `now >= stale_after`"). No RDF here:
 * these operate on parsed frontmatter and are reused by the mapper, the
 * validator, the exporter and the CLI summary. The timestamp primitives they
 * read dates with live in `timestamps.ts`.
 */

import { OKF_STATUS_VALUES } from './constants.js';
import { VERIFIED, definedKeys } from './families/specs.js';
import { parseList, type ParsedEntry } from './families/parse.js';
import { dateTimeLexical, instantOf } from './timestamps.js';
import { safeString } from './utils.js';
import type { OkfStatus, TrustTier, VerificationEvent } from './types.js';

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
 * read, so the events are exactly the entries that become nodes; each keeps
 * its entry's position in the list.
 */
export function parseVerified(value: unknown): ParsedVerification {
  if (value === undefined || value === null) return { shape: 'absent', entries: [], events: [] };
  const parsed = parseList(VERIFIED, value);
  const known = definedKeys(VERIFIED);
  const events = parsed.entries.flatMap((entry): VerificationEvent[] => {
    if (!entry.usable) return [];
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
  // Only a valid XSD value can be stale (`Date.parse` would silently roll an
  // impossible `2026-02-30` over to March), read the same in every time zone,
  // a date with an offset included.
  const t = lexical === null ? null : instantOf(lexical);
  return t !== null && now.getTime() >= t;
}
