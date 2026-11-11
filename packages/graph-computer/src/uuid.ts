import { randomBytes, uuidV4 } from 'ethers';

/** Cryptographically random UUID, including on HTTP node UIs without crypto.randomUUID. */
export function createUuid(): string {
  return uuidV4(randomBytes(16));
}
