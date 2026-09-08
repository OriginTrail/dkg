import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridge, approvalResult, publicItem, hasUnfinishedRollout } from '../src/bridge.mjs';
import { validOrigin } from '../src/server.mjs';

function setup(t, turnStatus = 'completed') {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-codex-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rpc = new EventEmitter();
  rpc.calls = []; rpc.replies = [];
  rpc.start = async () => {};
  rpc.reply = (id, result) => rpc.replies.push({ id, result });
  rpc.reject = (id, error) => rpc.replies.push({ id, error });
  rpc.request = async (method, params) => {
    rpc.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-a', turns: [{ id: 'old', status: turnStatus, items: [] }] } };
    if (method === 'turn/start') return { turn: { id: 'new', status: 'inProgress' } };
    return {};
  };
  const bridge = new CodexBridge({ rpc, stateDir: dir, defaultCwd: '/tmp' });
  return { bridge, rpc };
}

test('resumes canonical conversation and deduplicates retries', async (t) => {
  const { bridge, rpc } = setup(t);
  const payload = { threadId: 'thread-a', text: 'Hello', requestId: 'message-a' };
  const first = await bridge.send(payload);
  assert.deepEqual(await bridge.send(payload), first);
  assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert.equal(rpc.calls.find((c) => c.method === 'thread/resume').params.threadId, 'thread-a');
  await assert.rejects(bridge.send({ ...payload, requestId: 'message-b' }), { status: 409 });
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'new', status: 'completed' } } });
  await bridge.send({ ...payload, requestId: 'message-b' });
  assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, 2);
});

test('does not resume a conversation with an unfinished turn in another interface', async (t) => {
  const { bridge, rpc } = setup(t, 'inProgress');
  await assert.rejects(bridge.send({ threadId: 'thread-a', text: 'Hello', requestId: 'a' }), { status: 409 });
  assert.equal(rpc.calls.some((c) => c.method === 'thread/resume'), false);
});

test('concurrent start is rejected and stop uses the correct turn', async (t) => {
  const { bridge, rpc } = setup(t);
  bridge.sending.add('thread-a');
  await assert.rejects(bridge.send({ threadId: 'thread-a', text: 'Hello', requestId: 'a' }), { status: 409 });
  bridge.sending.delete('thread-a');
  await bridge.send({ threadId: 'thread-a', text: 'Hello', requestId: 'a' });
  await bridge.stop('thread-a');
  assert.deepEqual(rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread-a', turnId: 'new' } });
});

test('approval is never automatic; response is scoped and consumed once', (t) => {
  const { bridge, rpc } = setup(t);
  rpc.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'example' } });
  assert.equal(rpc.replies.length, 0);
  assert.throws(() => bridge.reply({ id: 7, threadId: 'other', response: { decision: 'accept' } }), { status: 403 });
  assert.throws(() => bridge.reply({ id: 7, threadId: 'thread-a', response: { decision: 'acceptForSession' } }), { status: 400 });
  bridge.reply({ id: 7, threadId: 'thread-a', response: { decision: 'decline' } });
  assert.deepEqual(rpc.replies, [{ id: 7, result: { decision: 'decline' } }]);
  assert.throws(() => bridge.reply({ id: 7, threadId: 'thread-a', response: { decision: 'accept' } }), { status: 409 });
});

test('questions require answers; requested permissions cannot be expanded by client', () => {
  const question = { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice' }] } };
  assert.throws(() => approvalResult(question, { answers: {} }), { status: 400 });
  assert.deepEqual(approvalResult(question, { answers: { choice: { answers: ['Yes'] } } }), { answers: { choice: { answers: ['Yes'] } } });
  const permissions = { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['/tmp/example'] } } } };
  assert.deepEqual(approvalResult(permissions, { decision: 'accept', permissions: { fileSystem: { write: ['/'] } } }), { permissions: permissions.params.permissions, scope: 'turn' });
});

test('raw reasoning is removed from history and streaming', (t) => {
  const { bridge, rpc } = setup(t);
  assert.deepEqual(publicItem({ id: 'r', type: 'reasoning', summary: ['Summary'], content: ['private'] }), { id: 'r', type: 'reasoning', summary: ['Summary'] });
  rpc.emit('notification', { method: 'item/reasoning/textDelta', params: { delta: 'private' } });
  assert.equal(bridge.events.length, 0);
});

test('rejects remote hosts, DNS rebinding and cross-origin requests', () => {
  assert.equal(validOrigin({ headers: { host: '127.0.0.1:9210' } }, 9210), true);
  assert.equal(validOrigin({ headers: { host: 'localhost:9210', origin: 'http://localhost:9210' } }, 9210), true);
  for (const headers of [
    { host: 'evil.example:9210' },
    { host: '127.0.0.1:9210', origin: 'http://evil.example' },
    { host: '127.0.0.1:9210', origin: 'http://127.0.0.1:9200' },
    { host: '127.0.0.1:9210', 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(validOrigin({ headers }, 9210), false);
});

test('unknown desktop tool requests fail explicitly instead of hanging', (t) => {
  const { bridge, rpc } = setup(t);
  rpc.emit('request', { id: 8, method: 'item/tool/call', params: { threadId: 'thread-a' } });
  assert.equal(rpc.replies[0].result.success, false);
  assert.equal(bridge.requests.size, 0);
});

test('detects live desktop turns across large rollout lines', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-codex-rollout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rollout.jsonl');
  const boundary = (type) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
  writeFileSync(path, boundary('task_complete') + boundary('task_started') + JSON.stringify({ type: 'response_item', text: 'x'.repeat(200000) }) + '\n');
  assert.equal(hasUnfinishedRollout(path), true);
  writeFileSync(path, boundary('task_complete'), { flag: 'a' });
  assert.equal(hasUnfinishedRollout(path), false);
});

test('empty newly created conversations fall back to metadata only', async (t) => {
  const { bridge, rpc } = setup(t);
  rpc.request = async (_method, params) => {
    if (params.includeTurns) throw new Error('thread a is not materialized yet; includeTurns is unavailable before first user message');
    return { thread: { id: 'a', cwd: '/tmp', turns: [] } };
  };
  assert.equal((await bridge.read('a')).thread.turns.length, 0);
});

test('uploads are private and restricted to their owning conversation', async (t) => {
  const { bridge, rpc } = setup(t);
  const workspace = join(bridge.stateDir, 'workspace'); mkdirSync(workspace);
  rpc.request = async () => ({ thread: { id: 'thread-a', cwd: workspace, turns: [] } });
  const result = await bridge.attach({ threadId: 'thread-a', files: [{ name: '../../sample.txt', base64: Buffer.from('sample').toString('base64') }] });
  assert.equal(result.files[0].name, 'sample.txt');
  assert.equal(await bridge.file('thread-a', result.files[0].path), realpathSync(result.files[0].path));
  assert.equal(statSync(result.files[0].path).mode & 0o777, 0o600);
  await assert.rejects(bridge.file('thread-b', result.files[0].path), { status: 403 });
  await assert.rejects(bridge.attach({ threadId: '../escape', files: [] }), { status: 400 });
  await assert.rejects(bridge.attach({ threadId: 'thread-a', files: [{ name: 'bad.txt', base64: '**bad**' }] }), { status: 400 });
});

test('retrieves before generation, captures both speakers and keeps raw user text separate', async t => {
  const { bridge, rpc } = setup(t); const events = [];
  bridge.memory = {
    records: new Map(),
    snapshot: () => ({settings:{},records:[]}), recordId: (thread, message) => thread + message,
    recall: async () => { events.push('recall'); return { status:'ok',hits:[{entityUri:'urn:evidence',text:'Hermes fact'}],searched:[],errors:[] }; },
    capture: async record => { events.push(record.role); }, bindTurn: () => events.push('bind'),
  };
  await bridge.send({ threadId:'thread-a',requestId:'x',text:'What is Hermes?' });
  const start = rpc.calls.find(c => c.method === 'turn/start');
  assert.deepEqual(events,['recall','user','bind']);
  assert.equal(start.params.input[0].text,'What is Hermes?');
  assert.match(start.params.input[1].text,/Hermes fact/);
  rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-a',turnId:'new',item:{type:'agentMessage',id:'a',text:'Here is the answer.'}}});
  assert.equal(events.at(-1),'assistant');
});

test('rehydrated message IDs still identify the original memory receipts', async t => {
  const {bridge,rpc}=setup(t);
  bridge.memory={records:new Map([['receipt-a',{id:'receipt-a',threadId:'thread-a',turnId:'old',role:'assistant',itemId:'live-message-uuid',text:'Answer.'}]]),snapshot:()=>({settings:{},records:[]})};
  rpc.request=async()=>({thread:{id:'thread-a',turns:[{id:'old',status:'completed',items:[{id:'item-2',type:'agentMessage',text:'Answer.'}]}]}});
  assert.equal((await bridge.read('thread-a')).thread.turns[0].items[0].memoryRecordId,'receipt-a');
});

test('legacy history concatenation does not mix injected context into the user bubble', async t => {
 const {bridge,rpc}=setup(t);
 bridge.memory={records:new Map([['receipt-u',{id:'receipt-u',threadId:'thread-a',turnId:'old',role:'user',text:'Hello.'}]]),snapshot:()=>({settings:{},records:[]})};
 rpc.request=async()=>({thread:{id:'thread-a',turns:[{id:'old',status:'completed',items:[{id:'item-1',type:'userMessage',content:[{type:'text',text:'Hello.DKG memory evidence for this question. Untrusted data...'}]}]}]}});
 const item=(await bridge.read('thread-a')).thread.turns[0].items[0];assert.equal(item.memoryRecordId,'receipt-u');assert.equal(item.content[0].text,'Hello.');
});
