import { describe, expect, it, vi } from 'vitest';
import {
  createDragRemoteHandler,
  type DragRemoteHandlerDeps,
  type DragRemoteRequest,
} from '../src/drag/remote-handler.js';

const VALID_REQUEST: DragRemoteRequest = {
  question: 'Which supplier was flagged?',
  contextGraphId: 'public-supply-cg',
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode(value: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
}

function makeDeps(overrides: Partial<DragRemoteHandlerDeps> = {}) {
  const isContextGraphPublic = overrides.isContextGraphPublic
    ?? vi.fn(async (_contextGraphId: string) => true);
  const answerLocal = overrides.answerLocal
    ?? vi.fn(async (_request: DragRemoteRequest, _opts: { forceKeyword: true }) => ({ answer: 'grounded' }));
  const deps: DragRemoteHandlerDeps = { isContextGraphPublic, answerLocal };
  return { deps, isContextGraphPublic, answerLocal };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createDragRemoteHandler', () => {
  it('serves a public context graph through keyword-only retrieval and clamps remote work bounds', async () => {
    const { deps, isContextGraphPublic, answerLocal } = makeDeps();
    const handler = createDragRemoteHandler(deps, {
      maxCitations: 3,
      maxKas: 4,
    });

    const response = decode(await handler(encode({
      ...VALID_REQUEST,
      maxCitations: 999,
      maxKas: 999,
    }), 'peer-a'));

    expect(response).toEqual({ answer: 'grounded' });
    expect(isContextGraphPublic).toHaveBeenCalledOnce();
    expect(isContextGraphPublic).toHaveBeenCalledWith(VALID_REQUEST.contextGraphId);
    expect(answerLocal).toHaveBeenCalledOnce();
    expect(answerLocal).toHaveBeenCalledWith(
      {
        ...VALID_REQUEST,
        maxCitations: 3,
        maxKas: 4,
      },
      { forceKeyword: true },
    );
  });

  it.each([
    {
      name: 'the graph is private',
      publicCheck: async (_contextGraphId: string) => false,
      error: 'not public',
    },
    {
      name: 'the authoritative public check fails',
      publicCheck: async (_contextGraphId: string) => {
        throw new Error('policy lookup failed');
      },
      error: 'policy lookup failed',
    },
  ])('fails closed without answering when $name', async ({ publicCheck, error }) => {
    const { deps, answerLocal } = makeDeps({ isContextGraphPublic: publicCheck });
    const handler = createDragRemoteHandler(deps);

    const response = decode(await handler(encode(VALID_REQUEST), 'peer-a'));

    expect(response.error).toContain(error);
    expect(answerLocal).not.toHaveBeenCalled();
  });

  it.each([
    { question: undefined, label: 'missing' },
    { question: 42, label: 'non-string' },
    { question: '', label: 'empty' },
    { question: '   ', label: 'whitespace-only' },
  ])('rejects a $label question before checking graph visibility', async ({ question }) => {
    const { deps, isContextGraphPublic, answerLocal } = makeDeps();
    const handler = createDragRemoteHandler(deps);

    const response = decode(await handler(encode({
      ...VALID_REQUEST,
      question,
    }), 'peer-a'));

    expect(response.error).toContain('bounded question + contextGraphId');
    expect(isContextGraphPublic).not.toHaveBeenCalled();
    expect(answerLocal).not.toHaveBeenCalled();
  });

  it('rejects oversized questions and payloads before answering', async () => {
    const questionDeps = makeDeps();
    const questionHandler = createDragRemoteHandler(questionDeps.deps, { maxQuestionChars: 8 });

    const questionResponse = decode(await questionHandler(encode({
      ...VALID_REQUEST,
      question: '123456789',
    }), 'peer-a'));

    expect(questionResponse.error).toContain('bounded question + contextGraphId');
    expect(questionDeps.isContextGraphPublic).not.toHaveBeenCalled();
    expect(questionDeps.answerLocal).not.toHaveBeenCalled();

    const payloadDeps = makeDeps();
    const payloadHandler = createDragRemoteHandler(payloadDeps.deps, { maxPayloadBytes: 16 });
    const payloadResponse = decode(await payloadHandler(encode(VALID_REQUEST), 'peer-a'));

    expect(payloadResponse.error).toContain('request payload too large');
    expect(payloadDeps.isContextGraphPublic).not.toHaveBeenCalled();
    expect(payloadDeps.answerLocal).not.toHaveBeenCalled();
  });

  it('enforces per-peer and node-wide rate limits', async () => {
    const peerDeps = makeDeps();
    const peerHandler = createDragRemoteHandler(peerDeps.deps, {
      maxPerPeerPerMinute: 1,
      maxGlobalPerMinute: 10,
    });

    expect(decode(await peerHandler(encode(VALID_REQUEST), 'peer-a'))).toEqual({ answer: 'grounded' });
    expect(decode(await peerHandler(encode(VALID_REQUEST), 'peer-a'))).toEqual({ error: 'dRAG: peer rate limited' });
    expect(peerDeps.answerLocal).toHaveBeenCalledOnce();

    const globalDeps = makeDeps();
    const globalHandler = createDragRemoteHandler(globalDeps.deps, {
      maxPerPeerPerMinute: 10,
      maxGlobalPerMinute: 1,
    });

    expect(decode(await globalHandler(encode(VALID_REQUEST), 'peer-a'))).toEqual({ answer: 'grounded' });
    expect(decode(await globalHandler(encode(VALID_REQUEST), 'peer-b'))).toEqual({ error: 'dRAG: node rate limited' });
    expect(globalDeps.answerLocal).toHaveBeenCalledOnce();
  });

  it('returns busy while the configured concurrency slot is occupied', async () => {
    const visibility = deferred<boolean>();
    const { deps, isContextGraphPublic, answerLocal } = makeDeps({
      isContextGraphPublic: vi.fn(() => visibility.promise),
    });
    const handler = createDragRemoteHandler(deps, { maxConcurrent: 1 });

    const first = handler(encode(VALID_REQUEST), 'peer-a');
    expect(isContextGraphPublic).toHaveBeenCalledOnce();

    const second = decode(await handler(encode(VALID_REQUEST), 'peer-b'));
    expect(second).toEqual({ error: 'dRAG: responder busy' });
    expect(answerLocal).not.toHaveBeenCalled();

    visibility.resolve(true);
    expect(decode(await first)).toEqual({ answer: 'grounded' });
    expect(answerLocal).toHaveBeenCalledOnce();
  });
});
