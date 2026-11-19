// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextGraph } from '../src/ui/stores/projects.js';
import type { LayeredTriple, MemoryData } from '../src/ui/hooks/useMemoryEntities.js';

const probes = vi.hoisted(() => ({
  graphs: [] as ContextGraph[],
  memory: new Map<string, MemoryData>(),
  cgsError: null as string | null,
  identityError: null as string | null,
  retry: vi.fn(),
  // Per graph: the /participants answer, or an Error to reject with. Unset → no agents.
  participants: new Map<string, { allowedAgents: string[] } | Error>(),
  nodeEventHandlers: [] as Array<(event: { type: string; data?: unknown }) => void>,
}));
vi.mock('../src/ui/hooks/useMyContextGraphs.js', () => ({
  useMyContextGraphs: () => ({
    myCgs: probes.graphs, identity: null, identityLoading: false, cgsLoading: false,
    cgsError: probes.cgsError, identityError: probes.identityError, retry: probes.retry,
    inventoryLoading: false, inventoryError: probes.cgsError || probes.identityError,
  }),
}));
vi.mock('../src/ui/hooks/useMemoryEntities.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/hooks/useMemoryEntities.js')>(),
  useMemoryEntities: (id: string) => probes.memory.get(id)!,
}));
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({
  useNodeEvents: (handler: (event: { type: string; data?: unknown }) => void) => { probes.nodeEventHandlers.push(handler); },
}));
vi.mock('../src/ui/hooks.js', () => ({
  useFetch: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    listParticipants: async (id: string) => {
      const answer = probes.participants.get(id);
      if (answer instanceof Error) throw answer;
      return answer ?? { allowedAgents: [] };
    },
  },
}));
vi.mock('../src/ui/stores/tabs.js', () => ({ useTabsStore: Object.assign(() => ({ openTab: () => {} }), { getState: () => ({ activeTabId: 'dashboard', openTab: () => {} }) }) }));
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
  failedLayer?: boolean; layeredTriples?: LayeredTriple[]; accessPolicy?: string;
}) {
  probes.graphs.push({ id, name: id, accessPolicy: options.accessPolicy ?? 'private', assetCount: options.assets ?? 0 } as ContextGraph);
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
    hasMore: false, canRetry: false, loadMore: () => {}, pageError: null, limitMessage: null,
  });
}

async function render() {
  await act(async () => { root.render(React.createElement(DashboardView)); });
  const card = [...container.querySelectorAll('.stat-card')]
    .find((element) => element.querySelector('.stat-label')?.textContent === 'Context graph size')!;
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
  probes.cgsError = null; probes.identityError = null; probes.retry.mockReset();
  probes.participants.clear(); probes.nodeEventHandlers = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('real DashboardView size presentation', () => {
  it.each(['cgsError', 'identityError'] as const)('never claims an empty inventory after %s and exposes retry', async failed => {
    probes[failed] = 'endpoint unavailable';
    await render();
    expect(container.textContent).not.toContain('No context graphs yet');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t load');
    expect(container.querySelector('.v10-dash-section-badge')?.textContent).toBe('—');
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
    await act(async () => { retry.click(); });
    expect(probes.retry).toHaveBeenCalledOnce();
  });

  it('keeps known graphs visible with an approximate count after refresh fails', async () => {
    addGraph('retained', { triples: 3 });
    probes.cgsError = 'refresh unavailable';
    await render();
    expect(container.querySelector('.v10-cg-row')?.textContent).toContain('retained');
    expect(container.querySelector('.v10-dash-section-badge')?.textContent).toBe('~1');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('last ones loaded');
    probes.cgsError = null;
    await render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.v10-dash-section-badge')?.textContent).toBe('1');
  });

  it('shows a genuine successful empty inventory as empty', async () => {
    await render();
    expect(container.textContent).toContain('No context graphs yet');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not assert a triple lower bound when a missing layer reveals promotion residue', async () => {
    const working: LayeredTriple[] = [0, 1, 2].map((i) => ({
      subject: 'urn:entity:A', predicate: `urn:edge:${i}`, object: 'urn:entity:B', layer: 'working',
    }));
    addGraph('residue', { layeredTriples: working, partial: true, failedLayer: true });
    const preview = await render();
    expect(preview.values).toEqual(['1+', '~3']);
    expect(preview.labels[1].textContent).toBe('triples preview');
    expect(preview.row.textContent).toContain('~3 triples · loaded preview');
    // The qualification lives behind the size card's info button: open it, check it, close it.
    const toggle = preview.card.querySelector<HTMLButtonElement>('.stat-about-toggle')!;
    const panel = preview.card.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('can rise or fall');
    await act(async () => { toggle.click(); });
    expect(panel.hidden).toBe(true);

    probes.graphs = [];
    addGraph('residue', { layeredTriples: [...working,
      { subject: 'urn:entity:A', predicate: 'urn:name', object: '"A"', layer: 'shared' },
      { subject: 'urn:entity:B', predicate: 'urn:name', object: '"B"', layer: 'shared' },
    ] });
    const complete = await render();
    expect(complete.values).toEqual(['2', '2']);
    expect(complete.row.textContent).toContain('2 entities · 2 triples');
    expect(complete.card.textContent).not.toContain('Partial:');
  });

  it.each([false, true])('marks capped or unavailable memory as an entity lower bound and triple preview (failed layer: %s)', async (failedLayer) => {
    addGraph('preview', { triples: 50_001, subjects: 1_251, partial: true, failedLayer });
    const { row, card, values, labels } = await render();
    expect(values).toEqual([`${(1_251).toLocaleString()}+`, `~${(50_001).toLocaleString()}`]);
    expect(labels.map((element) => element.textContent)).toEqual(['entities loaded', 'triples preview']);
    expect(row.textContent).toContain(`${(1_251).toLocaleString()}+ entities`);
    expect(row.textContent).toContain(`~${(50_001).toLocaleString()} triples · loaded preview`);
    expect(row.querySelector('[title]')?.getAttribute('title')).toMatch(/capped or unavailable.*increase or decrease/);
    expect(card.textContent).toContain('Partial:');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(2);
  });

  it('retains exact complete counts and their layer breakdown', async () => {
    addGraph('complete', { triples: 2_003, subjects: 2 });
    const { row, card, values, labels } = await render();
    expect(values).toEqual(['2', (2_003).toLocaleString()]);
    expect(labels.map((element) => element.textContent)).toEqual(['entities / Knowledge Assets', 'triples']);
    expect(row.textContent).toContain('2 entities · 2k triples');
    expect(card.textContent).not.toContain('Partial:');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(2);
  });

  it('keeps mixed live and published-summary totals approximate with explicit units', async () => {
    addGraph('live', { triples: 5, subjects: 2, partial: true });
    addGraph('summary', { error: 'query unavailable', assets: 7 });
    const { card, values, labels } = await render();
    expect(values).toEqual(['~9', '~5']);
    expect(labels.map((element) => element.textContent)).toEqual(['entities / Knowledge Assets · approx.', 'triples']);
    expect(labels[0].getAttribute('title')).toContain('mixes summary and live counts');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(0);
    expect(container.querySelectorAll('.v10-cg-row .v10-cg-size')[1].textContent).toContain('7 Knowledge Assets (summary) · — triples');
  });

  it('shows unavailable triples as unknown when only a Knowledge-Asset summary is available', async () => {
    addGraph('summary', { error: 'query unavailable', assets: 7 });
    const { row, card, values, labels } = await render();
    expect(values).toEqual(['7', '—']);
    expect(labels.map((element) => element.textContent)).toEqual(['Knowledge Assets (summary)', 'triples']);
    expect(labels[0].getAttribute('title')).toContain('not the full WM/SWM/VM entity total');
    expect(row.textContent).toContain('7 Knowledge Assets (summary) · — triples');
    expect(card.querySelectorAll('.v10-layerbar')).toHaveLength(0);
  });

  describe('collaborating agents count', () => {
    const agentsValue = () => [...container.querySelectorAll('.stat-card')]
      .find((card) => card.querySelector('.stat-label')?.textContent === 'Collaborating agents')
      ?.querySelector('.stat-value')?.textContent;
    const A = '0x' + 'a'.repeat(40);
    const B = '0x' + 'b'.repeat(40);

    it('reads as a floor ("2+") while a graph can’t report its agents, and exact once it recovers', async () => {
      addGraph('alpha', {});
      addGraph('beta', {});
      probes.participants.set('alpha', { allowedAgents: [A, B] });
      probes.participants.set('beta', new Error('participants unavailable'));
      await render();
      await act(async () => {});
      expect(agentsValue()).toBe('2+');
      expect(container.textContent).toContain('Some context graphs couldn’t report their agents.');

      probes.participants.set('beta', { allowedAgents: [B] });
      await act(async () => { for (const h of probes.nodeEventHandlers) h({ type: 'project_synced', data: { contextGraphId: 'beta' } }); });
      await act(async () => {});
      expect(agentsValue()).toBe('2');
      expect(container.textContent).toContain('Agents with access to your context graphs.');
    });

    it('reads as a floor when a public graph’s membership can’t be counted', async () => {
      addGraph('alpha', {});
      addGraph('open', { accessPolicy: 'public' });
      probes.participants.set('alpha', { allowedAgents: [A] });
      probes.participants.set('open', { allowedAgents: [B] });
      await render();
      await act(async () => {});
      expect(agentsValue()).toBe('1+');
    });

    it('is exact when every graph reports', async () => {
      addGraph('alpha', {});
      addGraph('beta', {});
      probes.participants.set('alpha', { allowedAgents: [A] });
      probes.participants.set('beta', { allowedAgents: [A, B] });
      await render();
      await act(async () => {});
      expect(agentsValue()).toBe('2');
    });
  });
});
