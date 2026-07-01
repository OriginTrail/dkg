/**
 * #1404 security regression: `DKGPublisher.getV10ACKChainCapabilities()` must
 * return a NARROW facade exposing ONLY the six V10 ACK methods — never the raw
 * chain adapter, whose EVM implementations also carry secret-bearing methods
 * (operational private-key getters). Handing back the adapter itself would turn
 * the accessor into a secret-extraction path.
 *
 * Exercised via the prototype method against a fake `this` carrying a mix of ACK
 * and secret methods, so no heavy DKGPublisher construction is needed.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';

const getCaps = (chain: unknown): any =>
  (DKGPublisher.prototype as any).getV10ACKChainCapabilities.call({ chain });

describe('DKGPublisher.getV10ACKChainCapabilities — narrow ACK facade (#1404)', () => {
  it('exposes the implemented V10 ACK methods, each bound to the real adapter', async () => {
    let boundThis: unknown;
    const adapter = {
      isV10Ready() { boundThis = this; return true; },
      verifyACKIdentity: async () => true,
      verifyACKIdentityDetailed: async () => ({ valid: true, reason: undefined }),
      getMinimumRequiredSignatures: async () => 3,
      getEvmChainId: async () => 8453n,
      getKnowledgeAssetsLifecycleAddress: async () => '0xabc',
    };
    const caps = getCaps(adapter);
    expect(caps.isV10Ready()).toBe(true);
    expect(boundThis).toBe(adapter); // bound to the real adapter, not the facade
    expect(await caps.getEvmChainId()).toBe(8453n);
    expect(await caps.getMinimumRequiredSignatures()).toBe(3);
    expect(await caps.getKnowledgeAssetsLifecycleAddress()).toBe('0xabc');
    expect(typeof caps.verifyACKIdentity).toBe('function');
    expect(typeof caps.verifyACKIdentityDetailed).toBe('function');
  });

  it('does NOT leak any non-ACK adapter method — closes the secret-extraction path', () => {
    let secretCalled = false;
    const adapter = {
      isV10Ready: () => true,
      verifyACKIdentity: async () => true,
      getEvmChainId: async () => 1n,
      getKnowledgeAssetsLifecycleAddress: async () => '0x',
      getMinimumRequiredSignatures: async () => 1,
      // secret-bearing methods that must NEVER be reachable from the facade
      getOperationalPrivateKey: () => { secretCalled = true; return 'TOP-SECRET'; },
      getPrivateKey: () => 'TOP-SECRET',
      wallet: { privateKey: 'TOP-SECRET' },
    };
    const caps = getCaps(adapter);
    expect(caps.getOperationalPrivateKey).toBeUndefined();
    expect(caps.getPrivateKey).toBeUndefined();
    expect(caps.wallet).toBeUndefined();
    // Only the ACK methods the adapter actually implements are present.
    expect(Object.keys(caps).sort()).toEqual([
      'getEvmChainId',
      'getKnowledgeAssetsLifecycleAddress',
      'getMinimumRequiredSignatures',
      'isV10Ready',
      'verifyACKIdentity',
    ]);
    expect(secretCalled).toBe(false);
  });

  it('omits methods the adapter does not implement (V9 / NoChainAdapter → empty facade)', () => {
    const caps = getCaps({ chainId: 'none' });
    expect(Object.keys(caps)).toEqual([]);
    expect(caps.isV10Ready).toBeUndefined();
  });
});
