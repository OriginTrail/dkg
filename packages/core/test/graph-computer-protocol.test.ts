import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AGENT_DELEGATION_ABI_TYPES, agentDelegationAbiValues, agentHttpRequestSigningMessage,
  boundOperationInvocationScope, canonicalProgramInputs, protocolSha256 } from '../src/graph-computer-protocol.js';

const address = `0x${'AB'.repeat(20)}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
describe('shared Graph Computer protocol bytes', () => {
  it('preserves v3 and v4 scope vectors and canonical input hashes', () => {
    const request = { version: 3 as const, contextGraphId: 'tenant', operationIri: 'urn:operation', invocationId: 'ABC' };
    expect(boundOperationInvocationScope(request, 'peer')).toBe('dkg.semantic-runtime.bound-operation.v3:' + sha256('[3,"bound-operation","tenant","urn:operation","abc","peer"]'));
    const inputs = [{ z: 2, a: ['é', -0] }];
    const canonical = '[{"a":["é",0],"z":2}]';
    expect(canonicalProgramInputs(inputs)).toBe(canonical);
    expect(boundOperationInvocationScope({ ...request, version: 4, inputs }, 'peer'))
      .toBe('dkg.semantic-runtime.bound-operation.v4:' + sha256(JSON.stringify([4, 'bound-operation', 'tenant', 'urn:operation', 'abc', 'peer', sha256(canonical)])));
    expect(protocolSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('preserves delegation ABI field order, absent fields and timestamp truncation', () => {
    expect(AGENT_DELEGATION_ABI_TYPES).toEqual(['string', 'string', 'address', 'string', 'string', 'uint256', 'uint256']);
    expect(agentDelegationAbiValues({ agentAddress: address, scope: 'scope', issuedAtMs: 12.7 }))
      .toEqual(['dkg.agent-delegation.v2', 'scope', address.toLowerCase(), '', '', 12, 0]);
    expect(agentDelegationAbiValues({ agentAddress: address, scope: 'scope', issuedAtMs: 12, expiresAtMs: 20.9, delegateePeerId: 'peer', delegateeOpKey: address }))
      .toEqual(['dkg.agent-delegation.v2', 'scope', address.toLowerCase(), 'peer', address.toLowerCase(), 12, 20]);
  });
  const http = { agentAddress: address, targetPeerId: 'peer', method: 'POST', path: '/api/programs/execute?a=%2F&b=1',
    contentType: 'application/json', body: new TextEncoder().encode('{"é":1}'), timestamp: '1800000000000', nonce: 'ab'.repeat(24) };
  it('preserves the exact HTTP preimage including encoded path and UTF-8 body', () => {
    expect(agentHttpRequestSigningMessage(http)).toBe(JSON.stringify(['DKG-HTTP-REQUEST-V1', address.toLowerCase(), 'peer', 'POST', http.path,
      'application/json', sha256('{"é":1}'), '1800000000000', 'ab'.repeat(24)]));
  });
  it.each([{ agentAddress: 'bad' }, { method: 'post' }, { path: '//other/' }, { path: '/a#b' }, { path: '/a\rb' },
    { targetPeerId: '' }, { targetPeerId: 'a\nb' }, { contentType: 'a\rb' }, { timestamp: '01' }, { timestamp: '9999999999999999' }, { nonce: 'INVALID' }])
  ('rejects ambiguous HTTP signing input %j', change => expect(() => agentHttpRequestSigningMessage({ ...http, ...change })).toThrow());
  it.each([{}, [NaN], [undefined], [new Date()], ['\uD800'], ['x'.repeat(65536)], Array.from({ length: 2 }, () => undefined)])
  ('rejects noncanonical input %j', input => expect(() => canonicalProgramInputs(input)).toThrow());
});
