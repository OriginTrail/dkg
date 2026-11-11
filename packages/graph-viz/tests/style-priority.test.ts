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

  it('restyles in place: new class colours and appearances, kept node overrides, palette-following defaults', () => {
    const { node, edge } = graph();
    const engine = new StyleEngine({ classColors: { 'schema:Person': '#222222' }, classAppearance: { 'schema:Person': { fill: 'flat' } }, edgeLabelMinZoom: 1.2 }, new PrefixManager(), PALETTE_DARK);
    engine.setNodeColors({ 'urn:other': '#999999' });
    expect(engine.getNodeColor(node)).toBe('#222222');
    // The light theme's dictionaries replace the dark ones.
    engine.setStyle({ classColors: { 'schema:Person': '#dddddd' }, classAppearance: { 'https://schema.org/Person': { shape: 'avatar' } } });
    expect(engine.getNodeColor(node)).toBe('#dddddd');
    expect(engine.getAppearance(node)).toEqual({ shape: 'avatar' });
    expect(engine.config.edgeLabelMinZoom).toBe(0.3);
    expect(engine.config.nodeColors).toEqual({ 'urn:other': '#999999' });
    // Unset defaults follow the active palette; an explicit one is kept across palette changes.
    expect(engine.getEdgeColor(edge)).toBe(PALETTE_DARK.edgeColor);
    engine.setStyle({ defaultEdgeColor: '#123456' });
    engine.setPalette(PALETTE_MIDNIGHT);
    expect(engine.config.defaultEdgeColor).toBe('#123456');
    expect(engine.config.defaultNodeColor).toBe(PALETTE_MIDNIGHT.primary);
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

describe('per-type appearance (classAppearance)', () => {
  it('resolves outline, fill and shape for a type keyed by full or compact URI', () => {
    const { node } = graph();
    const full = new StyleEngine({ classAppearance: { 'https://schema.org/Person': { border: { color: '#d9d0ff', width: 4 }, fill: 'flat' } } }, new PrefixManager());
    expect(full.getAppearance(node)).toEqual({ border: { color: '#d9d0ff', width: 4 }, fill: 'flat', shape: undefined });
    const compact = new StyleEngine({ classAppearance: { 'schema:Person': { shape: 'avatar' } } }, new PrefixManager());
    expect(compact.getAppearance(node).shape).toBe('avatar');
  });

  it('takes each property from the first of a node\'s types that sets it', () => {
    const se = new StyleEngine({ classAppearance: {
      'urn:x:A': { border: { color: '#111' } },
      'urn:x:B': { border: { color: '#222' }, fill: 'flat', shape: 'avatar' },
    } }, new PrefixManager());
    expect(se.getAppearance({ id: 'n', types: ['urn:x:A', 'urn:x:B'] } as any))
      .toEqual({ border: { color: '#111' }, fill: 'flat', shape: 'avatar' });
  });

  it('resolves a compact key whose prefix arrives later (declared by loaded Turtle)', () => {
    const pm = new PrefixManager();
    const se = new StyleEngine({ classAppearance: { 'ex:Agent': { shape: 'avatar' } } }, pm);
    const agent = { id: 'a', types: ['https://example.org/Agent'] } as any;
    expect(se.getAppearance(agent)).toEqual({});
    pm.addPrefix('ex', 'https://example.org/');
    expect(se.getAppearance(agent).shape).toBe('avatar');
    expect(se.getAppearance({ id: 'b', types: ['https://example.org/Other'] } as any)).toEqual({});
  });

  it('is empty when none of the node\'s types is configured', () => {
    const { node } = graph();
    expect(new StyleEngine({}, new PrefixManager()).getAppearance(node)).toEqual({});
    expect(new StyleEngine({ classAppearance: { 'urn:other-type': { fill: 'flat' } } }, new PrefixManager()).getAppearance(node)).toEqual({});
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

  it('draws avatar-shaped types no smaller than legible, keyed by compact form', async () => {
    const { HexagonPainter } = await import('../src/core/hexagon-painter.js');
    const { StyleEngine } = await import('../src/core/style-engine.js');
    const { PrefixManager } = await import('../src/core/prefix-manager.js');
    const pm = new PrefixManager();
    const se = new StyleEngine({ classAppearance: { 'schema:Person': { shape: 'avatar' } } }, pm);
    const painter = new HexagonPainter({ baseSize: 10, minSize: 2, maxSize: 30 }, se, pm);
    const node = (types: string[]) => ({ id: 'x', types, label: 'x', degree: 0 } as any);
    expect(se.getAppearance(node([pm.expand('schema:Person')])).shape).toBe('avatar');
    expect(se.getAppearance(node(['https://schema.org/Thing'])).shape).toBeUndefined();
    expect(painter.getRadius(node([pm.expand('schema:Person')]))).toBeGreaterThanOrEqual(13);
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

  it('falls back instead of throwing for separator-only names and empty DID suffixes', async () => {
    const { agentInitials } = await import('../src/core/hexagon-painter.js');
    for (const name of ['_', '-', '__--__', '"_"', 'did:dkg:agent:', 'did:dkg:agent:_']) {
      expect(agentInitials(name)).toBe('?');
    }
  });

  it('strips long runs of quotes in linear time', async () => {
    const { agentInitials } = await import('../src/core/hexagon-painter.js');
    const quotes = '"'.repeat(50_000);
    const started = performance.now();
    expect(agentInitials(`${quotes}Claude Code${quotes}`)).toBe('CC');
    expect(agentInitials(`${quotes}x`)).toBe('X');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

