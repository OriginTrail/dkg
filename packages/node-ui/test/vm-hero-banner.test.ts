// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LayerContent, VerifiedMemoryHeroBanner } from '../src/ui/views/project/components.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

function memoryEntity(uri: string, types: string[]): MemoryEntity {
  return {
    uri,
    label: uri,
    types,
    trustLevel: 'verified',
    layers: new Set(['verified']),
    subGraphs: new Set(['public']),
    properties: new Map(),
    connections: [],
  };
}

async function renderVmHero(props: {
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId: string;
}): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(VerifiedMemoryHeroBanner, props));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function renderLayerContent(props: React.ComponentProps<typeof LayerContent>): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(LayerContent, props));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('VerifiedMemoryHeroBanner', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows a purposeful empty VM state instead of a zero-stat hero', async () => {
    const { container, unmount } = await renderVmHero({
      entities: [],
      tripleCount: 0,
      contextGraphId: 'cg-empty',
    });

    expect(container.querySelector('.v10-vm-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('Verified Memory');
    expect(container.textContent).toContain('Nothing published yet');
    expect(container.textContent).toContain('No Knowledge Assets yet.');
    expect(container.textContent).toContain('Publish entities from Shared Working Memory');
    expect(container.querySelectorAll('.v10-vm-hero-stat')).toHaveLength(0);

    await unmount();
  });

  it('keeps populated stats numeric and moves the context graph id out of the stat row', async () => {
    const { container, unmount } = await renderVmHero({
      entities: [
        memoryEntity('asset-1', ['http://schema.org/Thing']),
        memoryEntity('asset-2', ['http://schema.org/Thing', 'http://schema.org/CreativeWork']),
      ],
      tripleCount: 1234,
      contextGraphId: 'cg-populated',
    });

    const statValues = Array.from(container.querySelectorAll('.v10-vm-hero-stat-val'))
      .map((node) => node.textContent);

    expect(statValues).toEqual(['2', (1234).toLocaleString(), '2']);
    expect(container.querySelector('.v10-vm-hero-context')?.textContent).toContain('cg-populated');
    expect(statValues.some((value) => value?.includes('cg-populated'))).toBe(false);
    expect(container.querySelector('.v10-vm-empty-state')).toBeNull();

    await unmount();
  });

  it('uses only the VM empty hero while preserving the caller footer', async () => {
    const { container, unmount } = await renderLayerContent({
      layer: 'vm',
      entities: [],
      tripleCount: 0,
      layerTriples: [],
      contextGraphId: 'cg-empty',
      memory: {
        entities: new Map(),
        entityList: [],
        allTriples: [],
        graphTriples: [],
        trustMap: new Map(),
        counts: { wm: 0, swm: 0, vm: 0, total: 0 },
        loading: false,
        error: null,
        partial: false,
        layerStatus: { wm: 'ok', swm: 'ok', vm: 'ok' },
        refresh: () => {},
      } as any,
      activeTab: 'items',
      onTabChange: () => {},
      onSelectEntity: () => {},
      footer: React.createElement('button', null, 'View full layer'),
    });

    expect(container.querySelector('.v10-vm-empty-state')).toBeTruthy();
    expect(container.querySelector('.v10-layer-widgets-strip')).toBeNull();
    expect(container.querySelector('.v10-entity-list')).toBeNull();
    expect(container.textContent).toContain('View full layer');

    await unmount();
  });

  it('keeps the empty VM hero when another layer is partial but VM loaded successfully', async () => {
    const { container, unmount } = await renderLayerContent({
      layer: 'vm',
      entities: [],
      tripleCount: 0,
      layerTriples: [],
      contextGraphId: 'cg-partial',
      memory: {
        entities: new Map(),
        entityList: [],
        allTriples: [],
        graphTriples: [],
        trustMap: new Map(),
        counts: { wm: 0, swm: 0, vm: 0, total: 0 },
        loading: false,
        error: null,
        partial: true,
        layerStatus: { wm: 'error', swm: 'ok', vm: 'ok' },
        refresh: () => {},
      } as any,
      activeTab: 'items',
      onTabChange: () => {},
      onSelectEntity: () => {},
      footer: React.createElement('button', null, 'View full layer'),
    });

    expect(container.querySelector('.v10-vm-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('Nothing published yet');
    expect(container.textContent).not.toContain('Verified Memory status unavailable.');
    expect(container.textContent).toContain('View full layer');

    await unmount();
  });

  it('suppresses the empty VM hero when the VM layer failed to load', async () => {
    const { container, unmount } = await renderLayerContent({
      layer: 'vm',
      entities: [],
      tripleCount: 0,
      layerTriples: [],
      contextGraphId: 'cg-vm-error',
      memory: {
        entities: new Map(),
        entityList: [],
        allTriples: [],
        graphTriples: [],
        trustMap: new Map(),
        counts: { wm: 0, swm: 0, vm: 0, total: 0 },
        loading: false,
        error: null,
        partial: false,
        layerStatus: { wm: 'error', swm: 'error', vm: 'error' },
        refresh: () => {},
      } as any,
      activeTab: 'items',
      onTabChange: () => {},
      onSelectEntity: () => {},
      footer: React.createElement('button', null, 'View full layer'),
    });

    expect(container.querySelector('.v10-vm-empty-state')).toBeNull();
    expect(container.textContent).not.toContain('Nothing published yet');
    expect(container.textContent).toContain('Verified Memory status unavailable.');
    expect(container.textContent).toContain('View full layer');

    await unmount();
  });
});
