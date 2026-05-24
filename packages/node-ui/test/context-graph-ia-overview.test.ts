// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerSwitcher, ProjectOverviewCard } from '../src/ui/views/project/components.js';
import { ContextGraphPrimerView } from '../src/ui/views/ContextGraphPrimerView.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseMemory = {
  entities: new Map(),
  entityList: [],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 4, swm: 2, vm: 1, total: 7 },
  loading: false,
  error: null,
  partial: false,
  layerStatus: { wm: 'ok', swm: 'ok', vm: 'ok' },
  refresh: vi.fn(),
} as any;

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}

describe('Context Graph IA and Overview', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('orders and labels the Context Graph view switcher according to the pipeline IA', async () => {
    const onSwitch = vi.fn();
    const { container, root } = await render(
      React.createElement(LayerSwitcher, {
        active: 'overview',
        counts: baseMemory.counts,
        onSwitch,
        onShare: vi.fn(),
        onImport: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    const topLevelLabels = Array.from(container.querySelectorAll('.v10-layer-switcher > button, .v10-layer-more > button'))
      .map(button => button.getAttribute('aria-label'));

    expect(topLevelLabels).toEqual([
      'Overview',
      'Working Memory',
      'Shared Working Memory',
      'Verifiable Memory',
      'Subgraphs',
      'More Context Graph views',
    ]);
    expect(container.textContent).not.toContain('Graph Overview');
    expect(container.textContent).not.toContain('Shared Memory4');
    expect(container.textContent).not.toContain('Verified Memory');

    const more = container.querySelector<HTMLButtonElement>('.v10-layer-more-btn');
    expect(more).toBeTruthy();
    await act(async () => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Query Catalogue');
    const query = container.querySelector<HTMLButtonElement>('.v10-layer-more-item');
    await act(async () => {
      query!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSwitch).toHaveBeenCalledWith('query');

    await act(async () => root.unmount());
  });

  it('renders Overview as a summary with one clickable Knowledge Pipeline', async () => {
    const onSwitchLayer = vi.fn();
    const onOpenPrimer = vi.fn();
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-test',
          name: 'UI Rework',
          description: 'Context Graph UI test',
          accessPolicy: 'private',
          curator: 'did:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: ['0x1234567890abcdef', '0xabcdef1234567890'],
        currentAgent: { agentDid: 'did:dkg:agent:0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' },
        onSwitchLayer,
        onOpenPrimer,
      }),
    );

    expect(container.textContent).toContain('Curator');
    expect(container.textContent).toContain('Curated');
    expect(container.textContent).toContain('Knowledge Pipeline');
    expect(container.querySelector('.v10-memory-strip')).toBeNull();
    expect(container.querySelectorAll('.v10-po-pipeline-step')).toHaveLength(3);

    const labels = Array.from(container.querySelectorAll('.v10-po-pipeline-step-label'))
      .map(node => node.textContent);
    expect(labels).toEqual(['Working Memory', 'Shared Working Memory', 'Verifiable Memory']);

    const steps = Array.from(container.querySelectorAll<HTMLButtonElement>('.v10-po-pipeline-step'));
    for (const step of steps) {
      await act(async () => {
        step.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    expect(onSwitchLayer.mock.calls.map(call => call[0])).toEqual(['wm', 'swm', 'vm']);

    const primer = container.querySelector<HTMLButtonElement>('.v10-po-primer-link');
    await act(async () => {
      primer!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenPrimer).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('keeps Overview role/access badges honest when metadata is incomplete', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-public', name: 'Public Graph', accessPolicy: 'public' },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Role unknown');
    expect(container.textContent).toContain('Public');

    await act(async () => root.unmount());
  });

  it('does not downgrade an unresolved curator role to participant before identity is available', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-member',
          name: 'Member Graph',
          accessPolicy: 'private',
          curator: 'did:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: null,
      }),
    );

    expect(container.textContent).toContain('Role unknown');
    expect(container.textContent).not.toContain('Participant');

    await act(async () => root.unmount());
  });

  it('renders the linked Context Graph primer with the required concepts', async () => {
    const { container, root } = await render(React.createElement(ContextGraphPrimerView));

    for (const text of [
      'What is a Context Graph?',
      'Memory layers',
      'Subgraphs',
      'Entities and Knowledge Assets',
      'Assertions',
      'Roles',
      'Working Memory',
      'Shared Working Memory',
      'Verifiable Memory',
      'assertion/triple bundle is anchored as a Knowledge Asset',
      'included entities on-chain provenance',
    ]) {
      expect(container.textContent).toContain(text);
    }
    expect(container.textContent).not.toContain('entity is published to Verifiable Memory, it becomes a Knowledge Asset');

    await act(async () => root.unmount());
  });
});
