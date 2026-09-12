// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryReceipt,
  MemorySettings,
  type MemoryData,
  type MemoryRecord,
} from '../src/ui/codex/MemoryPanel.js';
import { CodexView } from '../src/ui/codex/CodexView.js';

let root: Root | undefined;
let container: HTMLDivElement;

async function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

const storedRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'record-1',
  role: 'assistant',
  status: 'stored',
  contextGraphId: 'private-conversations',
  surface: 'dkg',
  createdAt: '2026-09-08T12:00:00.000Z',
  entityUri: 'urn:dkg:message:1',
  assertionName: 'message-1',
  stats: {
    newEntities: 3,
    messageEntities: 1,
    conversationEntities: 1,
    traceEntities: 1,
    existingEntitiesConnected: 2,
    evidenceEntitiesConnected: 1,
    triples: 12,
    assets: { WM: 1, SWM: 0, VM: 0 },
  },
  recall: {
    status: 'ok',
    hits: [{
      entityUri: 'urn:dkg:evidence:1',
      contextGraphId: 'research',
      layer: 'VM',
      text: 'Relevant evidence',
      matchedKeywords: ['relevant'],
    }],
    searched: [{ contextGraphId: 'research', layer: 'VM' }],
    errors: ['one graph was unavailable'],
    durationMs: 17,
    contextChars: 120,
  },
  trace: [{ label: 'Read graph', status: 'completed' }],
  ...overrides,
});

describe('Codex memory UI', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a stored receipt with graph counts, evidence, and the action trace', async () => {
    await render(React.createElement(MemoryReceipt, { record: storedRecord() }));

    expect(container.textContent).toContain('+3 entities · 2 existing linked · 1 WM asset');
    expect(container.textContent).toContain('1 recalled');
    expect(container.textContent).toContain('12 triples in this message asset');
    expect(container.textContent).toContain('urn:dkg:message:1');
    expect(container.textContent).toContain('research · VM');
    expect(container.textContent).toContain('Matched: relevant');
    expect(container.textContent).toContain('one graph was unavailable');
    expect(container.textContent).toContain('Read graph · completed');
    expect(container.textContent).toContain('Reply → private Working Memory (stored)');
  });

  it('renders a pending receipt without invented stored counts or evidence', async () => {
    await render(React.createElement(MemoryReceipt, { record: storedRecord({
      role: 'user',
      status: 'pending',
      stats: undefined,
      entityUri: undefined,
      assertionName: undefined,
      error: 'DKG is unavailable',
      recall: { status: 'failed', hits: [], searched: [], errors: [], durationMs: 4 },
      trace: undefined,
    }) }));

    expect(container.textContent).toContain('Private memory queued · not yet stored in DKG');
    expect(container.textContent).toContain('No relevant evidence was supplied.');
    expect(container.textContent).toContain('DKG is unavailable. The local queue retries automatically.');
    expect(container.textContent).toContain('Action trace · 0 tools');
    expect(container.textContent).not.toContain('Reply → private Working Memory');
  });

  it('hides settings until the bridge supplies them', async () => {
    await render(React.createElement(MemorySettings, { data: { settings: null, records: [] }, save: vi.fn(), retry: vi.fn() }));
    expect(container.innerHTML).toBe('');
  });

  it('saves toggles and search scope, retries queued records, and lists native captures', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn().mockResolvedValue(undefined);
    const data: MemoryData = {
      settings: {
        contextGraphId: 'private-conversations',
        dkgCapture: true,
        dkgRecall: true,
        nativeCapture: false,
        nativeRecall: false,
        searchLocalGraphs: true,
        extraGraphIds: ['existing'],
      },
      records: [storedRecord({ id: 'pending', status: 'pending' })],
      recentNative: [storedRecord({ id: 'native', role: 'user', surface: 'native' })],
    };
    await render(React.createElement(MemorySettings, { data, save, retry }));

    expect(container.textContent).toContain('1 queued');
    expect(container.textContent).toContain('Latest native Codex captures');
    const dkgCapture = container.querySelector('input[aria-label="dkg Capture"]') as HTMLInputElement;
    await act(async () => dkgCapture.click());
    expect(save).toHaveBeenCalledWith({ dkgCapture: false });

    const localGraphs = [...container.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.parentElement?.textContent?.includes('Search other joined')) as HTMLInputElement;
    await act(async () => localGraphs.click());
    expect(save).toHaveBeenCalledWith({ searchLocalGraphs: false });

    const scope = container.querySelector('textarea[aria-label="Additional memory graph IDs"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(scope, 'alpha\n\n beta ');
      scope.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveScope = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save search scope')!;
    await act(async () => saveScope.click());
    expect(save).toHaveBeenCalledWith({ extraGraphIds: ['alpha', 'beta'] });

    const retryButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry 1 queued'))!;
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('surfaces save and retry failures without leaving controls busy', async () => {
    const save = vi.fn().mockRejectedValue(new Error('settings rejected'));
    const retry = vi.fn().mockRejectedValue(new Error('retry rejected'));
    const data: MemoryData = {
      settings: {
        contextGraphId: 'private-conversations',
        dkgCapture: true,
        dkgRecall: true,
        nativeCapture: false,
        nativeRecall: false,
        searchLocalGraphs: false,
        extraGraphIds: [],
      },
      records: [storedRecord({ status: 'pending' })],
    };
    await render(React.createElement(MemorySettings, { data, save, retry }));

    const toggle = container.querySelector('input[aria-label="native Recall"]') as HTMLInputElement;
    await act(async () => toggle.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('settings rejected');
    expect(toggle.disabled).toBe(false);

    const retryButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry 1 queued'))!;
    await act(async () => retryButton.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('retry rejected');
    expect(retryButton.disabled).toBe(false);
  });

  it('loads the Codex workspace status and empty conversation list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const data = url.includes('/status')
        ? { connected: true, defaultCwd: '/workspace', selectedThreadId: null }
        : { data: [], nextCursor: null };
      return { ok: true, json: async () => data } as Response;
    }));

    await render(React.createElement(CodexView));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('What shall we work on?');
    expect(container.textContent).toContain('Codex connected');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Workspace folder"]')).toBeNull();
  });
});
