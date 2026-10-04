import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/byte-codec.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

describe('chain byte codec compatibility', () => {
  it('retains prefixed lowercase encoding, including zero padding and high bytes', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    expect(toHex(bytes)).toBe('0x00010f107f80ff');
    expect(fromHex('0x00010f107f80ff')).toEqual(bytes);
    expect(toHex(new Uint8Array())).toBe('0x');
  });

  it('retains unprefixed mixed-case decoding and empty inputs', () => {
    expect(fromHex('AbCd99')).toEqual(new Uint8Array([171, 205, 153]));
    expect(fromHex('')).toEqual(new Uint8Array());
    expect(fromHex('0x')).toEqual(new Uint8Array());
  });

  it('preserves the existing permissive parser rather than introducing strict validation', () => {
    // The extraction does not change the mock's historical input policy:
    // incomplete bytes are discarded, parseInt accepts partial bytes, and
    // NaN becomes zero in the typed array. Only lowercase 0x is a prefix.
    expect(fromHex('0x1gz2ff7')).toEqual(new Uint8Array([1, 0, 255]));
    expect(fromHex('0Xab')).toEqual(new Uint8Array([0, 171]));
  });

  it('keeps identity keys stable across registration, lookup and duplicate registration', async () => {
    const adapter = new MockChainAdapter();
    const publicKey = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
    const proof = { publicKey, signature: new Uint8Array() };
    const registered = await adapter.registerIdentity(proof);
    expect(adapter.getIdentityIdByKey(publicKey.slice())).toBe(registered);
    expect(await adapter.registerIdentity({ ...proof, publicKey: publicKey.slice() }))
      .toBe(registered);
    expect(await adapter.registerIdentity({ ...proof, publicKey: new Uint8Array([1, 15]) }))
      .not.toBe(registered);
  });
});
