// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Sprite, Texture, TextureLoader } from 'three';
const boundary = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock('3d-force-graph', () => ({ default: () => boundary.factory }));
import { WebGL3DRenderer } from '../src/core/renderer-3d.js';
import { canvasContext, config, edge, edges, graphDriver, node, nodes } from './rendering-support.js';

let driver: ReturnType<typeof graphDriver>, conf: ReturnType<typeof config>, renderer: WebGL3DRenderer;
let frames: Map<number, FrameRequestCallback>, nextFrame: number, now: number;
let drawing: ReturnType<typeof canvasContext>;
const data = () => driver.values.graphData!;
const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); };
beforeEach(() => {
  vi.useFakeTimers(); now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  drawing = canvasContext(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => drawing.ctx) as unknown as HTMLCanvasElement['getContext']);
  driver = graphDriver(); driver.values.camera = new PerspectiveCamera(); boundary.factory.mockReset().mockReturnValue(driver.chain);
  conf = config(); renderer = new WebGL3DRenderer(conf);
});
afterEach(() => { renderer.destroy(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('WebGL renderer public contracts', () => {
  it.each(['client', 'offset', 'default'])('initializes %s dimensions and supports public camera and export operations', dimensions => {
    expect(renderer.getCanvas()).toBeNull(); renderer.refresh(); renderer.resize(); renderer.zoomToFit(); renderer.centerOnNode('missing'); renderer.applyAnimation({}); renderer.applyPalette(conf.styleEngine.palette);
    if (dimensions !== 'default') Object.defineProperties(conf.container, { [dimensions + 'Width']: { value: 900 }, [dimensions + 'Height']: { value: 700 } });
    renderer.render(nodes(node('a')), new Map()); renderer.init(); expect(boundary.factory).toHaveBeenCalledOnce();
    expect(driver.values.width).toBe(dimensions === 'default' ? 800 : 900); expect(driver.values.height).toBe(dimensions === 'default' ? 600 : 700);
    Object.assign(data().nodes[0], { x: 10, y: 20 }); renderer.centerOnNode('a'); expect(driver.method('cameraPosition')).toHaveBeenLastCalledWith({ x: 10, y: 20, z: 200 }, { x: 10, y: 20, z: 0 }, 350);
    renderer.centerOnNode('a', 700, 5); expect(driver.method('cameraPosition')).toHaveBeenLastCalledWith({ x: 10, y: 20, z: 60 }, { x: 10, y: 20, z: 0 }, 700);
    for (const zoom of [0, -1, NaN, Infinity]) { renderer.centerOnNode('a', 1, zoom); expect(driver.method('cameraPosition').mock.calls.at(-1)?.[0].z).toBe(200); }
    renderer.centerOnNode('missing'); renderer.zoomToFit(10, 400); expect(driver.method('zoomToFit')).toHaveBeenCalledWith(400, 10);
    expect(renderer.getCanvas()).toBeNull(); const canvas = document.createElement('canvas'); conf.container.append(canvas); expect(renderer.getCanvas()).toBe(canvas);
    renderer.resize(); expect(driver.values.width).toBe(conf.container.clientWidth);
    renderer.applyPalette(conf.styleEngine.palette); expect(driver.values.backgroundColor).toBe(conf.styleEngine.palette.background);
  });
  it('retains moving node identity, pins and links across renders and image changes', () => {
    const a = node('a', { degree: 5 }), b = node('b'), c = node('c');
    renderer.render(nodes(a, b, c), edges(edge('a', 'b'), edge('b', 'c'), edge('missing', 'a')));
    const first = data().nodes[0]; Object.assign(first, { x: 0, y: 4, vx: 2, vy: -1, fx: 0, fy: 4 });
    renderer.render(nodes(a, b, c), edges(edge('a', 'b'), edge('b', 'c')), new Set(['c']));
    expect(data().nodes[0]).toBe(first); expect(data().links).toHaveLength(1);
    a.imageUrl = 'https://example.invalid/changed.png';
    renderer.render(nodes(a, b), edges(edge('a', 'b'))); expect(data().nodes[0]).not.toBe(first);
    expect(data().nodes[0]).toMatchObject({ x: 0, y: 4, vx: 2, vy: -1, fx: 0, fy: 4 });
    renderer.destroy(); renderer.render(nodes(a), new Map()); expect(boundary.factory).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses built-in spheres for plain nodes and animated size for risk nodes', () => {
    renderer.init(); expect(driver.call('nodeColor', {})).toBe('#334'); expect(driver.call('nodeVal', {})).toBe(1); expect(driver.call('nodeThreeObject', {})).toBeUndefined();
    const plain = node('plain'), risk = node('risk', { isHighRisk: true });
    expect(driver.call('nodeColor', { _graphNode: plain })).toBe(conf.styleEngine.getNodeColor(plain)); expect(driver.call('nodeColor', { _graphNode: risk })).toBe('#e04040');
    expect(driver.call('nodeVal', { _graphNode: plain })).toBeCloseTo(691.2);
    const ordinaryRisk = driver.call('nodeVal', { _graphNode: risk }); renderer.applyAnimation({ riskPulse: true });
    vi.advanceTimersByTime(50); const pulsed = driver.call('nodeVal', { _graphNode: risk }); expect(pulsed).not.toBe(ordinaryRisk); expect(pulsed / ordinaryRisk).toBeGreaterThanOrEqual(.75); expect(pulsed / ordinaryRisk).toBeLessThanOrEqual(1.25);
    expect(driver.call('nodeVal', { _graphNode: plain })).toBeCloseTo(691.2);
    renderer.applyAnimation({}); const updates = driver.method('nodeVal').mock.calls.length; vi.advanceTimersByTime(100); expect(driver.method('nodeVal')).toHaveBeenCalledTimes(updates);
  });
  it('delivers node, edge and background events and survives optional drag API failures', () => {
    const clicked = vi.fn(), hovered = vi.fn(), unhovered = vi.fn(), linked = vi.fn(), background = vi.fn();
    conf.events.on('node:click', clicked); conf.events.on('node:hover', hovered); conf.events.on('node:unhover', unhovered); conf.events.on('edge:click', linked); conf.events.on('background:click', background);
    renderer.init(); driver.call('onNodeClick', {}); driver.call('onLinkClick', {}); expect(clicked).not.toHaveBeenCalled(); expect(linked).not.toHaveBeenCalled();
    const a = node('a'), ab = edge('a', 'b'); driver.call('onNodeClick', { _graphNode: a }); driver.call('onNodeHover', { _graphNode: a }); driver.call('onLinkClick', { _graphEdge: ab });
    expect(clicked).toHaveBeenCalledWith(a); expect(hovered).toHaveBeenCalledWith(a); expect(linked).toHaveBeenCalledWith(ab); expect(conf.container.style.cursor).toBe('pointer');
    driver.call('onNodeHover', null); expect(unhovered).toHaveBeenCalledWith(null); expect(conf.container.style.cursor).toBe('default'); driver.call('onBackgroundClick'); expect(background).toHaveBeenCalledWith({ x: 0, y: 0 });
    driver.call('onNodeDrag', {}); driver.call('onNodeDragEnd', {}); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledTimes(2);
    driver.method('d3ReheatSimulation').mockImplementation(() => { throw new Error('optional method'); }); expect(() => { driver.call('onNodeDrag', {}); driver.call('onNodeDragEnd', {}); }).not.toThrow();
  });
  it.each([false, true])('limits hover tracing to incident edges with background particles %s', linkParticles => {
    renderer.init(); renderer.applyAnimation({ linkParticles, hoverTrace: true, linkParticleCount: 2, linkParticleSpeed: .01, linkParticleWidth: 5, linkParticleColor: 'orange' });
    const keys = ['linkDirectionalParticles', 'linkDirectionalParticleSpeed', 'linkDirectionalParticleWidth', 'linkDirectionalParticleColor'] as const;
    const sample = (source: any = 'a', target: any = 'b') => keys.map(key => driver.call(key, { source, target }));
    expect(sample()).toEqual([linkParticles ? 2 : 0, .01, 5, 'orange']); driver.call('onNodeHover', { _graphNode: node('a') }); expect(sample()).toEqual([4, .015, 2, '#60a0ff']); expect(sample({ id: 'z' }, { id: 'a' })).toEqual(sample());
    driver.call('onNodeHover', { _graphNode: node('z') }); expect(sample()).toEqual([linkParticles ? 2 : 0, .01, 5, 'orange']);
    renderer.applyAnimation({ linkParticles: true }); expect(driver.values.linkDirectionalParticles).toBe(1); expect(driver.values.linkDirectionalParticleSpeed).toBe(.003); expect(driver.call('linkDirectionalParticleColor')).toBe('rgba(100,150,255,0.6)');
    renderer.applyAnimation({}); expect(driver.values.linkDirectionalParticles).toBe(0);
  });
  it('runs drift at a bounded cadence, removes old timers, and tolerates missing particle APIs', () => {
    renderer.init(); renderer.applyAnimation({ drift: true }); expect(driver.values.d3AlphaDecay).toBe(.005); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(8000); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledTimes(2);
    driver.method('d3ReheatSimulation').mockImplementation(() => { throw new Error('old API'); });
    expect(() => renderer.applyAnimation({ drift: true })).not.toThrow(); expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    renderer.applyAnimation({}); expect(driver.values.d3AlphaDecay).toBe(.05); const count = driver.method('d3ReheatSimulation').mock.calls.length; vi.advanceTimersByTime(8000); expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledTimes(count);
    driver.omit('linkDirectionalParticles'); expect(() => renderer.applyAnimation({ linkParticles: true })).not.toThrow(); expect(() => renderer.applyAnimation({})).not.toThrow();
    renderer.applyAnimation({ drift: true, riskPulse: true }); renderer.destroy(); renderer.applyAnimation({}); expect(vi.getTimerCount()).toBe(0);
  });
  it('fades once at load, reaches full opacity, and cancels outstanding frames on destroy', () => {
    renderer.init(); renderer.applyAnimation({ fadeIn: true }); renderer.render(nodes(node('a')), new Map()); expect(driver.values.nodeOpacity).toBe(.05);
    now = 850; frame(); expect(driver.values.nodeOpacity).toBeCloseTo(.74375); now = 1600; frame(); expect(driver.values.nodeOpacity).toBe(.85); expect(frames.size).toBe(0);
    renderer.render(nodes(node('b')), new Map()); expect(frames.size).toBe(0);
    renderer.destroy(); renderer = new WebGL3DRenderer(conf); renderer.init(); renderer.applyAnimation({ fadeIn: true }); renderer.render(nodes(node('c')), new Map());
    const pending = [...frames.values()][0]; renderer.destroy(); expect(frames.size).toBe(0); const calls = driver.method('nodeOpacity').mock.calls.length; pending(now); expect(driver.method('nodeOpacity')).toHaveBeenCalledTimes(calls);
  });
  it('refreshes sprites with retained shared textures and destroys without a destructor API', () => {
    const texture = new Texture<HTMLImageElement>(); const load = vi.spyOn(TextureLoader.prototype, 'load').mockReturnValue(texture); const disposeTexture = vi.spyOn(texture, 'dispose');
    renderer.render(nodes(node('a', { imageUrl: 'https://example.invalid/icon.png' })), new Map());
    const sprite = driver.call('nodeThreeObject', data().nodes[0]) as Sprite; const disposeMaterial = vi.spyOn(sprite.material, 'dispose');
    renderer.refresh(); expect(driver.method('refresh')).toHaveBeenCalledOnce(); expect(disposeMaterial).toHaveBeenCalledOnce(); expect(disposeTexture).not.toHaveBeenCalled();
    const replacement = driver.call('nodeThreeObject', data().nodes[0]); expect(replacement).not.toBe(sprite); expect(load).toHaveBeenCalledOnce(); expect(replacement!.material.map).toBe(texture);
    driver.omit('refresh'); renderer.refresh(); driver.omit('_destructor'); renderer.destroy(); expect(data()).toEqual({ nodes: [], links: [] }); expect(disposeTexture).toHaveBeenCalledOnce();
  });
  it('clears failed SVG image handlers without discarding the fallback texture', () => {
    const images: any[] = []; vi.stubGlobal('Image', class { constructor() { images.push(this); } });
    renderer.render(nodes(node('a', { imageUrl: 'data:image/svg+xml,broken' })), new Map()); const sprite = driver.call('nodeThreeObject', data().nodes[0])!; const version = sprite.material.map!.version;
    images[0].onerror(); expect(images[0].onerror).toBeNull(); expect(images[0].onload).toBeNull(); expect(sprite.material.map!.version).toBe(version); expect(drawing.ctx.drawImage).not.toHaveBeenCalled();
  });
});

describe('proximity labels with real Three.js scene objects', () => {
  it('shows the nearest three labels plus distant focal nodes, updates scale, and disposes departed labels', () => {
    const items = [node('a', { label: 'Alice' }), node('b', { label: 'Bob' }), node('c', { label: 'Carol' }), node('d', { label: 'Dave' }), node('far', { label: 'Far' }), node('focal', { label: 'A very long focal label that needs truncation', sizeMultiplier: 2 }), node('risk', { label: 'Risk', isHighRisk: true }), node('anonymous')];
    renderer.render(nodes(...items), new Map());
    const distances = [10, 20, 30, 40, 600, 350, 700, 0];
    data().nodes.forEach((item, i) => Object.assign(item, { x: distances[i], y: 0, z: 0, __threeObj: new Object3D() }));
    vi.advanceTimersByTime(500);
    expect(data().nodes.map(item => item.__threeObj!.children.length)).toEqual([1, 1, 1, 0, 0, 1, 0, 0]);
    expect(drawing.ctx.fillText).toHaveBeenCalledWith('A very long focal lab…', expect.any(Number), 18);
    const alice = data().nodes[0].__threeObj!.children[0] as Sprite; expect(alice.position.y).toBe(-26); expect(alice.material.depthTest).toBe(false); const originalWidth = alice.scale.x;
    data().nodes[0].x = 200; vi.advanceTimersByTime(500); // Dave now occupies the third nearby slot.
    expect(data().nodes[0].__threeObj!.children).toHaveLength(0);
    const focal = data().nodes[5].__threeObj!.children[0] as Sprite; const width = focal.scale.x; data().nodes[5].x = 450; vi.advanceTimersByTime(500); expect(focal.scale.x).toBeLessThan(width);
    data().nodes[0].x = 100; data().nodes[3].x = 300; vi.advanceTimersByTime(500);
    expect(data().nodes[0].__threeObj!.children[0].scale.x).toBe(originalWidth);
    const removed = data().nodes[0].__threeObj!.children[0] as Sprite; const disposeMap = vi.spyOn(removed.material.map!, 'dispose'); const disposeMaterial = vi.spyOn(removed.material, 'dispose');
    driver.values.camera!.position.set(1000, 1000, 1000); vi.advanceTimersByTime(500); expect(disposeMap).toHaveBeenCalledOnce(); expect(disposeMaterial).toHaveBeenCalledOnce(); expect(data().nodes.every(item => item.__threeObj!.children.length === 0)).toBe(true);
  });
  it('handles absent camera, empty data, unavailable canvas, and nodes not attached to the scene', () => {
    renderer.init(); driver.values.camera = null; vi.advanceTimersByTime(500); expect(drawing.ctx.fillText).not.toHaveBeenCalled();
    driver.values.camera = new PerspectiveCamera(); vi.advanceTimersByTime(500); expect(drawing.ctx.fillText).not.toHaveBeenCalled();
    renderer.render(nodes(node('a', { label: 'Detached' })), new Map()); Object.assign(data().nodes[0], { x: undefined, y: undefined, z: undefined });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null); vi.advanceTimersByTime(500); expect(drawing.ctx.fillText).not.toHaveBeenCalled();
    const dispose = vi.spyOn(Texture.prototype, 'dispose'); vi.advanceTimersByTime(500); expect(drawing.ctx.fillText).toHaveBeenCalledWith('Detached', expect.any(Number), 18); expect(dispose).toHaveBeenCalledOnce();
  });
});

it('centers an unpositioned node safely and labels a high-risk node outside the ordinary label range', () => {
  renderer.render(nodes(node('a', { label: '', isHighRisk: false }), node('risk', { label: 'Risk', isHighRisk: true })), new Map());
  Object.assign(data().nodes[0], { x: undefined, y: undefined }); renderer.centerOnNode('a'); expect(driver.method('cameraPosition')).toHaveBeenCalledWith({ x: 0, y: 0, z: 200 }, { x: 0, y: 0, z: 0 }, 350);
  Object.assign(data().nodes[1], { x: 300, y: 0, __threeObj: new Object3D() }); vi.advanceTimersByTime(500); expect(data().nodes[1].__threeObj!.children).toHaveLength(1);
});
