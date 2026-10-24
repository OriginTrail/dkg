import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  describeContextGraphOnChainIdResolution,
  parseContextGraphOnChainIdReference,
  refusesPrivateContextGraphByOnChainId,
  type ContextGraphOnChainIdRefusal,
  type ResolvedContextGraphOnChainId,
} from '../src/index.js';

const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes('gnosis-fun-facts')).toLowerCase();

describe('on-chain Context Graph id syntax', () => {
  it('reads 32, #32 and the JSON number 32 as on-chain Context Graph 32', () => {
    expect(parseContextGraphOnChainIdReference('32')).toEqual({ onChainId: '32', explicit: false });
    expect(parseContextGraphOnChainIdReference('#32')).toEqual({ onChainId: '32', explicit: true });
    expect(parseContextGraphOnChainIdReference(' #32 ')).toEqual({ onChainId: '32', explicit: true });
    expect(parseContextGraphOnChainIdReference(32)).toEqual({ onChainId: '32', explicit: true });
    const maxUint256 = ethers.MaxUint256.toString(10);
    expect(parseContextGraphOnChainIdReference(`#${maxUint256}`)).toEqual({ onChainId: maxUint256, explicit: true });
  });

  it('leaves everything else to be used as an ordinary id', () => {
    for (const value of [
      '0', '#0', '032', '#032', '-1', '3.2', '#', '', ' ', '##32', '#-32', '# 32', '0x20',
      'acme', '#acme', `${ethers.MaxUint256 + 1n}`, '9'.repeat(79),
      0, -3, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null, undefined, {}, ['32'], 32n,
    ]) {
      expect(parseContextGraphOnChainIdReference(value), String(value)).toBeNull();
    }
  });
});

describe('the private rule for an on-chain id', () => {
  const resolved = (contextGraphId: string, isPrivate: boolean): ResolvedContextGraphOnChainId => ({
    kind: 'resolved',
    onChainId: '32',
    nameHash: NAME_HASH,
    contextGraphId,
    private: isPrivate,
  });

  it('refuses everyone when the node holds only the name hash of a private graph', () => {
    for (const admission of [undefined, 'allowed', 'denied', 'unavailable'] as const) {
      expect(refusesPrivateContextGraphByOnChainId(resolved(NAME_HASH, true), admission)).toBe(true);
    }
  });

  it('lets the caller\'s read authority decide when the node holds the cleartext id', () => {
    expect(refusesPrivateContextGraphByOnChainId(resolved('gnosis-fun-facts', true), 'denied')).toBe(true);
    expect(refusesPrivateContextGraphByOnChainId(resolved('gnosis-fun-facts', true), 'allowed')).toBe(false);
    expect(refusesPrivateContextGraphByOnChainId(resolved('gnosis-fun-facts', true), 'unavailable')).toBe(false);
    expect(refusesPrivateContextGraphByOnChainId(resolved('gnosis-fun-facts', true))).toBe(false);
  });

  it('never refuses a public graph', () => {
    for (const contextGraphId of [NAME_HASH, 'gnosis-fun-facts']) {
      for (const admission of [undefined, 'allowed', 'denied', 'unavailable'] as const) {
        expect(refusesPrivateContextGraphByOnChainId(resolved(contextGraphId, false), admission)).toBe(false);
      }
    }
  });
});

describe('on-chain Context Graph id messages', () => {
  const say = (resolution: ResolvedContextGraphOnChainId | ContextGraphOnChainIdRefusal) => (
    describeContextGraphOnChainIdResolution(resolution)
  );

  it('names the graph an id resolved to, and a retired numeric subscription', () => {
    expect(say({ kind: 'resolved', onChainId: '32', nameHash: NAME_HASH, contextGraphId: NAME_HASH, private: false }))
      .toBe(`On-chain Context Graph #32 is Context Graph ${NAME_HASH.slice(0, 10)}…${NAME_HASH.slice(-4)} (its on-chain name hash).`);
    expect(say({ kind: 'resolved', onChainId: '32', nameHash: NAME_HASH, contextGraphId: 'gnosis-fun-facts', private: false }))
      .toBe('On-chain Context Graph #32 is "gnosis-fun-facts" (verified against its on-chain name hash).');
    expect(say({
      kind: 'resolved',
      onChainId: '32',
      nameHash: NAME_HASH,
      contextGraphId: NAME_HASH,
      private: false,
      retiredNumericSubscription: { contextGraphId: '32', subscribed: true, syncMode: 'always-on' },
    })).toMatch(/Retired the subscription keyed "32", which could never sync\.$/);
  });

  it('says what is wrong with an id that names nothing subscribable, never "retry" unless a read failed', () => {
    const notFound = say({ kind: 'not-found', onChainId: '99', latestId: '32' });
    expect(notFound).toContain('Context Graph #99 does not exist on chain: the latest Context Graph id is 32.');
    expect(say({ kind: 'inactive', onChainId: '32' })).toBe('Context Graph #32 is deactivated on chain and can no longer be subscribed.');
    expect(say({ kind: 'no-name-hash', onChainId: '32' })).toContain('has no on-chain name hash');
    const privateGraph = say({ kind: 'private', onChainId: '32' });
    expect(privateGraph).toContain('private (curated access): only its members can subscribe');
    expect(privateGraph).toContain('Ask its curator for an invitation');
    expect(privateGraph).not.toMatch(/0x[0-9a-f]/i);
    expect(say({ kind: 'unsupported', onChainId: '32' })).toContain('cannot read ContextGraphStorage');
    for (const text of [notFound, privateGraph]) expect(text).not.toMatch(/retry/i);
    expect(say({ kind: 'unavailable', onChainId: '32', detail: 'RPC timed out' }))
      .toBe('Could not read Context Graph #32 from ContextGraphStorage (RPC timed out); retry once the chain RPC responds.');
  });
});
