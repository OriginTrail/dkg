import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConversationMemoryCoordinator } from '../src/conversation-memory.mjs';

function backend(overrides = {}) {
  const memory = Object.assign(new EventEmitter(), {
    records: new Map(), snapshot: () => ({ settings: {}, records: [] }),
    configure: () => ({}), retry: async () => {},
    recall: async () => ({ status: 'disabled', hits: [], searched: [], errors: [] }),
    recordId: (threadId, messageId) => `${threadId}:${messageId}`,
    stageCapture: () => {}, bindTurn: () => {}, commitCapture: async () => {}, capture: async () => {},
  }, overrides);
  memory.receiptCandidates ??= (threadId, turnId) => [...memory.records.values()]
    .filter(record => record.threadId === threadId && record.turnId === turnId);
  return memory;
}

test('coordinates a live turn when completion arrives before turn/start returns', async () => {
  const calls = [];
  const memory = backend({
    stageCapture: record => calls.push(['stage', record.awaitingTurn]),
    bindTurn: (_threadId, _messageId, turnId) => calls.push(['bind', turnId]),
    commitCapture: async () => calls.push(['commit']),
  });
  const coordinator = new ConversationMemoryCoordinator(memory);
  await coordinator.prepareTurn({ threadId: 'thread-a', requestId: 'request-a', text: 'Hello' });
  coordinator.finishTurn('thread-a', 'turn-real');
  await coordinator.startTurn('thread-a', 'request-a', 'turn-real');
  assert.deepEqual(calls, [['stage', true], ['bind', 'turn-real'], ['commit']]);
  assert.equal(coordinator.turns.size, 0);
});

test('decorates rehydrated history without exposing injected recall text', () => {
  const records = new Map([
    ['user-record', { id: 'user-record', threadId: 'thread-a', turnId: 'turn-a', role: 'user', text: 'Original question' }],
    ['assistant-record', { id: 'assistant-record', threadId: 'thread-a', turnId: 'turn-a', role: 'assistant', itemId: 'live-id', text: 'Answer' }],
  ]);
  const coordinator = new ConversationMemoryCoordinator(backend({ records }));
  const decorated = coordinator.decorateThread({ id: 'thread-a', turns: [{
    id: 'turn-a', items: [
      { id: 'rehydrated-user', type: 'userMessage', content: [{ type: 'text', text: 'Original question' }, { type: 'text', text: 'DKG memory evidence for this question. private' }] },
      { id: 'rehydrated-assistant', type: 'agentMessage', text: 'Answer' },
    ],
  }] });
  assert.equal(decorated.turns[0].items[0].memoryRecordId, 'user-record');
  assert.deepEqual(decorated.turns[0].items[0].content, [{ type: 'text', text: 'Original question' }]);
  assert.equal(decorated.turns[0].items[1].memoryRecordId, 'assistant-record');
});
