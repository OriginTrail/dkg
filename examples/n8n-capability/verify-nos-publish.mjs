/** Cross-repository HTTP contract proof. Synthetic publisher, no server or external effects.
 * node --import /path/to/tl-nos/node_modules/tsx/dist/loader.mjs verify-nos-publish.mjs /path/to/tl-nos
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createNosPublishAdapter } from './nos-publish-adapter.mjs';
const checkout = process.argv[2];
if (!checkout) throw new Error('Supply the nOS source checkout; no live URL is accepted.');
const load = (path) => import(pathToFileURL(resolve(checkout, path)).href);
const { createWorkflowsHandler } = await load('apps/control-plane/src/l1/workflows-access.ts');
const { createPublishClient } = await load('tools/pharmagenesis-devnet/publish-client.ts');
const dir = mkdtempSync(join(tmpdir(), 'nos-publish-contract-'));
const db = new DatabaseSync(':memory:');
const secret = 'synthetic-workflows-secret-for-contract-proof';
const secretFile = join(dir, 'secret');
writeFileSync(secretFile, secret, { mode: 0o600 });
const calls = [],
  requests = [];
try {
  const handler = createWorkflowsHandler({
    identity: {
      resolve: async () => {
        throw new Error('No customer bearer belongs on this service route');
      },
    },
    principalOf: async () => {
      throw new Error('Unexpected human identity resolution');
    },
    roleOf: async () => {
      throw new Error('The actual publisher rechecks ownership');
    },
    accounts: new Set(['account-a']),
    secret,
    requestId: () => 'fixture-request',
    // Publication effects are a labelled fixture. The real control-plane service
    // auth, route, publish client and component adapter execute unchanged.
    publish: async (accountId, request) => {
      calls.push({ accountId, request });
      assert.equal(request.approvedBy, 'owner-a');
      return {
        state: 'saved',
        actionId: null,
        message: null,
        node: { jobId: 'fixture-job', name: 'Fixture node' },
        asset: {
          name: 'fixture-asset',
          graphId: 'urn:fixture:graph',
          graphName: 'Fixture',
          ual: null,
        },
      };
    },
  });
  const publish = createPublishClient({
    accountId: 'account-a',
    url: 'https://nos.fixture.invalid',
    secretFile,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), null);
      assert.equal(new URL(url).pathname, '/workflows/account-a/service/publish');
      requests.push({ url: String(url), request: JSON.parse(init.body) });
      // Lose the first reply AFTER the existing route accepts publication.
      const response = await handler(new Request(url, init));
      if (requests.length === 1) throw new Error('synthetic lost reply');
      return response;
    },
    sleep: async () => {},
    pollMs: 1,
  });
  const adapter = createNosPublishAdapter({
    db,
    accountId: 'account-a',
    publish: (accountId, request) => {
      assert.equal(accountId, 'account-a');
      return publish(request);
    },
  });
  const actor = { id: 'owner-a', accountId: 'account-a', role: 'owner' };
  const input = {
    invocationId: '11223344-1234-4234-8234-123456789abc',
    blockId: 'write',
    workflowRef: 'urn:fixture:workflow',
    workflowHash: 'a'.repeat(64),
    profileRevision: 'b'.repeat(64),
    layer: 'working-memory',
    graphName: 'Fixture',
    assetName: 'Fixture asset',
    nquads: '<urn:fixture:s> <urn:fixture:p> "fixture" .',
  };
  const receipt = await adapter.execute(actor, input);
  assert.equal(receipt.storageState, 'working-memory-draft');
  assert.equal(receipt.readbackVerified, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(await adapter.execute(actor, input), receipt);
  assert.equal(requests.length, 2);
  for (const [account, key] of [
    ['account-b', secret],
    ['account-a', 'wrong-secret'],
  ]) {
    const response = await handler(
      new Request(`https://nos.fixture.invalid/workflows/${account}/service/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nos-workflows-secret': key },
        body: JSON.stringify(requests[0].request),
      }),
    );
    assert.equal(response.status, 404);
  }
  assert.equal(calls.length, 2);
  console.log(
    JSON.stringify({
      passed: true,
      route: '/workflows/{accountId}/service/publish',
      sameIdentityAfterLostReply: true,
      customerBearerForwarded: false,
      crossAccountAndWrongServiceSecretRefused: true,
      wmState: receipt.storageState,
      liveNodeEffects: false,
    }),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
