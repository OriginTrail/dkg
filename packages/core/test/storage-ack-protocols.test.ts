import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  isStorageACKProtocol,
  storageACKProtocolKind,
} from '../src/index.js';

describe('StorageACK protocol classification', () => {
  it.each([
    [PROTOCOL_STORAGE_ACK, 'publish'],
    [PROTOCOL_STORAGE_ACK_V2, 'publish'],
    [PROTOCOL_STORAGE_UPDATE_ACK, 'update'],
    [PROTOCOL_STORAGE_UPDATE_ACK_V2, 'update'],
  ] as const)('classifies %s as %s', (protocol, kind) => {
    expect(isStorageACKProtocol(protocol)).toBe(true);
    expect(storageACKProtocolKind(protocol)).toBe(kind);
  });

  it('rejects an unrelated protocol before dispatch', () => {
    expect(isStorageACKProtocol('/dkg/10.0.1/sync')).toBe(false);
  });
});
