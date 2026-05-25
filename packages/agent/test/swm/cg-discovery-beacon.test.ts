import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  BEACON_ACCESS_POLICY_CURATED,
  BEACON_ACCESS_POLICY_PUBLIC,
  BEACON_MAX_AGE_SECONDS,
  BEACON_VERSION,
  computeBeaconDigest,
  decodeCgDiscoveryBeacon,
  encodeCgDiscoveryBeacon,
  mintCgDiscoveryBeacon,
  verifyCgDiscoveryBeacon,
} from '../../src/swm/cg-discovery-beacon.js';

const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes('curator/test-cg')).toLowerCase();
const ALT_NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes('curator/other-cg')).toLowerCase();

function makeSigner(wallet: ethers.Wallet) {
  return async (digest: Uint8Array) => wallet.signMessage(digest);
}

describe('cg-discovery-beacon', () => {
  it('mints a beacon whose signature recovers to the curator EOA', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ts = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      ts,
      sign: makeSigner(wallet),
    });

    expect(beacon.v).toBe(BEACON_VERSION);
    expect(beacon.nameHash).toBe(NAME_HASH);
    expect(beacon.curatorEoa).toBe(wallet.address.toLowerCase());

    const result = verifyCgDiscoveryBeacon(beacon, ts);
    expect(result.ok).toBe(true);
    expect(result.recoveredSigner).toBe(wallet.address.toLowerCase());
  });

  it('rejects beacons whose signature was produced by a different wallet', async () => {
    const realCurator = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const ts = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: realCurator.address,
      ts,
      sign: makeSigner(impostor),
    });

    const result = verifyCgDiscoveryBeacon(beacon, ts);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signer mismatch/);
  });

  it('rejects beacons outside the freshness window', async () => {
    const wallet = ethers.Wallet.createRandom();
    const beaconTs = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      ts: beaconTs,
      sign: makeSigner(wallet),
    });

    const tooOld = beaconTs + BEACON_MAX_AGE_SECONDS + 1;
    const result = verifyCgDiscoveryBeacon(beacon, tooOld);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/skew/);
  });

  it('rejects malformed beacons (missing fields, wrong shape, bad hex)', () => {
    expect(verifyCgDiscoveryBeacon({}, Date.now() / 1000).ok).toBe(false);
    expect(verifyCgDiscoveryBeacon(null, Date.now() / 1000).ok).toBe(false);
    expect(verifyCgDiscoveryBeacon('beacon', Date.now() / 1000).ok).toBe(false);
    const partial = { v: 1, nameHash: NAME_HASH, accessPolicy: 1, curatorEoa: '0x', ts: 1, sig: '0x' };
    expect(verifyCgDiscoveryBeacon(partial, Date.now() / 1000).ok).toBe(false);
  });

  it('rejects beacons whose accessPolicy is not 0 or 1', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ts = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      ts,
      sign: makeSigner(wallet),
    });
    const mutated = { ...beacon, accessPolicy: 7 };
    const result = verifyCgDiscoveryBeacon(mutated, ts);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/accessPolicy/);
  });

  it('rejects mintCgDiscoveryBeacon on bad inputs (acceptance gate)', async () => {
    const wallet = ethers.Wallet.createRandom();
    await expect(mintCgDiscoveryBeacon({
      nameHash: '0xdeadbeef',
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      sign: makeSigner(wallet),
    })).rejects.toThrow(/nameHash/);

    await expect(mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: 99,
      curatorEoa: wallet.address,
      sign: makeSigner(wallet),
    })).rejects.toThrow(/accessPolicy/);

    await expect(mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_PUBLIC,
      curatorEoa: '0xnotahex',
      sign: makeSigner(wallet),
    })).rejects.toThrow(/curatorEoa/);
  });

  it('detects tampering with the signed fields (nameHash, accessPolicy, ts)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ts = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      ts,
      sign: makeSigner(wallet),
    });

    expect(verifyCgDiscoveryBeacon({ ...beacon, nameHash: ALT_NAME_HASH }, ts).ok).toBe(false);
    expect(verifyCgDiscoveryBeacon({ ...beacon, accessPolicy: BEACON_ACCESS_POLICY_PUBLIC }, ts).ok).toBe(false);
    expect(verifyCgDiscoveryBeacon({ ...beacon, ts: ts + 1 }, ts).ok).toBe(false);
  });

  it('round-trips through encode/decode without losing fields', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ts = Math.floor(Date.now() / 1000);
    const beacon = await mintCgDiscoveryBeacon({
      nameHash: NAME_HASH,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address,
      ts,
      sign: makeSigner(wallet),
    });

    const wire = encodeCgDiscoveryBeacon(beacon);
    const parsed = decodeCgDiscoveryBeacon(wire);
    expect(parsed).toEqual(beacon);
    expect(verifyCgDiscoveryBeacon(parsed, ts).ok).toBe(true);
  });

  it('decode returns null on invalid JSON / non-beacon shapes', () => {
    expect(decodeCgDiscoveryBeacon(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(decodeCgDiscoveryBeacon(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeCgDiscoveryBeacon(new TextEncoder().encode('{}'))).toBeNull();
  });

  it('computeBeaconDigest is deterministic for the same inputs', () => {
    const a = computeBeaconDigest({ v: 1, nameHash: NAME_HASH, accessPolicy: 1, curatorEoa: '0x0000000000000000000000000000000000000001', ts: 42 });
    const b = computeBeaconDigest({ v: 1, nameHash: NAME_HASH, accessPolicy: 1, curatorEoa: '0x0000000000000000000000000000000000000001', ts: 42 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
