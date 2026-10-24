import process from 'node:process';

import { openRfc64PersistenceV1 } from '../../packages/agent/dist/rfc64/persistence-v1.js';

const EVENT_PREFIX = 'RFC64_GATE0_EVENT ';
const dataDir = process.env.DKG_RFC64_GATE0_DATA_DIR;
if (!dataDir) throw new Error('DKG_RFC64_GATE0_DATA_DIR is required');

try {
  const persistence = await openRfc64PersistenceV1(dataDir, {
    yieldAfterPurgeBatch: async () => {},
  });
  await persistence.close();
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({
    event: 'lease-probe',
    acquired: true,
    errorCode: null,
  })}\n`);
} catch (error) {
  const errorCode = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({
    event: 'lease-probe',
    acquired: false,
    errorCode,
  })}\n`);
}
