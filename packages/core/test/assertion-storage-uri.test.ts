import { describe, expect, it } from 'vitest';
import {
  contextGraphAssertionUri,
  parseContextGraphAssertionStorageUri,
  parseContextGraphAssertionUri,
} from '../src/constants.js';
import {
  assertionScopedGraphParentUri,
  assertionScopedGraphUri,
} from '../src/assertion-scoped-graphs.js';

const PEER_ID = '12D3KooWLegacyPeer';
const EVM_ADDRESS = '0x0000000000000000000000000000000000000001';

describe('historical assertion storage inverse', () => {
  it.each([undefined, 'reports'])('retains peer-ID placement with subgraph %s', (subGraphName) => {
    const uri = contextGraphAssertionUri('team/assertion/private', PEER_ID, 'draft', subGraphName);
    expect(parseContextGraphAssertionStorageUri(uri)).toEqual({
      scope: `team/assertion/private${subGraphName ? `/${subGraphName}` : ''}`,
      agentAddress: PEER_ID,
      name: 'draft',
    });
    expect(parseContextGraphAssertionUri(uri)).toBeUndefined();
  });

  it('preserves the separate EVM cryptographic-coordinate contract', () => {
    const uri = contextGraphAssertionUri('team/private', EVM_ADDRESS, 'draft');
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: 'team/private', agentAddress: EVM_ADDRESS, name: 'draft',
    });
    expect(parseContextGraphAssertionUri(assertionScopedGraphUri(uri, 'urn:graph'))).toBeUndefined();
    expect(parseContextGraphAssertionUri(contextGraphAssertionUri('team/private', '0x123', 'draft')))
      .toBeUndefined();
  });

  it.each([
    'urn:other:assertion/peer/name',
    'did:dkg:context-graph:/assertion/peer/name',
    'did:dkg:context-graph:team/assertion//name',
    'did:dkg:context-graph:team/assertion/peer/',
    'did:dkg:context-graph:team/assertion/peer/name/extra',
  ])('rejects incomplete or unrelated storage coordinate %s', (uri) => {
    expect(parseContextGraphAssertionStorageUri(uri)).toBeUndefined();
  });
});

describe('assertion named-child parent inverse', () => {
  it.each(['urn:graph', 'https://example.org/graph/a?b=1', 'urn:café'])('round-trips named graph %s', (graph) => {
    const parent = contextGraphAssertionUri('team/_named_graph/private', PEER_ID, 'draft');
    expect(assertionScopedGraphParentUri(assertionScopedGraphUri(parent, graph))).toBe(parent);
  });

  it('does not manufacture a child for the default graph', () => {
    const parent = contextGraphAssertionUri('team/private', PEER_ID, 'draft');
    expect(assertionScopedGraphUri(parent, '')).toBe(parent);
    expect(assertionScopedGraphParentUri(parent)).toBeUndefined();
  });

  it.each(['', 'a', 'dXJuOmdyYXBo=', 'dXJuOmdyYXBo/extra', '%FF'])('rejects noncanonical named-child coordinate %s', (encoded) => {
    const parent = contextGraphAssertionUri('team/private', PEER_ID, 'draft');
    expect(assertionScopedGraphParentUri(`${parent}/_named_graph/${encoded}`)).toBeUndefined();
  });
});
