// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/renderer.js', () => ({ Canvas2DRenderer: class {
  init = vi.fn();
  render = vi.fn(); resize = vi.fn(); destroy = vi.fn();
} }));
import { RdfGraphViz } from '../src/core/rdf-graph-viz.js';
import { HexagonPainter } from '../src/core/hexagon-painter.js';
import { RdfGraph } from '../src/react/RdfGraph.js';
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('React wrapper with the real graph model', () => {
  it('keeps an image resolved after the first view across subsequent view changes', () => {
    const viz = new RdfGraphViz(container);
    try {
      viz.loadTriples([{ subject: 'urn:person', predicate: 'urn:name', object: 'Person' }]);
      viz.applyView({ name: 'Initial' });
      const person = viz.model.nodes.get('urn:person')!;
      expect(person.imageUrl).toBeNull();
      const image = 'https://example.test/photo one.png';
      viz.addTriples([{ subject: person.id, predicate: 'https://schema.org/image', object: image }]);
      expect(person.imageUrl).toBe(image);
      viz.applyView({ name: 'Next' });
      expect(viz.model.nodes.get(person.id)).toBe(person);
      expect(person.properties.get('https://schema.org/image')?.[0].value).toBe(image);
      expect(person.imageUrl).toBe(image);
      viz.applyView({ name: 'Override', focal: { uri: person.id, image: 'view.png' } });
      viz.applyView({ name: 'Default' });
      expect(person.imageUrl).toBe(image);
    } finally { viz.destroy(); }
  });
  it('preserves an active view image but restores newly ingested RDF images when the view changes', () => {
    const viz = new RdfGraphViz(container);
    try {
      viz.loadTriples([{ subject: 'urn:person', predicate: 'urn:name', object: 'Person' }]);
      viz.applyView({ name: 'Override', focal: { uri: 'urn:person', image: 'view.png' } });
      const person = viz.model.nodes.get('urn:person')!;
      const image = 'https://example.test/photo two.png';
      const triple = { subject: person.id, predicate: 'https://schema.org/image', object: image };
      viz.addTriples([triple]);
      expect(person.imageUrl).toBe('view.png');
      expect(person.dataDecorations.imageUrl).toBe(image);
      expect(person.viewOverrides.imageUrl).toBe('view.png');
      viz.applyView({ name: 'Default' });
      expect(person.imageUrl).toBe(image);
      expect(person.viewOverrides).toEqual({});
      viz.removeTriples([triple]);
      viz.applyView({ name: 'After removal' });
      expect(person.imageUrl).toBeNull();
    } finally { viz.destroy(); }
  });
  it('replaces view overrides without replacing application decorations or node identity', () => {
    const viz = new RdfGraphViz(container);
    try {
      viz.loadTriples([{ subject: 'urn:person', predicate: 'urn:name', object: 'Person' }]);
      const person = viz.model.nodes.get('urn:person')!;
      person.riskScore = 4; person.sizeMultiplier = 1.25;
      viz.applyView({ name: 'Focus', focal: { uri: person.id, image: 'focus.png', sizeMultiplier: 3 } });
      expect(person.imageUrl).toBe('focus.png'); expect(person.sizeMultiplier).toBe(3);
      expect(person.dataDecorations).toEqual({ imageUrl: null });
      expect(person.applicationOverrides).toEqual({ riskScore: 4, sizeMultiplier: 1.25 });
      person.imageUrl = 'latest-data.png';
      expect(person.imageUrl).toBe('focus.png');
      viz.applyView({ name: 'Default' });
      expect(viz.model.nodes.get(person.id)).toBe(person);
      expect(person.imageUrl).toBe('latest-data.png'); expect(person.riskScore).toBe(4);
      expect(person.sizeMultiplier).toBe(1.25); expect(person.viewOverrides).toEqual({});
    } finally { viz.destroy(); }
  });
  it('preserves application images across unrelated ingestion while still clearing removed RDF images', () => {
    const viz = new RdfGraphViz(container);
    try {
      const image = { subject: 'urn:person', predicate: 'https://schema.org/image', object: 'https://example.test/rdf photo.png' };
      const unrelated = { subject: 'urn:other', predicate: 'urn:name', object: 'Other' };
      viz.loadTriples([{ subject: 'urn:person', predicate: 'urn:name', object: 'Person' }, image]);
      const person = viz.getNode('urn:person')!;
      person.imageUrl = 'application.png';
      viz.addTriples([unrelated]);
      expect(person.imageUrl).toBe('application.png');
      viz.removeTriples([image, unrelated]);
      expect(person.imageUrl).toBe('application.png');
      // A different node with only an RDF image must lose it when that fact is removed.
      const rdfOnly = { ...image, subject: 'urn:other' };
      viz.addTriples([unrelated, rdfOnly]);
      expect(viz.getNode('urn:other')!.imageUrl).toBe(image.object);
      viz.removeTriples([rdfOnly]);
      expect(viz.getNode('urn:other')!.imageUrl).toBeNull();
      person.imageUrl = null;
      viz.addTriples([image]);
      expect(person.imageUrl).toBeNull();
    } finally { viz.destroy(); }
  });
  it('temporarily highlights above view sizing without copying view values into application data', () => {
    const viz = new RdfGraphViz(container);
    try {
      viz.loadTriples([{ subject: 'urn:person', predicate: 'urn:name', object: 'Person' }]);
      const person = viz.getNode('urn:person')!;
      person.sizeMultiplier = 1.25; person.isHighRisk = false; person.riskScore = 4;
      viz.applyView({ name: 'Focus', focal: { uri: person.id, sizeMultiplier: 1.5 } });
      viz.highlightNodes([person.id]);
      expect(person.sizeMultiplier).toBe(2); expect(person.isHighRisk).toBe(true);
      viz.clearHighlight();
      expect(person.sizeMultiplier).toBe(1.5); expect(person.isHighRisk).toBe(false);
      viz.applyView({ name: 'Default' });
      expect(person.sizeMultiplier).toBe(1.25); expect(person.riskScore).toBe(4);
      viz.highlightNodes([person.id]);
      person.sizeMultiplier = 1.75;
      viz.applyView({ name: 'Other focus', focal: { uri: person.id, sizeMultiplier: 3 } });
      viz.clearHighlight();
      expect(person.sizeMultiplier).toBe(3);
      viz.applyView({ name: 'Default' });
      expect(person.sizeMultiplier).toBe(1.75);
    } finally { viz.destroy(); }
  });
  it('replaces and removes view decorations while preserving model identity and data images', async () => {
    const loaded = vi.spyOn(RdfGraphViz.prototype, 'loadTriples');
    vi.spyOn(HexagonPainter.prototype, 'resolveImageUrl').mockImplementation(node => node.id === 'urn:b' ? 'https://example.invalid/data.png' : null);
    const data = [{ subject: 'urn:a', predicate: 'urn:p', object: 'urn:b' },
      { subject: 'urn:a', predicate: 'http://schema.org/risk', object: '9' }];
    await act(async () => root.render(React.createElement(RdfGraph, {
      data, viewConfig: { name: 'A', focal: { uri: 'urn:a', image: 'a.png', sizeMultiplier: 3 },
        highlight: { property: 'risk', threshold: 5, color: 'red' } },
    })));
    const viz = loaded.mock.contexts[0]; const a = viz.model.nodes.get('urn:a')!;
    expect(a.imageUrl).toBe('a.png');
    expect(a.isHighRisk).toBe(true);
    await act(async () => root.render(React.createElement(RdfGraph, {
      data, viewConfig: { name: 'B', focal: { uri: 'urn:b', image: 'b.png' },
        highlight: { property: 'risk', threshold: 99, color: 'red' } },
    })));
    expect(viz.model.nodes.get('urn:a')).toBe(a);
    expect(a.imageUrl).toBeNull(); expect(a.sizeMultiplier).toBeUndefined();
    expect(a.isHighRisk).not.toBe(true);
    expect(viz.model.nodes.get('urn:b')!.imageUrl).toBe('b.png');
    await act(async () => root.render(React.createElement(RdfGraph, { data })));
    expect(viz.model.nodes.get('urn:b')!.imageUrl).toBe('https://example.invalid/data.png');
    expect(viz.model.nodes.get('urn:b')!.sizeMultiplier).toBeUndefined();
    expect(loaded).toHaveBeenCalledOnce();
  });
  it('preserves requested focus during asynchronous string parsing', async () => {
    const loaded = vi.spyOn(RdfGraphViz.prototype, 'loadNTriples');
    const data = '<urn:selected> <urn:p> <urn:near> .\n' + Array.from({ length: 8 }, (_, i) => `<urn:hub> <urn:p> <urn:other${i}> .`).join('\n');
    await act(async () => root.render(React.createElement(RdfGraph, {
      data, options: { focus: { focalNode: 'urn:selected', maxNodes: 2, hops: 1 } },
    })));
    await act(async () => { await vi.dynamicImportSettled(); });
    const viz = loaded.mock.contexts[0];
    expect((viz as any)._focusFilter.focalNode).toBe('urn:selected');
    expect((viz as any)._focusFilter.visibleNodeIds.has('urn:selected')).toBe(true);
  });
});
