import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_LIST_DEFAULT_LIMIT,
  CONTEXT_GRAPH_LIST_ERROR_CODES,
  CONTEXT_GRAPH_LIST_MAX_LIMIT,
  CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
  CONTEXT_GRAPH_LIST_WIRE_KEYS,
  decodeContextGraphListErrorResponse,
  serializeContextGraphListOptions,
  type ContextGraphListPageOptions,
} from '../src/context-graph-list-wire.js';

describe('context-graph list wire contract', () => {
  it('gives every option one canonical wire spelling', () => {
    const expected = {
      limit: 'limit',
      cursor: 'cursor',
      projection: 'projection',
      subscribed: 'subscribed',
      synced: 'synced',
      onChain: 'onChain',
      q: 'q',
    } as const satisfies Record<keyof ContextGraphListPageOptions, string>;

    expect(CONTEXT_GRAPH_LIST_WIRE_KEYS).toEqual(expected);
    expect(serializeContextGraphListOptions({
      limit: 25,
      cursor: 'opaque',
      projection: 'summary',
      subscribed: false,
      synced: true,
      onChain: false,
      q: 'supply',
    })).toBe(
      'limit=25&cursor=opaque&projection=summary&subscribed=false&synced=true&onChain=false&q=supply',
    );
  });

  it('owns the bounded page policy and decodes only canonical error codes', () => {
    expect(CONTEXT_GRAPH_LIST_DEFAULT_LIMIT).toBe(50);
    expect(CONTEXT_GRAPH_LIST_MAX_LIMIT).toBe(100);
    expect(CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES).toBe(64 * 1024);
    expect(decodeContextGraphListErrorResponse({
      error: 'changed',
      code: CONTEXT_GRAPH_LIST_ERROR_CODES.snapshotChanged,
    })).toEqual({
      error: 'changed',
      code: CONTEXT_GRAPH_LIST_ERROR_CODES.snapshotChanged,
    });
    expect(decodeContextGraphListErrorResponse({
      error: 'unknown',
      code: 'CONTEXT_GRAPH_LIST_NEW_ERROR',
    })).toBeUndefined();
  });
});
