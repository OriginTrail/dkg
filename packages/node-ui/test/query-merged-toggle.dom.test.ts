// @vitest-environment happy-dom

// The query view's memory picker and "Search across assets" toggle: what
// each run asks the node for, how the answer says it searched, and what a
// refused search across assets tells the user.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { HttpError } from '../src/ui/http.js';

const { executeQueryMock, writeProfileQueryCatalogMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  writeProfileQueryCatalogMock: vi.fn(),
}));

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/ui/api.js');
  return { ...actual, executeQuery: executeQueryMock, writeProfileQueryCatalog: writeProfileQueryCatalogMock };
});

import { ContextGraphQueryView } from '../src/ui/views/project/components/query.js';
import { explainMergedRefusal, sameQueryRun, withSemantics } from '../src/ui/views/project/components/query-semantics.js';

const CG = '0x1111111111111111111111111111111111111111/merged-toggle';
let root: Root | null = null;

function bindings(semantics?: 'merged' | 'per-asset') {
  return { result: { type: 'bindings', bindings: [{ s: 'urn:a' }] }, ...(semantics ? { semantics } : {}) };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(ContextGraphQueryView, { contextGraphId: CG }));
  });
  await flush();
  return container;
}

function viewSelect(container: HTMLElement): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>('.v10-cg-query-options select')!;
}

function mergedBox(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.v10-cg-query-merged input')!;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

async function chooseView(container: HTMLElement, view: string): Promise<void> {
  await act(async () => {
    const select = viewSelect(container);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, view);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await flush();
}

async function typeInto(target: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, text);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The options of the last run the view asked the node for. */
function lastRun(): Record<string, unknown> {
  const calls = executeQueryMock.mock.calls;
  return { sparql: calls[calls.length - 1][0], ...calls[calls.length - 1][1] };
}

function resultCount(container: HTMLElement): string {
  return container.querySelector('.v10-mlv-result-count')?.textContent ?? '';
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  executeQueryMock.mockReset();
  writeProfileQueryCatalogMock.mockReset();
  executeQueryMock.mockResolvedValue(bindings('per-asset'));
  writeProfileQueryCatalogMock.mockResolvedValue({});
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
});

describe('ContextGraphQueryView memory picker and Search across assets', () => {
  it('searches across assets only in a memory, and says how the node searched it', async () => {
    const container = await render();
    expect(lastRun()).toMatchObject({ contextGraphId: CG, view: undefined, semantics: undefined });
    expect(viewSelect(container).value).toBe('');
    expect(mergedBox(container).disabled).toBe(true);
    expect(resultCount(container)).toBe('1 result');
    const options = container.querySelector<HTMLElement>('.v10-cg-query-options')!;
    expect(options.querySelector('label span')?.textContent).toBe('Search in');
    expect(Array.from(viewSelect(container).options).map(option => option.textContent)).toEqual(['All graphs', 'Published assets', 'Shared memory', 'Private drafts']);
    expect(options.querySelector('.v10-cg-query-merged span')?.textContent).toBe('Search across assets');
    const hint = document.getElementById(mergedBox(container).getAttribute('aria-describedby')!);
    expect(hint?.textContent).toBe('On: one query can link facts from different assets. Off: each asset is searched on its own.');
    expect(options.querySelector('.v10-cg-query-merged')?.getAttribute('title')).toBe('Choose a memory to search across its assets.');

    await chooseView(container, 'verifiable-memory');
    expect(mergedBox(container).disabled).toBe(false);
    await click(mergedBox(container));
    expect(mergedBox(container).checked).toBe(true);
    executeQueryMock.mockResolvedValue(bindings('merged'));
    await click(button(container, 'Run'));
    expect(lastRun()).toMatchObject({ contextGraphId: CG, view: 'verifiable-memory', semantics: 'merged' });
    expect(resultCount(container)).toBe('1 result · searched across assets');

    await click(mergedBox(container));
    executeQueryMock.mockResolvedValue(bindings('per-asset'));
    await click(button(container, 'Run'));
    expect(lastRun()).toMatchObject({ view: 'verifiable-memory', semantics: 'per-asset' });
    expect(resultCount(container)).toBe('1 result · each asset searched on its own');

    await click(mergedBox(container));
    await chooseView(container, '');
    expect(mergedBox(container).checked).toBe(false);
    expect(mergedBox(container).disabled).toBe(true);
    await click(button(container, 'Run'));
    expect(lastRun()).toMatchObject({ view: undefined, semantics: undefined });
  });

  it('says why a search across assets was refused, and passes other errors through', async () => {
    const container = await render();
    await chooseView(container, 'shared-working-memory');
    await click(mergedBox(container));

    executeQueryMock.mockRejectedValue(new HttpError(503, 'The view is not ready for a merged query', { code: 'VIEW_NOT_READY', retryable: true }));
    await click(button(container, 'Run'));
    expect(container.textContent).toContain('Search across assets is still getting ready for this memory. Try again shortly, or turn it off.');

    executeQueryMock.mockRejectedValue(new HttpError(400, 'semantics "merged" does not apply to a working-memory read by assertion name', { code: 'SEMANTICS_UNSUPPORTED' }));
    await click(button(container, 'Run'));
    expect(container.textContent).toContain('Search across assets doesn\'t apply to this query here (semantics "merged" does not apply to a working-memory read by assertion name). Turn it off to search each asset on its own.');

    executeQueryMock.mockRejectedValue(new HttpError(400, 'Parse error at line 1'));
    await click(button(container, 'Run'));
    expect(container.textContent).toContain('Parse error at line 1');
    expect(container.textContent).not.toContain('Turn it off');
  });

  it('fixes the memory while a loaded query is shown, and runs it with the toggle', async () => {
    const container = await render();
    await chooseView(container, 'verifiable-memory');
    await click(mergedBox(container));

    const graphs = container.querySelector<HTMLButtonElement>('button[aria-label^="Load query: Graphs"]')!;
    await click(graphs);
    expect(viewSelect(container).disabled).toBe(true);
    expect(viewSelect(container).value).toBe('');
    expect(lastRun()).toMatchObject({ view: undefined, semantics: undefined });

    const calls = executeQueryMock.mock.calls.length;
    await click(graphs);
    expect(executeQueryMock.mock.calls.length).toBe(calls + 1);
    await click(button(container, 'Run'));
    expect(executeQueryMock.mock.calls.length).toBe(calls + 2);
    expect(lastRun()).toMatchObject({ view: undefined, semantics: undefined });

    await typeInto(container.querySelector('textarea')!, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5');
    expect(viewSelect(container).disabled).toBe(false);
  });

  it('saves a query with the memory it runs in, and loads it back in that memory', async () => {
    const container = await render();
    await typeInto(container.querySelector('textarea')!, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5');
    await chooseView(container, 'shared-working-memory');
    await click(button(container, 'Save'));
    await typeInto(container.querySelector<HTMLInputElement>('.v10-cg-query-save-panel input')!, 'Shared subjects');
    await act(async () => {
      container.querySelector('form.v10-cg-query-save-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(writeProfileQueryCatalogMock).toHaveBeenCalledTimes(1);
    const quads = writeProfileQueryCatalogMock.mock.calls[0][1] as Array<{ predicate: string; object: string }>;
    expect(quads.find(quad => quad.predicate.endsWith('executionView'))?.object).toContain('shared-working-memory');
    expect(viewSelect(container).disabled).toBe(true);
    expect(viewSelect(container).value).toBe('shared-working-memory');

    await click(mergedBox(container));
    await click(container.querySelector<HTMLButtonElement>('button[aria-label^="Load query: Shared subjects"]')!);
    expect(lastRun()).toMatchObject({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5', view: 'shared-working-memory', semantics: 'merged' });

    // Edited, the saved query runs as ad-hoc SPARQL in all graphs, as the picker then shows.
    await typeInto(container.querySelector('textarea')!, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 6');
    expect(viewSelect(container).disabled).toBe(false);
    expect(viewSelect(container).value).toBe('');
    await click(button(container, 'Run'));
    expect(lastRun()).toMatchObject({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 6', view: undefined, semantics: undefined });
  });

  it('resets to the context graph query in all graphs', async () => {
    const container = await render();
    const first = executeQueryMock.mock.calls[0][0];
    await chooseView(container, 'working-memory');
    await click(button(container, 'Run'));
    expect(lastRun()).toMatchObject({ view: 'working-memory', semantics: 'per-asset', includeContextGraphPartitions: true });

    await click(button(container, 'Reset'));
    expect(viewSelect(container).value).toBe('');
    expect(lastRun()).toMatchObject({ sparql: first, view: undefined, semantics: undefined });

    const calls = executeQueryMock.mock.calls.length;
    await click(button(container, 'Reset'));
    expect(executeQueryMock.mock.calls.length).toBe(calls + 1);
  });
});

describe('query run helpers', () => {
  it('says how to search a run in a memory either way, and nothing for a run without one', () => {
    expect(withSemantics({ sparql: 'ASK {}' }, true)).toEqual({ sparql: 'ASK {}' });
    expect(withSemantics({ sparql: 'ASK {}' }, false)).toEqual({ sparql: 'ASK {}' });
    expect(withSemantics({ sparql: 'ASK {}', view: 'verifiable-memory' }, false)).toEqual({ sparql: 'ASK {}', view: 'verifiable-memory', semantics: 'per-asset' });
    expect(withSemantics({ sparql: 'ASK {}', view: 'verifiable-memory' }, true)).toEqual({ sparql: 'ASK {}', view: 'verifiable-memory', semantics: 'merged' });
  });

  it('tells runs apart by query, view, sub-graph and semantics', () => {
    const run = { sparql: 'ASK {}', view: 'verifiable-memory' as const };
    expect(sameQueryRun(run, { ...run })).toBe(true);
    expect(sameQueryRun(run, { ...run, semantics: 'merged' })).toBe(false);
    expect(sameQueryRun(run, { ...run, subGraphName: 'notes' })).toBe(false);
    expect(sameQueryRun(run, { sparql: 'ASK {}' })).toBe(false);
  });

  it('returns errors that are no merged refusal as they are', () => {
    const plain = new Error('offline');
    expect(explainMergedRefusal(plain)).toBe(plain);
    const other = new HttpError(503, 'busy', { code: 'STORE_INTERNAL_LIMIT' });
    expect(explainMergedRefusal(other)).toBe(other);
    expect(explainMergedRefusal('text')).toBe('text');
  });
});
