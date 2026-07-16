// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Codex bug L — the `'unknown'` branch of PendingJoinRequestsSection
// now optimistically fires `listJoinRequests`. Mock the API module so
// tests can drive the response (success / 401 / 403 / generic error).
const apiMock = vi.hoisted(() => ({
  listJoinRequests: vi.fn(async () => ({ requests: [] })),
  approveJoinRequest: vi.fn(async () => ({ ok: true })),
  rejectJoinRequest: vi.fn(async () => ({ ok: true })),
  HttpError: class HttpError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message?: string, body?: unknown) {
      super(message ?? `HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock('../src/ui/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    listJoinRequests: apiMock.listJoinRequests,
    approveJoinRequest: apiMock.approveJoinRequest,
    rejectJoinRequest: apiMock.rejectJoinRequest,
    HttpError: apiMock.HttpError,
  };
});

// SSE-driven auto-refresh path (`PendingJoinRequestsSection` now
// subscribes via `useNodeEvents`). Capture the registered handler
// so tests can drive a fake `join_request` event without standing
// up an EventSource.
const nodeEventsMock = vi.hoisted(() => {
  const handlers = new Set<(event: { type: string; data: Record<string, unknown> }) => void>();
  return {
    useNodeEvents: (handler: (event: { type: string; data: Record<string, unknown> }) => void) => {
      handlers.add(handler);
    },
    emit(event: { type: string; data: Record<string, unknown> }) {
      handlers.forEach(h => h(event));
    },
    reset() { handlers.clear(); },
  };
});
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({
  useNodeEvents: nodeEventsMock.useNodeEvents,
}));

import {
  LayerSwitcher,
  ProjectOverviewCard,
  OverviewPrimerEntry,
  PendingJoinRequestsSection,
  curatorStatusForOverview,
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
    // Reset the listJoinRequests mock back to a benign empty
    // response so tests that don't touch the join-requests path
    // don't trip Bug L's new optimistic fetch.
    apiMock.listJoinRequests.mockReset();
    apiMock.listJoinRequests.mockResolvedValue({ requests: [] });
    apiMock.approveJoinRequest.mockReset();
    apiMock.rejectJoinRequest.mockReset();
    nodeEventsMock.reset();
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
    // The legacy "Verifiable Memory" leak guard is moot post-#4 vocab
    // sweep — "Verifiable Memory" is now the canonical full-form
    // layer-switcher label and is intentionally rendered.

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
    // ui-lead item 3 — the section block carries an "At a glance"
    // title so it matches the structure of the other peer sections.
    const atAGlance = container.querySelector('[data-section="at-a-glance"]');
    expect(atAGlance).toBeTruthy();
    expect(atAGlance?.querySelector('.v10-po-section-title')?.textContent?.trim()).toBe('At a glance');
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
    // ui-lead item 2 — `you` / `curator` render as separate
    // `.v10-po-participant-tag` spans with a CSS `::before` `·`
    // separator; the DOM text reads the tag content only.
    expect(container.textContent).toContain('Participant agents');
    const participantRows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(participantRows).toHaveLength(2);
    const self = participantRows[0];
    expect(self.classList.contains('is-self')).toBe(true);
    expect(self.classList.contains('is-curator')).toBe(true);
    const selfTags = Array.from(self.querySelectorAll('.v10-po-participant-tag')).map(n => n.textContent);
    expect(selfTags).toEqual(['you', 'curator']);
    expect(self.getAttribute('aria-label')).toMatch(/ you curator$/);
    const other = participantRows[1];
    expect(other.classList.contains('is-self')).toBe(false);
    expect(other.classList.contains('is-curator')).toBe(false);
    expect(other.querySelectorAll('.v10-po-participant-tag')).toHaveLength(0);

    const primer = container.querySelector<HTMLButtonElement>('.v10-po-identity-primer');
    expect(primer).toBeTruthy();
    await act(async () => {
      primer!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenPrimer).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('always renders the curator row in Participant agents, even when `allowedAgents` omits them (Codex bug A)', async () => {
    const curatorAddress = '0xCAFE0000000000000000000000000000000000A1';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-curator-omitted',
          name: 'Curator Omitted',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${curatorAddress}`,
          callerInvolved: false,
        },
        memory: baseMemory,
        // `allowedAgents` from /participants does NOT contain the curator
        // on a normal private CG — Codex bug A pre-fix dropped the row.
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xDEADBEEF' },
      }),
    );

    const rows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(rows).toHaveLength(1);
    expect(rows[0].classList.contains('is-curator')).toBe(true);
    expect(Array.from(rows[0].querySelectorAll('.v10-po-participant-tag')).map(n => n.textContent))
      .toEqual(['curator']);

    await act(async () => root.unmount());
  });

  it('does NOT seed the curator row while participants are loading, even with a curator field set (Codex bug J)', async () => {
    const curatorAddress = '0xCAFE0000000000000000000000000000000000A4';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-loading-with-curator',
          name: 'Loading',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${curatorAddress}`,
        },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'loading',
        currentAgent: { agentDid: `did:dkg:agent:${curatorAddress}` },
      }),
    );

    // Loading copy renders; curator row does NOT (would imply a
    // complete roster while the allowlist is still resolving).
    expect(container.textContent).toContain('Loading participant agents');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('does NOT seed the curator row when participants errored, even with a curator field set (Codex bug J)', async () => {
    const curatorAddress = '0xCAFE0000000000000000000000000000000000A5';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-errored-with-curator',
          name: 'Errored',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${curatorAddress}`,
        },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'error',
        currentAgent: { agentDid: `did:dkg:agent:${curatorAddress}` },
      }),
    );

    expect(container.textContent).toContain('Participant list unavailable');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders the curator row in the bare-address shape, not the raw DID (Codex bug H)', async () => {
    const curatorAddress = '0x1234567890ABCDEF1234567890ABCDEF12345678';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-curator-display',
          name: 'Display',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${curatorAddress}`,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xDEADBEEF' },
      }),
    );

    const rows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(rows).toHaveLength(1);
    // Display reads in address shape (0x… …last4), NOT `did:dk…last4`.
    expect(rows[0].textContent).not.toContain('did:dk');
    expect(rows[0].textContent).toContain('0x1234');
    expect(rows[0].textContent).toContain('5678');
    // Hover title preserves the full DID for traceability.
    expect(rows[0].getAttribute('title')).toBe(`did:dkg:agent:${curatorAddress}`);

    await act(async () => root.unmount());
  });

  it('does not duplicate the curator row when `allowedAgents` already contains them (Codex bug A dedup)', async () => {
    const curatorAddress = '0xCAFE0000000000000000000000000000000000B2';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-curator-dup',
          name: 'Curator Already Allowed',
          accessPolicy: 'public',
          curator: `did:dkg:agent:${curatorAddress}`,
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [curatorAddress],
        currentAgent: { agentDid: 'did:dkg:agent:0xDEADBEEF' },
      }),
    );

    const rows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(rows).toHaveLength(1);
    expect(rows[0].classList.contains('is-curator')).toBe(true);

    await act(async () => root.unmount());
  });

  it('renders Triples as a lower bound when a layer query is partial (Codex bug B)', async () => {
    // GH #805 — Overview Triples now sums `useLayerTriples` per
    // layer; that hook SPO-deduplicates, so the fixture's 120
    // distinct rows must be uniquely-keyed (not 120 identical
    // copies of one triple) for the count to land at 120.
    const partialMemory = {
      ...baseMemory,
      counts: { wm: 4, swm: 2, vm: 0, total: 6 },
      layerStatus: { wm: 'ok', swm: 'ok', vm: 'error' },
      partial: true,
      allTriples: Array.from({ length: 120 }, (_, i) => ({ subject: `urn:s${i}`, predicate: 'p', object: `urn:o${i}`, layer: 'working' })),
      error: null,
    };
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-triples-partial', name: 'Partial', accessPolicy: 'public' },
        memory: partialMemory,
        subGraphCount: 1,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    const triplesCell = container.querySelector<HTMLElement>('[data-stat-id="triples"]');
    expect(triplesCell).toBeTruthy();
    expect(triplesCell!.querySelector('.v10-stat-strip-value')?.textContent?.trim())
      .toBe('120+');
    expect(triplesCell!.getAttribute('title'))
      .toBe('One or more layer triple counts are currently a lower bound.');

    await act(async () => root.unmount());
  });

  it('renders Triples as Unavailable when every layer query failed (Codex bug B all-error)', async () => {
    const outageMemory = {
      ...baseMemory,
      counts: { wm: 0, swm: 0, vm: 0, total: 0 },
      layerStatus: { wm: 'error', swm: 'error', vm: 'error' },
      partial: false,
      allTriples: [],
      error: null,
    };
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-triples-outage', name: 'Outage', accessPolicy: 'public' },
        memory: outageMemory,
        subGraphCount: 0,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    const triplesCell = container.querySelector<HTMLElement>('[data-stat-id="triples"]');
    expect(triplesCell?.querySelector('.v10-stat-strip-value')?.textContent?.trim())
      .toBe('Unavailable');
    expect(triplesCell?.getAttribute('title')).toBe('Live triple counts are unavailable.');

    await act(async () => root.unmount());
  });

  it('renders Subgraphs as Unavailable when subGraphFetchFailed is true (Codex bug D)', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-sg-failed', name: 'SG Failed', accessPolicy: 'public' },
        memory: baseMemory,
        subGraphCount: null,
        subGraphFetchFailed: true,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    const subgraphsCell = container.querySelector<HTMLElement>('[data-stat-id="subgraphs"]');
    expect(subgraphsCell?.querySelector('.v10-stat-strip-value')?.textContent?.trim())
      .toBe('Unavailable');
    expect(subgraphsCell?.getAttribute('title')).toBe('Sub-graph list is currently unavailable.');

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
    expect(Array.from(curatorRow.querySelectorAll('.v10-po-participant-tag')).map(n => n.textContent))
      .toEqual(['curator']);

    const selfRow = rows[1];
    expect(selfRow.classList.contains('is-self')).toBe(true);
    expect(selfRow.classList.contains('is-curator')).toBe(false);
    expect(Array.from(selfRow.querySelectorAll('.v10-po-participant-tag')).map(n => n.textContent))
      .toEqual(['you']);

    await act(async () => root.unmount());
  });

  it('shows a graceful Participant agents empty state when none are recorded on a curated CG', async () => {
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
    expect(container.textContent).not.toContain('public — anyone can subscribe');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders open-access copy on a public CG when allowedAgents is empty AND no curator (Codex bug E)', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-public-open', name: 'Open', accessPolicy: 'public' },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Participant agents');
    expect(container.textContent).toContain('This Context Graph is public — anyone can subscribe.');
    expect(container.textContent).not.toContain('No participant agents recorded yet.');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders the public-access copy on a public CG even when participantsStatus is "error" (Codex issue S)', async () => {
    // Access policy is local-only state from `cg.accessPolicy`;
    // it's known regardless of whether `/participants` succeeded.
    // The open-access copy must take precedence over the "list
    // unavailable" copy on a public CG.
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-public-errored', name: 'Open Errored', accessPolicy: 'public' },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'error',
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('This Context Graph is public — anyone can subscribe.');
    expect(container.textContent).not.toContain('Participant list unavailable.');
    expect(container.textContent).not.toContain('Loading participant agents');
    expect(container.querySelectorAll('.v10-po-participant')).toHaveLength(0);

    await act(async () => root.unmount());
  });

  it('renders the public-access copy on a public CG even when participantsStatus is "loading" (Codex issue S)', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-public-loading', name: 'Open Loading', accessPolicy: 'public' },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'loading',
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('This Context Graph is public — anyone can subscribe.');
    expect(container.textContent).not.toContain('Loading participant agents');
    expect(container.textContent).not.toContain('Participant list unavailable.');

    await act(async () => root.unmount());
  });

  it('renders the loading copy on a curated CG when participantsStatus is "loading" (Codex issue S — curated path unchanged)', async () => {
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: { id: 'cg-curated-loading', name: 'Curated Loading', accessPolicy: 'private' },
        memory: baseMemory,
        participants: [],
        participantsStatus: 'loading',
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    expect(container.textContent).toContain('Loading participant agents');
    expect(container.textContent).not.toContain('public — anyone can subscribe');
    expect(container.textContent).not.toContain('Participant list unavailable.');

    await act(async () => root.unmount());
  });

  it('still shows the curator row on a public CG that has a curator + empty allowedAgents (Codex bug E + A together)', async () => {
    const curatorAddress = '0xCAFE0000000000000000000000000000000000E5';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-public-with-curator',
          name: 'Open with curator',
          accessPolicy: 'public',
          curator: `did:dkg:agent:${curatorAddress}`,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      }),
    );

    // Curator row must still render (Bug A) — open-access copy is
    // the EMPTY-state, not a hard override.
    const rows = Array.from(container.querySelectorAll('.v10-po-participant'));
    expect(rows).toHaveLength(1);
    expect(rows[0].classList.contains('is-curator')).toBe(true);
    expect(container.textContent).not.toContain('public — anyone can subscribe');
    expect(container.textContent).not.toContain('No participant agents recorded yet.');

    await act(async () => root.unmount());
  });

  it('Overview sections render in the locked §4.2.1 order with stable `data-section` hooks', async () => {
    // The four card-internal sections (identity → at-a-glance →
    // pipeline → participants) live inside ProjectOverviewCard;
    // the next three (join-requests → activity → primer) are
    // siblings in ProjectView's Overview branch and verified
    // separately (PendingJoinRequestsSection + OverviewPrimerEntry
    // assertions below + the ProjectView mount order).
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-order',
          name: 'Order',
          accessPolicy: 'private',
          callerInvolved: false,
        },
        memory: baseMemory,
        subGraphCount: 1,
        participants: [],
        currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
        onSwitchLayer: vi.fn(),
        onOpenPrimer: vi.fn(),
      }),
    );

    const sections = Array.from(container.querySelectorAll('[data-section]'))
      .map(node => node.getAttribute('data-section'));
    expect(sections).toEqual([
      'identity',
      'at-a-glance',
      'pipeline',
      'participants',
    ]);

    await act(async () => root.unmount());
  });

  it('OverviewPrimerEntry tags itself with data-section="primer"', async () => {
    const { container, root } = await render(
      React.createElement(OverviewPrimerEntry, { onOpenPrimer: vi.fn() }),
    );
    expect(container.querySelector('[data-section="primer"]')).toBeTruthy();
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection tags itself with data-section="join-requests" when curatorStatus is "curator"', async () => {
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'curator' as const,
      }),
    );
    expect(container.querySelector('[data-section="join-requests"]')).toBeTruthy();
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection renders nothing when curatorStatus is "not-curator"', async () => {
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'not-curator' as const,
      }),
    );
    expect(container.querySelector('[data-section="join-requests"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection renders the verifying-access panel for curatorStatus "unknown" WITHOUT firing listJoinRequests (Codex bug N — reverts bug L)', async () => {
    // The daemon `/join-requests` route is NOT curator-gated
    // (cli/src/daemon/routes/context-graph.ts:898; agent.ts:13126
    // calls a raw SPARQL read with no caller auth). Firing it in
    // the 'unknown' state would leak pending-moderation metadata
    // to any caller whose `/api/agent/identity` is mid-resolution
    // or errored. Fail closed: render the quiet verifying panel,
    // skip the fetch.
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'unknown' as const,
      }),
    );
    const section = container.querySelector('[data-section="join-requests"]');
    expect(section).toBeTruthy();
    expect(section?.textContent).toContain('Verifying access');
    expect(container.querySelector('.v10-po-join-btn')).toBeNull();
    // Codex bug N regression — `listJoinRequests` MUST NOT fire.
    expect(apiMock.listJoinRequests).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection does not fire listJoinRequests for definitive non-curators (Codex bug N)', async () => {
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'not-curator' as const,
      }),
    );
    expect(container.querySelector('[data-section="join-requests"]')).toBeNull();
    expect(apiMock.listJoinRequests).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection fires listJoinRequests only when curatorStatus is positively "curator"', async () => {
    apiMock.listJoinRequests.mockResolvedValue({ requests: [] });
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'curator' as const,
      }),
    );
    expect(container.querySelector('[data-section="join-requests"]')).toBeTruthy();
    expect(apiMock.listJoinRequests).toHaveBeenCalledWith('cg-join');
    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection refetches when an SSE `join_request` event arrives for this CG', async () => {
    // Initial fetch returns an empty list (mount-time call).
    apiMock.listJoinRequests.mockResolvedValueOnce({ requests: [] });
    const { container, root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'curator' as const,
      }),
    );
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(1);
    // No row yet.
    expect(container.querySelector('.v10-po-join-item')).toBeNull();

    // Next fetch resolves with a row — simulating the daemon
    // having recorded a new join request just before the SSE
    // `join_request` event fires.
    apiMock.listJoinRequests.mockResolvedValueOnce({
      requests: [
        { agentAddress: '0xabc1230000000000000000000000000000000123', status: 'pending', name: 'Pending Bob' },
      ],
    });
    await act(async () => {
      nodeEventsMock.emit({ type: 'join_request', data: { contextGraphId: 'cg-join' } });
    });
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Pending Bob');

    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection ignores SSE `join_request` events scoped to a different CG', async () => {
    apiMock.listJoinRequests.mockResolvedValue({ requests: [] });
    const { root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'curator' as const,
      }),
    );
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(1);

    await act(async () => {
      nodeEventsMock.emit({ type: 'join_request', data: { contextGraphId: 'cg-other' } });
    });
    // Different CG — no refetch.
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('PendingJoinRequestsSection refetches on `join_approved` and `join_rejected` events too', async () => {
    apiMock.listJoinRequests.mockResolvedValue({ requests: [] });
    const { root } = await render(
      React.createElement(PendingJoinRequestsSection, {
        contextGraphId: 'cg-join',
        curatorStatus: 'curator' as const,
      }),
    );
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(1);

    await act(async () => {
      nodeEventsMock.emit({ type: 'join_approved', data: { contextGraphId: 'cg-join' } });
    });
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(2);

    await act(async () => {
      nodeEventsMock.emit({ type: 'join_rejected', data: { contextGraphId: 'cg-join' } });
    });
    expect(apiMock.listJoinRequests).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it('Overview role badge reads "Curator" when only agentAddress matches cg.curator (Codex issue P — shared predicate with curatorStatusForOverview)', async () => {
    const address = '0xcafe000000000000000000000000000000000a0e';
    const { container, root } = await render(
      React.createElement(ProjectOverviewCard, {
        cg: {
          id: 'cg-issue-p',
          name: 'Issue P',
          accessPolicy: 'private',
          curator: `did:dkg:agent:${address}`,
          callerInvolved: true,
        },
        memory: baseMemory,
        participants: [],
        currentAgent: { agentAddress: address } as any,
        currentAgentStatus: 'ok',
      }),
    );
    // Role badge must match `curatorStatusForOverview`'s verdict.
    // Pre-fix, this read 'Joined' (the role helper only matched
    // agentDid); the curator predicate now consults both.
    const roleBadge = container.querySelector('.v10-po-badge[data-role]');
    expect(roleBadge?.getAttribute('data-role')).toBe('curator');
    expect(roleBadge?.textContent?.trim()).toBe('Curator');
    expect(container.textContent).not.toContain('Joined');
    expect(container.textContent).not.toContain('Role unknown');
    await act(async () => root.unmount());
  });

  it('curatorStatusForOverview returns "curator" when only agentAddress is available and matches cg.curator (Codex bug G)', () => {
    const address = '0xcafe000000000000000000000000000000000a01';
    expect(curatorStatusForOverview({
      cg: { curator: `did:dkg:agent:${address}`, accessPolicy: 'private' },
      currentAgent: { agentAddress: address } as any,
      currentAgentStatus: 'ok',
    })).toBe('curator');
  });

  it('curatorStatusForOverview returns "curator" when agentAddress matches even on currentAgentStatus error (Codex bug G — fall-back identity)', () => {
    const address = '0xcafe000000000000000000000000000000000a02';
    // Real-world scenario: `/api/agent/identity` errored, but we still have a
    // cached `agentAddress` from a prior load. Should NOT fail closed.
    expect(curatorStatusForOverview({
      cg: { curator: `did:dkg:agent:${address}`, accessPolicy: 'private' },
      currentAgent: { agentAddress: address } as any,
      currentAgentStatus: 'error',
    })).toBe('curator');
  });

  it('curatorStatusForOverview tolerates case differences between curator DID and agentAddress (Codex bug G)', () => {
    // EVM addresses are case-insensitive; `canonicalAgentDid` already
    // lowercases bare EVM addresses, so this should equate.
    const upper = '0xCAFE000000000000000000000000000000000A03';
    const lower = '0xcafe000000000000000000000000000000000a03';
    expect(curatorStatusForOverview({
      cg: { curator: `did:dkg:agent:${upper}`, accessPolicy: 'private' },
      currentAgent: { agentAddress: lower } as any,
      currentAgentStatus: 'ok',
    })).toBe('curator');
  });

  it('curatorStatusForOverview returns "unknown" when curator is set but no identity material is present', () => {
    expect(curatorStatusForOverview({
      cg: { curator: 'did:dkg:agent:0xABC', accessPolicy: 'private' },
      currentAgent: null,
      currentAgentStatus: 'loading',
    })).toBe('unknown');

    expect(curatorStatusForOverview({
      cg: { curator: 'did:dkg:agent:0xABC', accessPolicy: 'private' },
      currentAgent: null,
      currentAgentStatus: 'error',
    })).toBe('unknown');
  });

  it('curatorStatusForOverview returns "unknown" when cg.curator is missing entirely (Codex bug I)', () => {
    // Older / partial CG payloads may omit `curator`. Returning
    // `'not-curator'` here hard-hides PendingJoinRequestsSection
    // from a real curator whose daemon simply didn't surface the
    // field; route through the `'unknown'` verifying-access state
    // instead. The eventual server-side authorisation in
    // /join-requests still gates real actions.
    expect(curatorStatusForOverview({
      cg: { accessPolicy: 'private' }, // no `curator` field
      currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      currentAgentStatus: 'ok',
    })).toBe('unknown');

    expect(curatorStatusForOverview({
      cg: { curator: '', accessPolicy: 'private' }, // empty string
      currentAgent: { agentDid: 'did:dkg:agent:0xdef' },
      currentAgentStatus: 'ok',
    })).toBe('unknown');
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

    // Each of the four cells is addressable via `[data-stat-id]`
    // and carries a non-empty `title`. The hint copy never leaks
    // into rendered text; `.v10-stat-strip-hint` is never rendered
    // (the inline-hint surface is intentionally unused by the
    // Overview — qa-engineer's defensive check).
    const ids = ['entities', 'triples', 'subgraphs', 'participants'] as const;
    for (const id of ids) {
      const cell = container.querySelector<HTMLElement>(`[data-stat-id="${id}"]`);
      expect(cell, `missing [data-stat-id="${id}"]`).toBeTruthy();
      expect(cell!.title?.trim().length ?? 0).toBeGreaterThan(0);
      expect(cell!.querySelector('.v10-stat-strip-hint')).toBeNull();
    }
    expect(container.textContent).not.toContain('Topical partitions inside this Context Graph.');
    expect(container.textContent).not.toContain('Canonical triple total across all layers.');
    expect(container.textContent).not.toContain('Canonical current-layer entity counts.');
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

    const subgraphsCell = container.querySelector<HTMLElement>('[data-stat-id="subgraphs"]');
    expect(subgraphsCell).toBeTruthy();
    // ui-lead review finding #4 — loading state collapses to '...'
    // (mono ellipsis convention used everywhere else in the file)
    // instead of 'Loading...'.
    expect(subgraphsCell!.querySelector('.v10-stat-strip-value')?.textContent?.trim())
      .toBe('...');

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
    // from the cell's attribute via the stable `[data-stat-id]`
    // hook (qa-engineer's selector convention). Defensive check
    // confirms no inline `.v10-stat-strip-hint` was rendered alongside.
    expect(container.textContent).toContain('Unavailable');
    const entitiesCell = container.querySelector<HTMLElement>('[data-stat-id="entities"]');
    expect(entitiesCell).toBeTruthy();
    expect(entitiesCell?.getAttribute('title')).toBe('Live memory counts are unavailable.');
    expect(entitiesCell?.querySelector('.v10-stat-strip-hint')).toBeNull();

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
    // Entities cell as a `title` tooltip via the stable
    // `[data-stat-id]` hook. Pipeline rendering assertions
    // unchanged.
    const entitiesCell = container.querySelector<HTMLElement>('[data-stat-id="entities"]');
    expect(entitiesCell).toBeTruthy();
    expect(entitiesCell?.getAttribute('title'))
      .toBe('One or more layer counts are currently a lower bound.');
    expect(entitiesCell?.querySelector('.v10-stat-strip-hint')).toBeNull();
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
