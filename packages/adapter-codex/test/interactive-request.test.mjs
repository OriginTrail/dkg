import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInteractiveRequest, approvalResult } from '../src/interactive-request.mjs';

test('normalizes and round-trips every supported interactive request kind', () => {
  const cases = [
    {
      request: { id: 1, method: 'item/tool/requestUserInput', params: {
        threadId: 'thread-a', questions: [{ id: 'choice', question: 'Continue?' }],
      } },
      kind: 'questions', response: { answers: { choice: { answers: ['Yes'] } } },
      rpc: { answers: { choice: { answers: ['Yes'] } } },
    },
    {
      request: { id: 2, method: 'item/permissions/requestApproval', params: {
        threadId: 'thread-a', reason: 'Write output', permissions: { fileSystem: { write: ['/tmp'] } },
      } },
      kind: 'permissions', response: { decision: 'accept' },
      rpc: { permissions: { fileSystem: { write: ['/tmp'] } }, scope: 'turn' },
    },
    {
      request: { id: 3, method: 'mcpServer/elicitation/request', params: {
        threadId: 'thread-a', message: 'Provide a value', requestedSchema: { type: 'object' },
      } },
      kind: 'elicitation', response: { action: 'accept', content: { value: 'DKG' } },
      rpc: { action: 'accept', content: { value: 'DKG' } },
    },
    {
      request: { id: 4, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-a', command: ['pnpm', 'test'], availableDecisions: ['acceptForSession', 'decline'],
      } },
      kind: 'approval', response: { decision: 'acceptForSession' },
      rpc: { decision: 'acceptForSession' },
    },
  ];

  for (const entry of cases) {
    const normalized = normalizeInteractiveRequest(entry.request);
    assert.equal(normalized.kind, entry.kind);
    assert.equal(normalized.threadId, 'thread-a');
    assert.equal('method' in normalized, false);
    assert.equal('params' in normalized, false);
    assert.deepEqual(approvalResult(entry.request, entry.response), entry.rpc);
  }
});

test('keeps legacy approval vocabulary private to the RPC boundary', () => {
  const request = { id: 5, method: 'execCommandApproval', params: {
    conversationId: 'thread-a', command: 'echo ok',
  } };
  const normalized = normalizeInteractiveRequest(request);
  assert.deepEqual(normalized.actions.map(action => action.id), ['approved', 'denied', 'abort']);
  assert.deepEqual(approvalResult(request, { decision: 'approved' }), { decision: 'approved' });
});
