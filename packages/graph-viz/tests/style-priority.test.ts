import { describe, expect, it } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { PrefixManager } from '../src/core/prefix-manager.js';
import { StyleEngine } from '../src/core/style-engine.js';
import { PALETTE_DARK, PALETTE_MIDNIGHT } from '../src/core/palette.js';
import type { StyleConfig } from '../src/core/types.js';

function graph() {
  const model = new GraphModel();
  model.addTriples([
    { subject: 'urn:item', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://schema.org/Person' },
    { subject: 'urn:item', predicate: 'https://schema.org/knows', object: 'urn:other' },
  ]);
  return { node: model.nodes.get('urn:item')!, edge: [...model.edges.values()][0] };
}

describe('style precedence and palette changes', () => {
  it.each([
    [{ nodeColors: { 'urn:item': '#111111' }, classColors: { 'schema:Person': '#222222' } }, '#111111'],
    [{ classColors: { 'schema:Person': '#222222' }, namespaceColors: { schema: '#333333' } }, '#222222'],
    [{ classColors: { 'https://schema.org/Person': '#444444' } }, '#444444'],
    [{ namespaceColors: { schema: '#333333' } }, '#333333'],
    [{ namespaceColors: { 'https://schema.org/': '#555555' } }, '#555555'],
    [{}, '#8b5cf6'],
  ] as [StyleConfig, string][])('applies explicit node/class/namespace precedence (%#)', (config, color) => {
    expect(new StyleEngine(config, new PrefixManager()).getNodeColor(graph().node)).toBe(color);
  });

  it('updates inherited defaults with the palette while preserving explicit choices', () => {
    const { node, edge } = graph();
    node.types = ['urn:unknown'];
    const inherited = new StyleEngine(undefined, new PrefixManager());
    expect(inherited.getNodeColor(node)).toBe(PALETTE_DARK.primary);
    inherited.setPalette(PALETTE_MIDNIGHT);
    expect(inherited.palette).toBe(PALETTE_MIDNIGHT);
    expect(inherited.getNodeColor(node)).toBe(PALETTE_MIDNIGHT.primary);
    expect(inherited.getEdgeColor(edge)).toBe(PALETTE_MIDNIGHT.edgeColor);
    const explicit = new StyleEngine({ defaultNodeColor: '#123456', defaultEdgeColor: '#654321' }, new PrefixManager());
    explicit.setPalette(PALETTE_MIDNIGHT);
    expect(explicit.getNodeColor(node)).toBe('#123456');
    expect(explicit.getEdgeColor(edge)).toBe('#654321');
  });

  it('merges node overrides and resolves compact and full predicate overrides', () => {
    const { node, edge } = graph();
    const styles = new StyleEngine({ nodeColors: { other: '#abcdef' }, predicateColors: { 'schema:knows': '#112233' } }, new PrefixManager());
    styles.setNodeColors({ 'urn:item': '#010203' });
    expect(styles.config.nodeColors).toEqual({ other: '#abcdef', 'urn:item': '#010203' });
    expect(styles.getNodeColor(node)).toBe('#010203');
    expect(styles.getEdgeColor(edge)).toBe('#112233');
    expect(new StyleEngine({ predicateColors: { 'https://schema.org/knows': '#223344' } }, new PrefixManager()).getEdgeColor(edge)).toBe('#223344');
  });

  it('keeps white unchanged, lightens black, and passes non-hex CSS colors through', () => {
    const styles = new StyleEngine({ gradientIntensity: 1 }, new PrefixManager());
    expect(styles.getGradientCenter('#000000')).toBe('#ffffff');
    expect(styles.getGradientCenter('#ffffff')).toBe('#ffffff');
    expect(styles.getBorderColor('#000000')).toBe('#4d4d4d');
    expect(styles.getBorderColor('rebeccapurple')).toBe('rebeccapurple');
    expect(new StyleEngine({ gradientIntensity: 0 }, new PrefixManager()).getGradientCenter('#123456')).toBe('#123456');
  });
});

it('falls through unrelated custom namespaces to a built-in vocabulary color', () => {
  const styles = new StyleEngine({ namespaceColors: { 'https://unrelated.invalid/': 'red' } }, new PrefixManager());
  expect(styles.getNodeColor(graph().node)).toBe('#8b5cf6');
});

describe('per-type outlines (classBorders)', () => {
  it('returns the outline configured for a node type, by full or compact URI', () => {
    const { node } = graph();
    expect(new StyleEngine({ classBorders: { 'https://schema.org/Person': { color: '#d9d0ff', width: 4 } } }, new PrefixManager())
      .getClassBorder(node)).toEqual({ color: '#d9d0ff', width: 4 });
    expect(new StyleEngine({ classBorders: { 'schema:Person': { color: '#2a1680' } } }, new PrefixManager())
      .getClassBorder(node)).toEqual({ color: '#2a1680' });
  });
  it('returns null when no outline applies', () => {
    const { node } = graph();
    expect(new StyleEngine({}, new PrefixManager()).getClassBorder(node)).toBeNull();
    expect(new StyleEngine({ classBorders: { 'urn:other-type': { color: '#000' } } }, new PrefixManager()).getClassBorder(node)).toBeNull();
  });
});

describe('withAlpha', () => {
  it('turns hex into rgba and leaves other colours alone', async () => {
    const { withAlpha } = await import('../src/core/palette.js');
    expect(withAlpha('#f8fafc', 0.8)).toBe('rgba(248, 250, 252, 0.8)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('transparent', 0.5)).toBe('transparent');
  });
});

describe('agent avatar nodes', () => {
  it('derives chip-style initials', async () => {
    const { agentInitials } = await import('../src/core/hexagon-painter.js');
    expect(agentInitials('Claude Code')).toBe('CC');
    expect(agentInitials('hermes')).toBe('HE');
    expect(agentInitials('0x3f2a…9b1c')).toBe('3F');
    expect(agentInitials('did:dkg:agent:0xab12cd')).toBe('AB');
    expect(agentInitials('')).toBe('?');
  });

  it('recognises agent types, expanded from compact form', async () => {
    const { HexagonPainter } = await import('../src/core/hexagon-painter.js');
    const { StyleEngine } = await import('../src/core/style-engine.js');
    const { PrefixManager } = await import('../src/core/prefix-manager.js');
    const pm = new PrefixManager();
    const painter = new HexagonPainter({ agentTypes: ['schema:Person'] }, new StyleEngine(undefined, pm), pm);
    const node = (types: string[]) => ({ id: 'x', types, label: 'x', degree: 1 } as any);
    expect(painter.isAgentNode(node([pm.expand('schema:Person')]))).toBe(true);
    expect(painter.isAgentNode(node(['https://schema.org/Thing']))).toBe(false);
  });

  it('defaults the edge label zoom threshold', async () => {
    const { StyleEngine } = await import('../src/core/style-engine.js');
    const { PrefixManager } = await import('../src/core/prefix-manager.js');
    const pm = new PrefixManager();
    expect(new StyleEngine(undefined, pm).config.edgeLabelMinZoom).toBe(0.3);
    expect(new StyleEngine({ edgeLabelMinZoom: 1.2 }, pm).config.edgeLabelMinZoom).toBe(1.2);
  });
});

describe('agent avatar initials from literals', () => {
  it('ignores literal quotes', async () => {
    const { agentInitials } = await import('../src/core/hexagon-painter.js');
    expect(agentInitials('"0x7b21…9a12"')).toBe('7B');
  });
});

describe('flat fill classes', () => {
  it('opts listed classes out of the gradient', () => {
    const pm = new PrefixManager();
    const se = new StyleEngine({ flatClasses: ['urn:x:Anchor'] }, pm);
    expect(se.isFlatFill({ id: 'a', types: ['urn:x:Anchor'] } as any)).toBe(true);
    expect(se.isFlatFill({ id: 'b', types: ['urn:x:Other'] } as any)).toBe(false);
  });
});
