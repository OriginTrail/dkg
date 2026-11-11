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
