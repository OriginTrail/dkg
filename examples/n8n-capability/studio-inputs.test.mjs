import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyInvocation } from './test-support/studio-invocation-checks.mjs';

test('named inputs survive save/reopen, preserve pins, substitute native values and retain manual/MCP admission', async () => {
  await verifyInvocation(fileURLToPath(new URL('../../', import.meta.url)));
});
