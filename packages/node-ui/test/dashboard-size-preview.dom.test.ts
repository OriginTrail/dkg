// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextGraph } from '../src/ui/stores/projects.js';
import type { LayeredTriple, MemoryData } from '../src/ui/hooks/useMemoryEntities.js';

const probes = vi.hoisted(() => ({
  graphs: [] as ContextGraph[],
  memory: new Map<string, MemoryData>(),
}));
vi.mock('../src/ui/hooks/useMyContextGraphs.js', () => ({
  useMyContextGraphs: () => ({
    myCgs: probes.graphs, identity: null, identityLoading: false, cgsLoading: false,
  }),
}));
vi.mock('../src/ui/hooks/useMemoryEntities.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/hooks/useMemoryEntities.js')>(),
  useMemoryEntities: (id: string) => probes.memory.get(id)!,
}));
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useNodeEvents: () => {} }));
vi.mock('../src/ui/hooks.js', () => ({
  useFetch: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('../src/ui/api-wrapper.js', () => ({
  api: { listParticipants: async () => ({ allowedAgents: [] }) },
}));
vi.mock('../src/ui/stores/tabs.js', () => ({ useTabsStore: () => ({ openTab: () => {} }) }));
vi.mock('../src/ui/stores/projects.js', () => ({
  useProjectsStore: () => ({ setActiveProject: () => {} }),
}));
vi.mock('../src/ui/pages/conviction/PcaDashboardRow.js', () => ({ PcaDashboardRow: () => null }));

const { DashboardView } = await import('../src/ui/views/DashboardView.js');
const { buildMemoryEntities } = await import('../src/ui/hooks/useMemoryEntities.js');
let root: Root;
let container: HTMLDivElement;

function addGraph(id: string, options: {
  triples?: number; subjects?: number; partial?: boolean; error?: string; assets?: number;
  failedLayer?: boolean; layeredTriples?: LayeredTriple[];
}) {
  probes.graphs.push({ id, name: id, accessPolicy: 'private', assetCount: options.assets ?? 0 } as ContextGraph);
  const subjects = options.subjects ?? 1;
  const allTriples: LayeredTriple[] = options.layeredTriples ?? Array.from({ length: options.triples ?? 0 }, (_, i) => ({
    subject: `urn:subject:${i % subjects}`, predicate: 'urn:value', object: `"value-${i}"`, layer: 'working',
  }));
  const entities = buildMemoryEntities(allTriples);
  const counts = { wm: 0, swm: 0, vm: 0, total: entities.size };
  for (const entity of entities.values()) {
    counts[entity.trustLevel === 'working' ? 'wm' : entity.trustLevel === 'shared' ? 'swm' : 'vm']++;
  }
  probes.memory.set(id, {
    entities, entityList: [...entities.values()], allTriples, graphTriples: [], trustMap: new Map(),
    counts,
    loading: false, error: options.error ?? null, partial: options.partial ?? false,
    layerStatus: { wm: 'ok', swm: options.failedLayer ? 'error' : 'ok', vm: 'ok' }, refresh: () => {},
  });
}

async function render() {
  await act(async () => { root.render(React.createElement(DashboardView)); });
  const card = [...container.querySelectorAll('.stat-card')]
    .find((element) => element.querySelector('.stat-label')?.textContent === 'Context Graph Size')!;
  return {
    card,
    values: [...card.querySelectorAll('.v10-cg-size-big')].map((element) => element.textContent),
    labels: [...card.querySelectorAll('.v10-cg-size-num > .v10-cg-dim')],
    row: container.querySelector('.v10-cg-row .v10-cg-size')!,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  probes.graphs = [];
  probes.memory.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('real DashboardView size presentation', () => {
  it('does not assert a triple lower bound when a missing layer reveals promotion residue', async () => {
    const working: LayeredTriple[] = [0, 1, 2].map((i) => ({
      subject: 'urn:entity:A', predicate: `urn:edge:${i}`, object: 'urn:entity:B', layer: 'working',
    }));
    addGraph('residue', { layeredTriples: working, partial: true, failedLayer: true });
    const preview = await render();
    expect(preview.values).toEqual(['1+', '~3']);
    expect(preview.labels[1].textContent).toBe('triples preview');
    expect(preview.row.textContent).toContain('~3 triples · loaded preview');
    expect(preview.card.textContent).toContain('may increase or decrease');

    probes.graphs = [];
    addGraph('residue', { layeredTriples: [...working,
      { subject: 'urn:entity:A', predicate: 'urn:name', object: '"A"', layer: 'shared' },
      { subject: 'urn:entity:B', predicate: 'urn:name', object: '"B"', layer: 'shared' },
    ] });
    const complete = await render();
    expect(complete.values).toEqual(['2', '2']);
    expect(complete.row.textContent).toContain('2 entities · 2 triples');
    expect(complete.card.textContent).not.toContain('Partial preview');
  });

  it.each([false, true])('marks capped or unavailable memory as an entity lower bound and triple preview (failed layer: %s)', async (failedLayer) => {
    addGraph('preview', { triples: 50_001, subjects: 1_251, partial: true, failedLayer });
    const { row, card, values, labels } = await render();
    expect(values).toEqual([`${(1_251).toLocaleString()}+`, `~${(50_001).toLocaleString()}`]);
    expect(labels.map((element) => element.textContent)).toEqual(['entities loaded', 'triples preview']);
    expect(row.textContent).toContain(`${(1_251).toLocaleString()}+ entities`);
    expect(row.textContent).toContain(`~${(50_001).toLocaleString()} triples · loaded preview`);
    expect(row.querySelector('[title]')?.getAttribute('title')).toMatch(/capped or unavailable.*increase or decrease/);
    expect(card.textContent).toContain('Partial preview');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(2);
  });

  it('retains exact complete counts and their layer breakdown', async () => {
    addGraph('complete', { triples: 2_003, subjects: 2 });
    const { row, card, values, labels } = await render();
    expect(values).toEqual(['2', (2_003).toLocaleString()]);
    expect(labels.map((element) => element.textContent)).toEqual(['entities / Knowledge Assets', 'triples']);
    expect(row.textContent).toContain('2 entities · 2k triples');
    expect(card.textContent).not.toContain('Partial preview');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(2);
  });

  it('keeps mixed live and published-summary totals approximate with explicit units', async () => {
    addGraph('live', { triples: 5, subjects: 2, partial: true });
    addGraph('summary', { error: 'query unavailable', assets: 7 });
    const { card, values, labels } = await render();
    expect(values).toEqual(['~9', '~5']);
    expect(labels.map((element) => element.textContent)).toEqual(['entities / KA · approx.', 'triples']);
    expect(labels[0].getAttribute('title')).toContain('mixes summary and live counts');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(0);
    expect(container.querySelectorAll('.v10-cg-row .v10-cg-size')[1].textContent).toContain('7 KA (summary) · — triples');
  });

  it('shows unavailable triples as unknown when only a Knowledge-Asset summary is available', async () => {
    addGraph('summary', { error: 'query unavailable', assets: 7 });
    const { row, card, values, labels } = await render();
    expect(values).toEqual(['7', '—']);
    expect(labels.map((element) => element.textContent)).toEqual(['Knowledge Assets (summary)', 'triples']);
    expect(labels[0].getAttribute('title')).toContain('not the full WM/SWM/VM entity total');
    expect(row.textContent).toContain('7 KA (summary) · — triples');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(0);
  });
});
