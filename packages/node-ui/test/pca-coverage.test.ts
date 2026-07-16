// @vitest-environment happy-dom
//
// #1344 — exhaustive matrix on the shared coverage leaf rules (the ones that drifted
// across C1/O4/Q2/S2/U2/V3). The hooks/components keep their own aggregation; this
// pins the extracted pure functions so the surfaces can't re-diverge.

import { describe, expect, it } from 'vitest';
import { isPcaSpendable, normalizeProbeRegistered, classifyCoverage } from '../src/ui/pca/coverage.js';
import { bigGt0, pcaBudgetState } from '../src/ui/pca/pca-primitives.js';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';

const FUTURE = Math.floor(Date.now() / 1000) + 60 * 86_400;
const PAST = Math.floor(Date.now() / 1000) - 86_400;

describe('bigGt0', () => {
  it('treats positive wei strings as true; everything else false', () => {
    expect(bigGt0('1')).toBe(true);
    expect(bigGt0('850000000000000000000')).toBe(true);
    expect(bigGt0('0')).toBe(false);
    expect(bigGt0(undefined)).toBe(false);
    expect(bigGt0('')).toBe(false);
    expect(bigGt0('not-a-number')).toBe(false);
  });
});

describe('isPcaSpendable', () => {
  it('expired → false', () => {
    expect(isPcaSpendable(makePcaSnapshot({ expiresAtTimestamp: PAST }))).toBe(false);
  });
  it('fully swept → false', () => {
    expect(isPcaSpendable(makePcaSnapshot({ fullySwept: true }))).toBe(false);
  });
  it('zero budget (both 0), not swept/expired → false', () => {
    expect(isPcaSpendable(makePcaSnapshot({ topUpBuffer: '0', baseEpochAllowance: '0', expiresAtTimestamp: FUTURE }))).toBe(false);
  });
  it('topUpBuffer-only → true', () => {
    expect(isPcaSpendable(makePcaSnapshot({ topUpBuffer: '1', baseEpochAllowance: '0', expiresAtTimestamp: FUTURE }))).toBe(true);
  });
  it('baseEpochAllowance-only → true (the capstone L2 case)', () => {
    expect(isPcaSpendable(makePcaSnapshot({ topUpBuffer: '0', baseEpochAllowance: '1', expiresAtTimestamp: FUTURE }))).toBe(true);
  });

  it('remainingAllowance=0 overrides nominal baseEpochAllowance for extended snapshots', () => {
    expect(
      isPcaSpendable(
        makePcaSnapshot({
          topUpBuffer: '0',
          baseEpochAllowance: '1',
          remainingAllowance: '0',
          expiresAtTimestamp: FUTURE,
        }),
      ),
    ).toBe(false);
  });
  it('missing remainingAllowance on a requested extended snapshot is unknown, not baseEpochAllowance-funded', () => {
    const snap = makePcaSnapshot({
      topUpBuffer: '0',
      baseEpochAllowance: '1',
      extendedRequested: true,
      expiresAtTimestamp: FUTURE,
    });
    expect(pcaBudgetState(snap)).toBeNull();
    expect(isPcaSpendable(snap)).toBe(false);
  });
  it('positive topUpBuffer stays spendable even when a requested extended allowance read is missing', () => {
    const snap = makePcaSnapshot({
      topUpBuffer: '1',
      baseEpochAllowance: '0',
      extendedRequested: true,
      expiresAtTimestamp: FUTURE,
    });
    expect(pcaBudgetState(snap)).toBe(true);
    expect(isPcaSpendable(snap)).toBe(true);
  });
  it('healthy + both budgets → true', () => {
    expect(isPcaSpendable(makePcaSnapshot({ expiresAtTimestamp: FUTURE }))).toBe(true);
  });
  it('expired beats budget (excluded even with budget)', () => {
    expect(isPcaSpendable(makePcaSnapshot({ expiresAtTimestamp: PAST, topUpBuffer: '1', baseEpochAllowance: '1' }))).toBe(false);
  });
});

describe('normalizeProbeRegistered', () => {
  it('registered true / false pass through', () => {
    expect(normalizeProbeRegistered({ key: '0x', registered: true })).toBe(true);
    expect(normalizeProbeRegistered({ key: '0x', registered: false })).toBe(false);
  });
  it('adapterSupported:false → null (couldn’t determine), even with registered:false', () => {
    expect(normalizeProbeRegistered({ key: '0x', registered: false, adapterSupported: false })).toBeNull();
    expect(normalizeProbeRegistered({ key: '0x', adapterSupported: false })).toBeNull();
  });
  it('undefined probedKey / undefined registered → null', () => {
    expect(normalizeProbeRegistered(undefined)).toBeNull();
    expect(normalizeProbeRegistered({ key: '0x' })).toBeNull();
  });
  it('registered true with adapterSupported true → true', () => {
    expect(normalizeProbeRegistered({ key: '0x', registered: true, adapterSupported: true })).toBe(true);
  });
});

describe('classifyCoverage (discriminated union — facets ONLY on uncovered)', () => {
  it('registered + spendable → { outcome: covers, registered: true } (no dead/hasBudget facets)', () => {
    const c = classifyCoverage(makePcaSnapshot({ expiresAtTimestamp: FUTURE, probedKey: { key: '0x', registered: true } }));
    expect(c).toEqual({ outcome: 'covers', registered: true });
  });
  it('registered + requested extended budget missing → inconclusive, not covers', () => {
    const c = classifyCoverage(
      makePcaSnapshot({
        topUpBuffer: '0',
        baseEpochAllowance: '1',
        extendedRequested: true,
        expiresAtTimestamp: FUTURE,
        probedKey: { key: '0x', registered: true },
      }),
    );
    // #1356 — a fail-softed budget read is inconclusive but NOT a capability gap.
    expect(c).toEqual({ outcome: 'inconclusive', registered: null, adapterUnsupported: false });
  });
  it('registered + expired → uncovered, dead:true (the reviewer’s example facet)', () => {
    const c = classifyCoverage(makePcaSnapshot({ expiresAtTimestamp: PAST, probedKey: { key: '0x', registered: true } }));
    expect(c).toEqual({ outcome: 'uncovered', registered: true, dead: true, hasBudget: true });
  });
  it('registered + zero-budget → uncovered, hasBudget:false', () => {
    const c = classifyCoverage(
      makePcaSnapshot({ topUpBuffer: '0', baseEpochAllowance: '0', expiresAtTimestamp: FUTURE, probedKey: { key: '0x', registered: true } }),
    );
    expect(c).toEqual({ outcome: 'uncovered', registered: true, dead: false, hasBudget: false });
  });
  // C1 — `dead` and `hasBudget` are INDEPENDENT reason facets. An account that is
  // BOTH expired (or swept) AND out-of-budget must set BOTH (dead:true, hasBudget:false),
  // not just one — the reviewer's independence lock (each facet has its own `if`).
  it('registered + expired + zero-budget → uncovered with BOTH facets (dead:true, hasBudget:false)', () => {
    const c = classifyCoverage(
      makePcaSnapshot({ expiresAtTimestamp: PAST, topUpBuffer: '0', baseEpochAllowance: '0', probedKey: { key: '0x', registered: true } }),
    );
    expect(c).toEqual({ outcome: 'uncovered', registered: true, dead: true, hasBudget: false });
  });
  it('registered + swept + zero-budget → uncovered with BOTH facets (dead:true, hasBudget:false)', () => {
    const c = classifyCoverage(
      makePcaSnapshot({ fullySwept: true, expiresAtTimestamp: FUTURE, topUpBuffer: '0', baseEpochAllowance: '0', probedKey: { key: '0x', registered: true } }),
    );
    expect(c).toEqual({ outcome: 'uncovered', registered: true, dead: true, hasBudget: false });
  });
  it('registered:false → { outcome: unregistered, registered: false }', () => {
    const c = classifyCoverage(makePcaSnapshot({ expiresAtTimestamp: FUTURE, probedKey: { key: '0x', registered: false } }));
    expect(c).toEqual({ outcome: 'unregistered', registered: false });
  });
  it('adapterSupported:false → { outcome: inconclusive, registered: null, adapterUnsupported: true }', () => {
    // #1356 — the capability gap flags adapterUnsupported so S6 can say "not supported".
    const c = classifyCoverage(makePcaSnapshot({ expiresAtTimestamp: FUTURE, probedKey: { key: '0x', registered: false, adapterSupported: false } }));
    expect(c).toEqual({ outcome: 'inconclusive', registered: null, adapterUnsupported: true });
  });
  it('missing probedKey → { outcome: inconclusive, registered: null, adapterUnsupported: false }', () => {
    // #1356 — a missing/transient probe is inconclusive but NOT a capability gap.
    const c = classifyCoverage(makePcaSnapshot({ expiresAtTimestamp: FUTURE }));
    expect(c).toEqual({ outcome: 'inconclusive', registered: null, adapterUnsupported: false });
  });
});
