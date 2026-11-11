// @vitest-environment happy-dom
//
// The agent conversation store runs turns itself, so a reply carries on with
// no panel mounted. Like the PanelRight tests, this mocks the local-agent
// calls in `api.js`: the agent bridges are external runtimes (see the note in
// `panel-right.component.test.ts`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalAgentIntegration } from '../src/ui/api.js';

const streamLocalAgentChatMock = vi.fn();
const fetchLocalAgentHistoryMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    streamLocalAgentChat: streamLocalAgentChatMock,
    fetchLocalAgentHistory: fetchLocalAgentHistoryMock,
  };
});

const { conversationActions, resetAgentConversations, useAgentConversations } =
  await import('../src/ui/stores/agentConversations.js');

const KEY = 'openclaw:session-1';
const integration = {
  id: 'openclaw',
  name: 'OpenClaw',
  chatSupported: true,
  chatReady: true,
  persistentChat: true,
} as LocalAgentIntegration;

const conversation = () => useAgentConversations.getState().conversations[KEY];
// The conversation key is the session id, so this target loads into KEY.
const target = { integrationId: 'openclaw', sessionId: KEY };
const request = () => ({ conversationKey: KEY, integration, sessionId: 'session-1', contextEntries: [], contextGraphId: null });

describe('agent conversation store', () => {
  beforeEach(() => {
    resetAgentConversations();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('runs a turn to the end with no panel mounted', async () => {
    streamLocalAgentChatMock.mockImplementation(async (_id, _text, opts) => {
      opts.onEvent({ type: 'text_delta', delta: 'Hel' });
      opts.onEvent({ type: 'text_delta', delta: 'lo' });
      return { text: 'Hello', turnId: 'turn-1' };
    });
    conversationActions.setInput(KEY, '  hi  ');

    const pending = conversationActions.send(request());
    expect(conversation().sending).toBe(true);
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'sent' });
    expect(streamLocalAgentChatMock).toHaveBeenCalledWith('openclaw', 'hi', expect.objectContaining({ sessionId: 'session-1' }));
    const { messages, input, sending } = conversation();
    expect(input).toBe('');
    expect(sending).toBe(false);
    expect(messages.map((m) => [m.role, m.content, m.streaming])).toEqual([
      ['user', 'hi', undefined],
      ['assistant', 'Hello', false],
    ]);
    expect(useAgentConversations.getState().sessionsRevision).toBe(1);
  });

  it('sends nothing when the composer is empty or a turn is already running', async () => {
    expect(conversationActions.send(request())).toBeNull();

    let finish!: (value: unknown) => void;
    streamLocalAgentChatMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    conversationActions.setInput(KEY, 'first');
    const first = conversationActions.send(request());
    await vi.waitFor(() => expect(streamLocalAgentChatMock).toHaveBeenCalled());
    conversationActions.setInput(KEY, 'second');
    expect(conversationActions.send(request())).toBeNull();

    finish({ text: 'ok' });
    await first;
    expect(streamLocalAgentChatMock).toHaveBeenCalledTimes(1);
  });

  it('stop aborts the reply in flight and shows it as cancelled', async () => {
    streamLocalAgentChatMock.mockImplementation((_id, _text, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    conversationActions.setInput(KEY, 'hi');
    const pending = conversationActions.send(request());
    await vi.waitFor(() => expect(streamLocalAgentChatMock).toHaveBeenCalled());

    conversationActions.stop(KEY);

    expect(await pending).toMatchObject({ status: 'failed', aborted: true, inConversation: true });
    const assistant = conversation().messages.at(-1)!;
    expect(assistant.streaming).toBe(false);
    expect(assistant.content).toContain('Request cancelled.');
    expect(conversation().sending).toBe(false);
  });

  it('keeps the queue free of a file that is already queued', () => {
    const file = new File(['x'], 'notes.md', { lastModified: 1 });
    conversationActions.addAttachments(KEY, [file], 'cg-1');
    conversationActions.addAttachments(KEY, [file], 'cg-1');
    expect(conversation().attachments).toHaveLength(1);

    conversationActions.removeAttachment(KEY, conversation().attachments[0].id);
    expect(conversation().attachments).toEqual([]);
  });

  it('carries a conversation over to the session that answered it', async () => {
    streamLocalAgentChatMock.mockResolvedValue({ text: 'Hello' });
    conversationActions.setInput(KEY, 'hi');
    await conversationActions.send(request());

    conversationActions.migrateSession(KEY, 'openclaw:session-2');

    const moved = useAgentConversations.getState().conversations['openclaw:session-2'];
    expect(moved.messages.map((m) => m.content)).toEqual(['hi', 'Hello']);
  });

  it('clear empties the conversation and marks it loaded', () => {
    conversationActions.setInput(KEY, 'draft');
    conversationActions.clear(KEY);
    expect(conversation()).toMatchObject({ messages: [], input: '', attachments: [], historyLoaded: true });
  });

  it('a history refresh keeps what is showing while it loads, and merges without duplicates', async () => {
    fetchLocalAgentHistoryMock.mockResolvedValueOnce([
      { uri: 'urn:msg:1', author: 'user', text: 'hi', ts: '2026-11-10T10:00:00Z', turnId: 'turn-1' },
    ]);
    await conversationActions.loadHistory(target);
    expect(conversation().messages).toHaveLength(1);

    let respond!: (value: unknown) => void;
    fetchLocalAgentHistoryMock.mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
    const refresh = conversationActions.loadHistory(target, { refresh: true });
    expect(conversation()).toMatchObject({ historyLoaded: true, messages: [expect.objectContaining({ content: 'hi' })] });

    respond([
      { uri: 'urn:msg:1', author: 'user', text: 'hi', ts: '2026-11-10T10:00:00Z', turnId: 'turn-1' },
      { uri: 'urn:msg:2', author: 'agent', text: 'hello', ts: '2026-11-10T10:00:05Z', turnId: 'turn-1' },
    ]);
    expect(await refresh).toEqual({ ok: true });
    expect(conversation().messages.map((m) => m.content)).toEqual(['hi', 'hello']);
  });

  it('a failed history refresh keeps the conversation and returns the failure', async () => {
    fetchLocalAgentHistoryMock.mockResolvedValueOnce([
      { uri: 'urn:msg:1', author: 'user', text: 'hi', ts: '2026-11-10T10:00:00Z', turnId: 'turn-1' },
    ]);
    await conversationActions.loadHistory(target);
    const revision = useAgentConversations.getState().sessionsRevision;
    const failure = new Error('node unreachable');
    fetchLocalAgentHistoryMock.mockRejectedValueOnce(failure);

    expect(await conversationActions.loadHistory(target, { refresh: true })).toEqual({ ok: false, error: failure });
    expect(conversation()).toMatchObject({ historyLoaded: true, messages: [expect.objectContaining({ content: 'hi' })] });
    expect(useAgentConversations.getState().sessionsRevision).toBe(revision);
  });

  it('needs no rendering code: it uses the message model, not the message renderer', () => {
    const source = readFileSync(resolve(__dirname, '../src/ui/stores/agentConversations.ts'), 'utf-8');
    expect(source).toContain("from '../components/Shell/PanelRight/message-model.js'");
    expect(source).not.toContain('PanelRight/messages.js');
    const model = readFileSync(resolve(__dirname, '../src/ui/components/Shell/PanelRight/message-model.ts'), 'utf-8');
    expect(model).not.toMatch(/from 'react'|thinking-orbs|MarkdownMessage/);
  });
});
