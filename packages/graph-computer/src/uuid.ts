import { randomBytes } from 'ethers/crypto';
import { uuidV4 } from 'ethers/utils';

/** Cryptographically random UUID, including on HTTP node UIs without crypto.randomUUID. */
export function createUuid(): string {
  return uuidV4(randomBytes(16));
}
