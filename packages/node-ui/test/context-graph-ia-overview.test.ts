// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LayerSwitcher,
  ProjectOverviewCard,
  OverviewPrimerEntry,
} from '../src/ui/views/project/components.js';
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
        subGraphCount: 3,
        participants: [
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          '0x1234567890abcdef1234567890abcdef12345678',
        ],
        currentAgent: { agentDid: 'did:dkg:agent:0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' },
        onSwitchLayer,
        onOpenPrimer,
      }),
    );

    // Identity row (S2 finalize §4.2.1) — label-pill pairs in
    // locked order: role first, then CG-type. The role glyph (◆) is
    // applied in CSS via `data-role`, NOT in the data string.
    const pairs = Array.from(container.querySelectorAll('.v10-po-identity-pair'));
    expect(pairs).toHaveLength(2);
    const roleLabel = pairs[0].querySelector('.v10-po-identity-label');
    const roleBadge = pairs[0].querySelector('.v10-po-badge');
    expect(roleLabel?.textContent?.trim()).toBe('Your role:');
    expect(roleBadge?.textContent?.trim()).toBe('Curator');
    expect(roleBadge?.getAttribute('data-role')).toBe('curator');
    const typeLabel = pairs[1].querySelector('.v10-po-identity-label');
    const typeBadge = pairs[1].querySelector('.v10-po-badge');
    expect(typeLabel?.textContent?.trim()).toBe('Context Graph:');
    expect(typeBadge?.textContent?.trim()).toBe('Curated');
    expect(typeBadge?.getAttribute('data-cg-type')).toBe('curated');
    expect(container.textContent).toContain('Agents with access');

    // At a glance — 4 stats (§4.2.1): Entities · Triples · Subgraphs
    // · Agents with access. Subgraph count is passed in by ProjectView.
    const statLabels = Array.from(container.querySelectorAll('.v10-stat-strip-label'))
      .map(node => node.textContent?.trim());
    expect(statLabels).toEqual(['Entities', 'Triples', 'Subgraphs', 'Agents with access']);

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

    // Participant agents section (§4.2.1) — heading uniform across
    // access policy. Self row carries ` · you · curator` suffix +
    // `.is-self.is-curator` for the CSS-driven ◆ glyph; the other
    // row stays bare with the default ◯ glyph supplied by CSS.
    expect(container.textContent).toContain('Participant agents');
    const participantRows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(participantRows).toHaveLength(2);
    const self = participantRows[0];
    expect(self.classList.contains('is-self')).toBe(true);
    expect(self.classList.contains('is-curator')).toBe(true);
    expect(self.textContent).toContain(' · you · curator');
    expect(self.textContent).not.toContain('(you');
    const other = participantRows[1];
    expect(other.classList.contains('is-self')).toBe(false);
    expect(other.classList.contains('is-curator')).toBe(false);
    expect(other.textContent).not.toContain(' · you');
    expect(other.textContent).not.toContain(' · curator');

    const primer = container.querySelector<HTMLButtonElement>('.v10-po-identity-primer');
    expect(primer).toBeTruthy();
    await act(async () => {
      primer!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenPrimer).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('marks a non-self curator with the curator suffix only — no `you` leakage', async () => {
    const curatorAddress = '0xCAFE000000000000000000000000000000000001';
    const otherAddress = '0xCAFE000000000000000000000000000000000002';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-other-curator',
          name: 'Other Curator Graph',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${curatorAddress}`,
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [curatorAddress, otherAddress],
        currentAgent: { agentDid: `did:dkg:agent:${otherAddress}`, agentAddress: otherAddress },
      }),
    );

    const rows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(rows).toHaveLength(2);

    const curatorRow = rows[0];
    expect(curatorRow.classList.contains('is-curator')).toBe(true);
    expect(curatorRow.classList.contains('is-self')).toBe(false);
    expect(curatorRow.textContent).toContain(' · curator');
    expect(curatorRow.textContent).not.toContain(' · you');

    const selfRow = rows[1];
    expect(selfRow.classList.contains('is-self')).toBe(true);
    expect(selfRow.classList.contains('is-curator')).toBe(false);
    expect(selfRow.textContent).toContain(' · you');
    expect(selfRow.textContent).not.toContain(' · curator');

    await act(async () => root.unmount());
  });

  it('shows a graceful Participant agents empty state when none are recorded', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-empty', name: 'Empty', accessPolicy: 'private' },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Participant agents');
    expect(container.textContent).toContain('No participant agents recorded yet.');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders At a glance status hints as title tooltips, not inline (§4.2.1 Delta 2)', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-tooltip', name: 'Tooltip', accessPolicy: 'public', callerInvolved: true },
        memory: baseMemory,
        subGraphCount: 2,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    const cells = Array.from(container.querySelectorAll<HTMLElement>('.v10-stat-strip-cell'));
    expect(cells).toHaveLength(4);

    // Every cell carries a non-empty `title` attribute. None of the
    // hint strings should appear in the rendered textContent — they
    // belong to the tooltip surface only.
    for (const cell of cells) {
      expect(cell.title?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(container.textContent).not.toContain('Topical partitions inside this Context Graph.');
    expect(container.textContent).not.toContain('Canonical triple total across all layers.');
    expect(container.textContent).not.toContain('Canonical current-layer entity counts.');

    // No inline `v10-stat-strip-hint` text leak (the prop is unused
    // by the Overview).
    expect(container.querySelectorAll('.v10-stat-strip-hint')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders an unknown subgraph count while subGraphCount is loading', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-loading-sg', name: 'Loading', accessPolicy: 'private' },
        memory: baseMemory,
        // subGraphCount intentionally omitted — caller has not resolved yet.
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    const cells = Array.from(container.querySelectorAll('.v10-stat-strip-cell'));
    const subgraphsCell = cells.find(cell =>
      cell.querySelector('.v10-stat-strip-label')?.textContent?.trim() === 'Subgraphs',
    );
    expect(subgraphsCell).toBeTruthy();
    expect(subgraphsCell!.querySelector('.v10-stat-strip-value')?.textContent?.trim())
      .toBe('Loading...');

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

  it('renders the participants section under the canonical "Participant agents" heading regardless of access policy', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-public-participants',
          name: 'Open Graph',
          accessPolicy: 'public',
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: ['0x1234567890abcdef1234567890abcdef12345678'],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    // S2 finalize §4.2.1 — the section is "Participant agents"
    // everywhere. Public-vs-curated semantics live on the CG-type
    // badge and the access stat hint, not the participants heading.
    expect(container.textContent).toContain('Participant agents');
    expect(container.textContent).not.toContain('Known participants');
    expect(container.textContent).not.toContain('Allowlisted participants');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(1);

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

    // §4.2.1 Delta 2 — the M6 status sentence now lives on the
    // Entities cell as a `title` tooltip, not inline text. Read it
    // from the cell's attribute, not from container.textContent.
    expect(container.textContent).toContain('Unavailable');
    const entitiesCell = Array.from(container.querySelectorAll('.v10-stat-strip-cell'))
      .find(cell => cell.querySelector('.v10-stat-strip-label')?.textContent?.trim() === 'Entities');
    expect(entitiesCell?.getAttribute('title')).toBe('Live memory counts are unavailable.');
    expect(entitiesCell?.getAttribute('title')).not.toBe('Canonical current-layer entity counts.');

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

    // §4.2.1 Delta 2 — the partial-bound hint now lives on the
    // Entities cell as a `title` tooltip; the pipeline rendering
    // assertions are unchanged.
    const entitiesCell = Array.from(container.querySelectorAll('.v10-stat-strip-cell'))
      .find(cell => cell.querySelector('.v10-stat-strip-label')?.textContent?.trim() === 'Entities');
    expect(entitiesCell?.getAttribute('title'))
      .toBe('One or more layer counts are currently a lower bound.');
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

  it('renders the OverviewPrimerEntry footer with locked copy + clickable primer link', async () => {
    const onOpenPrimer = vi.fn();
    const { container, root } = await render(
      React.createElement(OverviewPrimerEntry, { onOpenPrimer }),
    );

    const footer = container.querySelector('.v10-po-primer-footer');
    expect(footer).toBeTruthy();
    expect(footer!.textContent).toContain('New here?');
    expect(footer!.textContent).toContain('What is a Context Graph?');
    expect(footer!.textContent).toContain('A short primer on context graphs, the WM → SWM → VM pipeline');

    const link = container.querySelector<HTMLButtonElement>('.v10-po-primer-footer-link');
    expect(link).toBeTruthy();
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenPrimer).toHaveBeenCalledTimes(1);

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
