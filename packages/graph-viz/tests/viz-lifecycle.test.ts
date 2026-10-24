// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderers = vi.hoisted(() => ({ two: [] as any[], three: [] as any[], init: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/core/renderer.js', () => ({ Canvas2DRenderer: class {
  init = vi.fn(); render = vi.fn(); resize = vi.fn(); destroy = vi.fn(); applyAnimation = vi.fn();
  constructor() { renderers.two.push(this); }
} }));
vi.mock('../src/core/renderer-3d.js', () => ({ createWebGL3DRenderer: async () => {
  const renderer = { render: vi.fn(), resize: vi.fn(), destroy: vi.fn(), applyAnimation: vi.fn() };
  renderers.three.push(renderer);
  try { await renderers.init?.(); return renderer; }
  catch (error) { renderer.destroy(); throw error; }
} }));
import { RdfGraphViz } from '../src/core/rdf-graph-viz.js';

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn(); disconnect = vi.fn();
  constructor(readonly callback: () => void) { Observer.instances.push(this); }
}
beforeEach(() => {
  Observer.instances = []; renderers.two = []; renderers.three = []; renderers.init = undefined;
  vi.stubGlobal('ResizeObserver', Observer);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('visualizer lifecycle', () => {
  it('disconnects every resize observer and releases the model on repeated mount/unmount', () => {
    for (let i = 0; i < 20; i++) {
      const viz = new RdfGraphViz(document.createElement('div'));
      viz.loadTriples([{ subject: 'urn:order', predicate: 'urn:p', object: 'urn:step' }]);
      expect(viz.model.nodes.size).toBeGreaterThan(0);
      viz.destroy(); viz.destroy();
      expect(viz.model.nodes.size).toBe(0);
    }
    expect(Observer.instances).toHaveLength(20);
    expect(Observer.instances.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(renderers.two.every(renderer => renderer.destroy.mock.calls.length === 1)).toBe(true);
  });
  it('does not ingest an obsolete asynchronous parse after replacement or destruction', async () => {
    const viz = new RdfGraphViz(document.createElement('div'));
    const controller = new AbortController();
    const pending = viz.loadNTriples('<urn:old> <urn:p> <urn:o> .', controller.signal);
    controller.abort(); await pending;
    expect(viz.model.nodes.size).toBe(0);
    const destroyed = viz.loadNTriples('<urn:late> <urn:p> <urn:o> .');
    viz.destroy(); await destroyed;
    expect(viz.model.nodes.size).toBe(0);
  });
  it('does not create a 3D renderer after its container has been destroyed', async () => {
    const viz = new RdfGraphViz(document.createElement('div'), { renderer: '3d' });
    viz.destroy(); await vi.dynamicImportSettled();
    expect(renderers.three).toHaveLength(0);
  });
  it('waits for 3D initialization and does not render after destruction during initialization', async () => {
    let resolve!: () => void;
    renderers.init = () => new Promise<void>(r => { resolve = r; });
    const viz = new RdfGraphViz(document.createElement('div'), { renderer: '3d' });
    viz.loadTriples([{ subject: 'urn:order', predicate: 'urn:p', object: 'urn:step' }]);
    await vi.waitFor(() => expect(renderers.three).toHaveLength(1));
    expect(renderers.three[0].render).not.toHaveBeenCalled();
    viz.destroy(); resolve(); await flush();
    expect(renderers.three[0].render).not.toHaveBeenCalled();
    expect(renderers.three[0].destroy).toHaveBeenCalledOnce();
  });

  it('releases a failed 3D renderer and renders the loaded data with the 2D fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderers.init = async () => { throw new Error('WebGL unavailable'); };
    const viz = new RdfGraphViz(document.createElement('div'), { renderer: '3d' });
    viz.loadTriples([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }]);
    await vi.waitFor(() => expect(renderers.two).toHaveLength(1)); await flush();
    expect(renderers.three[0].destroy).toHaveBeenCalledOnce();
    expect(renderers.two[0].render).toHaveBeenCalled();
    viz.destroy(); expect(renderers.two[0].destroy).toHaveBeenCalledOnce();
  });

  it('does not allocate a fallback after failure of an already-destroyed 3D view', async () => {
    let reject!: (reason: Error) => void;
    renderers.init = () => new Promise<void>((_, fail) => { reject = fail; });
    const viz = new RdfGraphViz(document.createElement('div'), { renderer: '3d' });
    await vi.waitFor(() => expect(renderers.three).toHaveLength(1));
    viz.destroy(); reject(new Error('late WebGL failure')); await flush();
    expect(renderers.two).toHaveLength(0);
    expect(renderers.three[0].destroy).toHaveBeenCalledOnce();
  });

  it('applies deferred camera settings only while the view is still alive', async () => {
    let resolve!: () => void;
    renderers.init = () => new Promise<void>(r => { resolve = r; });
    const viz = new RdfGraphViz(document.createElement('div'), { renderer: '3d' });
    viz.autoFitDisabled = true;
    await vi.waitFor(() => expect(renderers.three).toHaveLength(1));
    resolve(); await flush();
    expect(renderers.three[0].autoFitDisabled).toBe(true);
    const view = { name: 'animated view', animation: { fadeIn: true } } as any;
    viz.applyView(view); await flush();
    expect(renderers.three[0].applyAnimation).toHaveBeenCalledExactlyOnceWith(view.animation);
    viz.applyView(view); viz.destroy(); await flush();
    expect(renderers.three[0].applyAnimation).toHaveBeenCalledTimes(1);
    expect(renderers.three[0].destroy).toHaveBeenCalledOnce();
  });

  it('loads each RDF format and suppresses canceled asynchronous parses', async () => {
    const viz = new RdfGraphViz(document.createElement('div'));
    await viz.loadNQuads('<urn:s> <urn:p> <urn:o> <urn:g> .');
    expect(viz.model.nodes.has('urn:s')).toBe(true);
    await viz.loadTurtle('@prefix ex: <urn:example:> . ex:a ex:p ex:b .');
    expect(viz.model.nodes.has('urn:example:a')).toBe(true);
    await viz.loadJsonLd({ '@id': 'urn:json', 'urn:p': { '@id': 'urn:target' } });
    expect(viz.model.nodes.has('urn:json')).toBe(true);
    const before = viz.model.nodes.size;
    const controller = new AbortController(); controller.abort();
    await viz.loadNQuads('<urn:old> <urn:p> <urn:o> <urn:g> .', controller.signal);
    await viz.loadTurtle('<urn:old> <urn:p> <urn:o> .', controller.signal);
    await viz.loadJsonLd({ '@id': 'urn:old', 'urn:p': { '@id': 'urn:target' } }, controller.signal);
    expect(viz.model.nodes.size).toBe(before);
    expect(viz.model.nodes.has('urn:old')).toBe(false);
    viz.destroy();
  });
});
