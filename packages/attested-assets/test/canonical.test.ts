import { describe, it, expect } from 'vitest';
import {
  canonicalJsonEncode,
  sha256Hex,
  sha256String,
  computeConfigHash,
  computeMembershipRoot,
  computeSessionId,
  computeInputSetHash,
  computeStateHash,
  computeTurnCommitment,
  signAKAPayload,
  verifyAKASignature,
} from '../src/canonical.js';
import type { SessionMember, SigningContext } from '../src/index.js';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';

describe('canonicalJsonEncode', () => {
  it('sorts object keys alphabetically', () => {
    const result = canonicalJsonEncode({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles nested objects with sorted keys', () => {
    const result = canonicalJsonEncode({ b: { d: 1, c: 2 }, a: 3 });
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('handles arrays (order preserved)', () => {
    const result = canonicalJsonEncode([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles strings with escaping', () => {
    const result = canonicalJsonEncode('hello "world"');
    expect(result).toBe('"hello \\"world\\""');
  });

  it('handles null and booleans', () => {
    expect(canonicalJsonEncode(null)).toBe('null');
    expect(canonicalJsonEncode(true)).toBe('true');
    expect(canonicalJsonEncode(false)).toBe('false');
  });

  it('handles numbers without trailing zeros', () => {
    expect(canonicalJsonEncode(1.0)).toBe('1');
    expect(canonicalJsonEncode(1.5)).toBe('1.5');
    expect(canonicalJsonEncode(0)).toBe('0');
  });

  it('converts -0 to 0', () => {
    expect(canonicalJsonEncode(-0)).toBe('0');
  });

  it('converts Infinity to null', () => {
    expect(canonicalJsonEncode(Infinity)).toBe('null');
    expect(canonicalJsonEncode(-Infinity)).toBe('null');
  });

  it('converts NaN to null', () => {
    expect(canonicalJsonEncode(NaN)).toBe('null');
  });

  it('omits undefined values in objects', () => {
    const result = canonicalJsonEncode({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it('handles empty objects and arrays', () => {
    expect(canonicalJsonEncode({})).toBe('{}');
    expect(canonicalJsonEncode([])).toBe('[]');
  });

  it('is deterministic across calls', () => {
    const obj = { foo: [1, { bar: 'baz' }], alpha: true };
    expect(canonicalJsonEncode(obj)).toBe(canonicalJsonEncode(obj));
  });
});

describe('sha256Hex', () => {
  it('produces a 64-character hex string', () => {
    const result = sha256Hex(new TextEncoder().encode('test'));
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    const data = new TextEncoder().encode('deterministic');
    expect(sha256Hex(data)).toBe(sha256Hex(data));
  });
});

describe('sha256String', () => {
  it('hashes a string to hex', () => {
    const result = sha256String('hello');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('different strings produce different hashes', () => {
    expect(sha256String('a')).not.toBe(sha256String('b'));
  });
});

describe('computeSessionId', () => {
  it('produces a deterministic hex hash', () => {
    const id = computeSessionId('paranet-1', 'peer-1', '2026-01-01T00:00:00Z', 'nonce-1');
    expect(id).toHaveLength(64);
    expect(computeSessionId('paranet-1', 'peer-1', '2026-01-01T00:00:00Z', 'nonce-1')).toBe(id);
  });

  it('different inputs produce different ids', () => {
    const a = computeSessionId('paranet-1', 'peer-1', '2026-01-01T00:00:00Z', 'nonce-1');
    const b = computeSessionId('paranet-2', 'peer-1', '2026-01-01T00:00:00Z', 'nonce-1');
    expect(a).not.toBe(b);
  });
});

describe('computeMembershipRoot', () => {
  const members: SessionMember[] = [
    { peerId: 'peer-b', pubKey: new Uint8Array([2]), displayName: 'Bob', role: 'member' },
    { peerId: 'peer-a', pubKey: new Uint8Array([1]), displayName: 'Alice', role: 'creator' },
  ];

  it('produces a hex hash', () => {
    const root = computeMembershipRoot(members);
    expect(root).toHaveLength(64);
  });

  it('is order-independent (sorts internally)', () => {
    const reversed = [...members].reverse();
    expect(computeMembershipRoot(members)).toBe(computeMembershipRoot(reversed));
  });
});

describe('computeInputSetHash', () => {
  it('produces a hex hash from ordered inputs', () => {
    const inputs = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const hash = computeInputSetHash(inputs);
    expect(hash).toHaveLength(64);
  });

  it('different order produces different hash', () => {
    const a = [new Uint8Array([1]), new Uint8Array([2])];
    const b = [new Uint8Array([2]), new Uint8Array([1])];
    expect(computeInputSetHash(a)).not.toBe(computeInputSetHash(b));
  });

  it('handles empty inputs', () => {
    const hash = computeInputSetHash([]);
    expect(hash).toHaveLength(64);
  });
});

describe('computeStateHash', () => {
  it('produces a hex hash of state bytes', () => {
    const hash = computeStateHash(new Uint8Array([1, 2, 3]));
    expect(hash).toHaveLength(64);
  });

  it('is deterministic', () => {
    const data = new Uint8Array([10, 20, 30]);
    expect(computeStateHash(data)).toBe(computeStateHash(data));
  });
});

describe('computeTurnCommitment', () => {
  it('produces a hex hash', () => {
    const commitment = computeTurnCommitment('s1', 5, '0xprev', '0xinput', '0xnext', '1.0.0', '0xmroot');
    expect(commitment).toHaveLength(64);
  });

  it('different rounds produce different commitments', () => {
    const a = computeTurnCommitment('s1', 5, '0xprev', '0xinput', '0xnext', '1.0.0', '0xmroot');
    const b = computeTurnCommitment('s1', 6, '0xprev', '0xinput', '0xnext', '1.0.0', '0xmroot');
    expect(a).not.toBe(b);
  });
});

describe('computeConfigHash', () => {
  const baseConfig = {
    sessionId: 'session-1',
    paranetId: 'paranet-1',
    appId: 'test-app',
    createdBy: 'peer-1',
    createdAt: '2026-01-01T00:00:00Z',
    membership: [
      { peerId: 'peer-1', pubKey: new Uint8Array([1]), displayName: 'Alice', role: 'creator' as const },
    ],
    membershipRoot: '0xroot',
    quorumPolicy: { type: 'THRESHOLD' as const, numerator: 2, denominator: 3, minSigners: 2 },
    reducer: { name: 'test', version: '1.0.0', hash: '0xreducer' },
    genesisStateHash: '0xgenesis',
    roundTimeout: 30000,
    maxRounds: null,
  };

  it('produces a hex hash', () => {
    expect(computeConfigHash(baseConfig)).toHaveLength(64);
  });

  it('is deterministic', () => {
    expect(computeConfigHash(baseConfig)).toBe(computeConfigHash(baseConfig));
  });

  it('changes when any field changes', () => {
    const modified = { ...baseConfig, appId: 'different-app' };
    expect(computeConfigHash(baseConfig)).not.toBe(computeConfigHash(modified));
  });
});

describe('signAKAPayload / verifyAKASignature', () => {
  const context: SigningContext = {
    domain: 'AKA-v1',
    network: 'test-net',
    paranetId: 'paranet-1',
    sessionId: 'session-1',
    round: 1,
    type: 'RoundAck',
  };

  it('sign and verify roundtrip succeeds', async () => {
    const kp = await generateEd25519Keypair();
    const payload = { action: 'travel', distance: 16 };
    const sig = await signAKAPayload(context, payload, kp.secretKey);
    expect(sig).toHaveLength(64);

    const valid = await verifyAKASignature(context, payload, sig, kp.publicKey);
    expect(valid).toBe(true);
  });

  it('rejects tampered payload', async () => {
    const kp = await generateEd25519Keypair();
    const payload = { action: 'travel' };
    const sig = await signAKAPayload(context, payload, kp.secretKey);

    const valid = await verifyAKASignature(context, { action: 'rest' }, sig, kp.publicKey);
    expect(valid).toBe(false);
  });

  it('rejects wrong public key', async () => {
    const kp1 = await generateEd25519Keypair();
    const kp2 = await generateEd25519Keypair();
    const sig = await signAKAPayload(context, 'data', kp1.secretKey);

    const valid = await verifyAKASignature(context, 'data', sig, kp2.publicKey);
    expect(valid).toBe(false);
  });

  it('rejects different signing context', async () => {
    const kp = await generateEd25519Keypair();
    const sig = await signAKAPayload(context, 'data', kp.secretKey);

    const wrongContext = { ...context, round: 2 };
    const valid = await verifyAKASignature(wrongContext, 'data', sig, kp.publicKey);
    expect(valid).toBe(false);
  });
});
