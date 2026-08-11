import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CORE_AMBIGUOUS_REJECT_LITERALS_V1,
  CORE_QUARANTINE_REASONS_V1,
  CORE_REJECT_REASON_SITES_V1,
} from './helpers/authority-verdict-diff-fixture-v1.js';

/**
 * Phase 1, first pinned piece: the harvested `literal -> site(s)` map for core's
 * authority decisions.
 *
 * WHY A SOURCE HARVEST AND NOT A RUN. `reject.reason` is an open `string`, so
 * its codomain cannot be enumerated from the type -- it has to be read out of
 * the source. Pinning the harvest here means a reject that is ADDED, REMOVED or
 * REWORDED turns this red immediately, rather than surfacing later as an
 * unmapped literal in the verdict table. The map is what makes such a red
 * triageable: it says which site to look at.
 *
 * This deliberately does not assert core's BEHAVIOUR -- that is the verdict
 * table's job. It asserts that the fixture the table depends on still describes
 * the file it was harvested from.
 */
const CORE_SRC = new URL(
  '../../core/src/system-record-authority-v1-internal.ts',
  import.meta.url,
);

function harvest(): { reject: Map<string, number[]>; quarantine: Map<string, number[]> } {
  const lines = readFileSync(CORE_SRC, 'utf8').split('\n');
  const reject = new Map<string, number[]>();
  const quarantine = new Map<string, number[]>();
  let pending: 'reject' | 'quarantine' | undefined;
  lines.forEach((line, index) => {
    const decision = /decision:\s*'(accept|stale|quarantine|reject)'/.exec(line);
    if (decision) {
      pending = decision[1] === 'reject' || decision[1] === 'quarantine'
        ? (decision[1] as 'reject' | 'quarantine')
        : undefined;
    }
    const reason = /reason:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
    if (!reason || pending === undefined) return;
    const target = pending === 'reject' ? reject : quarantine;
    target.set(reason[1], [...(target.get(reason[1]) ?? []), index + 1]);
  });
  return { reject, quarantine };
}

describe('core authority decision reason harvest', () => {
  const { reject, quarantine } = harvest();

  it('pins every reject literal and the sites that produce it', () => {
    expect(Object.fromEntries([...reject].sort())).toEqual(
      Object.fromEntries(Object.entries(CORE_REJECT_REASON_SITES_V1).map(
        ([literal, sites]) => [literal, [...sites]],
      )),
    );
  });

  // The finding this fixture exists to record. `{ decision: 'reject', reason }`
  // carries no origin, so for a literal produced at more than one site the
  // branch is indistinguishable to ANY caller -- the diff included. If this list
  // shrinks, someone made core more observable and the table can say more; if it
  // grows, a new branch became unobservable and Phase 3 inherits the problem.
  it('records exactly the reject literals that are observationally ambiguous', () => {
    const ambiguous = [...reject].filter(([, sites]) => sites.length > 1).map(([l]) => l);
    expect(ambiguous.sort()).toEqual([...CORE_AMBIGUOUS_REJECT_LITERALS_V1].sort());
    expect(ambiguous).toHaveLength(5);
  });

  // Quarantine is a different kind of thing wearing the same field name: a
  // closed union that is part of the contract, where the VALUE is the meaning.
  // Several sites producing one value is not ambiguity -- a caller acts on the
  // value, not the branch -- so this pins the closed set, and the sites only so
  // a change in where quarantine is decided is visible.
  it('pins the closed quarantine reason union as a contract value', () => {
    expect([...quarantine.keys()].sort()).toEqual(
      Object.keys(CORE_QUARANTINE_REASONS_V1).sort(),
    );
    expect(Object.fromEntries([...quarantine].sort())).toEqual(
      Object.fromEntries(Object.entries(CORE_QUARANTINE_REASONS_V1).map(
        ([reason, { sites }]) => [reason, [...sites]],
      )),
    );
  });

  // Non-vacuity: the harvester must actually find things. Without this the three
  // rows above would all pass against an empty map if the regex or the path
  // broke -- the zero-is-indistinguishable-from-a-broken-probe failure.
  it('harvests a non-trivial number of sites, so an empty map cannot pass', () => {
    expect([...reject.values()].flat().length).toBe(32);
    expect([...quarantine.values()].flat().length).toBe(10);
  });
});
