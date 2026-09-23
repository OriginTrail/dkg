import { describe, it, expect } from 'vitest';
import { applyEvent, type Thread } from '../src/ui/codex/events.js';

describe('Codex conversation events', () => {
  it('streams text then replaces it with the authoritative completed item', () => {
    let thread: Thread = { id: 'a', cwd: '/tmp', turns: [] };
    const event = (method: string, params: any) => ({ sequence: 1, method, params });
    thread = applyEvent(thread, event('turn/started', { threadId: 'a', turn: { id: 't', status: 'inProgress' } }));
    thread = applyEvent(thread, event('item/agentMessage/delta', { threadId: 'a', turnId: 't', itemId: 'm', delta: 'Hel' }));
    thread = applyEvent(thread, event('item/agentMessage/delta', { threadId: 'a', turnId: 't', itemId: 'm', delta: 'lo' }));
    expect(thread.turns[0].items[0].text).toBe('Hello');
    thread = applyEvent(thread, event('item/completed', { threadId: 'a', turnId: 't', item: { id: 'm', type: 'agentMessage', text: 'Hello!' } }));
    expect(thread.turns[0].items).toHaveLength(1);
    expect(thread.turns[0].items[0].text).toBe('Hello!');
    thread = applyEvent(thread, event('turn/completed', { threadId: 'a', turn: { id: 't', status: 'completed' } }));
    expect(thread.turns[0].status).toBe('completed');
  });
  it('ignores another conversation and preserves finished messages on completion', () => {
    const thread: Thread = { id: 'a', cwd: '/tmp', turns: [{ id: 't', status: 'inProgress', items: [{ id: 'm', type: 'agentMessage', text: 'Saved' }] }] };
    expect(applyEvent(thread, { sequence: 1, method: 'turn/started', params: { threadId: 'b', turn: { id: 'other' } } })).toBe(thread);
    const final = applyEvent(thread, { sequence: 2, method: 'turn/completed', params: { threadId: 'a', turn: { id: 't', status: 'completed', items: [] } } });
    expect(final.turns[0].items[0].text).toBe('Saved');
  });

  it('applies thread metadata, item lifecycle, and bounded command output updates', () => {
    const event = (method: string, params: any) => ({ sequence: 1, method, params });
    let thread: Thread = {
      id: 'a',
      cwd: '/tmp',
      turns: [{ id: 't', status: 'inProgress', items: [{ id: 'other', type: 'reasoning' }] }],
    };

    thread = applyEvent(thread, event('thread/name/updated', { threadId: 'a', threadName: 'Renamed' }));
    expect(thread.name).toBe('Renamed');
    thread = applyEvent(thread, event('item/started', {
      threadId: 'a', turnId: 't', item: { id: 'command', type: 'commandExecution', aggregatedOutput: '' },
    }));
    thread = applyEvent(thread, event('item/commandExecution/outputDelta', {
      threadId: 'a', turnId: 't', itemId: 'command', delta: 'x'.repeat(100_001),
    }));
    const command = thread.turns[0].items.find((item) => item.id === 'command');
    expect(command?.aggregatedOutput).toHaveLength(100_000);
    thread = applyEvent(thread, event('item/completed', {
      threadId: 'a', turnId: 't', item: { id: 'command', type: 'commandExecution', status: 'completed' },
    }));
    expect(thread.turns[0].items.find((item) => item.id === 'command')?.status).toBe('completed');

    expect(applyEvent(thread, event('unknown', { threadId: 'a' }))).toBe(thread);
    expect(applyEvent(thread, event('unknown', { threadId: 'a', turnId: 't' })).turns).toEqual(thread.turns);
    const unrelatedTurn = applyEvent(thread, event('item/started', {
      threadId: 'a', turnId: 'missing', item: { id: 'new', type: 'fileChange' },
    }));
    expect(unrelatedTurn.turns).toEqual(thread.turns);
  });
});
