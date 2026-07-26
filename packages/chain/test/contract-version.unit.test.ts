/**
 * The ONE deployed-contract version comparator (`src/contract-version.ts`).
 *
 * A version gate is a capability boundary where drift is SILENT: a comparator that
 * disagrees with its neighbour by one patch level fails nothing, passes every suite,
 * and either leaves a feature dormant forever or enables it a release early against
 * a contract that will revert. This PR collapsed two copies into one, so the
 * load-bearing test is not "does the comparator work" but **"does it still decide
 * exactly what the code it replaced decided"**.
 *
 * The PCA `clearAgents` gate previously computed its answer inline as:
 *
 *     maj > 10 || (maj === 10 && (min > 0 || (min === 0 && pat >= 6)))
 *
 * That expression is reproduced verbatim below and asserted equivalent to
 * `contractVersionAtLeast(v, CLEAR_AGENTS_MIN_PCA_VERSION)` across the full
 * edge-case matrix plus an exhaustive numeric grid. If the shared comparator is
 * ever changed in a way that alters the PCA capability boundary, this fails.
 */
import { describe, it, expect } from 'vitest';
import {
  contractVersionAtLeast,
  parseContractVersionTriple,
} from '../src/contract-version.js';
// Both production thresholds, imported from the modules that own them so a change
// to either cannot silently un-pin these assertions.
import { CLEAR_AGENTS_MIN_PCA_VERSION } from '../src/evm-adapter-conviction.js';
import { ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION } from '../src/evm-adapter-base.js';

/**
 * The pre-migration PCA gate, character-for-character as it stood in
 * `evm-adapter-conviction.ts` before this PR — including its own parse. Kept
 * verbatim ON PURPOSE: rewriting it to share the new parse would make the
 * equivalence assertion circular and prove nothing.
 */
function legacyPcaClearAgentsGate(rawVersion: string): boolean {
  const v = String(rawVersion).split('.').map((n) => parseInt(n, 10) || 0);
  const [maj, min, pat] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return maj > 10 || (maj === 10 && (min > 0 || (min === 0 && pat >= 6)));
}

describe('contractVersionAtLeast — PCA clearAgents migration equivalence [CH-VER-1]', () => {
  const NAMED = [
    // boundary
    '10.0.5', '10.0.6', '10.0.7',
    // above / below on each component
    '10.1.0', '10.1.7', '9.9.9', '11.0.0', '0.0.0',
    // malformed / partial — must sort BELOW every real release, never throw
    '', '10.0', '10', 'garbage', 'x.y.z', '10..6', '  ',
    // suffixed and out-of-range shapes
    '10.0.6-rc.1', '10.0.600', '-1.0.0', '10.-1.0',
  ];

  for (const version of NAMED) {
    it(`matches the pre-migration PCA gate for ${JSON.stringify(version)}`, () => {
      expect(contractVersionAtLeast(version, CLEAR_AGENTS_MIN_PCA_VERSION))
        .toBe(legacyPcaClearAgentsGate(version));
    });
  }

  it('matches the pre-migration PCA gate across an exhaustive numeric grid', () => {
    const divergences: string[] = [];
    for (let major = 0; major <= 12; major += 1) {
      for (let minor = 0; minor <= 3; minor += 1) {
        for (let patch = 0; patch <= 8; patch += 1) {
          const version = `${major}.${minor}.${patch}`;
          if (contractVersionAtLeast(version, CLEAR_AGENTS_MIN_PCA_VERSION)
            !== legacyPcaClearAgentsGate(version)) {
            divergences.push(version);
          }
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  it('still answers the PCA boundary the way the shipped gate must', () => {
    // Guards the grid above from being vacuously satisfied by a comparator that
    // returns a constant — both branches must actually occur at the boundary.
    expect(contractVersionAtLeast('10.0.6', CLEAR_AGENTS_MIN_PCA_VERSION)).toBe(true);
    expect(contractVersionAtLeast('10.0.5', CLEAR_AGENTS_MIN_PCA_VERSION)).toBe(false);
  });
});

describe('contractVersionAtLeast — general ordering [CH-VER-2]', () => {
  it('orders major → minor → patch, not lexically', () => {
    // The trap a string compare falls into: '10' < '9' lexically.
    expect(contractVersionAtLeast('10.0.0', '9.9.9')).toBe(true);
    expect(contractVersionAtLeast('9.9.9', '10.0.0')).toBe(false);
    // Double-digit components must compare numerically, not character-wise.
    expect(contractVersionAtLeast('10.1.70', '10.1.7')).toBe(true);
    expect(contractVersionAtLeast('10.10.0', '10.9.0')).toBe(true);
  });

  it('is reflexive at the threshold and strict below it', () => {
    for (const v of ['10.1.7', '0.0.0', '11.2.3']) {
      expect(contractVersionAtLeast(v, v)).toBe(true);
    }
    expect(contractVersionAtLeast('10.1.6', '10.1.7')).toBe(false);
  });

  it('treats every unreadable shape as BELOW any real threshold (fail closed)', () => {
    for (const bad of ['', '  ', 'unknown', 'x.y.z', 'null', 'undefined']) {
      expect(contractVersionAtLeast(bad, ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION)).toBe(false);
      expect(contractVersionAtLeast(bad, CLEAR_AGENTS_MIN_PCA_VERSION)).toBe(false);
    }
  });

  it('parses to a 3-tuple with zero-fill, never throwing', () => {
    expect(parseContractVersionTriple('10.1.7')).toEqual([10, 1, 7]);
    expect(parseContractVersionTriple('10.1')).toEqual([10, 1, 0]);
    expect(parseContractVersionTriple('10')).toEqual([10, 0, 0]);
    expect(parseContractVersionTriple('')).toEqual([0, 0, 0]);
    expect(parseContractVersionTriple('garbage')).toEqual([0, 0, 0]);
    // Contract `_VERSION` literals are plain dotted integers; a suffix truncates.
    expect(parseContractVersionTriple('10.0.6-rc.1')).toEqual([10, 0, 6]);
  });
});
