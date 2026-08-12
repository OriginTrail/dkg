import { describe, expect, it, vi } from 'vitest';

/**
 * THE SWEEP FORWARDS THE UNRESOLVED-ARTIFACT COLLECTOR TO THE MINTER.
 *
 * The storage audit's claim is that an EMPTY unresolved set means every mint
 * lookup was answered. That claim rests on two links: the minter reporting an
 * unanswered lookup, and `runStorageSweepV1` FORWARDING the collector to the
 * minter. The audit's own positive controls prove the first link only -- they
 * call `mintStorageSummaryForHeadV1` directly and bypass the sweep entirely.
 * Delete the forwarding and the audit still finds an empty set, both of those
 * controls still pass, and the guard reports success for a wire that is cut.
 *
 * This is the third consecutive round in which a control on that audit proved a
 * path adjacent to the one it named -- first the active arm rather than the
 * tombstone arm, now the minter rather than the sweep. So this file proves the
 * SECOND link and nothing else.
 *
 * It uses a module seam rather than a corrupted cell on purpose: no constructible
 * cell produces an unanswered lookup, which is precisely what the audit asserts,
 * so the only way to observe forwarding is to make one mint report. The seam is
 * scoped to this file so the audit's own suite keeps running against the real
 * minter.
 */
vi.mock('./helpers/authority-verdict-diff-storage-driver-v1.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./helpers/authority-verdict-diff-storage-driver-v1.js')
  >();
  return {
    ...actual,
    // Reports one unanswered lookup on every mint, through whatever collector it
    // is handed. If the sweep stops passing one, `onUnresolved` is undefined and
    // nothing is recorded -- which is exactly the mutant this file kills.
    mintStorageSummaryForHeadV1: async (
      candidate: unknown,
      onUnresolved?: (reference: string) => void,
    ) => {
      onUnresolved?.('agent-profile-head:0xseam');
      return { minted: false as const, message: 'seam' };
    },
  };
});

const { enumerateVerdictDiffCellsV1 } = await import(
  './helpers/authority-verdict-diff-cells-v1.js');
const { resolveConstructibilityV1 } = await import(
  './helpers/authority-verdict-diff-constructibility-v1.js');
const { runStorageSweepV1 } = await import(
  './helpers/authority-verdict-diff-storage-sweep-v1.js');

describe('verdict-diff: the storage sweep forwards its unresolved collector', () => {
  it('observes a lookup the MINTER reports, proving the sweep passes the hook', async () => {
    const seen: string[] = [];
    // A handful of cells is enough: the claim is about the wire, not the walk,
    // and the sweep mints once per head shape.
    const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1())
      .constructible.slice(0, 5000);

    await runStorageSweepV1(cells, (reference) => seen.push(reference));

    // The collector saw what the minter reported. Under the mutant -- the sweep
    // calling `mintStorageSummaryForHeadV1(head.candidate)` with no second
    // argument -- this array stays empty and the test fails, while the audit's
    // own empty-set assertion and its two direct-minter controls all stay green.
    expect(seen).toContain('agent-profile-head:0xseam');
  }, 300_000);
});
