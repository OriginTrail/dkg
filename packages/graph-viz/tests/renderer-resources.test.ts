// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const graph = vi.hoisted(() => ({ callbacks: new Map<string, any>(), factory: vi.fn(), chain: null as any }));
vi.mock('force-graph', () => ({ default: () => () => graph.chain }));
vi.mock('3d-force-graph', () => ({ default: () => graph.factory }));
import { Canvas2DRenderer } from '../src/core/renderer.js';
import { WebGL3DRenderer, createWebGL3DRenderer } from '../src/core/renderer-3d.js';
import { GraphEventEmitter } from '../src/core/events.js';
import { Sprite, SpriteMaterial, Texture } from 'three';
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('renderer hit regions and resources', () => {
  it('publishes a ready backend and destroys it if synchronous initialization fails', async () => {
    const renderer = await createWebGL3DRenderer(config());
    expect(graph.factory).toHaveBeenCalledOnce();
    renderer.destroy();
    const destroy = vi.spyOn(WebGL3DRenderer.prototype, 'destroy');
    const release = vi.fn(); const chain = graph.chain;
    graph.chain = new Proxy({}, { get: (_target, key) => key === '_destructor' ? release
      : key === 'height' ? () => { throw new Error('setup failed'); } : chain[key] });
    graph.factory.mockReturnValue(graph.chain);
    await expect(createWebGL3DRenderer(config())).rejects.toThrow('setup failed');
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
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
    const sprite = new Sprite(new SpriteMaterial()); const texture = { dispose: vi.fn() };
    const removedMaterial = sprite.material;
    vi.spyOn(removedMaterial, 'dispose');
    internal._iconSprites.set('urn:gone', { url: 'gone.png', sprite });
    internal._textureCache.set('gone.png', { texture });
    renderer.render(new Map(), new Map());
    expect(removedMaterial.dispose).toHaveBeenCalledOnce(); expect(texture.dispose).toHaveBeenCalledOnce();
    expect(internal._iconSprites.size).toBe(0); expect(internal._textureCache.size).toBe(0);
    const remaining = label(); internal._labelSprites.set('urn:remaining', remaining);
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame'); internal._fadeFrame = 7;
    renderer.destroy(); renderer.destroy();
    expect(remaining.material.dispose).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith(7);
    expect(internal._currentNodes.size).toBe(0);
  });
  it('initializes 3D synchronously once and never allocates after destruction', () => {
    const renderer = new WebGL3DRenderer(config());
    renderer.init(); renderer.init(); renderer.init();
    expect(graph.factory).toHaveBeenCalledOnce();
    renderer.destroy(); expect(vi.getTimerCount()).toBe(0);
    const early = new WebGL3DRenderer(config()); early.destroy(); early.init();
    expect(graph.factory).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses image sprites and shared textures across redraws, then disposes each resource once', async () => {
    const renderer = new WebGL3DRenderer(config());
    await renderer.init();
    const texture = new Texture();
    const disposeTexture = vi.spyOn(texture, 'dispose');
    const load = vi.spyOn((renderer as any)._textureLoader, 'load').mockReturnValue(texture);
    const node = { id: 'urn:a', label: 'urn:a', degree: 1, imageUrl: 'https://example.invalid/icon.png' } as any;
    const peer = { ...node, id: 'urn:b', label: 'urn:b' };
    renderer.render(new Map([[node.id, node], [peer.id, peer]]), new Map());
    const drawNode = graph.callbacks.get('nodeThreeObject');
    const first = drawNode({ _graphNode: node });
    const second = drawNode({ _graphNode: peer });
    expect(first.material.opacity).toBe(0.9);
    const disposeFirst = vi.spyOn(first.material, 'dispose');
    const disposeSecond = vi.spyOn(second.material, 'dispose');
    for (let i = 0; i < 10; i++) {
      renderer.render(new Map([[node.id, node], [peer.id, peer]]), new Map());
      expect(drawNode({ _graphNode: node })).toBe(first);
      expect(drawNode({ _graphNode: peer })).toBe(second);
    }
    expect(load).toHaveBeenCalledOnce();
    expect(first.material.map).toBe(second.material.map);
    renderer.render(new Map([[peer.id, peer]]), new Map());
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeTexture).not.toHaveBeenCalled();
    // Leave the second icon/texture live until teardown, so destroy's resource
    // loops are independently covered rather than just graph replacement.
    renderer.destroy(); renderer.destroy();
    expect(disposeSecond).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares SVG textures and cancels pending image work when its nodes disappear', async () => {
    const images: Array<{ src: string; onload: (() => void) | null }> = [];
    vi.stubGlobal('Image', class {
      src = ''; onload: (() => void) | null = null;
      constructor() { images.push(this); }
    });
    const context = { beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
    const conf = config(); conf.styleEngine.getNodeColor = () => '#112233';
    const renderer = new WebGL3DRenderer(conf); await renderer.init();
    const a = { id: 'urn:a', label: 'urn:a', degree: 1, imageUrl: 'data:image/svg+xml,<svg></svg>' } as any;
    const b = { ...a, id: 'urn:b', label: 'urn:b' };
    renderer.render(new Map([[a.id, a], [b.id, b]]), new Map());
    const drawNode = graph.callbacks.get('nodeThreeObject');
    const first = drawNode({ _graphNode: a }); const second = drawNode({ _graphNode: b });
    expect(first.material.opacity).toBe(1);
    expect(images).toHaveLength(1);
    expect(first.material.map).toBe(second.material.map);
    const dispose = vi.spyOn(first.material.map, 'dispose');
    const lateLoad = images[0].onload!;
    renderer.render(new Map([[b.id, b]]), new Map());
    expect(images[0].onload).not.toBeNull();
    renderer.render(new Map(), new Map());
    expect(images[0].onload).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    lateLoad();
    expect(context.drawImage).not.toHaveBeenCalled();
    renderer.render(new Map([[a.id, a]]), new Map());
    drawNode({ _graphNode: a });
    expect(images).toHaveLength(2);
    lateLoad(); // An old callback must not update a replacement with the same URL.
    expect(context.drawImage).not.toHaveBeenCalled();
    renderer.destroy(); lateLoad();
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('updates an SVG texture after a successful load and releases it on teardown', async () => {
    const images: Array<{ src: string; onload: (() => void) | null }> = [];
    vi.stubGlobal('Image', class {
      src = ''; onload: (() => void) | null = null;
      constructor() { images.push(this); }
    });
    const context = { beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
    const conf = config(); conf.styleEngine.getNodeColor = () => '#112233';
    const renderer = new WebGL3DRenderer(conf); await renderer.init();
    const node = { id: 'urn:svg', label: 'urn:svg', degree: 1, imageUrl: 'data:image/svg+xml,<svg></svg>' } as any;
    renderer.render(new Map([[node.id, node]]), new Map());
    const sprite = graph.callbacks.get('nodeThreeObject')({ _graphNode: node });
    const texture = sprite.material.map; const version = texture.version;
    const dispose = vi.spyOn(texture, 'dispose');
    images[0].onload!();
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(texture.version).toBeGreaterThan(version);
    renderer.destroy(); expect(dispose).toHaveBeenCalledOnce();
  });
});
