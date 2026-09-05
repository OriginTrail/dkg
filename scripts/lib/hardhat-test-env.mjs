import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each Vitest project invocation owns its context, even across checkouts. */
export function hardhatTestEnvironment(port) {
  return {
    HARDHAT_PORT: String(port),
    DKG_HARDHAT_CONTEXT_FILE: join(tmpdir(), `dkg-hardhat-${randomUUID()}.json`),
  };
}
