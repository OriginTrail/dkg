import { describe, expect, it } from 'vitest';
import { canonicalContextGraphAgentDid, contextGraphBelongsToAgent } from '../src/context-graph-membership.js';

const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const did = `did:dkg:agent:${address}`;
describe('context graph caller membership', () => {
  it.each([did, address, address.toUpperCase(), `"${did}"`, `<${did}>`, `DID:DKG:AGENT:${address.toUpperCase()}`])('matches the same curator identity %s', (curator) => {
    expect(contextGraphBelongsToAgent({ curator }, did)).toBe(true);
  });
  it('lets explicit caller involvement override legacy curator data in both directions', () => {
    expect(contextGraphBelongsToAgent({ callerInvolved: true, curator: 'other' }, null)).toBe(true);
    expect(contextGraphBelongsToAgent({ callerInvolved: false, curator: did }, did)).toBe(false);
  });
  it('does not invent membership from incomplete or foreign identity', () => {
    for (const graph of [{}, { curator: '' }, { curator: 'foreign' }]) expect(contextGraphBelongsToAgent(graph, did)).toBe(false);
    expect(contextGraphBelongsToAgent({ curator: did }, null)).toBe(false);
    expect(canonicalContextGraphAgentDid('did:dkg:agent:PeerMixedCase')).toBe('did:dkg:agent:PeerMixedCase');
  });
});
