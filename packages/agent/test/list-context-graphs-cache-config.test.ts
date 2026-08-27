import { describe, expect, it } from 'vitest';
import { DKGAgentBase } from '../src/dkg-agent-base.js';

describe('context-graph catalogue cache configuration', () => {
  it('uses a 60-second cache window by default', () => {
    expect(DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS).toBe(60_000);
  });
});
