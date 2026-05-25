// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  writeProfileQueryCatalog: vi.fn(),
}));

vi.mock('../src/ui/api.js', () => ({
  listJoinRequests: vi.fn(async () => ({ requests: [] })),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
  listAssertions: vi.fn(),
  promoteAssertion: vi.fn(),
  publishSharedMemory: vi.fn(),
  executeQuery: apiMocks.executeQuery,
  writeProfileQueryCatalog: apiMocks.writeProfileQueryCatalog,
  fetchSubGraphs: vi.fn(async () => ({ subGraphs: [] })),
}));

const {
  ContextGraphQueryView,
} = await import('../src/ui/views/project/components.js');

const {
  ProjectProfileContext,
} = await import('../src/ui/hooks/useProjectProfile.js');

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    contextGraphId: 'cg-test',
    displayName: 'Test graph',
    primaryColor: '#a855f7',
    accentColor: '#22c55e',
    subGraphs: [],
    typeBindings: [],
    views: [],
    filterChips: [],
    queryCatalogs: [],
    savedQueries: [],
    loading: false,
    error: undefined,
    forSubGraph: (slug: string) => ({
      slug,
      displayName: slug === 'docs' ? 'Documents' : slug,
      color: '#38bdf8',
      rank: 1,
    }),
    forType: () => undefined,
    view: () => undefined,
    chipsFor: () => [],
    savedQueryCatalogsFor: () => [],
    savedQueriesFor: () => [],
    ...overrides,
  };
}

async function renderWithProfile(value: ProjectProfile): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(ProjectProfileContext.Provider, { value },
        React.createElement(ContextGraphQueryView, { contextGraphId: 'cg-test' }),
      ),
    );
  });

  return { container, root };
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if ((container.textContent ?? '').includes(text)) return;
    await act(async () => { await Promise.resolve(); });
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ContextGraphQueryView', () => {
  beforeEach(() => {
    apiMocks.executeQuery.mockResolvedValue({ result: { bindings: [] } });
    apiMocks.writeProfileQueryCatalog.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('frames the page as a catalogue first and editor second', async () => {
    const { container, root } = await renderWithProfile(profile());

    await waitForText(container, 'Query Catalogue');

    const buttonLabels = Array.from(container.querySelectorAll('button'))
      .map(button => button.textContent?.trim())
      .filter(Boolean);

    expect(container.querySelector('h2.v10-mlv-title')?.textContent).toBe('Query Catalogue');
    expect(container.querySelector('#query-catalogue-saved-title')?.textContent).toBe('Choose a query');
    expect(container.querySelector('#query-catalogue-editor-title')?.textContent).toBe('Editor and results');
    expect(container.querySelector('textarea')).toBeTruthy();
    expect(buttonLabels.some(label => label?.startsWith('All triples'))).toBe(true);
    expect(buttonLabels.some(label => label?.startsWith('Graphs'))).toBe(true);
    expect(buttonLabels.some(label => label?.startsWith('Types'))).toBe(true);
    expect(buttonLabels).toEqual(expect.arrayContaining(['Run', 'Save', 'Reset']));
    expect(container.textContent).toContain('Reusable SPARQL for this Context Graph');
    expect(container.textContent).toContain('Load a preset or saved query into the editor below.');
    expect(container.textContent).toContain('Built-in presets');
    expect(container.textContent).not.toContain('Catalogue scope');
    expect(container.textContent).not.toContain('Built-in context queries');

    await act(async () => { root.unmount(); });
  });

  it('groups saved queries and loads the selected query into the editor', async () => {
    const savedProfile = profile({
      queryCatalogs: [{
        slug: 'ui-saved-queries',
        subGraph: '__context_graph',
        name: 'Old saved-query title',
        description: 'Queries saved from the Query tab.',
        rank: 1,
        queries: [{
          slug: 'entity-counts',
          subGraph: '__context_graph',
          catalogSlug: 'ui-saved-queries',
          catalogName: 'Old saved-query title',
          catalogDescription: 'Queries saved from the Query tab.',
          catalogRank: 1,
          name: 'Entity counts',
          description: 'Count reusable context entities with a long enough description to need a tooltip.',
          sparql: 'SELECT (COUNT(?s) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } }',
          resultColumn: 'count',
          rank: 1,
        }],
      }, {
        slug: 'personal',
        subGraph: '__context_graph',
        name: 'Personal research',
        description: 'Custom context-level query set.',
        rank: 2,
        queries: [{
          slug: 'named-entities',
          subGraph: '__context_graph',
          catalogSlug: 'personal',
          catalogName: 'Personal research',
          catalogDescription: 'Custom context-level query set.',
          catalogRank: 2,
          name: 'Named entities',
          description: 'Find entities that have names.',
          sparql: 'SELECT ?s ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }',
          resultColumn: 's',
          rank: 1,
        }],
      }, {
        slug: 'research',
        subGraph: 'docs',
        name: 'Document research',
        description: 'Queries for document-backed entities.',
        rank: 1,
        queries: [{
          slug: 'find-documents',
          subGraph: 'docs',
          catalogSlug: 'research',
          catalogName: 'Document research',
          catalogDescription: 'Queries for document-backed entities.',
          catalogRank: 1,
          name: 'Find documents',
          description: 'List markdown-backed document entities.',
          sparql: 'SELECT ?doc WHERE { GRAPH ?g { ?doc <http://schema.org/name> ?name } } LIMIT 5',
          resultColumn: 'doc',
          rank: 1,
        }],
      }],
    });
    const { container, root } = await renderWithProfile(savedProfile);

    await waitForText(container, 'Saved queries');
    expect(container.textContent).toContain('User-created SPARQL saved in this node profile for this Context Graph.');
    expect(container.textContent).not.toContain('Queries saved from the Query tab.');
    expect(container.textContent).not.toContain('Profile-saved queries');
    expect(container.textContent).toContain('Personal research');
    expect(container.textContent).toContain('Custom context-level query set.');
    expect(container.textContent).toContain('Preset');
    expect(container.textContent).toContain('Saved');
    await waitForText(container, 'Documents: Document research');
    expect(container.textContent).toContain('Subgraph');
    expect(container.textContent).toContain('Queries for document-backed entities.');
    expect(container.textContent).toContain('List markdown-backed document entities.');

    const entityCountsButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Entity counts'));
    expect(entityCountsButton?.getAttribute('title')).toBe('Entity counts. Count reusable context entities with a long enough description to need a tooltip.');
    expect(entityCountsButton?.getAttribute('aria-label')).toBe('Load query: Entity counts. Count reusable context entities with a long enough description to need a tooltip.');

    const findButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Find documents'));
    expect(findButton).toBeTruthy();

    await act(async () => {
      findButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('schema.org/name');

    await act(async () => { root.unmount(); });
  });

  it('shows profile loading and saved-query empty catalogue states', async () => {
    const { container, root } = await renderWithProfile(profile({ loading: true }));

    await waitForText(container, 'Loading saved queries...');
    expect(container.textContent).toContain('All triples');
    expect(container.textContent).not.toContain('No saved queries yet.');

    await act(async () => { root.unmount(); });
    document.body.innerHTML = '';

    const emptyRender = await renderWithProfile(profile());
    const { container: emptyContainer, root: emptyRoot } = emptyRender;
    expect(emptyContainer.textContent).toContain('No saved queries yet.');

    await act(async () => { emptyRoot.unmount(); });
  });

  it('shows profile errors without also implying an empty catalogue', async () => {
    const { container, root } = await renderWithProfile(profile({ error: 'Profile query failed' }));

    await waitForText(container, 'Saved query catalogue unavailable');

    expect(container.textContent).toContain('Profile query failed');
    expect(container.textContent).toContain('All triples');
    expect(container.textContent).not.toContain('No saved queries yet.');

    await act(async () => { root.unmount(); });
  });

  it('saves the draft query into the local catalogue', async () => {
    const { container, root } = await renderWithProfile(profile({
      queryCatalogs: [{
        slug: 'ui-saved-queries',
        subGraph: '__context_graph',
        name: 'Saved queries',
        description: 'User-created SPARQL saved in this node profile for this Context Graph.',
        rank: 50,
        queries: [{
          slug: 'existing-query',
          subGraph: '__context_graph',
          catalogSlug: 'ui-saved-queries',
          catalogName: 'Saved queries',
          catalogDescription: 'User-created SPARQL saved in this node profile for this Context Graph.',
          catalogRank: 50,
          name: 'Existing saved query',
          description: 'Already persisted.',
          sparql: 'SELECT ?type WHERE { GRAPH ?g { ?s a ?type } }',
          resultColumn: 'type',
          rank: 1,
        }],
      }],
    }));

    await waitForText(container, 'Query Catalogue');

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setFieldValue(textarea, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 10');
    });

    const saveButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save');
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector('input[placeholder="Query name"]') as HTMLInputElement;
    const descriptionInput = container.querySelector('input[placeholder="Optional"]') as HTMLInputElement;
    await act(async () => {
      setFieldValue(nameInput, 'Reusable triples');
      setFieldValue(descriptionInput, 'A reusable triples query.');
    });

    const submitButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save query');
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForText(container, 'Saved to catalogue.');
    expect(apiMocks.writeProfileQueryCatalog).toHaveBeenCalledWith('cg-test', expect.any(Array));
    const savedHeadings = Array.from(container.querySelectorAll('h4'))
      .filter(heading => heading.textContent === 'Saved queries');
    expect(savedHeadings).toHaveLength(1);
    expect(container.textContent).toContain('Existing saved query');
    expect(container.textContent).toContain('Reusable triples');
    expect(container.textContent).toContain('A reusable triples query.');

    apiMocks.executeQuery.mockRejectedValueOnce(new Error('HTTP 400'));
    await act(async () => {
      setFieldValue(textarea, 'SELECT ?broken WHERE { ?broken ?p }');
    });
    const runButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Run');
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForText(container, 'Query could not run.');
    expect(container.textContent).not.toContain('Saved to catalogue.');

    await act(async () => { root.unmount(); });
  });

  it('keeps local saves visible while profile queries are loading', async () => {
    const { container, root } = await renderWithProfile(profile({ loading: true }));

    await waitForText(container, 'Loading saved queries...');

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setFieldValue(textarea, 'SELECT ?entity WHERE { ?entity ?p ?o } LIMIT 5');
    });

    const saveButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save');
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector('input[placeholder="Query name"]') as HTMLInputElement;
    const descriptionInput = container.querySelector('input[placeholder="Optional"]') as HTMLInputElement;
    await act(async () => {
      setFieldValue(nameInput, 'Loading-safe query');
      setFieldValue(descriptionInput, 'Visible before profile data returns.');
    });

    const submitButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Save query');
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForText(container, 'Saved to catalogue.');
    expect(container.textContent).toContain('All triples');
    expect(container.textContent).toContain('Loading-safe query');
    expect(container.textContent).toContain('Visible before profile data returns.');

    await act(async () => { root.unmount(); });
  });

  it('renders query failures as a friendly EmptyState', async () => {
    apiMocks.executeQuery.mockRejectedValueOnce(new Error('HTTP 500'));
    const { container, root } = await renderWithProfile(profile());

    await waitForText(container, 'Query could not run.');

    expect(container.textContent).toContain('Review the query or node response details, then try again.');
    expect(container.textContent).toContain('HTTP 500');

    await act(async () => { root.unmount(); });
  });
});
