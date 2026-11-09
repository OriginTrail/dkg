/**
 * The seller's model for the marketplace lane: a small OpenAI-compatible
 * server on loopback, so the devnet sells without downloading a model.
 * `POST /v1/chat/completions` answers each backend model with one fixed
 * sentence and fixed token counts (9 in, 6 out), so every call costs the
 * same and the specs can say exactly what the UI should show.
 * `GET /v1/models` lists the models, `GET /health` answers once it listens,
 * and `GET /calls` counts the completions served per model.
 *
 * Started by `playwright.marketplace.config.ts` as its first web server:
 *   pnpm exec tsx e2e/marketplace/stub-backend.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PORTS, SERVICES, STUB_COMPLETION_TOKENS, STUB_PROMPT_TOKENS, stubAnswerOf } from './topology.js';

const MODELS = new Set<string>(SERVICES.map((s) => s.backendModel));
const calls = new Map<string, number>();
const MAX_BODY_BYTES = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && path === '/calls') return send(res, 200, Object.fromEntries(calls));
  if (req.method === 'GET' && path === '/v1/models') {
    return send(res, 200, { object: 'list', data: [...MODELS].map((id) => ({ id, object: 'model', owned_by: 'devnet-stub' })) });
  }
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    bodyOf(req).then((raw) => {
      const call = raw as { model?: unknown; messages?: unknown };
      if (typeof call.model !== 'string' || !MODELS.has(call.model)) {
        return send(res, 404, { error: { message: `no model ${String(call.model)}`, type: 'invalid_request_error' } });
      }
      if (!Array.isArray(call.messages) || call.messages.length === 0) {
        return send(res, 400, { error: { message: 'messages are required', type: 'invalid_request_error' } });
      }
      calls.set(call.model, (calls.get(call.model) ?? 0) + 1);
      return send(res, 200, {
        id: `chatcmpl-stub-${calls.get(call.model)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: call.model,
        choices: [{ index: 0, message: { role: 'assistant', content: stubAnswerOf(call.model) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: STUB_PROMPT_TOKENS, completion_tokens: STUB_COMPLETION_TOKENS, total_tokens: STUB_PROMPT_TOKENS + STUB_COMPLETION_TOKENS },
      });
    }).catch((err: unknown) => send(res, 400, { error: { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error' } }));
    return;
  }
  send(res, 404, { error: { message: `no route ${req.method} ${path}`, type: 'invalid_request_error' } });
});

server.listen(PORTS.stub, '127.0.0.1', () => {
  console.log(`[marketplace-stub] OpenAI-compatible stub on http://127.0.0.1:${PORTS.stub}/v1 (${[...MODELS].join(', ')})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
