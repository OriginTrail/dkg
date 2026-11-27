import { describe, expect, it } from 'vitest';
import { buildAgentColorMap } from '../src/ui/hooks/useSwmAttributions.js';
import { agentColorForUri, agentHexForUri } from '../src/ui/hooks/useAgents.js';

// The SWM graph tints each agent's nodes with that agent's chip colour, so an
// agent reads the same in the chip, the legend and the graph. These tests pin
// that link. Distinct colours per agent (GH#1128) are no longer guaranteed: the
// hue hash can collide, and the legend + node hover tell agents apart then.

const AGENTS = [
  'did:dkg:agent:0xa4c123b1612dd272d1371c17149d439536b3216f',
  'did:dkg:agent:0x5fc324bdb2e1142a21c402364f9572b85a8e48f6',
  'did:dkg:agent:0x49ddb14f71010b93b7d946bf54074e3248c801be',
  'did:dkg:agent:0xf750110c57513064d6d59291f0cde2e5738713a8',
  '12D3KooWQf3m8r1Lx2c9Vb7nT4yE6uJ1aP5sH8kD3gF2bN9zC',
];

function hslToRgb(hsl: string): [number, number, number] {
  const m = /^hsl\((\d+(?:\.\d+)?), (\d+)%, (\d+)%\)$/.exec(hsl);
  if (!m) throw new Error(`not hsl: ${hsl}`);
  const h = Number(m[1]), s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255)) as [number, number, number];
}
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('SWM graph agent tint = agent chip colour', () => {
  it('uses the chip colour for every agent', () => {
    const map = buildAgentColorMap(AGENTS);
    for (const a of AGENTS) {
      expect(map.get(a)).toBe(agentHexForUri(a));
      expect(hexToRgb(map.get(a)!)).toEqual(hslToRgb(agentColorForUri(a)));
    }
  });

  it('emits #rrggbb so graph-viz can derive borders and gradients', () => {
    for (const c of buildAgentColorMap(AGENTS).values()) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('does not depend on which other agents are in the graph', () => {
    const alone = buildAgentColorMap([AGENTS[0]!]);
    const withOthers = buildAgentColorMap(AGENTS);
    const reversed = buildAgentColorMap([...AGENTS].reverse());
    expect(withOthers.get(AGENTS[0]!)).toBe(alone.get(AGENTS[0]!));
    expect([...reversed.entries()].sort()).toEqual([...withOthers.entries()].sort());
  });

  it('deduplicates repeated agents', () => {
    expect(buildAgentColorMap([AGENTS[0]!, AGENTS[0]!, AGENTS[1]!]).size).toBe(2);
  });
});
