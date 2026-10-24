// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock('force-graph', () => ({ default: () => boundary.factory }));
import { Canvas2DRenderer } from '../src/core/renderer.js';
import { canvasContext, config, edge, edges, graphDriver, node, nodes } from './rendering-support.js';

let driver: ReturnType<typeof graphDriver>;
let renderer: Canvas2DRenderer;
let conf: ReturnType<typeof config>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let now: number;
const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); };
const data = () => driver.values.get('graphData') as { nodes: any[]; links: any[] };
beforeEach(() => {
  vi.useFakeTimers(); now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  driver = graphDriver(); boundary.factory.mockReset().mockReturnValue(driver.chain);
  conf = config(); renderer = new Canvas2DRenderer(conf);
});
afterEach(() => { renderer.destroy(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canvas graph rendering', () => {
  it.each(['client', 'offset', 'default'])('initializes once using %s dimensions and supports resizing and canvas export', dimensions => {
    expect(renderer.getCanvas()).toBeNull(); renderer.refresh(); renderer.resize(); renderer.centerOnNode('missing'); renderer.zoomToFit(); renderer.applyAnimation({}); renderer.applyPalette(conf.styleEngine.palette);
    if (dimensions !== 'default') Object.defineProperties(conf.container, { [dimensions + 'Width']: { value: 900 }, [dimensions + 'Height']: { value: 700 } });
    renderer.init(); renderer.init(); expect(boundary.factory).toHaveBeenCalledOnce();
    expect(driver.values.get('width')).toBe(dimensions === 'default' ? 800 : 900);
    expect(driver.values.get('height')).toBe(dimensions === 'default' ? 600 : 700);
    expect(driver.forces.get('charge').strength).toHaveBeenCalledWith(-150);
    expect(driver.forces.get('link').distance).toHaveBeenCalledWith(80);
    expect(renderer.getCanvas()).toBeNull(); const canvas = document.createElement('canvas'); conf.container.append(canvas); expect(renderer.getCanvas()).toBe(canvas);
    renderer.resize(); expect(driver.values.get('width')).toBe(conf.container.clientWidth);
    renderer.applyPalette({ ...conf.styleEngine.palette, background: '#abcdef' }); expect(driver.values.get('backgroundColor')).toBe('#abcdef');
    renderer.applyPalette({ ...conf.styleEngine.palette, background: '#0a0a0f' }); expect(driver.values.get('backgroundColor')).toBe('transparent');
  });
  it('preserves positions, momentum and pins while filtering collapsed and dangling links', () => {
    const ordinary = node('ordinary'), risk = node('risk', { isHighRisk: true, degree: 5 }), featured = node('featured', { sizeMultiplier: 3 });
    const all = nodes(featured, risk, ordinary);
    renderer.render(all, edges(edge('ordinary', 'risk'), edge('risk', 'featured'), edge('missing', 'ordinary')));
    expect(data().nodes.map(n => n.id)).toEqual(['ordinary', 'risk', 'featured']); expect(data().links).toHaveLength(2);
    Object.assign(data().nodes[0], { x: 0, y: 18, vx: 3, vy: -2, fx: 0, fy: 18 });
    renderer.render(all, edges(edge('ordinary', 'risk'), edge('risk', 'featured')), new Set(['featured']));
    expect(data().nodes[0]).toMatchObject({ id: 'ordinary', x: 0, y: 18, vx: 3, vy: -2, fx: 0, fy: 18 }); expect(data().links).toHaveLength(1);
    renderer.centerOnNode('ordinary', 900, 4); expect(driver.method('centerAt')).toHaveBeenLastCalledWith(0, 18, 900); expect(driver.method('zoom')).toHaveBeenLastCalledWith(4, 900);
    renderer.centerOnNode('risk'); expect(driver.method('centerAt')).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Number), 350);
    renderer.centerOnNode('missing'); expect(driver.method('centerAt')).toHaveBeenCalledTimes(2);
    renderer.zoomToFit(20, 800); expect(driver.method('zoomToFit')).toHaveBeenLastCalledWith(800, 20);
  });
  it.each([false, true])('places dated nodes chronologically, tolerating equal dates (%s) and invalid values', same => {
    const dated = (id: string, date: string, namespace = 'https') => node(id, { properties: new Map([[`${namespace}://schema.org/dateCreated`, [{ value: date }]]]) });
    renderer.render(nodes(dated('early', '2025-01-01', 'http'), dated('late', same ? '2025-01-01' : '2025-12-31'), dated('invalid', 'not-a-date'), node('undated')), new Map());
    const early = data().nodes.find(n => n.id === 'early'), late = data().nodes.find(n => n.id === 'late');
    expect(early.x).toBe(-200); expect(late.x).toBe(same ? -200 : 200);
    early.x = -100; early.vx = undefined; late.fx = 5; late.vx = 7;
    driver.forces.get('chronoX')(.5); expect(early.vx).toBe(-2.5); expect(late.vx).toBe(7);
    renderer.render(nodes(node('no-date')), new Map()); expect(driver.forces.get('chronoX')).toBeNull();
  });
  it('fits once per topology, coalesces pending fits, and respects explicit camera ownership', () => {
    renderer.render(nodes(node('a')), new Map()); renderer.render(nodes(node('a')), new Map());
    vi.advanceTimersByTime(300); expect(driver.method('zoomToFit')).toHaveBeenCalledOnce();
    driver.call('onEngineStop'); renderer.render(nodes(node('a')), new Map()); vi.advanceTimersByTime(300); expect(driver.method('zoomToFit')).toHaveBeenCalledOnce();
    renderer.render(nodes(node('a'), node('b')), new Map()); driver.call('onEngineStop'); vi.advanceTimersByTime(300); expect(driver.method('zoomToFit')).toHaveBeenCalledTimes(2);
    renderer.render(nodes(node('a'), node('b'), node('c')), new Map()); renderer.autoFitDisabled = true; vi.advanceTimersByTime(300); driver.call('onEngineStop'); expect(driver.method('zoomToFit')).toHaveBeenCalledTimes(2);
    renderer.render(nodes(node('d')), new Map()); expect(vi.getTimerCount()).toBe(0);
  });
  it('emits only valid graph objects and updates hover cursor', () => {
    const clicked = vi.fn(), hovered = vi.fn(), left = vi.fn(), link = vi.fn(), background = vi.fn();
    conf.events.on('node:click', clicked); conf.events.on('node:hover', hovered); conf.events.on('node:unhover', left); conf.events.on('edge:click', link); conf.events.on('background:click', background);
    renderer.init(); const gn = node('a'); const ge = edge('a', 'b');
    driver.call('onNodeClick', {}); driver.call('onLinkClick', {}); expect(clicked).not.toHaveBeenCalled(); expect(link).not.toHaveBeenCalled();
    driver.call('onNodeClick', { _graphNode: gn }); driver.call('onLinkClick', { _graphEdge: ge }); expect(clicked).toHaveBeenCalledExactlyOnceWith(gn); expect(link).toHaveBeenCalledExactlyOnceWith(ge);
    driver.call('onNodeHover', { _graphNode: gn }); expect(hovered).toHaveBeenCalledWith(gn); expect(conf.container.style.cursor).toBe('pointer');
    driver.call('onNodeHover', null); expect(left).toHaveBeenCalledWith(null); expect(conf.container.style.cursor).toBe('default');
    driver.call('onBackgroundClick', {}); expect(background).toHaveBeenCalledWith({ x: 0, y: 0 });
    driver.call('onNodeDrag', {}); driver.call('onNodeDragEnd', {}); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledTimes(2);
    driver.method('d3ReheatSimulation').mockImplementation(() => { throw new Error('older graph API'); });
    expect(() => { driver.call('onNodeDrag', {}); driver.call('onNodeDragEnd', {}); }).not.toThrow();
  });
  it('paints real nodes, visible hit areas, and readable link labels at their midpoints', () => {
    renderer.init(); const { ctx, paints } = canvasContext(); const paint = vi.spyOn(conf.hexPainter, 'paint');
    expect(driver.call('nodeCanvasObjectMode', {})).toBe('replace'); expect(driver.call('nodeCanvasObjectMode', { _graphNode: node('featured', { sizeMultiplier: 2 }) })).toBe('after');
    driver.call('nodeCanvasObject', {}, ctx, 1); expect(paint).not.toHaveBeenCalled();
    driver.call('nodeCanvasObject', { _graphNode: node('a') }, ctx, 1); expect(paint).toHaveBeenCalledWith(ctx, expect.objectContaining({ id: 'a' }), 0, 0, 1, 1);
    ctx.arc.mockClear(); driver.call('nodePointerAreaPaint', {}, 'pick', ctx); driver.call('nodePointerAreaPaint', { _graphNode: node('a'), x: 0 }, 'pick', ctx); expect(ctx.arc).not.toHaveBeenCalled();
    driver.call('nodePointerAreaPaint', { _graphNode: node('a'), x: 0, y: 0 }, 'pick', ctx); expect(ctx.arc).toHaveBeenCalledWith(0, 0, 24, 0, Math.PI * 2);
    const link = { _graphEdge: edge('a', 'b'), source: { x: 10, y: 20 }, target: { x: 30, y: 40 } };
    expect(driver.call('linkColor', link)).toBe(conf.styleEngine.config.defaultEdgeColor); expect(driver.call('linkColor', {})).toBe(conf.styleEngine.config.defaultEdgeColor);
    expect(driver.call('linkCanvasObjectMode')).toBe('after'); ctx.fillText.mockClear();
    driver.call('linkCanvasObject', link, ctx, .2); driver.call('linkCanvasObject', {}, ctx, 1); driver.call('linkCanvasObject', { ...link, _graphEdge: edge('a', 'b', '') }, ctx, 1); expect(ctx.fillText).not.toHaveBeenCalled();
    driver.call('linkCanvasObject', link, ctx, .55); expect(ctx.fillText).toHaveBeenCalledWith('knows', 20, 30); expect(paints.at(-1)?.alpha).toBeCloseTo(.5);
    driver.call('linkCanvasObject', link, ctx, 2); expect(paints.at(-1)?.alpha).toBe(1);
  });
  it('animates node fade and risk pulse while keeping canvas alpha restored', () => {
    renderer.init(); renderer.applyAnimation({ fadeIn: true, riskPulse: true }); renderer.render(nodes(node('risk', { isHighRisk: true })), new Map());
    const { ctx } = canvasContext(); const alphas: number[] = []; const paint = vi.spyOn(conf.hexPainter, 'paint').mockImplementation(() => { alphas.push(ctx.globalAlpha); return 24; });
    now = 850; driver.call('nodeCanvasObject', data().nodes[0], ctx, 1); expect(alphas[0]).toBe(.875); expect(ctx.globalAlpha).toBe(1);
    const pulse = paint.mock.calls[0][5]!; expect(pulse).toBeGreaterThanOrEqual(.85); expect(pulse).toBeLessThanOrEqual(1.15);
    now = 1700; driver.call('nodeCanvasObject', data().nodes[0], ctx, 1); expect(alphas[1]).toBe(1); expect(paint.mock.calls[1][5]).not.toBe(pulse);
    frame(); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalled(); renderer.applyAnimation({}); expect(frames.size).toBe(0);
  });
  it.each([false, true])('traces only hovered incident edges with background particles %s', linkParticles => {
    renderer.init(); renderer.applyAnimation({ hoverTrace: true, linkParticles, linkParticleCount: 2, linkParticleSpeed: .01, linkParticleWidth: 5, linkParticleColor: 'orange' });
    const sample = () => ['linkDirectionalParticles', 'linkDirectionalParticleSpeed', 'linkDirectionalParticleWidth', 'linkDirectionalParticleColor'].map(key => driver.call(key, { source: 'a', target: 'b' }));
    expect(sample()).toEqual([linkParticles ? 2 : 0, .01, 5, 'orange']);
    driver.call('onNodeHover', { _graphNode: node('a') }); expect(sample()).toEqual([4, .02, 3, '#60a0ff']);
    for (const key of ['linkDirectionalParticles', 'linkDirectionalParticleSpeed', 'linkDirectionalParticleWidth', 'linkDirectionalParticleColor']) expect(driver.call(key, { source: { id: 'z' }, target: { id: 'a' } })).toBe(driver.call(key, { source: 'a', target: 'z' }));
    driver.call('onNodeHover', { _graphNode: node('z') }); expect(sample()).toEqual([linkParticles ? 2 : 0, .01, 5, 'orange']);
    renderer.applyAnimation({ linkParticles: true }); expect(driver.values.get('linkDirectionalParticles')).toBe(1); expect(driver.call('linkDirectionalParticleColor')).toBe('rgba(100,150,255,0.6)');
    renderer.applyAnimation({}); expect(driver.values.get('linkDirectionalParticles')).toBe(0);
  });
  it('repaints without rebuilding data, debounces fallback frames and cools the simulation', () => {
    renderer.init(); renderer.refresh(); expect(driver.method('refresh')).toHaveBeenCalledOnce(); expect(driver.method('graphData')).not.toHaveBeenCalled();
    driver.absent.add('refresh'); renderer.refresh(); renderer.refresh(); expect(frames.size).toBe(1); frame(); expect(driver.values.get('cooldownTicks')).toBe(3); vi.advanceTimersByTime(60); expect(driver.values.get('cooldownTicks')).toBe(0);
    renderer.applyAnimation({ drift: true }); renderer.refresh(); frame(); expect(driver.values.get('cooldownTicks')).toBe(Infinity);
    renderer.refresh(); renderer.destroy(); frame(); expect(driver.method('_destructor')).toHaveBeenCalledOnce();
  });
  it('repaints loaded images without interrupting drift and tolerates missing optional force APIs', () => {
    driver.forces.clear(); driver.absent.add('d3AlphaTarget'); driver.absent.add('refresh');
    const register = vi.spyOn(conf.hexPainter, 'setImageLoadCallback'); renderer.init(); renderer.applyAnimation({ drift: true, driftAlpha: .02 });
    register.mock.calls[0][0](); frame(); expect(driver.values.get('cooldownTicks')).toBe(Infinity);
    vi.advanceTimersByTime(300); expect(driver.method('zoomToFit')).toHaveBeenCalledOnce();
    renderer.applyAnimation({ riskPulse: true }); driver.method('d3ReheatSimulation').mockImplementation(() => { throw new Error('optional API'); }); expect(frame).not.toThrow();
    renderer.applyAnimation({}); renderer.refresh(); frame(); renderer.applyAnimation({ drift: true }); vi.advanceTimersByTime(60); expect(driver.values.get('cooldownTicks')).toBe(Infinity);
  });
  it('draws padded KA convex hulls and ignores missing, small or collinear groups', () => {
    renderer.render(nodes(node('a'), node('b'), node('c'), node('d'), node('inside'), node('line')), new Map());
    const coordinates = [[0, 0], [100, 0], [100, 100], [0, 100], [50, 50], [50, 0]];
    data().nodes.forEach((item, i) => Object.assign(item, { x: coordinates[i][0], y: coordinates[i][1] }));
    const { ctx, paints } = canvasContext(); driver.call('onRenderFramePre', ctx, 1); expect(ctx.fill).not.toHaveBeenCalled();
    renderer.setKaGroups(new Map([['small', new Set(['a', 'missing'])], ['collinear', new Set(['a', 'b', 'line'])], ['square', new Set(['a', 'b', 'c', 'd', 'inside'])]]), true, .1);
    driver.call('onRenderFramePre', ctx, 1);
    expect(ctx.moveTo).toHaveBeenCalledWith(expect.closeTo(-21.2132, 3), expect.closeTo(-21.2132, 3)); expect(ctx.lineTo).toHaveBeenCalledTimes(3);
    expect(paints).toEqual([expect.objectContaining({ method: 'fill', alpha: .1 }), expect.objectContaining({ method: 'stroke', alpha: .25 })]);
    renderer.setKaGroups(new Map(), true); ctx.fill.mockClear(); driver.call('onRenderFramePre', ctx, 1); expect(ctx.fill).not.toHaveBeenCalled();
  });
});

it('ignores a canceled pulse callback and a pending automatic fit after camera ownership changes', () => {
  renderer.init(); renderer.applyAnimation({ riskPulse: true });
  const pulse = [...frames.values()][0]; renderer.applyAnimation({}); pulse(now); expect(frames.size).toBe(0);
  renderer.applyAnimation({ drift: true }); renderer.autoFitDisabled = true; vi.advanceTimersByTime(300); expect(driver.method('zoomToFit')).not.toHaveBeenCalled();
  renderer.applyAnimation({ drift: true }); expect(vi.getTimerCount()).toBe(0);
});
it('does not paint unresolved link endpoints and pulls an unpositioned date node toward its chronology', () => {
  const dateNode = (id: string, date: string) => node(id, { properties: new Map([['https://schema.org/dateCreated', [{ value: date }]]]) });
  renderer.render(nodes(dateNode('a', '2025-01-01'), dateNode('b', '2025-01-02')), new Map());
  const first = data().nodes[0]; first.x = undefined; first.vx = undefined; driver.forces.get('chronoX')(.5); expect(first.vx).toBe(-5);
  const { ctx } = canvasContext(); driver.call('linkCanvasObject', { _graphEdge: edge('a', 'b'), source: 'a', target: 'b' }, ctx, 1); expect(ctx.fillText).not.toHaveBeenCalled();
});
