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
  parseContractVersion,
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

/** The pre-strictness LENIENT comparator, for the general well-formed equivalence
 *  sweep against an arbitrary floor (the PCA gate above is hardcoded to 10.0.6). */
function legacyAtLeast(raw: string, minimum: string): boolean {
  const parse = (s: string): [number, number, number] => {
    const p = String(s).split('.').map((n) => parseInt(n, 10) || 0);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  };
  const [maj, min, pat] = parse(raw);
  const [fMaj, fMin, fPat] = parse(minimum);
  if (maj !== fMaj) return maj > fMaj;
  if (min !== fMin) return min > fMin;
  return pat >= fPat;
}

/** The shape a real contract `_VERSION` literal can take: dotted integers only. */
const WELL_FORMED_SHAPE = /^\d+\.\d+\.\d+$/;

describe('contractVersionAtLeast — PCA clearAgents migration equivalence [CH-VER-1]', () => {
  // Every version a deployed contract can actually report. Behaviour here MUST be
  // identical to the gate this replaced — this is the load-bearing claim.
  const WELL_FORMED_CASES = [
    '10.0.5', '10.0.6', '10.0.7',            // the boundary and its neighbours
    '10.1.0', '10.1.7', '9.9.9', '11.0.0',   // above / below on each component
    '0.0.0', '10.0.600', '10.10.0',          // zero, large patch, double-digit minor
  ];

  for (const version of WELL_FORMED_CASES) {
    it(`matches the pre-migration PCA gate for well-formed ${JSON.stringify(version)}`, () => {
      expect(WELL_FORMED_SHAPE.test(version)).toBe(true);
      expect(contractVersionAtLeast(version, CLEAR_AGENTS_MIN_PCA_VERSION))
        .toBe(legacyPcaClearAgentsGate(version));
    });
  }

  it('matches the pre-migration PCA gate across an exhaustive well-formed grid', () => {
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

/**
 * Where strict parsing DELIBERATELY departs from the lenient `split`+`parseInt`
 * behaviour the PCA gate used to have.
 *
 * This exists to document the divergence, not to hide it. The old parse accepted
 * garbage in the direction that reads as a NEWER version — `'11.garbage'` became
 * `11.0.0`, so it would have ENABLED the capability. Strict parsing refuses, which
 * is a real behaviour change on malformed input and therefore has to be deliberate,
 * enumerated, and confined.
 */
describe('contractVersionAtLeast — deliberate strict-parse divergence [CH-VER-3]', () => {
  // Inputs the OLD gate admitted (or ranked wrongly) and the NEW one refuses.
  // Every one of these would have turned a capability ON from a malformed string.
  const DIVERGENT = ['11.garbage', '10.1.7junk', '10.0.6-rc.1', '10..6', '10.1'];

  for (const version of DIVERGENT) {
    it(`refuses malformed ${JSON.stringify(version)} that the lenient parse admitted`, () => {
      expect(legacyPcaClearAgentsGate(version)).toBe(true);   // old: enabled
      expect(contractVersionAtLeast(version, CLEAR_AGENTS_MIN_PCA_VERSION)).toBe(false); // new: closed
    });
  }

  // THE confinement proof the divergence rests on: nothing a deployed contract can
  // report is affected. If a future edit made a WELL-FORMED version diverge, this
  // fails — which is the only case where the strictness would be a regression
  // rather than a hardening.
  it('every divergence is confined to input no real _VERSION can produce', () => {
    for (const version of DIVERGENT) {
      expect(WELL_FORMED_SHAPE.test(version)).toBe(false);
    }
  });

  it('no WELL-FORMED version diverges between strict and lenient (exhaustive)', () => {
    const divergences: string[] = [];
    for (let major = 0; major <= 12; major += 1) {
      for (let minor = 0; minor <= 12; minor += 1) {
        for (let patch = 0; patch <= 12; patch += 1) {
          const version = `${major}.${minor}.${patch}`;
          for (const floor of [CLEAR_AGENTS_MIN_PCA_VERSION, ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION]) {
            if (contractVersionAtLeast(version, floor) !== legacyAtLeast(version, floor)) {
              divergences.push(`${version} vs ${floor}`);
            }
          }
        }
      }
    }
    expect(divergences).toEqual([]);
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

  it('parses ONLY a full dotted-integer triple, else null (never throws)', () => {
    expect(parseContractVersion('10.1.7')).toEqual([10, 1, 7]);
    expect(parseContractVersion('0.0.0')).toEqual([0, 0, 0]);
    expect(parseContractVersion('10.0.600')).toEqual([10, 0, 600]);
    // Everything below would have parsed to a confident (and wrong) triple under
    // the lenient split+parseInt — several of them ranking as NEWER than they are.
    for (const bad of ['10.1', '10', '', '  ', 'garbage', 'x.y.z', '10..6',
      '10.0.6-rc.1', '11.garbage', '10.1.7junk', '-1.0.0', '10.-1.0', '1.2.3.4']) {
      expect(parseContractVersion(bad)).toBeNull();
    }
  });
});
