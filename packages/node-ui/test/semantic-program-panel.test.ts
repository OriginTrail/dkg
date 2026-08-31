// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSemanticProgram, invokeSemanticProgram } = vi.hoisted(() => ({
  resolveSemanticProgram: vi.fn(),
  invokeSemanticProgram: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/api.js')>()),
  resolveSemanticProgram,
  invokeSemanticProgram,
}));

vi.mock('../src/ui/stores/layout.js', () => ({
  useLayoutStore: (selector: (state: { theme: 'dark' }) => unknown) => selector({ theme: 'dark' }),
}));

vi.mock('../src/ui/components/VerifiedIdentityBanner.js', () => ({
  VerifiedIdentityBanner: () => null,
}));

import { KADetailView } from '../src/ui/views/project/components.js';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { AgentsContext, type AgentsData } from '../src/ui/hooks/useAgents.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: ProjectProfile = {
  contextGraphId: 'devnet-test',
  displayName: 'Devnet',
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
  forType: (typeIri) => ({ typeIri, label: 'Program', color: '#64748b' }),
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
  uri: 'urn:sr:program:codex',
  label: 'Codex Program',
  types: ['https://origintrail.io/semantic-runtime/v1#Program'],
  trustLevel: 'verified',
  layers: new Set(['verified']),
  subGraphs: new Set(),
  properties: new Map(),
  connections: [],
};

describe('DKG-native semantic Program panel', () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.querySelector('#root')!);
    resolveSemanticProgram.mockResolvedValue({
      contextGraphId: 'devnet-test',
      programIri: entity.uri,
      executingNode: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      selectedPolicy: { iri: 'urn:sr:policy:codex', version: '1', hash: `sha256:${'11'.repeat(32)}` },
      requiredTools: [{
        toolIri: 'urn:sr:tool:investigator-v1',
        operation: 'agent/investigate',
        semanticVersion: '1',
        witInterface: 'origintrail:semantic-tools/investigator@1',
        requested: true,
        offered: true,
        policyAllowed: true,
        locallyInstalled: true,
        locallyEnabled: true,
        adapterVersion: '1',
        adapterHash: `sha256:${'22'.repeat(32)}`,
        effective: true,
        unavailableReason: null,
      }],
      previousExecutions: [],
      executable: true,
    });
    invokeSemanticProgram.mockResolvedValue({
      invocationId: '123e4567-e89b-42d3-a456-426614174000',
      executionIri: 'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
      executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
      persisted: true,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows effective operator authority and navigates only after persisted success', async () => {
    const onRefresh = vi.fn();
    const onNavigate = vi.fn();
    await act(async () => {
      root.render(React.createElement(ProjectProfileContext.Provider, { value: profile },
        React.createElement(AgentsContext.Provider, { value: agents },
          React.createElement(KADetailView, {
            entity,
            allEntities: new Map([[entity.uri, entity]]),
            allTriples: [],
            onNavigate,
            onClose: vi.fn(),
            contextGraphId: 'devnet-test',
            onRefresh,
          }))));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector('[data-testid="semantic-program-panel"]')?.textContent)
      .toContain('requested · offered · policy allowed · installed · enabled');
    const run = document.querySelector<HTMLButtonElement>('[data-testid="run-semantic-program"]')!;
    expect(run.disabled).toBe(false);
    await act(async () => {
      run.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invokeSemanticProgram).toHaveBeenCalledWith(
      'devnet-test',
      entity.uri,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(
      'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
    );
  });
});
