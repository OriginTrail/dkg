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
 * Structure: the lookup phases only assign a DISPOSITION to each derived root; a single
 * final pass then walks the original page and materializes the result from those
 * dispositions. That keeps `insert` and `withheld` in arrival order — "uncovered roots use
 * legacy insertion" means unchanged, and reordering a passthrough page is a change — and
 * keeps the classification invariant readable in one place rather than spread across
 * mutations in each lookup branch.
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

import { tripleContentV10 } from '@origintrail-official/dkg-core';
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
 * Request one's answer: the applied records found, and the roots it could NOT decide.
 *
 * `unclassifiedRoots` exists because absence and ignorance are different answers and the
 * gate cannot tell them apart on its own. A root that was asked about and is simply
 * missing from `records` means "no applied record", and its quads take the ordinary
 * legacy path. A root the implementation could not classify — because a bounded response
 * ran out before reaching it — must NOT take that path, or honouring a byte cap silently
 * becomes an insertion of unsigned quads over signed state. :926 requires the opposite
 * ("signed-root quads not classified within the selected bounded batch are withheld"), so
 * the implementation names what it could not decide and the gate withholds it.
 */
export interface LegacyAgentProfileAppliedRootsV1 {
  readonly records: readonly LegacyAgentProfileAppliedRootV1[];
  /** Requested roots this bounded response did not decide. Their quads are withheld. */
  readonly unclassifiedRoots: readonly string[];
}

/** Request two's answer: the projection rows, and whether they are the exact set. */
export interface LegacyAgentProfileProjectionV1 {
  readonly rows: readonly Quad[];
  /**
   * True when a bound stopped this response short of the exact projection. Row-count
   * overflow is visible to the gate; the 2-MiB byte bound is not, so the implementation
   * reports it. Either way every covered root is withheld rather than compared against a
   * partial projection, which would misread a real duplicate as a conflict.
   */
  readonly truncated: boolean;
}

/**
 * The two bounded store reads this gate is allowed for one legacy page.
 *
 * Implementations own the batching; the gate guarantees it calls each at most once per
 * page and never per root or per quad.
 *
 * BOTH BYTE CAPS BELONG TO THE IMPLEMENTATION, AND NEITHER MAY BE HONOURED SILENTLY.
 * :926 caps request one at 1 MiB and request two at 2 MiB, and by the time the gate holds
 * a result the bytes have already transferred — so the gate can only refuse to trust an
 * answer, never prevent it. An implementation that cannot honour a cap reports the
 * shortfall (`unclassifiedRoots` / `truncated`); it must not simply return less, because
 * a short response is indistinguishable from "no record here" and so fails toward
 * insertion — the one direction :1505 forbids.
 */
export interface LegacyAgentProfileGateLookupV1 {
  /** Request one: which of these derived roots carry an applied signed record. */
  lookupAppliedRoots(
    roots: readonly string[],
    signal?: AbortSignal,
  ): Promise<LegacyAgentProfileAppliedRootsV1>;
  /** Request two: the exact projection triples owned by these subjects. */
  lookupProjectionMembership(
    subjects: readonly string[],
    signal?: AbortSignal,
  ): Promise<LegacyAgentProfileProjectionV1>;
}

export interface LegacyAgentProfileGateResultV1 {
  /** Quads cleared for ordinary legacy insertion, in the page's arrival order. */
  readonly insert: readonly Quad[];
  /** Quads never offered to the store, in arrival order. */
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
 * What one derived root's quads are to do. Assigned by the lookup phases, consumed once
 * by the final pass. Deliberately not exported: it is this module's internal plan.
 */
type RootDispositionV1 =
  /** No applied signed record: ordinary legacy behaviour, untouched. */
  | { readonly kind: 'uncovered' }
  /** A batch cap stopped us classifying it, so nothing may be inserted unverified. */
  | { readonly kind: 'unclassified' }
  /** Covered by an applied record; each quad is compared against its exact projection. */
  | { readonly kind: 'covered' };

/**
 * Derive the canonical record root for an arbitrary inbound subject.
 *
 * Exact `did:dkg:agent:<address>` subjects are their own root; a `/.well-known/`
 * descendant and a validated `#x25519-<32 lowercase hex>` fragment strip back to it.
 * Every candidate is confirmed by core's owned-subject classifier rather than by
 * restating its string rules here, so this can never admit a shape core rejects.
 * Unknown shapes stay uncovered and take the legacy path.
 *
 * Known gap, filed rather than papered over: the separators tried here are fixed, while
 * the authoritative shape set is core's module-private policy table. A future owned-subject
 * shape using a new separator would derive to null and be treated as uncovered. Core is
 * the only place that can see the full set, which is why reverse derivation belongs there.
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

const PROJECTION_KEY_DECODER_V1 = new TextDecoder();

/**
 * Projection membership identity: the canonical graphless N-Triples line, the same
 * encoding storage's projection inspection uses. Graph is deliberately excluded — the
 * applied projection lives in its own graph while the legacy page carries the aggregate
 * `agents` graph, so a graph-sensitive key would call every real duplicate a conflict.
 */
function projectionKeyV1(quad: Quad): string {
  // The decoder is module-scope on purpose: this runs once per projection row and again
  // per page quad, so a per-call decoder would allocate up to 10,000 of them on a
  // maximum-size page — and :926 exists to bound exactly that per-page cost.
  return PROJECTION_KEY_DECODER_V1.decode(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  );
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
      // Phase 1 — derive once per quad, keeping the result positionally so the final pass
      // never re-derives. No query.
      const rootByIndex: (string | null)[] = new Array(quads.length);
      const roots = new Set<string>();
      for (const [index, quad] of quads.entries()) {
        const root = deriveLegacyAgentProfileRootV1(quad.subject);
        rootByIndex[index] = root;
        if (root !== null) roots.add(root);
      }

      const disposition = new Map<string, RootDispositionV1>();
      let storeRequests = 0;
      const projection = new Set<string>();

      if (roots.size > 0) {
        // Phase 2 — a page may derive more roots than one batch may carry. Selection is
        // sorted so the same page always selects the same roots; the remainder is withheld
        // rather than inserted on an unverified assumption that it is uncovered, because
        // absence of a lookup is not absence of a record.
        const derivedRoots = [...roots].sort();
        const selected = derivedRoots.slice(0, LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1);
        for (const root of derivedRoots.slice(LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1)) {
          disposition.set(root, { kind: 'unclassified' });
        }

        // Phase 3 — one batched read maps the selected roots to applied records.
        const applied = await lookup.lookupAppliedRoots(selected, signal);
        storeRequests += 1;
        const appliedByRoot = new Map<string, LegacyAgentProfileAppliedRootV1>();
        // Roots the response itself declined to decide. Kept separate from `untrusted`
        // only for readability; both end in the same disposition, because "the batch ran
        // out before this root" and "this record's table cannot be believed" are the same
        // thing to a gate that must not insert on an unverified assumption.
        const undecided = new Set(applied.unclassifiedRoots);
        const untrusted = new Set<string>();
        for (const record of applied.records) {
          if (!roots.has(record.root)) continue;
          // Fail closed on data crossing the injected lookup boundary. A well-formed
          // record cannot exceed the owned-subject cap, so an over-cap table means this
          // response is not the exact applied set and its root must not be classified
          // against it — withholding is the safe answer, insertion is not.
          if (record.ownedSubjects.length > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
            untrusted.add(record.root);
            continue;
          }
          appliedByRoot.set(record.root, record);
        }
        for (const root of selected) {
          if (untrusted.has(root) || undecided.has(root)) {
            disposition.set(root, { kind: 'unclassified' });
            continue;
          }
          disposition.set(root, appliedByRoot.has(root) ? { kind: 'covered' } : { kind: 'uncovered' });
        }

        // Phase 4 — one batched membership read, for covered roots only and only for the
        // subjects this page actually touched.
        const subjects = new Set<string>();
        for (const [root, record] of appliedByRoot) {
          const owned = new Set(record.ownedSubjects);
          for (const [index, quad] of quads.entries()) {
            if (rootByIndex[index] === root && owned.has(quad.subject)) subjects.add(quad.subject);
          }
        }

        // A covered root whose page subjects overflow the membership batch cannot be
        // classified exactly, so it is withheld whole rather than partly compared.
        if (subjects.size > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
          for (const root of appliedByRoot.keys()) disposition.set(root, { kind: 'unclassified' });
        } else if (subjects.size > 0) {
          const membership = await lookup.lookupProjectionMembership([...subjects].sort(), signal);
          storeRequests += 1;
          // Two independent ways this response can fail to be the exact projection: a row
          // count the gate can see, and a byte bound only the implementation can. Both
          // land here, because a partial projection makes a real duplicate look like a
          // conflict, and comparing against it would withhold on manufactured evidence.
          if (membership.truncated || membership.rows.length > SYSTEM_RECORD_MAX_PROJECTION_QUADS) {
            for (const root of appliedByRoot.keys()) disposition.set(root, { kind: 'unclassified' });
          } else {
            for (const row of membership.rows) projection.add(projectionKeyV1(row));
          }
        }
      }

      // Phase 5 — one materialization pass over the page, in arrival order.
      const insert: Quad[] = [];
      const withheld: Quad[] = [];
      const conflicted = new Set<string>();
      let discardedDuplicates = 0;
      let unclassifiedRoots = 0;
      for (const [index, quad] of quads.entries()) {
        const root = rootByIndex[index];
        const plan = root === null ? undefined : disposition.get(root);
        if (root === null || plan === undefined || plan.kind === 'uncovered') {
          insert.push(quad);
          continue;
        }
        if (plan.kind === 'unclassified') {
          withheld.push(quad);
          continue;
        }
        if (projection.has(projectionKeyV1(quad))) {
          discardedDuplicates += 1;
          continue;
        }
        // Additional or different for a covered root: never inserted.
        withheld.push(quad);
        conflicted.add(root);
      }
      // These two counts are disjoint today — a root is either withheld whole by a cap or
      // classified and possibly conflicted, never both — but they derive asymmetrically:
      // one from a set built in the pass above, one from a scan of the dispositions. If a
      // third withhold reason is ever added, derive BOTH from `disposition`, or the scan
      // will adapt and the set silently will not.
      for (const plan of disposition.values()) {
        if (plan.kind === 'unclassified') unclassifiedRoots += 1;
      }

      // The roots owing exact signed recovery stay inside this module and surface only as
      // counts. The record-dirty mechanism that would consume them does not exist yet, and
      // it is shared with plan :927 ("generic deletes/updates ... must use the record
      // capability or atomically dirty that record"), so it belongs where both consumers
      // reach it rather than as an interface here with nothing on the other end.
      return Object.freeze({
        insert: Object.freeze(insert),
        withheld: Object.freeze(withheld),
        discardedDuplicates,
        conflictedRoots: conflicted.size,
        unclassifiedRoots,
        storeRequests,
      }) as LegacyAgentProfileGateResultV1;
    },
  });
}
