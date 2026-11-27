// SPDX-License-Identifier: Apache-2.0

import { closeSync, openSync, readSync } from 'node:fs';
import { InventoryV1OpenError } from './open-error.js';

export interface SqliteHeaderIdentityV1 {
  applicationId: number;
  userVersion: number;
  writeVersion: number;
  readVersion: number;
}

export function readValidSqliteHeaderIdentity(databasePath: string): SqliteHeaderIdentityV1 | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(databasePath, 'r');
    const header = Buffer.alloc(100);
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead < header.byteLength || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') {
      return null;
    }
    return {
      applicationId: header.readUInt32BE(68),
      userVersion: header.readUInt32BE(60),
      writeVersion: header[18],
      readVersion: header[19],
    };
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      'failed to read the inventory database header; it will not be quarantined',
      { cause },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

