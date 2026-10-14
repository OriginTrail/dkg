// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderers = vi.hoisted(() => ({ two: [] as any[], three: [] as any[], init: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/core/renderer.js', () => ({ Canvas2DRenderer: class {
  render = vi.fn(); resize = vi.fn(); destroy = vi.fn();
  constructor() { renderers.two.push(this); }
} }));
vi.mock('../src/core/renderer-3d.js', () => ({ WebGL3DRenderer: class {
  render = vi.fn(); resize = vi.fn(); destroy = vi.fn();
  constructor() { renderers.three.push(this); }
  init() { return renderers.init?.() ?? Promise.resolve(); }
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
afterEach(() => { vi.unstubAllGlobals(); });
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
});
