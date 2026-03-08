import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleNodeUIRequest } from '../src/api.js';

function createMockReq(opts: {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): { req: IncomingMessage; url: URL } {
  const stream = Readable.from(opts.body != null ? [Buffer.from(opts.body, 'utf8')] : []);
  const req = stream as unknown as IncomingMessage & {
    method: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.headers = opts.headers ?? {};
  return {
    req: req as IncomingMessage,
    url: new URL(`http://localhost${opts.path}`),
  };
}

function createMockRes(): {
  res: ServerResponse;
  state: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
} {
  const chunks: Buffer[] = [];
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
  };

  const res: any = {
    writableEnded: false,
    destroyed: false,
    writeHead(code: number, headers?: Record<string, string>) {
      state.statusCode = code;
      state.headers = headers ?? {};
      return res;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
      }
      state.body = Buffer.concat(chunks).toString('utf8');
      res.writableEnded = true;
      return res;
    },
  };

  return { res: res as ServerResponse, state };
}

function parseJsonBody(body: string): any {
  return body ? JSON.parse(body) : {};
}

describe('handleNodeUIRequest Stage 5 memory/publication routes', () => {
  it('returns session graph delta for valid session/turn parameters', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn().mockResolvedValue({
        mode: 'delta',
        sessionId: 'session-1',
        turnId: 'turn-2',
        watermark: {
          baseTurnId: 'turn-1',
          previousTurnId: 'turn-1',
          appliedTurnId: 'turn-2',
          latestTurnId: 'turn-2',
          turnIndex: 2,
          turnCount: 2,
        },
        triples: [{ subject: 's', predicate: 'p', object: 'o' }],
      }),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=turn-1',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(memoryManager.getSessionGraphDelta).toHaveBeenCalledWith('session-1', 'turn-2', { baseTurnId: 'turn-1' });
    expect(parseJsonBody(state.body)).toMatchObject({ mode: 'delta', turnId: 'turn-2' });
  });

  it('returns 400 for invalid turn id in graph-delta route', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=bad/turn',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Missing or invalid "turnId"' });
    expect(memoryManager.getSessionGraphDelta).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid baseTurnId in graph-delta route', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=bad/base',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Invalid "baseTurnId" format' });
    expect(memoryManager.getSessionGraphDelta).not.toHaveBeenCalled();
  });

  it('returns publication status for a valid session id', async () => {
    const memoryManager = {
      getSessionPublicationStatus: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        workspaceTripleCount: 12,
        dataTripleCount: 3,
        scope: 'enshrined',
        rootEntityCount: 4,
      }),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/publication',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(memoryManager.getSessionPublicationStatus).toHaveBeenCalledWith('session-1');
    expect(parseJsonBody(state.body)).toMatchObject({
      sessionId: 'session-1',
      scope: 'enshrined',
    });
  });

  it('publishes a session with selected roots and clearAfter option', async () => {
    const memoryManager = {
      publishSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        rootEntityCount: 1,
        status: 'confirmed',
        tripleCount: 5,
        publication: {
          sessionId: 'session-1',
          workspaceTripleCount: 5,
          dataTripleCount: 5,
          scope: 'enshrined',
          rootEntityCount: 1,
        },
      }),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/sessions/session-1/publish',
      body: JSON.stringify({
        rootEntities: ['urn:dkg:chat:msg:m-1'],
        clearAfter: true,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(memoryManager.publishSession).toHaveBeenCalledWith('session-1', {
      rootEntities: ['urn:dkg:chat:msg:m-1'],
      clearWorkspaceAfter: true,
    });
    expect(parseJsonBody(state.body)).toMatchObject({
      sessionId: 'session-1',
      status: 'confirmed',
    });
  });

  it('returns 400 for invalid session id in publication route', async () => {
    const memoryManager = {
      getSessionPublicationStatus: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1%2Fbad/publication',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Invalid session ID' });
    expect(memoryManager.getSessionPublicationStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid session id in publish route', async () => {
    const memoryManager = {
      publishSession: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/sessions/session-1%2Fbad/publish',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Invalid session ID' });
    expect(memoryManager.publishSession).not.toHaveBeenCalled();
  });

  it('returns 400 for session-scope publish validation errors', async () => {
    const memoryManager = {
      publishSession: vi.fn().mockRejectedValue(
        new Error('Selected root entities are not part of session session-1'),
      ),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/sessions/session-1/publish',
      body: JSON.stringify({ rootEntities: ['urn:dkg:chat:msg:other'] }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({
      error: 'Selected root entities are not part of session session-1',
    });
  });

  it('returns 500 for unexpected publish failures', async () => {
    const memoryManager = {
      publishSession: vi.fn().mockRejectedValue(new Error('storage offline')),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/sessions/session-1/publish',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(500);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'storage offline' });
  });
});

describe('handleNodeUIRequest Stage 5 sessionId validation', () => {
  it('rejects invalid session id in /api/chat-assistant payload', async () => {
    const chatAssistant = {
      answer: vi.fn(),
      answerStream: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/chat-assistant',
      body: JSON.stringify({
        message: 'hello',
        sessionId: 'bad/session-id',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      chatAssistant,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Invalid "sessionId" format' });
    expect(chatAssistant.answer).not.toHaveBeenCalled();
  });
});
