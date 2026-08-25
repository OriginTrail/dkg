import { describe, expect, it } from 'vitest';
import { buildAgentColorMap } from '../src/ui/hooks/useSwmAttributions.js';

// GH#1128 — the legend hashed each agent into a fixed 8-slot palette, so two
// distinct agents could render an IDENTICAL swatch, and the graph tint hashed
// independently at a second call site so a swatch and its nodes could disagree
// too. Attribution exists to tell agents apart, so a collision is a wrong
// answer, not a cosmetic nit.
//
// These five addresses are not arbitrary: every one of them hashes to the SAME
// palette slot (6) under the old `h * 31 + charCode` scheme, so this fixture
// reproduces the reported collision rather than merely asserting distinctness
// against inputs that happened not to collide.
const COLLIDING = [
  'did:dkg:agent:0xa4c123b1612dd272d1371c17149d439536b3216f',
  'did:dkg:agent:0x5fc324bdb2e1142a21c402364f9572b85a8e48f6',
  'did:dkg:agent:0x49ddb14f71010b93b7d946bf54074e3248c801be',
  'did:dkg:agent:0xf750110c57513064d6d59291f0cde2e5738713a8',
  'did:dkg:agent:0xd0b698d5c7e41ba4ea5ee874ae7689447ab57a68',
];

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => `did:dkg:agent:0x${i.toString(16).padStart(40, '0')}`);

describe('buildAgentColorMap (GH#1128)', () => {
  it('gives distinct colours to five agents that all collide under the old hash', () => {
    const map = buildAgentColorMap(COLLIDING);
    expect(map.size).toBe(5);
    expect(new Set(map.values()).size).toBe(5);
  });

  it('gives every agent a distinct colour up to the palette size', () => {
    for (let n = 1; n <= 8; n++) {
      const map = buildAgentColorMap(COLLIDING.concat(many(n)).slice(0, n));
      expect(new Set(map.values()).size).toBe(map.size);
    }
  });

  it('is deterministic regardless of input order', () => {
    const forward = buildAgentColorMap(COLLIDING);
    const reversed = buildAgentColorMap([...COLLIDING].reverse());
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it('is stable across repeated builds for the same agent set', () => {
    expect([...buildAgentColorMap(COLLIDING).entries()])
      .toEqual([...buildAgentColorMap(COLLIDING).entries()]);
  });

  it('deduplicates repeated agents', () => {
    expect(buildAgentColorMap([COLLIDING[0]!, COLLIDING[0]!, COLLIDING[1]!]).size).toBe(2);
  });

  it('consumes every palette slot before any reuse begins', () => {
    // PR #2333 review — the previous implementation gated probing on the TOTAL
    // set size, so a ninth agent flipped the whole collection back to raw
    // hashing and collapsed the five colliding fixtures onto one colour again.
    // Degradation must be local to the agents that actually overflow.
    const overflow = (n: number) =>
      Array.from({ length: n }, (_, i) => `did:dkg:agent:0x${i.toString(16).padStart(40, 'f')}`);

    for (const extra of [0, 1, 2, 5, 20]) {
      const agents = COLLIDING.concat(overflow(extra));
      const map = buildAgentColorMap(agents);
      expect(map.size).toBe(agents.length);
      // All 8 slots in use as soon as there are at least 8 agents.
      const expectedDistinct = Math.min(agents.length, 8);
      expect(new Set(map.values()).size).toBe(expectedDistinct);
      // And the originally-colliding five stay distinct at every size.
      expect(new Set(COLLIDING.map((a) => map.get(a))).size).toBe(COLLIDING.length);
    }
  });

  // PR #2333 review — an earlier version of this test claimed the agents below
  // the boundary keep their colours, but asserted only cardinality, so it would
  // have passed while every one of them moved. Measured: adding a ninth agent
  // recolours 3 of the existing 8.
  //
  // That is inherent, not a defect. Distinctness requires coordinating slots
  // across the whole set, so assignment MUST depend on set membership;
  // per-agent stability would mean going back to the raw hash, which is the
  // collision this issue is about. #1128 asks for distinct colours, so
  // distinctness wins and colours may permute when the roster changes.
  //
  // What IS guaranteed, and what these assert:
  it('is fully determined by the agent set — same membership, same colours', () => {
    const eight = COLLIDING.concat(
      Array.from({ length: 3 }, (_, i) => `did:dkg:agent:0x${i.toString(16).padStart(40, 'f')}`),
    );
    // The load-bearing property: a re-render with unchanged membership must not
    // move the legend, in any input order.
    const a = [...buildAgentColorMap(eight).entries()].sort();
    const b = [...buildAgentColorMap([...eight].reverse()).entries()].sort();
    expect(b).toEqual(a);
  });

  it('adding a ninth agent still leaves every agent distinctly coloured', () => {
    const eight = COLLIDING.concat(
      Array.from({ length: 3 }, (_, i) => `did:dkg:agent:0x${i.toString(16).padStart(40, 'f')}`),
    );
    const after = buildAgentColorMap(eight.concat('did:dkg:agent:0x' + 'e'.repeat(40)));
    // All 8 slots still in use, and the originally-colliding five still apart —
    // colours may have permuted, but nothing collapsed.
    expect(new Set(after.values()).size).toBe(8);
    expect(new Set(COLLIDING.map((a) => after.get(a))).size).toBe(COLLIDING.length);
  });

  it('returns an empty map for no agents', () => {
    expect(buildAgentColorMap([]).size).toBe(0);
  });
});
