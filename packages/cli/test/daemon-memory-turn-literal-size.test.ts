import { describe, expect, it, vi } from 'vitest';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
} from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
    return res;
  };
  res.setHeader = (key: string, value: string) => {
    res.headers[key] = value;
  };
  res.end = (body?: string) => {
    res.body = body ?? '';
    res.writableEnded = true;
  };
  return res;
}

function fakeReq(body: unknown) {
  return {
    method: 'POST',
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

const noopTracker = {
  start() {},
  complete() {},
  fail() {},
  setCost() {},
  setTxHash() {},
  trackPhase: (_ctx: unknown, _phase: unknown, fn: () => unknown) => fn(),
};

const ACCEPT_PROBE = {
  exists: true,
  hasLocalContent: true,
  declarationFound: true,
  accessPolicy: 'public',
  callerAuthorized: true,
};

describe('POST /api/memory/turn RDF literal normalization', () => {
  it('chunks oversized schema:text emitted from markdown frontmatter before WM insert', async () => {
    const inserted: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
    const events: unknown[] = [];
    const agent = {
      peerId: 'peer-memory-turn',
      probeContextGraphWritePreflight: vi.fn(async () => ACCEPT_PROBE),
      store: {
        insert: vi.fn(async (quads: typeof inserted) => {
          inserted.push(...quads);
        }),
      },
    };
    const res = fakeRes();
    const url = new URL('http://127.0.0.1/api/memory/turn');
    const largeBody = 'computer history '.repeat(4_000);
    const markdown = [
      '---',
      'id: http://example.org/turn/frontmatter-text',
      'text: |-',
      `  ${largeBody}`,
      '---',
      '# Conversation turn',
    ].join('\n');

    await handleMemoryRoutes({
      req: fakeReq({
        contextGraphId: 'memory-turn-cg',
        layer: 'wm',
        markdown,
      }),
      res,
      agent,
      tracker: noopTracker,
      config: {},
      fileStore: {
        put: vi.fn(async (bytes: Buffer, contentType: string) => ({
          keccak256: 'abc123',
          size: bytes.length,
          contentType,
        })),
      },
      vectorStore: { insert: vi.fn() },
      embeddingProvider: null,
      path: url.pathname,
      url,
      requestAgentAddress: `0x${'12'.repeat(20)}`,
      emitMemoryGraphChanged: (event: unknown) => {
        events.push(event);
      },
    } as unknown as RequestContext);

    expect(res.statusCode, res.body).toBe(200);
    const response = JSON.parse(res.body);
    expect(agent.store.insert).toHaveBeenCalledTimes(1);
    expect(inserted.some((quad) =>
      quad.subject === response.turnUri &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(inserted.some((quad) =>
      quad.subject === response.turnUri &&
      quad.predicate === DKG_HAS_TEXT_BODY
    )).toBe(true);
    expect(inserted.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    expect(response.totalQuads).toBe(inserted.length);
    expect(events).toHaveLength(1);
  });
});
