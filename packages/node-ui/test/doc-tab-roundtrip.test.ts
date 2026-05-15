// @vitest-environment happy-dom
//
// Covers the imported-document viewer 404 fix (PR fix/doc-viewer-404):
//
//   1. `DocumentsList.handleOpenDoc` encodes the center-tab id as
//      `doc:<contextGraphId>|<fileRef>|<contentType>`, keeping the FULL
//      `urn:dkg:file:keccak256:<hex>` ref (no prefix loss).
//   2. The `doc:` decoder in `ViewContainer` splits on the first/last `|`
//      and hands `{ docRef, contentType }` to `DocumentViewer`.
//   3. `DocumentViewer` builds the request URL via `fileUrl()` so the
//      keccak256 prefix and `?contentType=` survive to the daemon, then
//      renders markdown formatted (MarkdownMessage) with a Raw toggle, and
//      shows a friendly empty state — never a 404 — when no source file is
//      linked.
//
// These assert the client-side encode/decode/URL contract, so `fetch` is
// stubbed to capture the request the component issues and return a
// controlled response (no backend; the daemon route is validated
// separately). All other collaborators — the real zustand tabs store, the
// real `fileUrl()`/`authHeaders()` helpers, the real components — run
// unmocked.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { useTabsStore } from '../src/ui/stores/tabs.js';
import {
  MARKDOWN_FORM,
  SOURCE_CONTENT_TYPE,
} from '../src/ui/views/project/helpers.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

const HEX = 'a'.repeat(64);
const FILE_REF = `urn:dkg:file:keccak256:${HEX}`;

function docEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    uri: 'urn:dkg:entity:doc-1',
    label: 'Quarterly Report.md',
    types: ['http://dkg.io/ontology/Document'],
    trustLevel: 'working',
    layers: new Set(['working']),
    subGraphs: new Set(['main']),
    properties: new Map([[SOURCE_CONTENT_TYPE, ['text/markdown']]]),
    connections: [
      { predicate: MARKDOWN_FORM, targetUri: FILE_REF, targetLabel: 'source.md' },
    ],
    ...overrides,
  };
}

function resetTabs() {
  useTabsStore.setState({
    tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }],
    activeTabId: 'dashboard',
  });
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

/**
 * Flush the DocumentViewer fetch chain. The effect does
 * `fetch().then(res => res.text()).then(setState)` — several microtask hops
 * plus the body promise — so a single `Promise.resolve()` is not enough.
 * Drain a handful of `act`-wrapped microtask turns; deterministic, no timers.
 */
async function flushAsync(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

async function mount(node: React.ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

// Records every fetch the component issues. `beforeEach` installs a default
// stub so EVERY test (incl. the DocumentsList encode tests that never fetch)
// runs against a clean, deterministic `globalThis.fetch` from the very first
// render — never an unstubbed or cross-file-contaminated global. vitest runs
// test files in parallel workers sharing one globalThis, and ~6 sibling
// suites also stub `fetch`; installing the stub in `beforeEach` (mirroring
// use-memory-entities-live-updates.test.ts) + `vi.unstubAllGlobals()` in
// `afterEach` is the proven isolation pattern in this package. Stubbing
// mid-test (after render) instead races React effects and flakes.
let fetchCalls: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Reconfigure the active fetch stub's response. Returns the live recorder. */
function stubFetch(body: string, contentType: string) {
  fetchMock.mockImplementation(async (input: any) => {
    fetchCalls.push(String(input));
    return new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    });
  });
  return { calls: fetchCalls, fn: fetchMock };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetTabs();
  fetchCalls = [];
  // Default: a 404 recorder. Tests that expect a successful body call
  // stubFetch() to override; tests asserting "no fetch" simply assert the
  // mock was never called (a leaked real fetch cannot satisfy that).
  fetchMock = vi.fn(async (input: any) => {
    fetchCalls.push(String(input));
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTabs();
});

describe('doc tab-id encode → decode round-trip', () => {
  it('encodes the full keccak256 ref + contentType, never a bare hex', async () => {
    const { DocumentsList } = await import('../src/ui/views/project/components.js');
    const { container, unmount } = await mount(
      React.createElement(DocumentsList, {
        entities: [docEntity()],
        contextGraphId: 'cg-1',
      }),
    );

    const row = container.querySelector('.v10-item-row') as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const tab = useTabsStore.getState().tabs.find(t => t.id.startsWith('doc:'));
    expect(tab).toBeTruthy();
    // Full ref preserved — keccak256 prefix intact, no bare hex.
    expect(tab!.id).toBe(`doc:cg-1|${FILE_REF}|text/markdown`);
    expect(tab!.id).toContain('keccak256:');

    await unmount();
  });

  it('survives a contextGraphId that itself contains colons and slashes', async () => {
    const { DocumentsList } = await import('../src/ui/views/project/components.js');
    const cg = 'urn:dkg:context:weird/id:with:colons';
    const { container, unmount } = await mount(
      React.createElement(DocumentsList, {
        entities: [docEntity()],
        contextGraphId: cg,
      }),
    );

    await act(async () => {
      (container.querySelector('.v10-item-row') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const id = useTabsStore.getState().tabs.find(t => t.id.startsWith('doc:'))!.id;
    expect(id).toBe(`doc:${cg}|${FILE_REF}|text/markdown`);

    // Decode the way ViewContainer does (first/last pipe) and confirm the
    // middle segment is the untouched full file ref even with separators in
    // the cgId.
    const raw = id.slice('doc:'.length);
    const firstPipe = raw.indexOf('|');
    const lastPipe = raw.lastIndexOf('|');
    expect(raw.slice(0, firstPipe)).toBe(cg);
    expect(raw.slice(firstPipe + 1, lastPipe)).toBe(FILE_REF);
    expect(raw.slice(lastPipe + 1)).toBe('text/markdown');

    await unmount();
  });

  it('falls back to the entity uri when no source file is linked', async () => {
    const { DocumentsList } = await import('../src/ui/views/project/components.js');
    const { container, unmount } = await mount(
      React.createElement(DocumentsList, {
        entities: [docEntity({ connections: [] })],
        contextGraphId: 'cg-1',
      }),
    );
    await act(async () => {
      (container.querySelector('.v10-item-row') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const id = useTabsStore.getState().tabs.find(t => t.id.startsWith('doc:'))!.id;
    expect(id).toBe('doc:cg-1|urn:dkg:entity:doc-1|text/markdown');
    expect(id).not.toContain('urn:dkg:file:');

    await unmount();
  });
});

describe('DocumentViewer URL construction via fileUrl()', () => {
  it('requests /api/file/keccak256:<hex>?contentType=text/markdown (prefix kept)', async () => {
    const { calls } = stubFetch('# Title\n\nBody text.', 'text/markdown');
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');

    useTabsStore.setState({
      tabs: [
        { id: 'dashboard', label: 'Dashboard', closable: false },
        { id: `doc:cg-1|${FILE_REF}|text/markdown`, label: 'Doc', closable: true },
      ],
      activeTabId: `doc:cg-1|${FILE_REF}|text/markdown`,
    });

    const { unmount } = await mount(React.createElement(PanelCenter));
    await flushAsync();

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(
      `/api/file/${encodeURIComponent(`keccak256:${HEX}`)}?contentType=${encodeURIComponent('text/markdown')}`,
    );
    // Crucially NOT a bare-hex sha256 path (the original 404 cause).
    expect(calls[0]).toContain('keccak256%3A');
    expect(calls[0]).not.toBe(`/api/file/${HEX}`);

    await unmount();
  });
});

describe('DocumentViewer markdown render + Formatted/Raw toggle', () => {
  async function openMarkdownDoc() {
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
    const tabId = `doc:cg-1|${FILE_REF}|text/markdown`;
    useTabsStore.setState({
      tabs: [
        { id: 'dashboard', label: 'Dashboard', closable: false },
        { id: tabId, label: 'Doc', closable: true },
      ],
      activeTabId: tabId,
    });
    const mounted = await mount(React.createElement(PanelCenter));
    await flushAsync();
    return mounted;
  }

  it('defaults to Formatted (MarkdownMessage) and toggles to Raw (<pre>)', async () => {
    stubFetch('# Heading One\n\nSome paragraph.', 'text/markdown');
    const { container, unmount } = await openMarkdownDoc();

    // Formatted by default: MarkdownMessage renders its .v10-md wrapper with
    // a real <h1>, and there is no raw <pre>.
    expect(container.querySelector('.v10-md')).toBeTruthy();
    expect(container.querySelector('.v10-md-h1')?.textContent).toContain('Heading One');
    expect(container.querySelector('pre')).toBeNull();

    // The toggle is offered for markdown.
    const rawBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent === 'Raw') as HTMLButtonElement;
    expect(rawBtn).toBeTruthy();

    await act(async () => {
      rawBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Raw: source text in a <pre>, no formatted markdown tree.
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toBe('# Heading One\n\nSome paragraph.');
    expect(container.querySelector('.v10-md')).toBeNull();

    await unmount();
  });

  it('shows the friendly empty state (no fetch) when no source file is linked', async () => {
    const { fn } = stubFetch('unused', 'text/markdown');
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
    // Missing-fileRef: handleOpenDoc encodes the entity uri in the fileRef
    // slot; that does not start with `urn:dkg:file:`.
    const tabId = 'doc:cg-1|urn:dkg:entity:doc-1|text/markdown';
    useTabsStore.setState({
      tabs: [
        { id: 'dashboard', label: 'Dashboard', closable: false },
        { id: tabId, label: 'Doc', closable: true },
      ],
      activeTabId: tabId,
    });

    const { container, unmount } = await mount(React.createElement(PanelCenter));
    await flushAsync();

    expect(container.textContent).toContain('Source file not available for this document');
    // No doomed request fired, and certainly no "Failed to load: HTTP 404".
    expect(fn).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Failed to load');

    await unmount();
  });
});

describe('legacy no-pipe doc: tab id (firstPipe < 0 fallback, contract 1b)', () => {
  // Pre-fix / persisted tab ids had no `|` delimiter (the old encoding was
  // `doc:<scope>:<hash>`). The decoder must still degrade gracefully:
  // docRef = the whole payload, contentType = ''. Both downstream outcomes
  // are exercised below.

  it('non-file legacy payload → docRef=raw, contentType="", empty state, no fetch', async () => {
    const { fn } = stubFetch('unused', 'text/markdown');
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
    // Realistic legacy shape: old `doc:<contextGraphId>:<barehex>` id with no
    // `|`. The payload is not a `urn:dkg:file:` ref, so the viewer shows the
    // friendly empty state instead of firing a doomed (404) request.
    const tabId = `doc:cg-1:${HEX}`;
    expect(tabId.includes('|')).toBe(false);
    useTabsStore.setState({
      tabs: [
        { id: 'dashboard', label: 'Dashboard', closable: false },
        { id: tabId, label: 'Legacy Doc', closable: true },
      ],
      activeTabId: tabId,
    });

    const { container, unmount } = await mount(React.createElement(PanelCenter));
    await flushAsync();

    // firstPipe < 0 ⇒ docRef = raw (`cg-1:<hex>`), contentType = ''. That raw
    // does not start with `urn:dkg:file:`, so: empty state, no request.
    expect(container.textContent).toContain('Source file not available for this document');
    expect(fn).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Failed to load');

    await unmount();
  });

  it('legacy payload that IS a file urn → fetches via fileUrl() with NO ?contentType=', async () => {
    const { calls } = stubFetch('# Legacy\n\nStored body.', 'text/markdown');
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
    // No `|` at all, and the whole payload is the full file ref. Decoder:
    // docRef = the file urn, contentType = '' (the firstPipe < 0 branch).
    const tabId = `doc:${FILE_REF}`;
    expect(tabId.includes('|')).toBe(false);
    useTabsStore.setState({
      tabs: [
        { id: 'dashboard', label: 'Dashboard', closable: false },
        { id: tabId, label: 'Legacy Doc', closable: true },
      ],
      activeTabId: tabId,
    });

    const { unmount } = await mount(React.createElement(PanelCenter));
    await flushAsync();

    // It fetches (raw IS a urn:dkg:file:), keccak256 prefix preserved, and
    // because contentType decoded to '' the hint query is omitted entirely.
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`/api/file/${encodeURIComponent(`keccak256:${HEX}`)}`);
    expect(calls[0]).not.toContain('?contentType=');
    expect(calls[0]).toContain('keccak256%3A');

    await unmount();
  });
});
