import { createHash } from 'node:crypto';
import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Fingerprint of a Shared-Working-Memory public-quads snapshot.
 *
 * The digest is `sha256` over the JSON rows `[subject, predicate, object, '']`
 * of every quad, sorted, framed as a JSON array. The sort order is the only
 * moving part. Two orderings exist:
 *
 * - `code-unit`: plain UTF-16 code-unit order (`Array.prototype.sort()`
 *   without a comparator). Deterministic on every host: it reads no locale
 *   and no ICU data, and two different rows never compare equal.
 * - `locale`: `String.prototype.localeCompare` with the process default
 *   collator. This is what every release before the code-unit ordering
 *   computes. It depends on `LANG` / `LC_ALL` and on the ICU build, so two
 *   nodes holding byte-identical quads can disagree on the digest (for
 *   example `da-DK` sorts `urn:x:aa` after `urn:x:b`, `en-US` before it).
 *
 * The digest names the on-disk snapshot file and is recomputed and compared at
 * many sites, so the switch is staged (see `resolveWorkspaceDigestOrdering`):
 *
 * - Every site that compares a digest recomputed from quads against a digest
 *   that came from another node, or from this node before an upgrade or a gate
 *   change (a peer descriptor, a persisted metadata row, a persisted head),
 *   goes through `workspacePublicQuadsDigestMatches` and accepts every form.
 * - Every site that writes a digest (a producer) goes through
 *   `workspacePublicQuadsDigest`, which emits the `locale` form until an
 *   operator opts into `code-unit`. A legacy node cannot verify a `code-unit`
 *   digest, so the opt-in is meant for a network whose nodes all run a release
 *   that accepts both.
 */

/** Environment gate selecting the ordering this node WRITES into new digests. */
export const WORKSPACE_DIGEST_ORDERING_ENV = 'DKG_SWM_DIGEST_ORDERING';

export type WorkspaceDigestOrdering = 'locale' | 'code-unit';

const warnedOrderingValues = new Set<string>();

/**
 * Pure resolver for the producer gate. Anything but the exact value
 * `code-unit` keeps the legacy own-locale ordering, so a typo can never make a
 * node emit digests that legacy peers reject. An unrecognised non-empty value
 * is reported once per process because a silently ignored rollout gate is worse
 * than a noisy one.
 */
export function resolveWorkspaceDigestOrdering(
  raw: string | undefined = process.env[WORKSPACE_DIGEST_ORDERING_ENV],
): WorkspaceDigestOrdering {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === 'code-unit') return 'code-unit';
  if (value !== '' && value !== 'locale' && !warnedOrderingValues.has(value)) {
    warnedOrderingValues.add(value);
    process.emitWarning(
      `${WORKSPACE_DIGEST_ORDERING_ENV}=${JSON.stringify(raw)} is not recognised; `
        + 'using the legacy locale ordering. Use "code-unit" or "locale".',
      { code: 'DKG_SWM_DIGEST_ORDERING_UNRECOGNISED' },
    );
  }
  return 'locale';
}

/**
 * One greppable startup line: the ordering this node writes and the locale its
 * default collator resolved to. It is what tells an operator (or a devnet
 * suite) which digest form a node produces when digests disagree between nodes.
 */
export function describeWorkspaceDigestConfiguration(): string {
  let collatorLocale = 'unknown';
  try {
    collatorLocale = new Intl.Collator().resolvedOptions().locale;
  } catch {
    // A runtime built without Intl has no collator locale to report.
  }
  return `SWM public-quads digest ordering=${resolveWorkspaceDigestOrdering()} collatorLocale=${collatorLocale}`
    + ` (set ${WORKSPACE_DIGEST_ORDERING_ENV}=code-unit to write locale-independent digests once every peer`
    + ' runs a release that accepts them)';
}

/** `sha256:` plus 64 lowercase hex digits: the only shape a digest can have. */
const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

function canonicalRows(quads: readonly Quad[]): string[] {
  return quads.map((quad) => JSON.stringify([quad.subject, quad.predicate, quad.object, '']));
}

function digestOfSortedRows(rows: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update('[');
  rows.forEach((row, index) => {
    if (index > 0) hash.update(',');
    hash.update(row);
  });
  hash.update(']');
  return `sha256:${hash.digest('hex')}`;
}

/** The ambient-locale ordering, called exactly as the pre-gate code called it. */
function sortByAmbientLocale(rows: string[]): void {
  rows.sort((a, b) => a.localeCompare(b));
}

/** UTF-16 code-unit order: the default comparator, no locale involved. */
function sortByCodeUnit(rows: string[]): void {
  rows.sort();
}

/**
 * The `en-US` collation, pinned. It is the default collator of a node whose
 * `LANG` is unset, `C`, `C.UTF-8`, `POSIX` or `en_US.*` (Node reports `en-US`
 * for all of them), which is what stock Linux and Docker hosts run. Verifiers
 * try it in addition to their own locale so a node on another locale still
 * accepts snapshots written by the en-US majority before the gate flips.
 * A Collator is built once because `localeCompare(b, 'en-US')` would construct
 * one per comparison.
 */
function sortByEnglishUnitedStates(rows: string[]): boolean {
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator('en-US');
  } catch {
    return false;
  }
  rows.sort(collator.compare);
  return true;
}

function ambientLocaleIsEnglishUnitedStates(): boolean {
  try {
    return new Intl.Collator().resolvedOptions().locale === 'en-US';
  } catch {
    return false;
  }
}

/** Digest of these quads under one explicit ordering. */
export function workspacePublicQuadsDigestWithOrdering(
  quads: readonly Quad[],
  ordering: WorkspaceDigestOrdering,
): string {
  const rows = canonicalRows(quads);
  if (ordering === 'code-unit') sortByCodeUnit(rows);
  else sortByAmbientLocale(rows);
  return digestOfSortedRows(rows);
}

/**
 * The digest this node WRITES: the own-locale form unless the operator has set
 * `DKG_SWM_DIGEST_ORDERING=code-unit`. Use it wherever a digest is produced
 * or where two quad sets are compared inside one operation. Never compare it
 * against a digest that came from somewhere else; use
 * `workspacePublicQuadsDigestMatches` for that.
 */
export function workspacePublicQuadsDigest(quads: readonly Quad[]): string {
  return workspacePublicQuadsDigestWithOrdering(quads, resolveWorkspaceDigestOrdering());
}

/** The locale- and ICU-independent digest. */
export function workspacePublicQuadsCodeUnitDigest(quads: readonly Quad[]): string {
  return workspacePublicQuadsDigestWithOrdering(quads, 'code-unit');
}

/** The pre-gate digest: sorted by this process's default collator. */
export function workspacePublicQuadsLegacyDigest(quads: readonly Quad[]): string {
  return workspacePublicQuadsDigestWithOrdering(quads, 'locale');
}

/**
 * Every digest a verifier accepts for these quads, lazily and de-duplicated by
 * ordering, most likely first: the form this node writes, the other own-node
 * form, then the pinned `en-US` legacy form (skipped when the ambient locale
 * already is `en-US`). Rows are serialised once and each candidate sorts its
 * own copy, so the common case (the first candidate matches) costs what the
 * single-digest function always did.
 *
 * All candidates hash the identical multiset of rows and differ only in row
 * order, so accepting several does not weaken the check: a wrong or tampered
 * quad set still fails every one of them.
 */
export function* workspacePublicQuadsDigestCandidates(quads: readonly Quad[]): Generator<string> {
  const rows = canonicalRows(quads);
  const sortedDigest = (sort: (target: string[]) => void): string => {
    const copy = rows.slice();
    sort(copy);
    return digestOfSortedRows(copy);
  };
  const codeUnit = () => sortedDigest(sortByCodeUnit);
  const locale = () => sortedDigest(sortByAmbientLocale);
  if (resolveWorkspaceDigestOrdering() === 'code-unit') {
    yield codeUnit();
    yield locale();
  } else {
    yield locale();
    yield codeUnit();
  }
  if (!ambientLocaleIsEnglishUnitedStates()) {
    const copy = rows.slice();
    if (sortByEnglishUnitedStates(copy)) yield digestOfSortedRows(copy);
  }
}

/**
 * True when `expected` is a digest this build accepts for `quads`. Use it
 * wherever the expected digest comes from a peer, a peer-served descriptor or
 * this node's own earlier state (metadata, heads, staged references).
 */
export function workspacePublicQuadsDigestMatches(
  quads: readonly Quad[],
  expected: string,
): boolean {
  if (typeof expected !== 'string' || !DIGEST_SHAPE.test(expected)) return false;
  for (const candidate of workspacePublicQuadsDigestCandidates(quads)) {
    if (candidate === expected) return true;
  }
  return false;
}

/**
 * Every digest this build accepts for these quads (distinct values). Callers
 * that keep validation evidence for immutable bytes use it so later questions
 * about the same bytes are answered without rereading them: a digest in the
 * list is proven, and one outside it is disproven. It costs one sort and hash
 * per accepted ordering, which is small next to reading the snapshot.
 */
export function workspacePublicQuadsAcceptedDigests(quads: readonly Quad[]): readonly string[] {
  return [...new Set(workspacePublicQuadsDigestCandidates(quads))];
}
