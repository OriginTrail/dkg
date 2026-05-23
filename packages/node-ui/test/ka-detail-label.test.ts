// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KADetailView, TrailEvent } from '../src/ui/views/project/components.js';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { AgentsContext, type AgentsData } from '../src/ui/hooks/useAgents.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: ProjectProfile = {
  contextGraphId: 'cg-test',
  displayName: 'Context Graph Test',
  primaryColor: '#64748b',
  accentColor: '#22c55e',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: () => undefined,
  forType: typeIri => ({
    typeIri,
    label: typeIri.split(/[/#]/).pop() ?? typeIri,
    color: '#64748b',
  }),
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

const agents: AgentsData = {
  agents: new Map(),
  list: [],
  loading: false,
  get: () => undefined,
  openAgent: vi.fn(),
};

const entity: MemoryEntity = {
  uri: 'urn:entity:working',
  label: 'Working entity',
  types: ['http://schema.org/Thing'],
  trustLevel: 'working',
  layers: new Set(['working']),
  subGraphs: new Set(),
  properties: new Map(),
  connections: [],
};

function query(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

describe('KADetailView navigation label', () => {
  let root: Root;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const container = query('#root');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders Back to Context Graph and calls onClose', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(AgentsContext.Provider, { value: agents },
            React.createElement(KADetailView, {
              entity,
              allEntities: new Map([[entity.uri, entity]]),
              allTriples: [],
              onNavigate: vi.fn(),
              onClose,
              contextGraphId: 'cg-test',
              onRefresh: vi.fn(),
            }))),
      );
    });

    const back = query('.v10-ka-back');
    expect(back.textContent).toContain('Back to Context Graph');
    expect(back.textContent).not.toContain('Back to Project');

    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders provenance timestamps in the event header without requiring an agent', async () => {
    const at = '2026-05-23T12:34:00.000Z';

    await act(async () => {
      root.render(React.createElement(TrailEvent, {
        toneClass: 'created',
        title: 'Created in Working Memory',
        actionWord: 'Created',
        agent: null,
        agentUri: null,
        at,
      }));
    });

    const timestamp = query('.v10-ka-event-time') as HTMLTimeElement;
    expect(timestamp.tagName).toBe('TIME');
    expect(timestamp.dateTime).toBe(at);
    expect(timestamp.textContent).toContain('2026');
    expect(document.querySelector('.v10-ka-event-attribution')).toBeNull();
  });

  it('omits provenance timestamp chrome when a lifecycle step has no timestamp', async () => {
    await act(async () => {
      root.render(React.createElement(TrailEvent, {
        toneClass: 'shared',
        title: 'Promoted to Shared Working Memory',
        actionWord: 'Promoted',
        agent: null,
        agentUri: null,
        at: null,
      }));
    });

    expect(document.querySelector('.v10-ka-event-time')).toBeNull();
    expect(query('.v10-ka-event-title').textContent).toContain('Promoted to Shared Working Memory');
  });
});
