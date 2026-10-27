#!/usr/bin/env node
// Deterministic OpenAI-compatible upstream for the OT-RFC-27 marketplace devnet.
//
// Ported from the NeuroSymbolic-Marketplace fork (packages/marketplace/scripts/
// llm-stub.mjs). A seller `chat-connector` offering whose connector kind is
// `openai-compatible` (packages/agent/src/marketplace/connectors/
// openai-compatible.ts) POSTs `<baseUrl>/chat/completions` with
// `{ model, messages, max_tokens, stream: false, [temperature, top_p, seed,
// stop], [tools, tool_choice, parallel_tool_calls] }` and a `Bearer` key read
// from its secret env file, and expects `{ choices[0].message.{content,
// tool_calls}, choices[0].finish_reason, usage.{prompt_tokens,
// completion_tokens} }` back. This server answers that contract with NO model:
// the reply and its usage are pure functions of the prompt, so a test can
// predict the exact completion (and the exact units both seats meter with the
// `stub-words-v1` engine and the `openai-chat-count/v1` template) before it
// sends the request.
//
//   words(text)             = text.trim() === '' ? [] : text.trim().split(/\s+/)
//                             (count = createStubWordsEngine().encodeCount)
//   reply(lastUser, max)    = "STUB:" + words(lastUser).reverse().map(upper).join(" ") + " :: ok"
//                             truncated to `max` words (finish_reason "length")
//                             when it would exceed it, else finish_reason "stop".
//                             `max` = body.max_tokens, else body.max_completion_tokens;
//                             absent, zero or negative means uncapped.
//   usage.prompt_tokens     = Σ over messages (words(content) + words(role) + 3) + 3
//                             (tools and tool_calls are NOT counted)
//   usage.completion_tokens = words(reply)
//
// Golden vectors (spec §3.2): GV-2 `[{system,'You are terse.'},{user,'hello
// marketplace world'}]` → `STUB:WORLD MARKETPLACE HELLO :: ok`, stop, usage
// {17,5,22}; GV-3 the same with max_tokens 3 → `STUB:WORLD MARKETPLACE HELLO`,
// length, {17,3,20}.
//
// Deterministic tool calls: when `body.tools` is a non-empty array AND
// `tool_choice` is `'required'` or `{type:'function', function:{name}}`, the
// reply is `{role:'assistant', content:null, tool_calls:[{ id, type:'function',
// function:{ name, arguments: JSON.stringify({ echo: words(lastUser).length }) } }]}`
// with finish_reason `tool_calls`, where `name` is the named function (else
// `tools[0].function.name`) and `id = 'call_stub_' + sha256(JSON.stringify(
// messages) + '|' + name).hex.slice(0, 16)`. Its usage.completion_tokens is
// `words(JSON.stringify(tool_calls)).length`; prompt_tokens keeps the formula
// above. Any other `tool_choice` gets the normal text reply.
//
// Test seams, parsed from the LEADING whitespace-separated tokens of the last
// user message (in any order, repeated tokens: the last one wins):
//   __stub_delay_ms=<n>__   sleep min(n, 60000) ms before replying
//   __stub_status=<code>__  for 400..599, answer that status with
//                           {error:{message:'stub forced status <code>', type:'stub_error'}};
//                           any other code is stripped and ignored
// Seam tokens are stripped from the text used for the reply and the tool-call
// `echo`; usage still counts the raw messages, so it stays equal to the
// seller's pinned count of what it sent. A delayed request whose client
// disconnects, or that is pending when the stub closes, is dropped unanswered.
//
// Routes: GET /healthz (no auth; call counter for liveness probes) ·
// GET /v1/models · POST /v1/chat/completions (JSON; SSE when `stream:true`:
// role chunk, content word deltas or ONE tool_calls delta, finish chunk, a
// usage chunk that is always sent, then `data: [DONE]`). Every /v1 request
// must carry `Authorization: Bearer <non-empty>` (any value, or exactly
// LLM_STUB_API_KEY when that is set) — that is what proves the connector's
// secret-file wiring — unless LLM_STUB_ALLOW_ANON=1. 401s carry
// `WWW-Authenticate: Bearer`. Request bodies above 64 MiB answer 413.
// Port from LLM_STUB_PORT (default 18080), model id from LLM_STUB_MODEL
// (default stub-chat); loopback only (listen() refuses any other host).
//
//   LLM_STUB_API_KEY=devnet-stub-key pnpm devnet:marketplace:llm-stub
//
// Usable as a library too:
//   import { createLlmStub, stubReply, stubUsage, words } from './llm-stub.mjs';
//   const stub = createLlmStub({ apiKey: 'devnet-stub-key', log: () => {} });
//   const port = await stub.listen(0, '127.0.0.1');   // resolves the real port
//   stub.state.lastAuthorization / stub.state.lastBody / stub.state.calls
//   await stub.close();
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 18080;
export const DEFAULT_MODEL = 'stub-chat';
export const PER_MESSAGE_TOKENS = 3;
export const PER_REPLY_PRIMER_TOKENS = 3;
export const MAX_DELAY_MS = 60_000;
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function words(text) {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/) : [];
}

/** Deterministic completion for a prompt. `maxTokens` bounds the WORD count. */
export function stubReply(lastUserMessage, maxTokens) {
  const body = words(lastUserMessage).reverse().map((w) => w.toUpperCase());
  const full = ['STUB:' + (body.length ? body[0] : ''), ...body.slice(1), '::', 'ok'];
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : Infinity;
  const truncated = full.length > cap;
  const out = truncated ? full.slice(0, cap) : full;
  return { content: out.join(' '), finishReason: truncated ? 'length' : 'stop', completionTokens: out.length };
}

/** Deterministic usage counts (the stub-words engine under openai-chat-count/v1, without tools). */
export function stubUsage(messages, completionTokens) {
  const prompt = (messages ?? []).reduce(
    (s, m) => s + words(m?.content).length + words(m?.role).length + PER_MESSAGE_TOKENS, 0,
  ) + PER_REPLY_PRIMER_TOKENS;
  return { prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: prompt + completionTokens };
}

const SEAM_TOKEN = /^__stub_(delay_ms|status)=(\d+)__$/;

/** Leading test-seam tokens of a prompt: `{ text (seams stripped), delayMs, status | null }`. */
export function parseStubSeams(text) {
  const ws = words(text);
  let delayMs = 0;
  let status = null;
  let i = 0;
  for (; i < ws.length; i++) {
    const m = SEAM_TOKEN.exec(ws[i]);
    if (!m) break;
    const n = Number(m[2]);
    if (m[1] === 'delay_ms') delayMs = Math.min(n, MAX_DELAY_MS);
    else status = n >= 400 && n <= 599 ? n : null;
  }
  return { text: i === 0 ? String(text ?? '') : ws.slice(i).join(' '), delayMs, status };
}

/**
 * The function a request forces, or null for a text reply. Throws a
 * `TypeError` when `tool_choice` is `'required'` but `tools[0]` has no name.
 */
export function stubToolChoiceName(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  if (toolChoice === 'required') {
    const name = tools[0]?.function?.name;
    if (typeof name !== 'string' || name === '') throw new TypeError('tools[0].function.name is required');
    return name;
  }
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const name = toolChoice.function?.name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return null;
}

/** Deterministic tool-call reply: `{ toolCalls, completionTokens }`. */
export function stubToolCalls(messages, name, lastUserMessage) {
  const id = 'call_stub_' + createHash('sha256').update(JSON.stringify(messages ?? []) + '|' + name).digest('hex').slice(0, 16);
  const toolCalls = [{
    id, type: 'function',
    function: { name, arguments: JSON.stringify({ echo: words(lastUserMessage).length }) },
  }];
  return { toolCalls, completionTokens: words(JSON.stringify(toolCalls)).length };
}

/** True for a loopback host literal (`localhost`, `127.0.0.0/8`, `::1`). */
export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(h);
}

function lastUserContent(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  }
  return '';
}

function json(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(s)), ...headers });
  res.end(s);
}

class BodyTooLargeError extends Error {}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BodyTooLargeError(`request body exceeds ${limit} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sleep `ms`; resolves false (and drops the response) on client disconnect or stub close. */
function sleepUnlessDropped(ms, res, pending) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending.delete(entry);
      res.off('close', onClose);
      if (!ok && !res.destroyed) res.destroy();
      resolve(ok);
    };
    const entry = { abort: () => finish(false) };
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    pending.add(entry);
    res.on('close', onClose);
  });
}

function writeSse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const e of events) res.write('data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n');
  res.end();
}

export function createLlmStub(opts = {}) {
  const model = opts.model ?? process.env.LLM_STUB_MODEL ?? DEFAULT_MODEL;
  const allowAnon = opts.allowAnon ?? process.env.LLM_STUB_ALLOW_ANON === '1';
  const expectedKey = opts.apiKey ?? process.env.LLM_STUB_API_KEY ?? null;
  const log = opts.log ?? ((l) => console.log(`[llm-stub] ${l}`));
  const state = { calls: 0, lastAuthorization: null, lastBody: null, startedAt: new Date().toISOString() };
  const pending = new Set();

  async function chatCompletions(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        json(res, 413, { error: { message: e.message, type: 'invalid_request_error' } }, { connection: 'close' });
      } else {
        json(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } });
      }
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(res, 400, { error: { message: 'body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }
    state.lastBody = body;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const seams = parseStubSeams(lastUserContent(messages));
    if (seams.delayMs > 0 && !(await sleepUnlessDropped(seams.delayMs, res, pending))) return;
    if (seams.status !== null) {
      json(res, seams.status, { error: { message: `stub forced status ${seams.status}`, type: 'stub_error' } });
      return;
    }
    let toolName;
    try {
      toolName = stubToolChoiceName(body.tools, body.tool_choice);
    } catch (e) {
      json(res, 400, { error: { message: e.message, type: 'invalid_request_error', param: 'tools' } });
      return;
    }
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    const id = 'chatcmpl-stub-' + createHash('sha256').update(JSON.stringify(messages) + '|' + String(maxTokens ?? '')).digest('hex').slice(0, 16);
    const created = Math.floor(Date.now() / 1000);
    const requestedModel = typeof body.model === 'string' && body.model ? body.model : model;
    const head = { id, created, model: requestedModel };
    const chunk = (delta, finish) => ({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });

    let message;
    let finishReason;
    let usage;
    let deltas;
    if (toolName !== null) {
      const tc = stubToolCalls(messages, toolName, seams.text);
      message = { role: 'assistant', content: null, tool_calls: tc.toolCalls };
      finishReason = 'tool_calls';
      usage = stubUsage(messages, tc.completionTokens);
      deltas = [{ tool_calls: tc.toolCalls.map((c, index) => ({ index, ...c })) }];
    } else {
      const reply = stubReply(seams.text, Number(maxTokens));
      message = { role: 'assistant', content: reply.content };
      finishReason = reply.finishReason;
      usage = stubUsage(messages, reply.completionTokens);
      deltas = reply.content.split(' ').map((w, i) => ({ content: (i === 0 ? '' : ' ') + w }));
    }
    state.calls++;
    if (body.stream === true) {
      writeSse(res, [
        chunk({ role: 'assistant', content: '' }, null),
        ...deltas.map((d) => chunk(d, null)),
        chunk({}, finishReason),
        { ...head, object: 'chat.completion.chunk', choices: [], usage },
        '[DONE]',
      ]);
      return;
    }
    json(res, 200, {
      ...head, object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      usage,
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      if (path === '/healthz') { json(res, 200, { ok: true, model, calls: state.calls, startedAt: state.startedAt }); return; }
      if (path.startsWith('/v1/')) {
        const auth = req.headers.authorization ?? null;
        state.lastAuthorization = auth;
        if (!allowAnon) {
          const bearer = (/^Bearer\s+(.*)$/is.exec(String(auth ?? ''))?.[1] ?? '').trim();
          const deny = !bearer ? 'missing bearer' : expectedKey && bearer !== expectedKey ? 'bad key' : null;
          if (deny) {
            json(res, 401, { error: { message: deny, type: 'invalid_request_error', code: 'invalid_api_key' } }, { 'www-authenticate': 'Bearer' });
            return;
          }
        }
      }
      if (path === '/v1/models' && method === 'GET') {
        json(res, 200, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'dkg-devnet-stub' }] });
        return;
      }
      if (path === '/v1/chat/completions' && method === 'POST') { await chatCompletions(req, res); return; }
      json(res, 404, { error: { message: `no route ${method} ${path}`, type: 'invalid_request_error' } });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, 500, { error: { message: String((e && e.message) || e), type: 'server_error' } });
    }
  });

  return {
    server, state, model,
    listen(port = Number(process.env.LLM_STUB_PORT) || DEFAULT_PORT, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        if (!isLoopbackHost(host)) { reject(new Error(`llm-stub binds loopback only (got host ${host})`)); return; }
        const onError = (e) => reject(e);
        server.once('error', onError);
        try {
          server.listen(port, host, () => {
            server.removeListener('error', onError);
            const addr = server.address();
            const p = typeof addr === 'object' && addr ? addr.port : port;
            log(`listening on http://${host}:${p}/v1 (model=${model}, auth=${allowAnon ? 'anon' : expectedKey ? 'pinned key' : 'any bearer'})`);
            resolve(p);
          });
        } catch (e) {
          server.removeListener('error', onError);
          reject(e);
        }
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const p of pending) p.abort(); // abort() deletes its own entry; Set iteration tolerates that
        server.closeIdleConnections();
      });
    },
  };
}

const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const stub = createLlmStub();
  stub.listen().catch((e) => { console.error(`[llm-stub] failed to listen: ${(e && e.message) || e}`); process.exit(1); });
  const bye = () => { stub.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
