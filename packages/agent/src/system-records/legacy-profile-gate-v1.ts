/**
 * `LegacyAgentProfileGateV1` — the inbound legacy `agents` duplicate/conflict gate.
 *
 * Legacy aggregate sync replays whole `agents` pages. Once a root carries an applied
 * signed record, those pages are redundant at best and contradictory at worst, so this
 * gate partitions incoming quads by the canonical root/subject index before any store
 * insertion:
 *
 *   - a quad already present in the applied record's exact projection is DISCARDED;
 *   - a quad that is additional or different for a covered root is WITHHELD, and its root
 *     is counted as conflicted;
 *   - a quad whose root has no applied record — including an unknown subject shape —
 *     falls through to ordinary legacy insertion, unchanged.
 *
 * The invariant is that unsigned legacy bytes never reach the store for a covered root,
 * so applied signed state cannot be overwritten by legacy insertion.
 *
 * Comparison is streaming per quad, never page equality. A page that omits quads the
 * record holds carries no deletion or conflict meaning: absence is not evidence. Pages
 * split across root, nested and key subjects are expected and are classified
 * independently.
 *
 * Plan lines 924-930. At :924 "quarantined" takes quads as its object, in parallel with
 * "discarded" — the quads are held aside. The record-level marker is :925's "dirties ...
 * it", and the plan's record vocabulary is consistently dirty (:923, :927, AC-4).
 *
 * This module decides; it does not write. Marking a contaminated record is deferred: the
 * record-dirty mechanism does not exist yet and is shared with :927, so it lands where
 * both consumers reach it. Withholding alone holds the invariant for this seam.
 *
 * Scope is the legacy durable-sync seam only. `agents` also reaches the store through the
 * RFC-59 changelog lane, which is a separate slice (D-13) because its page shape differs
 * and :926's two-request budget does not transfer to it. Activation is gated on both.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import {
  classifyAgentProfileOwnedSubjectV1,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
} from '@origintrail-official/dkg-core/system-record-v1';

/**
 * Derived roots resolved by one batched lookup for one legacy page.
 *
 * The plan fixes this at 256 and it has no existing limits-v1 constant: the neighbouring
 * 256s there are byte caps and B+tree fanouts, not a per-page root budget.
 */
export const LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1 = 256;

/** One applied signed record, as resolved by the first batched lookup. */
export interface LegacyAgentProfileAppliedRootV1 {
  readonly root: string;
  /** The record's exact owned-subject table. */
  readonly ownedSubjects: readonly string[];
}

/**
 * The two bounded store reads this gate is allowed for one legacy page.
 *
 * Implementations own the batching; the gate guarantees it calls each at most once per
 * page and never per root or per quad.
 */
export interface LegacyAgentProfileGateLookupV1 {
  /** Request one: which of these derived roots carry an applied signed record. */
  lookupAppliedRoots(
    roots: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly LegacyAgentProfileAppliedRootV1[]>;
  /** Request two: the exact projection triples owned by these subjects. */
  lookupProjectionMembership(
    subjects: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly Quad[]>;
}

/** Why a root's quads were withheld rather than classified. Deliberately not exported. */
type LegacyAgentProfileWithholdReasonV1 = 'conflict' | 'unclassified';

export interface LegacyAgentProfileGateResultV1 {
  /** Quads cleared for ordinary legacy insertion, in arrival order. */
  readonly insert: readonly Quad[];
  /** Quads never offered to the store: a conflict, or a root left unclassified by a cap. */
  readonly withheld: readonly Quad[];
  /** Exact duplicates dropped before insertion. */
  readonly discardedDuplicates: number;
  /** Covered roots that saw at least one conflicting quad. */
  readonly conflictedRoots: number;
  /** Roots a batch cap left unclassified, so their quads were withheld unverified. */
  readonly unclassifiedRoots: number;
  /** Physical store reads performed. Never exceeds two. */
  readonly storeRequests: number;
}

/**
 * Derive the canonical record root for an arbitrary inbound subject.
 *
 * Exact `did:dkg:agent:<address>` subjects are their own root; a `/.well-known/`
 * descendant and a validated `#x25519-<32 lowercase hex>` fragment strip back to it.
 * Every candidate is confirmed by core's owned-subject classifier rather than by
 * restating its string rules here, so this can never admit a shape core rejects.
 * Unknown shapes stay uncovered and take the legacy path.
 */
export function deriveLegacyAgentProfileRootV1(subject: string): string | null {
  if (typeof subject !== 'string' || subject.length === 0) return null;
  if (classifyAgentProfileOwnedSubjectV1(subject, subject) !== null) return subject;
  const wellKnown = subject.indexOf('/.well-known/');
  if (wellKnown > 0) {
    const root = subject.slice(0, wellKnown);
    if (classifyAgentProfileOwnedSubjectV1(root, subject) !== null) return root;
  }
  const fragment = subject.indexOf('#');
  if (fragment > 0) {
    const root = subject.slice(0, fragment);
    if (classifyAgentProfileOwnedSubjectV1(root, subject) !== null) return root;
  }
  return null;
}

/** Graphless identity. Projection membership is a triple property; the page's graph is not. */
function tripleKeyV1(quad: Quad): string {
  return JSON.stringify([quad.subject, quad.predicate, quad.object]);
}

export interface LegacyAgentProfileGateV1 {
  /**
   * Classify one legacy page. Performs at most two bounded store reads, and none at all
   * when the page derives no covered-candidate root.
   */
  filterPage(quads: readonly Quad[], signal?: AbortSignal): Promise<LegacyAgentProfileGateResultV1>;
}

export function createLegacyAgentProfileGateV1(
  lookup: LegacyAgentProfileGateLookupV1,
): LegacyAgentProfileGateV1 {
  return Object.freeze({
    async filterPage(
      quads: readonly Quad[],
      signal?: AbortSignal,
    ): Promise<LegacyAgentProfileGateResultV1> {
      // Partition first: one pass, one derivation per quad, no query.
      const byRoot = new Map<string, Quad[]>();
      const uncovered: Quad[] = [];
      for (const quad of quads) {
        const root = deriveLegacyAgentProfileRootV1(quad.subject);
        if (root === null) {
          uncovered.push(quad);
          continue;
        }
        const existing = byRoot.get(root);
        if (existing === undefined) byRoot.set(root, [quad]);
        else existing.push(quad);
      }

      if (byRoot.size === 0) {
        return frozenResult({
          insert: uncovered,
          withheld: [],
          discardedDuplicates: 0,
          conflictedRoots: 0,
          unclassifiedRoots: 0,
          storeRequests: 0,
        });
      }

      // A page may derive more roots than one batch may carry. Selection is sorted so the
      // same page always selects the same roots, and the remainder is withheld rather than
      // inserted on an unverified assumption that it is uncovered — absence of a lookup is
      // not absence of a record.
      const derivedRoots = [...byRoot.keys()].sort();
      const selected = derivedRoots.slice(0, LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1);
      const deferred = derivedRoots.slice(LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1);

      const withheld: Quad[] = [];
      const recovery = new Map<string, LegacyAgentProfileWithholdReasonV1>();
      for (const root of deferred) {
        withheld.push(...(byRoot.get(root) ?? []));
        recovery.set(root, 'unclassified');
      }

      const applied = await lookup.lookupAppliedRoots(selected, signal);
      let storeRequests = 1;

      const appliedByRoot = new Map<string, LegacyAgentProfileAppliedRootV1>();
      for (const record of applied) {
        if (byRoot.has(record.root)) appliedByRoot.set(record.root, record);
      }

      // Only covered roots need a membership read, and only for subjects the page touched.
      const subjects = new Set<string>();
      for (const [root, record] of appliedByRoot) {
        const owned = new Set(record.ownedSubjects);
        for (const quad of byRoot.get(root) ?? []) {
          if (owned.has(quad.subject)) subjects.add(quad.subject);
        }
      }

      // A covered root whose page subjects overflow the membership batch cannot be
      // classified exactly, so it is withheld whole rather than partly compared.
      const membershipSubjects: string[] = [];
      const overflowed = new Set<string>();
      if (subjects.size > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
        for (const [root] of appliedByRoot) {
          withheld.push(...(byRoot.get(root) ?? []));
          recovery.set(root, 'unclassified');
          overflowed.add(root);
        }
      } else {
        membershipSubjects.push(...[...subjects].sort());
      }

      const projection = new Set<string>();
      if (membershipSubjects.length > 0) {
        const rows = await lookup.lookupProjectionMembership(membershipSubjects, signal);
        storeRequests += 1;
        if (rows.length > SYSTEM_RECORD_MAX_PROJECTION_QUADS) {
          // An over-cap response cannot be trusted as the exact applied set, so every
          // covered root falls back to withhold-and-recover rather than being compared
          // against a truncated projection.
          for (const [root] of appliedByRoot) {
            if (overflowed.has(root)) continue;
            withheld.push(...(byRoot.get(root) ?? []));
            recovery.set(root, 'unclassified');
            overflowed.add(root);
          }
        } else {
          for (const row of rows) projection.add(tripleKeyV1(row));
        }
      }

      const insert: Quad[] = [...uncovered];
      let discardedDuplicates = 0;
      const conflicted = new Set<string>();
      for (const root of selected) {
        const pageQuads = byRoot.get(root) ?? [];
        const record = appliedByRoot.get(root);
        if (record === undefined) {
          // No applied signed record: ordinary legacy behaviour, untouched.
          insert.push(...pageQuads);
          continue;
        }
        if (overflowed.has(root)) continue;
        for (const quad of pageQuads) {
          if (projection.has(tripleKeyV1(quad))) {
            discardedDuplicates += 1;
            continue;
          }
          // Additional or different for a covered root: never inserted.
          withheld.push(quad);
          conflicted.add(root);
        }
      }
      for (const root of conflicted) recovery.set(root, 'conflict');

      // The roots owing exact signed recovery stay inside this module and surface only as
      // counts. The record-dirty mechanism that would consume them does not exist yet, and
      // it is shared with plan :927 ("generic deletes/updates ... must use the record
      // capability or atomically dirty that record"), so it belongs where both consumers
      // reach it rather than as an interface here with nothing on the other end.
      // Withholding alone already holds :1505 for this seam.
      let unclassifiedRoots = 0;
      for (const reason of recovery.values()) if (reason === 'unclassified') unclassifiedRoots += 1;

      return frozenResult({
        insert,
        withheld,
        discardedDuplicates,
        conflictedRoots: conflicted.size,
        unclassifiedRoots,
        storeRequests,
      });
    },
  });
}

function frozenResult(result: LegacyAgentProfileGateResultV1): LegacyAgentProfileGateResultV1 {
  return Object.freeze({
    insert: Object.freeze([...result.insert]),
    withheld: Object.freeze([...result.withheld]),
    discardedDuplicates: result.discardedDuplicates,
    conflictedRoots: result.conflictedRoots,
    unclassifiedRoots: result.unclassifiedRoots,
    storeRequests: result.storeRequests,
  }) as LegacyAgentProfileGateResultV1;
}
