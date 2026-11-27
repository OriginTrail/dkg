import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
} from './constants.js';

/** Shared publish/update StorageACK wire family. */
export const STORAGE_ACK_PROTOCOLS = [
  [PROTOCOL_STORAGE_ACK, 'publish'],
  [PROTOCOL_STORAGE_ACK_V2, 'publish'],
  [PROTOCOL_STORAGE_UPDATE_ACK, 'update'],
  [PROTOCOL_STORAGE_UPDATE_ACK_V2, 'update'],
] as const;

export type StorageACKProtocol = (typeof STORAGE_ACK_PROTOCOLS)[number][0];
export type StorageACKProtocolKind = (typeof STORAGE_ACK_PROTOCOLS)[number][1];

const kindByProtocol = new Map<string, StorageACKProtocolKind>(STORAGE_ACK_PROTOCOLS);

export function isStorageACKProtocol(protocol: string): protocol is StorageACKProtocol {
  return kindByProtocol.has(protocol);
}

export function storageACKProtocolKind(protocol: StorageACKProtocol): StorageACKProtocolKind {
  return kindByProtocol.get(protocol)!;
}
