import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
} from '@origintrail-official/dkg-core';

/** The sole registry for remote registration, cleanup, and local dispatch. */
export const STORAGE_ACK_PROTOCOLS = [
  [PROTOCOL_STORAGE_ACK, 'publish'],
  [PROTOCOL_STORAGE_ACK_V2, 'publish'],
  [PROTOCOL_STORAGE_UPDATE_ACK, 'update'],
  [PROTOCOL_STORAGE_UPDATE_ACK_V2, 'update'],
] as const;

export type StorageACKProtocol = (typeof STORAGE_ACK_PROTOCOLS)[number][0];

const kindByProtocol = new Map<StorageACKProtocol, 'publish' | 'update'>(STORAGE_ACK_PROTOCOLS);

export function storageACKProtocolKind(protocol: string): 'publish' | 'update' {
  const kind = kindByProtocol.get(protocol as StorageACKProtocol);
  if (!kind) throw new Error(`Unsupported StorageACK protocol: ${protocol}`);
  return kind;
}

export function isStorageACKProtocol(protocol: string): protocol is StorageACKProtocol {
  return kindByProtocol.has(protocol as StorageACKProtocol);
}
