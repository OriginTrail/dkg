import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/*
 * THE INVARIANT CORE'S DISPOSITION READER DEPENDS ON, MADE EXECUTABLE.
 *
 * `deriveAgentProfileAuthorityDispositionV1` reads a non-empty
 * `conflictDigestSlots` as "a terminal transition conflict was merged here".
 * That is true because of how storage writes the field, not because of anything
 * the field's TYPE says -- so a future write path that put fork-typed or
 * diagnostic digests into the same array would silently turn head forks into
 * permanent transition-equivocation quarantines, and no behavioural test would
 * notice, because the misfiled digests would look exactly like real ones.
 *
 * Raised in review on PR #2266. The behavioural half is already pinned in
 * `system-record-applied-disposition-restart-v1.test.ts` (fork-typed evidence
 * leaves the slots empty and re-derives as `head-fork-quarantined`). This file
 * pins the STRUCTURAL half the behavioural one cannot reach: that the merge is
 * still the only writer that ADDS, and that it is still gated on both the
 * terminal-transition flag and the transition entry type.
 *
 * It is deliberately a source-shape pin rather than a line-number citation:
 * line numbers drift on unrelated edits, and a pin that has to be renumbered
 * every release is a pin people delete.
 */

const STORAGE_SRC = new URL('../src/', import.meta.url);
const NEXT_STATE = 'system-record-next-state-v1-internal.ts';

function sourceOf(name: string): string {
  return readFileSync(new URL(name, STORAGE_SRC), 'utf8');
}

/**
 * EVERY `.ts` UNDER `packages/storage/src`, INCLUDING NESTED DIRECTORIES.
 *
 * This walked only the top level until review caught it. `packages/storage/src`
 * has three subdirectories (`adapters`, `internal`, `structured-mutation`)
 * holding 20 of its 66 source files, so the "only one module writes the slots"
 * claim was measured over 46 files and asserted over 66 -- an absence claim
 * scoped to a tree smaller than the one it named, on a security-relevant
 * invariant. A writer added at `src/internal/…` would have passed silently.
 *
 * Paths are returned relative to `src/` so a nested writer is NAMED in the
 * failure rather than merely changing a count.
 */
function storageSourceFiles(prefix = ''): readonly string[] {
  const dir = prefix === '' ? STORAGE_SRC : new URL(`${prefix}`, STORAGE_SRC);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...storageSourceFiles(`${relative}/`));
    else if (entry.name.endsWith('.ts')) out.push(relative);
  }
  return out;
}

function filesMentioning(token: string): readonly string[] {
  return storageSourceFiles().filter((name) => sourceOf(name).includes(token));
}

/** Lines that mention the slots, with their 1-based numbers, for reporting. */
function slotLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source.split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => text.includes('conflictDigestSlots'));
}

describe('the conflict-slot substrate the authority disposition is derived from', () => {
  /*
   * THE SCAN REACHES NESTED DIRECTORIES -- asserted directly, because the
   * absence claim below is only as wide as this walk. Naming the subdirectories
   * rather than comparing a count means a walk that silently stops descending
   * fails here, at the instrument, instead of downstream where it would read as
   * "no other writer exists".
   */
  it('walks the whole storage source tree, not just its top level', () => {
    const files = storageSourceFiles();
    const nested = files.filter((name) => name.includes('/'));
    expect(nested.length).toBeGreaterThan(0);
    for (const directory of ['adapters/', 'internal/', 'structured-mutation/']) {
      expect(files.some((name) => name.startsWith(directory))).toBe(true);
    }
    // Positive control on the reader the walk feeds: a token that really is in a
    // nested file is found through it.
    expect(filesMentioning('export').length).toBeGreaterThan(files.length / 2);
  });

  it('is written in exactly one storage module', () => {
    // Scope stated and now actually held: this sweeps ALL of
    // packages/storage/src, nested directories included. Core's occurrences are
    // the type field, the canonical key list and validation -- declaration, not
    // derivation.
    expect(filesMentioning('conflictDigestSlots')).toEqual([NEXT_STATE]);
  });

  it('adds to the slots in exactly one place, and copies them everywhere else', () => {
    const source = sourceOf(NEXT_STATE);
    const lines = slotLines(source);
    // Negative control: if the token ever stops appearing, every assertion below
    // would pass vacuously on an empty list.
    expect(lines.length).toBeGreaterThan(0);

    // The two carry-forward sites READ the persisted array; they never build one.
    const carriedForward = lines.filter(({ text }) =>
      text.includes('snapshot.appliedState.conflictDigestSlots'));
    expect(carriedForward).toHaveLength(2);

    // Exactly one site CONSTRUCTS a new array for the field.
    const constructed = lines.filter(({ text }) =>
      text.includes('const conflictDigestSlots ='));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.text).toContain('allSlots.slice(0, SYSTEM_RECORD_MAX_CONFLICT_DIGESTS)');
  });

  it('gates the only adding site on the terminal-transition flag and the transition entry type', () => {
    const source = sourceOf(NEXT_STATE);
    const start = source.indexOf('function quarantineSystemRecordDerivationV1(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nfunction ', start + 1);
    const merge = source.slice(start, end === -1 ? undefined : end);

    // Both conjuncts, in the function that owns the only add.
    expect(merge).toContain('facts.terminalTransitionConflict');
    expect(merge).toContain("entry.type === 'transition'");
    // And the digests it merges come from the evidence entries, not from the row.
    expect(merge).toContain('facts.conflictEvidence.entries');

    // Negative control: a filter for some OTHER entry type would mean the slots
    // had stopped meaning "transition equivocation" for this reader.
    expect(merge).not.toContain("entry.type === 'fork'");
  });

  /*
   * The overflow flag is NOT pinned here. An earlier version of this file
   * asserted that the token and the cap constant appear in the source, which
   * would have stayed green if the writer stopped setting overflow for over-cap
   * evidence -- a check that cannot fail, raised in review. Overflow turned out
   * to be constructible through the real write path (two quarantines
   * accumulating past the cap), so it is pinned BEHAVIOURALLY instead, in
   * `system-record-applied-disposition-restart-v1.test.ts`.
   */
});
