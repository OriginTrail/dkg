// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import type { RendererBackend } from '../src/core/renderer-backend.js';
const boundary = vi.hoisted(() => {
  const instances: Mocked<RendererBackend>[] = [];
  function create(overrides: Partial<Mocked<RendererBackend>> = {}): Mocked<RendererBackend> {
    const renderer: Mocked<RendererBackend> = {
      init: vi.fn<RendererBackend['init']>(),
      render: vi.fn<RendererBackend['render']>(),
      resize: vi.fn<RendererBackend['resize']>(),
      destroy: vi.fn<RendererBackend['destroy']>(),
      refresh: vi.fn<NonNullable<RendererBackend['refresh']>>(),
      applyAnimation: vi.fn<NonNullable<RendererBackend['applyAnimation']>>(),
      applyPalette: vi.fn<NonNullable<RendererBackend['applyPalette']>>(),
      setKaGroups: vi.fn<NonNullable<RendererBackend['setKaGroups']>>(),
      centerOnNode: vi.fn<RendererBackend['centerOnNode']>(),
      zoomToFit: vi.fn<RendererBackend['zoomToFit']>(),
      getCanvas: vi.fn<RendererBackend['getCanvas']>().mockReturnValue(null),
      ...overrides,
    };
    instances.push(renderer);
    return renderer;
  }
  return { instances, create };
});
vi.mock('../src/core/renderer.js', () => ({
  Canvas2DRenderer: vi.fn(function () { return boundary.create(); }),
}));
vi.mock('../src/core/renderer-3d.js', () => ({
  createWebGL3DRenderer: async () => boundary.create({
    refresh: undefined, applyAnimation: undefined, applyPalette: undefined, setKaGroups: undefined,
  }),
}));
import { RdfGraphViz } from '../src/core/rdf-graph-viz.js';
import { parseNTriples } from '../src/parsers/ntriples.js';
import type { RdfGraphVizConfig, RdfTriple } from '../src/core/types.js';
import type { GraphDataSource } from '../src/data-sources/types.js';

let container: HTMLDivElement; const views: RdfGraphViz[] = [];
const make = (options?: RdfGraphVizConfig) => { const viz = new RdfGraphViz(container, options); views.push(viz); return viz; };
const backend = () => boundary.instances.at(-1)!;
const rendered = (): Parameters<RendererBackend['render']> => backend().render.mock.calls.at(-1)!;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
class Observer { static callback: () => void; observe = vi.fn(); disconnect = vi.fn(); constructor(callback: () => void) { Observer.callback = callback; } }
beforeEach(() => {
  vi.useFakeTimers(); boundary.instances.length = 0; container = document.createElement('div'); document.body.append(container);
  vi.stubGlobal('ResizeObserver', Observer);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ clearRect: vi.fn(), fillRect: vi.fn() })) as unknown as HTMLCanvasElement['getContext']);
});
afterEach(() => { views.splice(0).forEach(view => view.destroy()); container.remove(); document.getElementById('gv-timeline-styles')?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const triple = (subject: string, object: string): RdfTriple => ({ subject, predicate: 'urn:knows', object });

describe('visualizer data and navigation contracts', () => {
  it('normalizes every public triple input and emits incremental changes with real model state', () => {
    const viz = make({ prefixes: { ex: 'https://example.invalid/' }, autoFitDisabled: true });
    expect(backend().autoFitDisabled).toBe(true); expect(viz.prefixes.expand('ex:a')).toBe('https://example.invalid/a');
    viz.loadTriples([['urn:a', 'urn:knows', 'urn:b'], { s: 'urn:b', p: 'urn:knows', o: 'urn:c' }, triple('urn:c', 'urn:d')]);
    expect([...viz.model.nodes.keys()]).toEqual(['urn:a', 'urn:b', 'urn:c', 'urn:d']);
    expect(viz.getNode('urn:a')?.id).toBe('urn:a'); expect(viz.getNode('missing')).toBeUndefined();
    expect(viz.getEdgesFrom('urn:a')).toHaveLength(1); expect(viz.getEdgesTo('urn:b')).toHaveLength(1);
    const changed = vi.fn(); viz.on('data:change', changed); const added = viz.addTriples([triple('urn:d', 'urn:e')]); expect(changed).toHaveBeenLastCalledWith(added); expect(viz.getNode('urn:e')).toBeDefined();
    const removed = viz.removeTriples([triple('urn:d', 'urn:e')]); expect(changed).toHaveBeenLastCalledWith(removed); expect(viz.getNode('urn:e')).toBeUndefined();
    viz.off('data:change', changed); viz.addTriples([triple('urn:d', 'urn:f')]); expect(changed).toHaveBeenCalledTimes(2);
    Observer.callback(); expect(backend().resize).toHaveBeenCalledOnce();
    viz.autoFitDisabled = false; expect(backend().autoFitDisabled).toBe(false);
  });
  it('focuses a large graph while camera-only navigation preserves visible nodes', () => {
    const viz = make({ focus: { maxNodes: 2 } }); viz.loadTriples([triple('urn:a', 'urn:b'), triple('urn:b', 'urn:c'), triple('urn:c', 'urn:d')]);
    const focused = vi.fn(); viz.on('focus:change', focused); viz.focus('urn:a', 1);
    expect([...rendered()[0].keys()]).toEqual(['urn:a', 'urn:b']); expect(focused).toHaveBeenCalledWith({ focalNode: 'urn:a', visibleNodes: 2 });
    expect(backend().centerOnNode).toHaveBeenLastCalledWith('urn:a', 500, 2);
    viz.centerOnNode('urn:b', { durationMs: 100, zoomLevel: 4 }); expect(backend().centerOnNode).toHaveBeenLastCalledWith('urn:b', 100, 4); expect(rendered()[0].size).toBe(2);
    viz.centerOnNode('urn:a'); expect(backend().centerOnNode).toHaveBeenLastCalledWith('urn:a', undefined, undefined);
    viz.removeTriples([triple('urn:b', 'urn:c'), triple('urn:c', 'urn:d')]);
    viz.expandNode('urn:b'); viz.showAll(); expect(rendered()[0].size).toBe(2);
    viz.focus('urn:b'); expect(rendered()[0].has('urn:b')).toBe(true); viz.zoomToFit(70); expect(backend().zoomToFit).toHaveBeenCalledWith(70);
    viz.refresh(); expect(backend().render).toHaveBeenCalled();
  });
  it('keeps source queries separate from ingestion and ignores a late source response after destruction', async () => {
    const viz = make(); let complete!: (value: { triples: RdfTriple[] }) => void;
    const source: GraphDataSource = { name: 'fixture', loadNTriples: vi.fn(), isReady: vi.fn(), tripleCount: vi.fn(), construct: vi.fn(async () => ({ triples: [triple('urn:a', 'urn:b')] })), select: vi.fn(async () => ({ variables: ['s'], bindings: [{ s: 'urn:query-only' }] })) };
    await viz.loadFromSource(source, 'CONSTRUCT fixture'); expect(source.construct).toHaveBeenCalledWith('CONSTRUCT fixture'); expect(viz.model.nodes.size).toBe(2);
    expect(await viz.querySource(source, 'SELECT fixture')).toEqual({ variables: ['s'], bindings: [{ s: 'urn:query-only' }] }); expect(source.select).toHaveBeenCalledWith('SELECT fixture'); expect(viz.getNode('urn:query-only')).toBeUndefined();
    vi.mocked(source.construct).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })); const pending = viz.loadFromSource(source, 'late'); viz.destroy(); complete({ triples: [triple('urn:late', 'urn:o')] }); await pending; expect(viz.model.nodes.size).toBe(0);
    vi.mocked(source.select).mockRejectedValueOnce(new Error('query rejected')); await expect(viz.querySource(source, 'bad')).rejects.toThrow('query rejected');
  });
  it('updates labels after ingestion and mode changes', () => {
    const viz = make(); viz.loadTriples([
      { subject: 'https://schema.org/Person', predicate: 'https://schema.org/knows', object: 'urn:other' },
      { subject: 'urn:other', predicate: 'https://schema.org/image', object: 'urn:image' },
      { subject: 'urn:image', predicate: 'https://schema.org/url', object: 'https://example.invalid/photo.jpg', datatype: 'http://www.w3.org/2001/XMLSchema#anyURI' },
    ]);
    expect(viz.labelMode).toBe('humanized'); expect(viz.getNode('https://schema.org/Person')?.label).toBe('person');
    viz.setLabelMode('strict'); expect(viz.labelMode).toBe('strict'); expect(viz.getNode('https://schema.org/Person')?.label).toBe('schema:Person'); expect(viz.getEdgesFrom('https://schema.org/Person')[0].label).toBe('schema:knows');
  });
  it('restores application decorations when transient highlights are replaced or nodes disappear', () => {
    const viz = make(); viz.loadTriples([triple('urn:a', 'urn:b')]); const a = viz.getNode('urn:a')!; a.sizeMultiplier = 4; a.isHighRisk = false;
    viz.highlightNodes(['urn:a', 'missing']); expect(a.sizeMultiplier).toBe(4); expect(a.isHighRisk).toBe(true); expect(backend().refresh).toHaveBeenCalled();
    viz.highlightNodes(['urn:b']); expect(a.isHighRisk).toBe(false); expect(viz.getNode('urn:b')?.isHighRisk).toBe(true);
    viz.removeTriples([triple('urn:a', 'urn:b')]); expect(() => viz.clearHighlight()).not.toThrow();
    backend().refresh = undefined; viz.loadTriples([triple('urn:a', 'urn:b')]); const before = backend().render.mock.calls.length; viz.highlightNodes(['urn:a']); viz.clearHighlight(); expect(backend().render.mock.calls.length).toBe(before + 2);
  });
});

describe('exports and view integration', () => {
  it('exports every RDF term kind with escaping and parses back to the same values', () => {
    const viz = make(); const input: RdfTriple[] = [
      { subject: '_:s', predicate: 'urn:p', object: '_:o' },
      { subject: 'urn:s', predicate: 'urn:p', object: 'http://example.invalid/o' },
      { subject: 'urn:s', predicate: 'urn:p', object: 'https://example.invalid/o' },
      { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' },
      { subject: 'urn:s', predicate: 'urn:p', object: 'quote" slash\\ line\nreturn\rtab\t' },
      { subject: 'urn:s', predicate: 'urn:p', object: 'bonjour', language: 'fr' },
      { subject: 'urn:s', predicate: 'urn:p', object: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' },
    ]; viz.loadTriples(input); const exported = viz.exportTriples();
    expect(exported).toContain('_:s <urn:p> _:o .'); expect(exported).toContain('"bonjour"@fr'); expect(exported).toContain('"42"^^<http://www.w3.org/2001/XMLSchema#integer>'); expect(exported).toContain('quote\\" slash\\\\ line\\nreturn\\rtab\\t');
    const parsed = parseNTriples(exported); expect(parsed).toHaveLength(input.length); input.slice(1).forEach((expected, index) => expect(parsed[index + 1]).toMatchObject(expected));
    // RDF blank-node identifiers are scoped to the parsed document.
    expect(parsed[0].subject).not.toBe(parsed[0].object); expect(parsed[0].predicate).toBe('urn:p');
  });
  it('exports a PNG blob and reports absent canvas and failed encoding', async () => {
    const viz = make(); await expect(viz.exportImage()).rejects.toThrow('no canvas');
    const blob = new Blob(['png'], { type: 'image/png' });
    const canvas = document.createElement('canvas');
    const toBlob = vi.spyOn(canvas, 'toBlob').mockImplementation(callback => callback(blob));
    backend().getCanvas.mockReturnValue(canvas);
    expect(await viz.exportImage()).toBe(blob); expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    toBlob.mockImplementation(callback => callback(null)); await expect(viz.exportImage()).rejects.toThrow('toBlob returned null');
  });
  it('filters nodes and edges through timeline interaction and cleans playback on view replacement', async () => {
    const viz = make(); viz.playTimeline(); viz.pauseTimeline(); expect(viz.timelineOverlay).toBeNull(); expect(viz.getDateRange()).toBeNull();
    viz.loadTriples([triple('urn:a', 'urn:b'), triple('urn:b', 'urn:c'), { subject: 'urn:a', predicate: 'https://schema.org/dateCreated', object: '2025-01-01' }, { subject: 'urn:b', predicate: 'https://schema.org/dateCreated', object: '2025-01-02' }]);
    const changed = vi.fn(); viz.on('temporal:change', changed); viz.setTimeCursor(new Date('2024-01-01')); expect(changed).toHaveBeenLastCalledWith({ cursor: new Date('2024-01-01'), visibleCount: 3, totalDated: 0 });
    viz.applyView({ name: 'timeline', temporal: { enabled: true, showUndated: false, playSpeed: 20 } }); await flush();
    expect(viz.temporalFilter.datedNodeCount).toBe(2); expect(viz.getDateRange()).toEqual([new Date('2025-01-01'), new Date('2025-01-02')]); expect(viz.timelineOverlay?.mounted).toBe(true);
    const slider = container.querySelector<HTMLInputElement>('input[type=range]')!; slider.value = String(new Date('2025-01-01').getTime()); slider.dispatchEvent(new Event('input'));
    expect([...rendered()[0].keys()]).toEqual(['urn:a']); expect(rendered()[1].size).toBe(0); expect(container.querySelector('.gv-tl-count')?.textContent).toBe('1'); expect(changed).toHaveBeenLastCalledWith({ cursor: new Date('2025-01-01'), visibleCount: 1, totalDated: 2 });
    viz.setTimeCursor(new Date('2025-01-02')); expect(rendered()[0].size).toBe(2); expect(rendered()[1].size).toBe(1);
    viz.playTimeline(); expect(vi.getTimerCount()).toBe(1); viz.pauseTimeline(); expect(vi.getTimerCount()).toBe(0);
    const old = viz.timelineOverlay; viz.applyView({ name: 'replacement', temporal: { enabled: true } }); expect(old?.mounted).toBe(false); expect(container.querySelectorAll('.gv-timeline-overlay')).toHaveLength(1);
    viz.applyView({ name: 'no overlay' }); expect(viz.timelineOverlay).toBeNull(); expect(container.querySelector('.gv-timeline-overlay')).toBeNull();
  });
  it.each([false, true])('applies palette, trust, animation and KA options with explicit overrides %s', explicit => {
    const viz = make();
    viz.applyView({ name: 'assets', palette: 'light', trust: { enabled: true, ...(explicit ? { style: 'glow' as const, showBadge: false } : {}) }, animation: { drift: true }, knowledgeAssets: { enabled: true, ...(explicit ? { membershipPredicate: 'urn:member', showBoundaries: false, boundaryOpacity: .2 } : {}) } });
    viz.loadTriples([{ subject: 'urn:a', predicate: explicit ? 'urn:member' : 'dkg:partOfAsset', object: 'urn:asset' }]);
    return flush().then(() => {
      expect(backend().applyAnimation).toHaveBeenCalledWith({ drift: true }); expect(backend().applyPalette).toHaveBeenCalledWith(viz.styleEngine.palette);
      expect(backend().setKaGroups).toHaveBeenCalledWith(new Map([['urn:asset', new Set(['urn:a'])]]), !explicit, explicit ? .2 : .06);
      expect(container.style.getPropertyValue('--gv-bg')).not.toBe('');
    });
  });
  it('supports environments without ResizeObserver and temporal views with no dated data', () => {
    vi.stubGlobal('ResizeObserver', undefined); const viz = make(); viz.loadTriples([triple('urn:a', 'urn:b')]); viz.applyView({ name: 'undated', temporal: { enabled: true } }); expect(viz.timelineOverlay).toBeNull(); expect(rendered()[0].size).toBe(2);
  });
  it('applies constructor camera ownership after asynchronous 3D initialization', async () => {
    const viz = make({ renderer: '3d', autoFitDisabled: true }); viz.loadTriples([triple('urn:a', 'urn:b')]); viz.refresh(); Observer.callback(); await vi.dynamicImportSettled(); await flush();
    expect(backend().autoFitDisabled).toBe(true); expect(rendered()[0].size).toBe(2);
  });
});
