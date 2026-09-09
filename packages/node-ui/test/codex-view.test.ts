// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexView } from '../src/ui/codex/CodexView.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
}

const memory = {
  settings: {
    contextGraphId: 'private-conversations',
    dkgCapture: true,
    dkgRecall: true,
    nativeCapture: false,
    nativeRecall: false,
    searchLocalGraphs: true,
    extraGraphIds: [],
  },
  records: [{
    id: 'memory-1', role: 'assistant', status: 'stored', itemId: 'assistant', turnId: 'turn-1',
    surface: 'dkg', contextGraphId: 'private-conversations', createdAt: '2026-09-08T12:00:00Z',
  }],
};

const richThread = {
  id: 'thread-1',
  name: 'Rich thread',
  preview: 'Preview',
  cwd: '/workspace/project',
  model: 'codex',
  turns: [{
    id: 'turn-1', status: 'completed', items: [
      { id: 'user', type: 'userMessage', content: [{ text: 'Question' }, { type: 'image' }] },
      { id: 'assistant', type: 'agentMessage', text: 'Answer', phase: 'commentary' },
      { id: 'reasoning', type: 'reasoning', summary: ['Summary', { text: 'More' }] },
      { id: 'compaction', type: 'contextCompaction' },
      { id: 'command', type: 'commandExecution', command: 'pnpm test', aggregatedOutput: 'passed', status: 'completed' },
      { id: 'mcp', type: 'mcpToolCall', server: 'dkg', tool: 'read', status: 'inProgress' },
      { id: 'files', type: 'fileChange', changes: [{ path: '/tmp/a.ts', diff: '+ok' }] },
      { id: 'search', type: 'webSearch', query: 'DKG' },
      { id: 'dynamic', type: 'dynamicToolCall', tool: 'custom' },
    ],
  }, {
    id: 'turn-failed', status: 'failed', error: { message: 'failed turn' }, items: [],
  }, {
    id: 'turn-stopped', status: 'interrupted', items: [],
  }],
};

const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data } as Response);

describe('Codex workspace view', () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => undefined);
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/status')) return response({ connected: true, defaultCwd: '/workspace', selectedThreadId: 'thread-1' });
      if (url.includes('/threads')) return response({ data: [richThread], nextCursor: url.includes('cursor=') ? null : 'next' });
      if (url.includes('/select')) return response({ thread: richThread, pendingRequests: [], activeTurnId: null, externalActive: false, sequence: 4, memory });
      if (url.includes('/thread?')) return response({ thread: richThread, pendingRequests: [], activeTurnId: null, externalActive: false, memory });
      if (url.includes('/send')) return response({ turn: { id: 'turn-new' } });
      if (url.includes('/new')) return response({ thread: richThread });
      if (url.includes('/memory?')) return response(memory);
      if (url.includes('/memory/settings')) return response(memory.settings);
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads a rich thread and applies the complete event lifecycle', async () => {
    await act(async () => root.render(React.createElement(CodexView)));
    await vi.waitFor(() => expect(container.textContent).toContain('Rich thread'));

    expect(container.textContent).toContain('Question');
    expect(container.textContent).toContain('Answer');
    expect(container.textContent).toContain('Reasoning summary');
    expect(container.textContent).toContain('Conversation context compacted');
    expect(container.textContent).toContain('pnpm test');
    expect(container.textContent).toContain('Files changed · a.ts');
    expect(container.textContent).toContain('failed turn');
    expect(container.textContent).toContain('Stopped');
    expect(FakeEventSource.instances[0].url).toContain('threadId=thread-1');

    const source = FakeEventSource.instances[0];
    await act(async () => { source.onopen?.(); source.onopen?.(); await Promise.resolve(); });
    expect(container.textContent).toContain('Enter to send');
    await act(async () => { source.onerror?.(); await Promise.resolve(); });

    const emit = async (method: string, params: unknown) => act(async () => {
      source.onmessage?.({ data: JSON.stringify({ sequence: 5, method, params }) });
      await Promise.resolve();
    });
    await emit('memory/updated', { record: { ...memory.records[0], id: 'memory-2' } });
    await emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } });
    expect(container.textContent).toContain('Codex is working');
    await emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed' } });
    await emit('bridge/request', { id: 9, threadId: 'thread-1', kind: 'approval', title: 'Approval required', details: { reason: 'Run checks', command: ['pnpm', 'test'], cwd: '/workspace' }, actions: [{ id: 'decline', label: 'Decline' }] });
    expect(container.textContent).toContain('Approval required');
    await emit('bridge/requestResolved', { requestId: 9 });
    await emit('bridge/request', { id: 10, threadId: 'thread-1', kind: 'questions', title: 'Codex needs your input', details: { questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Proceed' }] }] } });
    expect(container.textContent).toContain('Codex needs your input');
    await emit('serverRequest/resolved', { requestId: 10 });
    await emit('error', { error: { message: 'event failed' } });
    expect(container.textContent).toContain('event failed');
    await emit('bridge/disconnected', {});
    expect(container.textContent).toContain('Codex disconnected');
  });

  it('searches, pages, creates, sends, stops, and answers requests', async () => {
    await act(async () => root.render(React.createElement(CodexView)));
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    await act(async () => source.onopen?.());

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'catalog');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const loadMore = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Load more');
    if (loadMore) await act(async () => loadMore.click());

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')!.click());
    const cwd = container.querySelector<HTMLInputElement>('input[aria-label="Workspace folder"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(cwd, '/new-workspace');
      cwd.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Create conversation')!.click());
    const currentSource = FakeEventSource.instances.at(-1)!;
    await act(async () => currentSource.onopen?.());

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Codex"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Hello');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button.codex-send')!.click());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/send'))).toBe(true);

    await act(async () => currentSource.onmessage?.({ data: JSON.stringify({ sequence: 7, method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'active', status: 'inProgress' } } }) }));
    const stop = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Stop');
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    const stopCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/stop'))!;
    expect(stopCall).toBeDefined();
    expect(stopCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(stopCall[1]?.body))).toEqual({ threadId: 'thread-1' });

    await act(async () => currentSource.onmessage?.({ data: JSON.stringify({ sequence: 8, method: 'bridge/request', params: { id: 12, threadId: 'thread-1', kind: 'elicitation', title: 'Additional information requested', details: { message: 'Provide value', schema: { required: ['name'], properties: { name: { type: 'string', title: 'Name' }, count: { type: 'integer' }, enabled: { type: 'boolean' }, mode: { type: 'string', enum: ['safe'] } } } }, actions: [{ id: 'accept', label: 'Allow once' }, { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }] } }) }));
    expect(container.textContent).toContain('Additional information requested');
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'DKG');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const count = container.querySelector<HTMLInputElement>('input[aria-label="count"]')!;
    const enabled = container.querySelector<HTMLInputElement>('input[aria-label="enabled"]')!;
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="mode"]')!;
    expect(count).toBeDefined(); expect(enabled).toBeDefined(); expect(mode).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(count, '3');
      count.dispatchEvent(new Event('input', { bubbles: true }));
      enabled.click();
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(mode, 'safe');
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit');
    expect(submit).toBeDefined();
    await act(async () => submit!.click());
    const replyCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/reply'))!;
    expect(replyCall).toBeDefined();
    expect(replyCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(replyCall[1]?.body))).toEqual({
      id: 12,
      threadId: 'thread-1',
      response: { action: 'accept', content: { name: 'DKG', count: 3, enabled: true, mode: 'safe' } },
    });
  });

  it('shows the complete network and permission context and only advertises server-supported decisions', async () => {
    await act(async () => root.render(React.createElement(CodexView)));
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    await act(async () => source.onmessage?.({ data: JSON.stringify({ sequence: 9, method: 'bridge/request', params: {
      id: 14,
      threadId: 'thread-1',
      kind: 'approval',
      title: 'Network access approval required',
      details: {
        command: ['curl', 'https://attacker.example'],
        cwd: '/workspace/project',
        reason: 'Contact the requested service',
        network: { host: 'attacker.example', protocol: 'https', port: 443 },
        additionalPermissions: { fileSystem: { read: ['/workspace/project'], write: ['/tmp/result'] } },
      },
      actions: [{ id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }],
    } }) }));
    expect(container.textContent).toContain('Network access approval required');
    expect(container.textContent).toContain('Host: attacker.example');
    expect(container.textContent).toContain('Protocol: https');
    expect(container.textContent).toContain('Port: 443');
    expect(container.textContent).toContain('Additional permissions requested');
    expect(container.textContent).toContain('/workspace/project');
    expect(container.textContent).toContain('/tmp/result');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Allow once')).toBe(false);
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Allow for session')).toBe(false);
    const decline = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Decline');
    const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
    expect(decline).toBeDefined(); expect(cancel).toBeDefined();
    await act(async () => decline!.click());
    const replyCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/reply'))!;
    expect(JSON.parse(String(replyCall[1]?.body))).toEqual({ id: 14, threadId: 'thread-1', response: { decision: 'decline' } });
  });
});
