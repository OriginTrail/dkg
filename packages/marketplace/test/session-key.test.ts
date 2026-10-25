import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeAuthDigest,
  createSessionKey,
  eip191RecoverDigest,
  loadSessionKey,
  parseSessionKey,
  persistSessionKey,
  serializeSessionKey,
  sessionKeyWallet,
  signAuthorization,
} from '../src/index.js';
import type { AuthorizationFields } from '../src/index.js';

const FIELDS: AuthorizationFields = {
  chainId: 31337n,
  marketplaceAddress: '0x1111111111111111111111111111111111111111',
  buyer: '0x2222222222222222222222222222222222222222',
  sellerIdentityId: 7n,
  offeringId: '0x71bca9a6544a949e1b23e90662484d852a552be7d60ac61cb2abc96966d78780',
  callId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  epoch: 42n,
  maxUnits: 1000n,
  askPerUnitWei: 500000000000n,
  expiry: 1793577600n,
};

describe('createSessionKey', () => {
  it('derives a consistent address and timestamps from the injected clock', () => {
    const record = createSessionKey(() => 1_761_400_000_000);
    expect(record.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sessionKeyWallet(record).address).toBe(record.address);
    expect(record.createdAt).toBe(new Date(1_761_400_000_000).toISOString());
  });

  it('never repeats keys', () => {
    expect(createSessionKey().privateKey).not.toBe(createSessionKey().privateKey);
  });
});

describe('persist / load round trip', () => {
  it('writes and reloads the exact record', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-session-key-'));
    const file = path.join(directory, 'nested', 'session-key.json');
    const record = createSessionKey(() => 0);
    persistSessionKey(file, record);
    expect(loadSessionKey(file)).toEqual(record);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('serialization is stable JSON with a trailing newline', () => {
    const record = createSessionKey(() => 0);
    const serialized = serializeSessionKey(record);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(parseSessionKey(serialized)).toEqual(record);
  });

  it('rejects a record whose address does not match its private key', () => {
    const record = createSessionKey(() => 0);
    const tampered = { ...record, address: '0x2222222222222222222222222222222222222222' };
    expect(() => parseSessionKey(JSON.stringify(tampered))).toThrow('address mismatch');
  });

  it('rejects structurally invalid files', () => {
    expect(() => parseSessionKey('42')).toThrow('JSON object');
    expect(() => parseSessionKey('{"privateKey":"0x01"}')).toThrow('privateKey, address, createdAt');
  });
});

describe('signAuthorization', () => {
  it('produces a digest-bound EIP-191 signature recovering to the session key', async () => {
    const record = createSessionKey(() => 0);
    const authorization = await signAuthorization(record, FIELDS);
    expect(authorization.authDigest).toBe(computeAuthDigest(FIELDS));
    expect(authorization.buyer).toBe(FIELDS.buyer);
    expect(eip191RecoverDigest(authorization.authDigest, authorization.signature)).toBe(record.address);
  });

  it('a signature from one session key never recovers to another', async () => {
    const first = createSessionKey(() => 0);
    const second = createSessionKey(() => 0);
    const authorization = await signAuthorization(first, FIELDS);
    expect(eip191RecoverDigest(authorization.authDigest, authorization.signature)).not.toBe(second.address);
  });
});
