// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const graph = vi.hoisted(() => ({ callbacks: new Map<string, any>(), factory: vi.fn(), chain: null as any }));
vi.mock('force-graph', () => ({ default: () => () => graph.chain }));
vi.mock('3d-force-graph', () => ({ default: () => graph.factory }));
import { Canvas2DRenderer } from '../src/core/renderer.js';
import { WebGL3DRenderer } from '../src/core/renderer-3d.js';
import { GraphEventEmitter } from '../src/core/events.js';
const config = () => ({ container: document.createElement('div'), events: new GraphEventEmitter(),
  hexPainter: { setImageLoadCallback: vi.fn(), setMaxDegree: vi.fn(), getRadius: () => 28 } as any,
  styleEngine: { config: {} } as any });
const label = () => ({ parent: { remove: vi.fn() }, material: { map: { dispose: vi.fn() }, dispose: vi.fn() } });

beforeEach(() => {
  vi.useFakeTimers(); graph.callbacks.clear(); graph.factory.mockReset();
  graph.chain = new Proxy({}, { get: (_target, name) => (...args: any[]) => {
    graph.callbacks.set(String(name), args[0]); return graph.chain;
  } });
  graph.factory.mockReturnValue(graph.chain);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('renderer hit regions and resources', () => {
  it('makes the whole visible node clickable, including at coordinate zero', () => {
    const conf = config(); const clicked = vi.fn(); conf.events.on('node:click', clicked);
    const renderer = new Canvas2DRenderer(conf); renderer.init();
    const node = { x: 0, y: 0, _graphNode: { id: 'urn:order' } };
    const ctx = { fillStyle: '', beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn() };
    graph.callbacks.get('nodePointerAreaPaint')(node, 'picker-color', ctx);
    expect(ctx.arc).toHaveBeenCalledWith(0, 0, 28, 0, Math.PI * 2);
    graph.callbacks.get('onNodeClick')(node);
    expect(clicked).toHaveBeenCalledWith(node._graphNode);
    renderer.destroy();
  });
  it('disposes labels on graph replacement instead of losing their texture handles', () => {
    const renderer = new WebGL3DRenderer(config());
    const internal = renderer as any; internal._graph = graph.chain;
    for (let i = 0; i < 20; i++) {
      const sprite = label(); internal._labelSprites.set('urn:label', sprite);
      renderer.render(new Map(), new Map());
      expect(sprite.parent.remove).toHaveBeenCalledWith(sprite);
      expect(sprite.material.map.dispose).toHaveBeenCalledOnce();
      expect(sprite.material.dispose).toHaveBeenCalledOnce();
      expect(internal._labelSprites.size).toBe(0);
    }
    renderer.destroy();
  });
  it('prunes removed icons/textures and disposes all remaining resources and animation frames', () => {
    const renderer = new WebGL3DRenderer(config()); const internal = renderer as any;
    internal._graph = graph.chain;
    const sprite = label(); const texture = { dispose: vi.fn() };
    internal._iconSprites.set('urn:gone', { url: 'gone.png', sprite });
    internal._iconMaterials.add(sprite.material); internal._textureCache.set('gone.png', texture);
    renderer.render(new Map(), new Map());
    expect(sprite.material.dispose).toHaveBeenCalledOnce(); expect(texture.dispose).toHaveBeenCalledOnce();
    expect(internal._iconSprites.size).toBe(0); expect(internal._textureCache.size).toBe(0);
    const remaining = label(); internal._labelSprites.set('urn:remaining', remaining);
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame'); internal._fadeFrame = 7;
    renderer.destroy(); renderer.destroy();
    expect(remaining.material.dispose).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith(7);
    expect(internal._currentNodes.size).toBe(0);
  });
  it('initializes 3D once for concurrent callers and never allocates after early destruction', async () => {
    const renderer = new WebGL3DRenderer(config());
    await Promise.all([renderer.init(), renderer.init(), renderer.init()]);
    expect(graph.factory).toHaveBeenCalledOnce();
    renderer.destroy(); expect(vi.getTimerCount()).toBe(0);
    const early = new WebGL3DRenderer(config()); const pending = early.init(); early.destroy(); await pending;
    expect(graph.factory).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
