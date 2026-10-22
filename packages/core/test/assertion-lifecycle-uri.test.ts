import { describe, expect, it } from 'vitest';
import { assertionLifecycleUri, decodeAssertionLifecycleUriOwner } from '../src/constants.js';

describe('scoped assertion lifecycle URI codec', () => {
  it.each([
    ['cg', 'PeerOwner', 'asset', undefined],
    ['cg', 'peerowner', 'asset', 'Team'],
    ['wallet/cg:part', 'did:dkg:agent:Peer:Owner', 'asset:part', 'team'],
    ['cg', '0xAbCd', 'asset', '0xAbCd'],
  ] as const)('round-trips lexical owner for %s %s %s %s', (contextGraphId, owner, name, subGraphName) => {
    const uri = assertionLifecycleUri(contextGraphId, owner, name, subGraphName);
    expect(decodeAssertionLifecycleUriOwner(uri, { contextGraphId, name, subGraphName })).toBe(owner);
  });
  it('preserves the existing root and subgraph wire format', () => {
    expect(assertionLifecycleUri('cg', 'PeerOwner', 'asset')).toBe('urn:dkg:assertion:cg:PeerOwner:asset');
    expect(assertionLifecycleUri('cg', 'PeerOwner', 'asset', 'Team')).toBe('urn:dkg:assertion:cg:Team:PeerOwner:asset');
  });
  it.each([
    ['urn:dkg:assertion:other:owner:asset', { contextGraphId: 'cg', name: 'asset' }],
    ['urn:dkg:assertion:cg:owner:other', { contextGraphId: 'cg', name: 'asset' }],
    ['urn:dkg:assertion:cg:Team:owner:asset', { contextGraphId: 'cg', name: 'asset', subGraphName: 'Other' }],
    ['urn:dkg:assertion:cg::asset', { contextGraphId: 'cg', name: 'asset' }],
    ['urn:other:cg:owner:asset', { contextGraphId: 'cg', name: 'asset' }],
  ] as const)('refuses a mismatched or ownerless URI %s', (uri, scope) => {
    expect(decodeAssertionLifecycleUriOwner(uri, scope)).toBeUndefined();
  });
  it('requires the caller to establish scope when colon-bearing owners are lexically ambiguous', () => {
    const uri = assertionLifecycleUri('cg', 'owner', 'asset', 'Team');
    expect(decodeAssertionLifecycleUriOwner(uri, { contextGraphId: 'cg', name: 'asset', subGraphName: 'Team' })).toBe('owner');
    expect(decodeAssertionLifecycleUriOwner(uri, { contextGraphId: 'cg', name: 'asset' })).toBe('Team:owner');
  });
});
