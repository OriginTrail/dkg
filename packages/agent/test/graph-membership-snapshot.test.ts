import { describe, expect, it } from 'vitest';
import { compareCodePoint } from '../src/sync/code-point-order.js';
import { createGraphMembershipSnapshot } from '../src/sync/graph-membership-snapshot.js';

describe('graph membership snapshot', () => {
  it('keeps one immutable sorted membership index', () => {
    const snapshot = createGraphMembershipSnapshot([
      'urn:graph:z',
      'urn:graph:a/child',
      'urn:graph:a',
      'urn:graph:z',
      'urn:graph:a/😀',
    ]);

    expect(snapshot.graphs).toEqual([
      'urn:graph:a',
      'urn:graph:a/child',
      'urn:graph:a/😀',
      'urn:graph:z',
    ].sort(compareCodePoint));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.graphs)).toBe(true);
    expect(snapshot.has('urn:graph:a/child')).toBe(true);
    expect(snapshot.has('urn:graph:missing')).toBe(false);
  });

  it('accepts a proven sorted catalog without reordering it', () => {
    const sorted = Object.freeze(['urn:graph:a', 'urn:graph:b', 'urn:graph:𐀀']);
    const snapshot = createGraphMembershipSnapshot(sorted, { sortedUnique: true });

    expect(snapshot.graphs).toEqual(sorted);
    expect(snapshot.graphs).toBe(sorted);
    expect(snapshot.matches([...sorted].reverse())).toBe(true);
    expect(snapshot.equalOrUnder('urn:graph:a')).toEqual(['urn:graph:a']);
  });

  it('selects only the exact graph and slash-delimited descendants', () => {
    const root = 'did:dkg:context-graph:alpha';
    const graphs = [
      root,
      `${root}/_meta`,
      `${root}/_shared_memory`,
      `${root}/_shared_memory/0xabc/1`,
      `${root}/sub/_meta`,
      `${root}-lookalike`,
      'did:dkg:context-graph:beta/data',
    ];
    const snapshot = createGraphMembershipSnapshot([...graphs].reverse());

    expect(snapshot.equalOrUnder(root)).toEqual(
      [...graphs]
        .filter((graph) => graph === root || graph.startsWith(`${root}/`))
        .sort(compareCodePoint),
    );
    expect(snapshot.equalOrUnder(root, (graph) => !graph.endsWith('/_meta'))).toEqual(
      [...graphs]
        .filter((graph) => (
          (graph === root || graph.startsWith(`${root}/`))
          && !graph.endsWith('/_meta')
        ))
        .sort(compareCodePoint),
    );
  });

  it('matches reordered graph listings and rejects membership changes', () => {
    const snapshot = createGraphMembershipSnapshot(['urn:graph:a', 'urn:graph:b']);
    expect(snapshot.matches(['urn:graph:b', 'urn:graph:a'])).toBe(true);
    expect(snapshot.matches(['urn:graph:a', 'urn:graph:a'])).toBe(false);
    expect(snapshot.matches(['urn:graph:a', 'urn:graph:c'])).toBe(false);
    expect(snapshot.matches(['urn:graph:a'])).toBe(false);
  });

  it('matches full-scan selection across large graph families', () => {
    const graphs = Array.from({ length: 20_000 }, (_, index) => (
      `did:dkg:context-graph:${String(index % 200).padStart(3, '0')}`
      + `/_shared_memory/0x${String(index % 37).padStart(40, '0')}/${index}`
    ));
    const snapshot = createGraphMembershipSnapshot([...graphs].reverse());

    for (const contextGraphIndex of [0, 1, 17, 99, 199, 250]) {
      const root = `did:dkg:context-graph:${String(contextGraphIndex).padStart(3, '0')}`;
      const expected = [...graphs]
        .filter((graph) => graph === root || graph.startsWith(`${root}/`))
        .sort(compareCodePoint);
      expect(snapshot.equalOrUnder(root)).toEqual(expected);
    }
  });
});
