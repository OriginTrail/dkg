// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererBackendConfig } from '../src/core/renderer-backend.js';
const boundary = vi.hoisted(() => ({ canvas: vi.fn(), webgl: vi.fn() }));
vi.mock('force-graph', () => ({ default: () => boundary.canvas }));
vi.mock('3d-force-graph', () => ({ default: () => boundary.webgl }));
import { Canvas2DRenderer } from '../src/core/renderer.js';
import { WebGL3DRenderer } from '../src/core/renderer-3d.js';
import { config, edge, edges, graphDriver, node, nodes } from './rendering-support.js';

describe.each([
  { name: 'Canvas2D', factory: boundary.canvas, create: (conf: RendererBackendConfig) => new Canvas2DRenderer(conf) },
  { name: 'WebGL3D', factory: boundary.webgl, create: (conf: RendererBackendConfig) => new WebGL3DRenderer(conf) },
])('$name shared renderer contracts', ({ factory, create }) => {
  let driver: ReturnType<typeof graphDriver>;
  let conf: ReturnType<typeof config>;
  let renderer: Canvas2DRenderer | WebGL3DRenderer;
  const data = () => driver.values.graphData!;

  beforeEach(() => {
    vi.useFakeTimers();
    driver = graphDriver();
    factory.mockReset().mockReturnValue(driver.chain);
    conf = config();
    renderer = create(conf);
  });
  afterEach(() => {
    renderer.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('allows public controls before initialization without creating a graph', () => {
    renderer.refresh(); renderer.resize(); renderer.centerOnNode('missing'); renderer.zoomToFit();
    renderer.applyAnimation({}); renderer.applyPalette(conf.styleEngine.palette);
    expect(renderer.getCanvas()).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['client', 'offset', 'default'])('initializes once using %s dimensions and resizes to current client dimensions', dimensions => {
    if (dimensions !== 'default') {
      Object.defineProperties(conf.container, {
        [dimensions + 'Width']: { value: 900, configurable: true },
        [dimensions + 'Height']: { value: 700, configurable: true },
      });
    }
    renderer.init(); renderer.init();
    expect(factory).toHaveBeenCalledExactlyOnceWith(conf.container);
    expect(driver.values.width).toBe(dimensions === 'default' ? 800 : 900);
    expect(driver.values.height).toBe(dimensions === 'default' ? 600 : 700);
    Object.defineProperties(conf.container, { clientWidth: { value: 1100 }, clientHeight: { value: 750 } });
    renderer.resize();
    expect(driver.values.width).toBe(1100);
    expect(driver.values.height).toBe(750);
  });

  it('initializes lazily on render and exposes the canvas for export', () => {
    renderer.render(nodes(node('a')), new Map()); renderer.init();
    expect(factory).toHaveBeenCalledOnce();
    expect(data().nodes.map(item => item.id)).toEqual(['a']);
    expect(renderer.getCanvas()).toBeNull();
    const canvas = document.createElement('canvas'); conf.container.append(canvas);
    expect(renderer.getCanvas()).toBe(canvas);
    renderer.zoomToFit(20, 800);
    expect(driver.method('zoomToFit')).toHaveBeenCalledExactlyOnceWith(800, 20);
  });

  it('preserves positions, momentum and pins while filtering collapsed nodes and dangling links', () => {
    const all = nodes(node('a'), node('b'), node('c'));
    const links = edges(edge('a', 'b'), edge('b', 'c'), edge('missing', 'a'));
    renderer.render(all, links);
    expect(data().links.map(link => link._graphEdge?.id)).toEqual(['a-b', 'b-c']);
    Object.assign(data().nodes.find(item => item.id === 'a')!, { x: 0, y: 18, vx: 3, vy: -2, fx: 0, fy: 18 });
    renderer.render(all, links, new Set(['c']));
    expect(data().nodes.map(item => item.id)).toEqual(['a', 'b']);
    expect(data().nodes.find(item => item.id === 'a')).toMatchObject({ x: 0, y: 18, vx: 3, vy: -2, fx: 0, fy: 18 });
    expect(data().links.map(link => link._graphEdge?.id)).toEqual(['a-b']);
  });

  it('emits only resolved graph objects and updates hover cursor', () => {
    const clicked = vi.fn(), hovered = vi.fn(), left = vi.fn(), linked = vi.fn(), background = vi.fn();
    conf.events.on('node:click', clicked); conf.events.on('node:hover', hovered);
    conf.events.on('node:unhover', left); conf.events.on('edge:click', linked); conf.events.on('background:click', background);
    renderer.init();
    driver.call('onNodeClick', {}); driver.call('onLinkClick', {});
    expect(clicked).not.toHaveBeenCalled(); expect(linked).not.toHaveBeenCalled();
    const a = node('a'), ab = edge('a', 'b');
    driver.call('onNodeClick', { _graphNode: a }); driver.call('onLinkClick', { _graphEdge: ab });
    expect(clicked).toHaveBeenCalledExactlyOnceWith(a); expect(linked).toHaveBeenCalledExactlyOnceWith(ab);
    driver.call('onNodeHover', { _graphNode: a });
    expect(hovered).toHaveBeenCalledExactlyOnceWith(a); expect(conf.container.style.cursor).toBe('pointer');
    driver.call('onNodeHover', null);
    expect(left).toHaveBeenCalledExactlyOnceWith(null); expect(conf.container.style.cursor).toBe('default');
    driver.call('onBackgroundClick', {});
    expect(background).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
  });

  it.each(['onNodeDrag', 'onNodeDragEnd'] as const)('%s reheats the simulation and tolerates an unavailable drag API', callback => {
    renderer.init(); driver.call(callback, {});
    expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledOnce();
    driver.method('d3ReheatSimulation').mockImplementation(() => { throw new Error('older graph API'); });
    expect(() => driver.call(callback, {})).not.toThrow();
    expect(driver.method('d3ReheatSimulation')).toHaveBeenCalledTimes(2);
  });
});
