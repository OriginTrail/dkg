import { describe, expect, it } from 'vitest';
import {
  AGENT_DID_PREFIX,
  canonicalAgentDidSubject,
  isEvmAgentDidSubject,
  normalizeAgentDid,
  toAgentDid,
} from '../src/agent-identity.js';

describe('canonical agent identity', () => {
  const lowerAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const mixedAddress = '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd';

  it('canonicalizes bare and full EVM identities through one contract', () => {
    expect(canonicalAgentDidSubject(mixedAddress)).toBe(lowerAddress);
    expect(isEvmAgentDidSubject(mixedAddress)).toBe(true);
    expect(normalizeAgentDid(`${AGENT_DID_PREFIX}${mixedAddress}`))
      .toBe(`${AGENT_DID_PREFIX}${lowerAddress}`);
    expect(toAgentDid(mixedAddress)).toBe(`${AGENT_DID_PREFIX}${lowerAddress}`);
    expect(toAgentDid(`${AGENT_DID_PREFIX}${mixedAddress}`))
      .toBe(`${AGENT_DID_PREFIX}${lowerAddress}`);
  });

  it('preserves case-sensitive peer subjects and unrelated DIDs', () => {
    const peer = '12D3KooWCaseSensitivePeerABC';
    expect(canonicalAgentDidSubject(peer)).toBe(peer);
    expect(isEvmAgentDidSubject(peer)).toBe(false);
    expect(toAgentDid(peer)).toBe(`${AGENT_DID_PREFIX}${peer}`);
    expect(normalizeAgentDid('did:web:Example.COM')).toBe('did:web:Example.COM');
  });
});
