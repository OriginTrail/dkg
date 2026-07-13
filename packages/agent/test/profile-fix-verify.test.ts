import { describe, it, expect } from 'vitest';
import { buildAgentProfile } from '../src/profile.js';

describe('buildAgentProfile contextGraphsServed fix', () => {
  it('emits one triple per CG instead of a comma-joined string', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmTest123',
      name: 'TestAgent',
      skills: [],
      contextGraphsServed: ['agent-skills', 'climate', 'weather-data'],
    });

    const cgsQuads = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );

    expect(cgsQuads).toHaveLength(3);
    expect(cgsQuads.map((q) => q.object)).toEqual([
      '"agent-skills"',
      '"climate"',
      '"weather-data"',
    ]);
  });

  it('produces no oversized literal even with 1000 CGs', () => {
    const largeCgs = Array.from(
      { length: 1000 },
      (_, i) => `owner-${String(i).padStart(4, '0')}/context-graph-${i}`,
    );
    const { quads } = buildAgentProfile({
      peerId: 'QmLargeNode',
      name: 'CoreNode',
      skills: [],
      contextGraphsServed: largeCgs,
    });

    const cgsQuads = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );

    expect(cgsQuads).toHaveLength(1000);
    const maxLen = Math.max(...cgsQuads.map((q) => q.object.length));
    expect(maxLen).toBeLessThan(200);
  });

  it('produces no duplicate triples', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmDupCheck',
      name: 'DupAgent',
      skills: [],
      contextGraphsServed: ['cg-alpha', 'cg-beta'],
    });

    const cgsQuads = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );

    expect(cgsQuads).toHaveLength(2);
    const serialized = cgsQuads.map((q) => JSON.stringify(q));
    const unique = new Set(serialized);
    expect(unique.size).toBe(cgsQuads.length);
  });

  it('advertises dRAG answering as a separate opt-in hosting capability', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmDragHost',
      name: 'DragHost',
      skills: [],
      contextGraphsServed: ['cg-alpha', 'cg-beta'],
      dragContextGraphsServed: ['cg-beta'],
    });

    const generic = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );
    const drag = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#dragContextGraphsServed',
    );

    expect(generic.map((q) => q.object)).toEqual(['"cg-alpha"', '"cg-beta"']);
    expect(drag.map((q) => q.object)).toEqual(['"cg-beta"']);
    expect(drag[0].subject).toBe(generic[0].subject);
  });

  it('omits contextGraphsServed when not configured', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmEmpty',
      name: 'NoHosting',
      skills: [],
    });

    const cgsQuads = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );
    expect(cgsQuads).toHaveLength(0);

    const hostingQuads = quads.filter(
      (q) => q.predicate === 'https://dkg.origintrail.io/skill#hostingProfile',
    );
    expect(hostingQuads).toHaveLength(0);
  });
});
