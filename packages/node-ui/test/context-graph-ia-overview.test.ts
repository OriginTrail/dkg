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

  it('closes the More menu on outside pointer input', async () => {
    const { container, root } = await render(
      React.createElement(LayerSwitcher, {
        active: 'overview',
        counts: baseMemory.counts,
        onSwitch: vi.fn(),
        onShare: vi.fn(),
        onImport: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    const more = container.querySelector<HTMLButtonElement>('.v10-layer-more-btn');
    await act(async () => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Query Catalogue');

    await act(async () => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('Query Catalogue');

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
    expect(container.textContent).toContain('Agents with access');
    expect(container.textContent).toContain('Knowledge Pipeline');
    expect(container.textContent).toContain('published assertion bundles become Knowledge Assets');
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

  it('keeps curator-owned membership role neutral while current-agent identity is loading', async () => {
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
        currentAgentStatus: 'loading',
      }),
    );

    expect(container.textContent).toContain('Role checking');
    expect(container.textContent).not.toContain('Joined');

    await act(async () => root.unmount());
  });

  it('does not show joined for curator-owned graphs when current-agent lookup fails', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-member-error',
          name: 'Member Graph',
          accessPolicy: 'private',
          curator: 'did:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: null,
        currentAgentStatus: 'error',
      }),
    );

    expect(container.textContent).toContain('Role unknown');
    expect(container.textContent).not.toContain('Joined');

    await act(async () => root.unmount());
  });

  it('uses caller involvement as the joined-role fallback when curator metadata is absent', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-member-no-curator',
          name: 'Member Graph',
          accessPolicy: 'private',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: null,
        currentAgentStatus: 'ok',
      }),
    );

    expect(container.textContent).toContain('Joined');
    expect(container.textContent).not.toContain('Role unknown');

    await act(async () => root.unmount());
  });

  it('uses participant membership as the joined-role fallback for older daemons', async () => {
    const agentAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-member-legacy',
          name: 'Member Graph',
          accessPolicy: 'private',
        },
        memory: baseMemory,
        participants: [agentAddress],
        currentAgent: {
          agentDid: `did:dkg:agent:${agentAddress}`,
          agentAddress,
        },
        currentAgentStatus: 'ok',
      }),
    );

    expect(container.textContent).toContain('Joined');
    expect(container.textContent).not.toContain('Role unknown');

    await act(async () => root.unmount());
  });

  it('does not use stale participant membership while participants are loading', async () => {
    const agentAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-member-loading',
          name: 'Member Graph',
          accessPolicy: 'private',
        },
        memory: baseMemory,
        participants: [agentAddress],
        participantsStatus: 'loading',
        currentAgent: {
          agentDid: `did:dkg:agent:${agentAddress}`,
          agentAddress,
        },
        currentAgentStatus: 'ok',
      }),
    );

    expect(container.textContent).toContain('Role unknown');
    expect(container.textContent).not.toContain('Joined');

    await act(async () => root.unmount());
  });

  it('summarizes public access without pretending the allowlist is an exact count', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-public-open',
          name: 'Open Graph',
          accessPolicy: 'public',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Public access');
    expect(container.textContent).toContain('Open');
    expect(container.textContent).not.toContain('Allowlisted agents');

    await act(async () => root.unmount());
  });

  it('labels public graph participant lists as known, not allowlisted', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-public-participants',
          name: 'Open Graph',
          accessPolicy: 'public',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: ['0x1234567890abcdef'],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Known participants');
    expect(container.textContent).not.toContain('Allowlisted participants');

    await act(async () => root.unmount());
  });

  it('does not present all-layer query failures as authoritative zero counts', async () => {
    const outageMemory = {
      ...baseMemory,
      counts: { wm: 0, swm: 0, vm: 0, total: 0 },
      layerStatus: { wm: 'error', swm: 'error', vm: 'error' },
      partial: false,
      error: null,
    };
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-outage',
          name: 'Outage Graph',
          accessPolicy: 'private',
          callerInvolved: false,
        },
        memory: outageMemory,
        participants: [],
        currentAgent: null,
      }),
    );

    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).toContain('Live memory counts are unavailable.');
    expect(container.textContent).not.toContain('Canonical current-layer entity counts.');

    await act(async () => root.unmount());
  });

  it('does not fold failed layer counts into pipeline percentages', async () => {
    const partialOutageMemory = {
      ...baseMemory,
      counts: { wm: 4, swm: 2, vm: 0, total: 6 },
      layerStatus: { wm: 'ok', swm: 'ok', vm: 'error' },
      partial: true,
      error: null,
    };
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-partial-outage',
          name: 'Partial Outage Graph',
          accessPolicy: 'private',
          callerInvolved: false,
        },
        memory: partialOutageMemory,
        participants: [],
        currentAgent: null,
      }),
    );

    expect(container.textContent).toContain('One or more layer counts are currently a lower bound.');
    expect(container.querySelector('.v10-po-pipeline-step.vm .v10-po-pipeline-step-count')?.textContent)
      .toBe('Unavailable');
    expect(container.querySelectorAll('.v10-po-pipeline-seg')).toHaveLength(0);
    expect(container.querySelector('.v10-po-pipeline-empty')).toBeTruthy();

    await act(async () => root.unmount());
  });

  it('does not turn participant fetch failures into exact access counts', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-private-error',
          name: 'Private Graph',
          accessPolicy: 'private',
          curator: 'did:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'error',
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Agents with access');
    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).not.toContain('Allowlisted agents');

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
