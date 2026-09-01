// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSemanticProgram, invokeSemanticProgram, forkSemanticProgram } = vi.hoisted(() => ({
  resolveSemanticProgram: vi.fn(),
  invokeSemanticProgram: vi.fn(),
  forkSemanticProgram: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/api.js')>()),
  resolveSemanticProgram,
  invokeSemanticProgram,
  forkSemanticProgram,
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
      programLayer: 'vm',
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
      executionLayer: 'wm',
      persisted: true,
    });
    forkSemanticProgram.mockResolvedValue({
      programIri: 'urn:sr:program:my-copy',
      programLayer: 'swm',
      authorAgentAddress: '0x3333333333333333333333333333333333333333',
      derivedFrom: entity.uri,
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
    expect(run.disabled).toBe(true);
    const executionLayer = document.querySelector<HTMLSelectElement>('[data-testid="semantic-execution-layer"]')!;
    await act(async () => {
      executionLayer.value = 'wm';
      executionLayer.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(run.disabled).toBe(false);
    await act(async () => {
      run.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invokeSemanticProgram).toHaveBeenCalledWith(
      'devnet-test',
      entity.uri,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'vm',
      'wm',
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(
      'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
      undefined,
      'wm',
    );
  });

  it('forks to a caller-selected IRI and navigates only after VM persistence', async () => {
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

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="fork-semantic-program"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const iri = document.querySelector<HTMLInputElement>('[data-testid="semantic-program-fork-iri"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        ?.call(iri, 'urn:sr:program:my-copy');
      iri.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const forkLayer = document.querySelector<HTMLSelectElement>('[data-testid="semantic-program-fork-layer"]')!;
    await act(async () => {
      forkLayer.value = 'swm';
      forkLayer.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="confirm-fork-semantic-program"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(forkSemanticProgram).toHaveBeenCalledWith(
      'devnet-test',
      entity.uri,
      'urn:sr:program:my-copy',
      'vm',
      'swm',
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith('urn:sr:program:my-copy', undefined, 'swm');
  });
});
