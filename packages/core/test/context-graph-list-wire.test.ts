import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_LIST_WIRE_KEYS,
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
});
