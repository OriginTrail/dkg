import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fstatSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { memoryContext } from './memory.mjs';

export const HTTP_ERROR = (status, message) => Object.assign(new Error(message), { status });
const INTERACTIVE = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/tool/requestUserInput', 'item/permissions/requestApproval',
  'mcpServer/elicitation/request', 'applyPatchApproval', 'execCommandApproval',
]);

// A second app-server labels unfinished disk turns "interrupted", even while
// the desktop still owns them. Check the actual turn boundary before resuming.
export function hasUnfinishedRollout(path) {
  if (!path) return false;
  let fd;
  try {
    fd = openSync(path, 'r');
    let position = fstatSync(fd).size;
    let carry = '';
    while (position > 0) {
      const size = Math.min(position, 65536); position -= size;
      const bytes = Buffer.alloc(size); readSync(fd, bytes, 0, size, position);
      const lines = (bytes.toString('utf8') + carry).split('\n');
      carry = position ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!/task_started|task_complete|turn_aborted/.test(lines[i])) continue;
        let row; try { row = JSON.parse(lines[i]); } catch { continue; }
        if (row.type !== 'event_msg') continue;
        if (row.payload?.type === 'task_started') return true;
        if (['task_complete', 'turn_aborted'].includes(row.payload?.type)) return false;
      }
    }
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
  return false;
}

export function approvalResult(request, input) {
  const method = request.method;
  if (method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of request.params.questions ?? []) {
      const answer = input.answers?.[question.id];
      if (!Array.isArray(answer?.answers) || !answer.answers.length ||
          answer.answers.some((a) => typeof a !== 'string' || !a.trim() || a.length > 20_000)) {
        throw HTTP_ERROR(400, 'Answer each question before continuing.');
      }
      answers[question.id] = { answers: answer.answers };
    }
    return { answers };
  }
  if (method === 'item/permissions/requestApproval') {
    if (!['accept', 'decline'].includes(input.decision)) throw HTTP_ERROR(400, 'Choose Allow or Decline.');
    return { permissions: input.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(input.action)) throw HTTP_ERROR(400, 'Invalid response.');
    return { action: input.action, content: input.content ?? null };
  }
  const legacy = method === 'applyPatchApproval' || method === 'execCommandApproval';
  const advertised = request.params.availableDecisions;
  const allowed = legacy ? ['approved', 'denied', 'abort']
    : Array.isArray(advertised) ? advertised.filter((decision) => typeof decision === 'string')
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
  if (!allowed.includes(input.decision)) throw HTTP_ERROR(400, 'Invalid approval decision.');
  return { decision: input.decision };
}

// Only readable summaries are exposed for reasoning items; never raw reasoning.
export function publicItem(item) {
  if (item?.type !== 'reasoning') return item;
  return { id: item.id, type: item.type, summary: item.summary ?? [] };
}
function publicThread(thread) {
  return { ...thread, turns: (thread.turns ?? []).map((turn) => ({
    ...turn, items: (turn.items ?? []).map((item) => item.type === 'userMessage'
      ? { ...item, content: (item.content || []).filter((part, index) => index === 0 || !part.text?.startsWith('DKG memory evidence for this question.')) }
      : publicItem(item)),
  })) };
}

export class CodexBridge extends EventEmitter {
  constructor({ rpc, stateDir, defaultCwd, initialThreadId, memory }) {
    super();
    Object.assign(this, { rpc, stateDir, defaultCwd, initialThreadId, memory });
    this.memoryTurns = new Map();
    memory?.on('update', (p) => this.publish('memory/updated', p));
    this.requests = new Map();
    this.loaded = new Set();
    this.active = new Map();
    this.completedTurns = new Set();
    this.events = [];
    this.sequence = 0;
    this.eventBytes = 0;
    this.sending = new Set();
    this.receipts = new Map();
    this.mcp = null;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { this.settings = JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')); }
    catch { this.settings = {}; }
    rpc.on('notification', (message) => this.onNotification(message));
    rpc.on('request', (message) => this.onRequest(message));
    rpc.on('disconnect', () => {
      this.loaded.clear(); this.active.clear(); this.completedTurns.clear(); this.requests.clear();
      this.publish('bridge/disconnected', {});
    });
  }

  save() {
    const file = join(this.stateDir, 'settings.json');
    writeFileSync(file + '.tmp', JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  publish(method, params) {
    const event = { sequence: ++this.sequence, method, params };
    const size = Buffer.byteLength(JSON.stringify(event));
    this.eventBytes += size;
    Object.defineProperty(event, 'bytes', { value: size });
    this.events.push(event);
    while (this.events.length > 1500 || this.eventBytes > 8_000_000) this.eventBytes -= this.events.shift().bytes;
    this.emit('event', event);
  }
  onNotification(message) {
    const { method } = message;
    const params = { ...message.params };
    if (method === 'item/reasoning/textDelta') return;
    if (params.item) params.item = publicItem(params.item);
    const memoryTurn = this.memoryTurns.get(params.threadId);
    if (memoryTurn && params.item?.type === 'userMessage') params.item = { ...params.item,
      memoryRecordId: this.memory.recordId(params.threadId, memoryTurn.userMessageId), content: [{ type: 'text', text: memoryTurn.text }] };
    if (memoryTurn && method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage' && item.text) {
        item.memoryRecordId = this.memory.recordId(params.threadId, `assistant:${params.turnId}:${item.id}`);
        void this.memory.capture({ threadId: params.threadId, turnId: params.turnId,
          messageId: `assistant:${params.turnId}:${item.id}`, itemId: item.id,
          role: 'assistant', phase: item.phase || 'final', text: item.text, surface: 'dkg',
          recall: memoryTurn.recall, trace: item.phase === 'commentary' ? [] : [...memoryTurn.trace] }).catch(() => {});
      } else if (['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'dynamicToolCall'].includes(item.type)) {
        memoryTurn.trace.push({ label: item.type === 'mcpToolCall' ? `${item.server} · ${item.tool}` : item.tool || item.type,
          status: item.status || 'completed', itemId: item.id });
      }
    }
    const turnId = params.turn?.id ?? params.turnId;
    if (method === 'turn/started' && !this.completedTurns.has(turnId)) this.active.set(params.threadId, turnId);
    if (method === 'turn/completed') {
      if (turnId) {
        this.completedTurns.add(turnId);
        if (this.completedTurns.size > 1000) this.completedTurns.delete(this.completedTurns.values().next().value);
      }
      this.active.delete(params.threadId); this.memoryTurns.delete(params.threadId);
    }
    if (method === 'serverRequest/resolved') this.requests.delete(String(params.requestId));
    this.publish(method, params);
  }
  onRequest(message) {
    if (!INTERACTIVE.has(message.method)) {
      if (message.method === 'item/tool/call') {
        this.rpc.reply(message.id, { success: false, contentItems: [{ type: 'inputText',
          text: 'This desktop-only dynamic tool is unavailable in the DKG UI. Use the available Codex tools instead.' }] });
      } else this.rpc.reject(message.id, 'This request requires the Codex desktop application.');
      return;
    }
    this.requests.set(String(message.id), message);
    this.publish('bridge/request', message);
  }
  async ready() { await this.rpc.start(); }
  async status() {
    await this.ready();
    const result = await this.rpc.request('account/read', { refreshToken: false });
    // Only return account type; email, credentials and account IDs stay in Codex.
    return { connected: true, accountType: result.account?.type ?? null,
      requiresLogin: !result.account, selectedThreadId: this.settings.selectedThreadId ?? this.initialThreadId ?? null,
      defaultCwd: this.defaultCwd, sequence: this.sequence };
  }
  async list({ cursor, search } = {}) {
    await this.ready();
    const result = await this.rpc.request('thread/list', { limit: 40, sortKey: 'updated_at',
      cursor: cursor || null, searchTerm: search || null, archived: false, useStateDbOnly: true });
    return { ...result, data: result.data.filter((t) => !t.parentThreadId).map(publicThread) };
  }
  async read(threadId) {
    await this.ready();
    let result;
    try { result = await this.rpc.request('thread/read', { threadId, includeTurns: true }); }
    catch (error) {
      if (!error.message.includes('not materialized yet')) throw error;
      result = await this.rpc.request('thread/read', { threadId, includeTurns: false });
    }
    const { thread } = result;
    const externalActive = !this.loaded.has(threadId) && hasUnfinishedRollout(thread.path);
    if (externalActive && thread.turns?.length) thread.turns.at(-1).status = 'inProgress';
    const visible = publicThread(thread);
    // Recall remains visible in its evidence inspector, not mixed into the
    // user's own message bubble. Codex still retains the exact submitted input.
    if (this.memory) for (const turn of visible.turns) {
      const records = [...this.memory.records.values()].filter((r) => r.threadId === threadId && r.turnId === turn.id);
      const used = new Set();
      turn.items = turn.items.map((item) => {
        const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null;
        if (!role) return item;
        const text = role === 'user' ? (item.content || []).map((part) => part.text || '').join('\n') : item.text;
        const record = records.find((r) => !used.has(r.id) && r.role === role && (r.itemId === item.id || r.text === text || (role === 'user' &&
          (text.startsWith(r.text + '\n\nAttached local files:\n') || text.startsWith(r.text + 'DKG memory evidence for this question.')))));
        if (!record) return item;
        used.add(record.id);
        return { ...item, memoryRecordId: record.id, ...(role === 'user' ? { content: [{ type: 'text', text: record.text }] } : {}) };
      });
    }
    return { thread: visible, sequence: this.sequence, memory: this.memory?.snapshot(threadId),
      externalActive,
      activeTurnId: this.active.get(threadId) ?? null,
      pendingRequests: [...this.requests.values()].filter((r) => r.params.threadId === threadId || r.params.conversationId === threadId) };
  }
  async select(threadId) {
    const data = await this.read(threadId);
    this.settings.selectedThreadId = threadId; this.save();
    return data;
  }
  async create({ cwd } = {}) {
    await this.ready();
    if (cwd && !isAbsolute(cwd)) throw HTTP_ERROR(400, 'Choose an absolute workspace path.');
    const result = await this.rpc.request('thread/start', { cwd: cwd || this.defaultCwd, historyMode: 'legacy',
      serviceName: 'dkg-node-ui', ...(this.mcp ? { config: this.mcp } : {}) });
    this.loaded.add(result.thread.id);
    this.settings.selectedThreadId = result.thread.id; this.save();
    return { thread: publicThread(result.thread), sequence: this.sequence, pendingRequests: [] };
  }
  async file(threadId, path) {
    await this.ready();
    if (typeof path !== 'string' || !isAbsolute(path)) throw HTTP_ERROR(400, 'An absolute file path is required.');
    const { thread } = await this.rpc.request('thread/read', { threadId, includeTurns: false });
    const root = realpathSync(thread.cwd);
    const actual = realpathSync(path.replace(/:\d+(?::\d+)?$/, ''));
    const uploadRoot = join(realpathSync(this.stateDir), 'attachments', threadId);
    if (!actual.startsWith(root + sep) && !actual.startsWith(uploadRoot + sep)) throw HTTP_ERROR(403, 'This file is outside the conversation workspace.');
    const stat = statSync(actual);
    if (!stat.isFile()) throw HTTP_ERROR(400, 'Choose a file.');
    if (stat.size > 50_000_000) throw HTTP_ERROR(413, 'This file is too large to preview (50 MB maximum).');
    return actual;
  }
  async attach({ threadId, files }) {
    await this.ready();
    if (typeof threadId !== 'string' || !/^[\w-]+$/.test(threadId)) throw HTTP_ERROR(400, 'Invalid conversation ID.');
    await this.rpc.request('thread/read', { threadId, includeTurns: false });
    if (!Array.isArray(files) || !files.length || files.length > 4) throw HTTP_ERROR(400, 'Attach one to four files.');
    let total = 0;
    const decoded = files.map((file) => {
      if (typeof file.name !== 'string' || typeof file.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw HTTP_ERROR(400, 'Invalid attachment.');
      const bytes = Buffer.from(file.base64, 'base64'); total += bytes.length;
      if (bytes.length > 4_000_000 || total > 8_000_000) throw HTTP_ERROR(413, 'Attachments are limited to 4 MB each and 8 MB total.');
      const name = basename(file.name).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 140) || 'attachment';
      return { name, bytes };
    });
    const dir = join(this.stateDir, 'attachments', threadId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { files: decoded.map(({ name, bytes }) => {
      const path = join(dir, `${randomUUID()}-${name}`);
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      return { name, path };
    }) };
  }
  async ensureLoaded(threadId) {
    if (this.loaded.has(threadId)) return;
    const { thread, externalActive } = await this.read(threadId);
    const last = thread.turns?.at(-1);
    if (externalActive || last?.status === 'inProgress') {
      throw HTTP_ERROR(409, 'This conversation is still running in another Codex interface. Wait for it to finish before continuing here.');
    }
    await this.rpc.request('thread/resume', { threadId, ...(this.mcp ? { config: this.mcp } : {}) });
    this.loaded.add(threadId);
  }
  async send({ threadId, text, requestId, attachments = [] }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200_000) throw HTTP_ERROR(400, 'Enter a message (maximum 200,000 characters).');
    if (typeof requestId !== 'string' || requestId.length > 100) throw HTTP_ERROR(400, 'A message ID is required.');
    const key = `${threadId}:${requestId}`;
    if (this.receipts.has(key)) return this.receipts.get(key);
    if (this.sending.has(threadId) || this.active.has(threadId)) throw HTTP_ERROR(409, 'Codex is working. Stop or wait for the current reply.');
    this.sending.add(threadId);
    try {
      await this.ready(); await this.ensureLoaded(threadId);
      if (!Array.isArray(attachments) || attachments.length > 4) throw HTTP_ERROR(400, 'Invalid attachments.');
      const paths = [];
      for (const attachment of attachments) {
        const actual = await this.file(threadId, attachment.path);
        const root = join(realpathSync(this.stateDir), 'attachments', threadId) + sep;
        if (!actual.startsWith(root)) throw HTTP_ERROR(403, 'Only uploaded attachments can be sent.');
        paths.push(actual);
      }
      if (paths.reduce((sum, path) => sum + statSync(path).size, 0) > 8_000_000) throw HTTP_ERROR(413, 'Attachments are limited to 8 MB total per message.');
      const recall = await this.memory?.recall(text, 'dkg');
      await this.memory?.capture({ threadId, messageId: `user:${requestId}`, role: 'user', text, surface: 'dkg', recall });
      const input = [{ type: 'text', text: text + (paths.length ? '\n\nAttached local files:\n' + paths.join('\n') : ''), text_elements: [] }];
      const context = memoryContext(recall);
      if (context) input.push({ type: 'text', text: context, text_elements: [] });
      for (const path of paths) if (/\.(png|jpe?g|webp|gif)$/i.test(path)) input.push({ type: 'localImage', path });
      if (this.memory) this.memoryTurns.set(threadId, { recall, trace: [], text, userMessageId: `user:${requestId}` });
      const result = await this.rpc.request('turn/start', { threadId,
        clientUserMessageId: requestId, input });
      this.memory?.bindTurn(threadId, `user:${requestId}`, result.turn.id);
      // Notifications can arrive while the turn/start response is still in flight.
      // Never resurrect a turn after its authoritative completion event.
      if (!this.completedTurns.has(result.turn.id)) this.active.set(threadId, result.turn.id);
      this.receipts.set(key, result);
      if (this.receipts.size > 1000) this.receipts.delete(this.receipts.keys().next().value);
      return result;
    } finally { this.sending.delete(threadId); }
  }
  async stop(threadId) {
    const turnId = this.active.get(threadId);
    if (!turnId) throw HTTP_ERROR(409, 'No active turn to stop.');
    return this.rpc.request('turn/interrupt', { threadId, turnId });
  }
  reply({ id, threadId, response }) {
    const request = this.requests.get(String(id));
    if (!request) throw HTTP_ERROR(409, 'This request has already been resolved.');
    if ((request.params.threadId ?? request.params.conversationId) !== threadId) throw HTTP_ERROR(403, 'Request belongs to another conversation.');
    this.rpc.reply(request.id, approvalResult(request, response ?? {}));
    this.requests.delete(String(id));
    this.publish('bridge/requestResolved', { requestId: request.id, threadId });
    return { ok: true };
  }
}
