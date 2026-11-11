import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyGoogleParentAuthorization } from './workflow-verification.mjs';

const google = { kind: 'google-sheets-export', available: true, kaRef: 'urn:test:google', sourceHash: 'a'.repeat(64) };
const definition = { id: 'original', nodes: [{ id: 'map' }], edges: [] };
const prefix = '/capabilities';

for (const capabilities of [[], [{ ...google, available: false }]]) {
  test(`unavailable Google authorization is skipped without a passing claim (${capabilities.length ? 'disabled' : 'absent'})`, async () => {
    const evidence = await verifyGoogleParentAuthorization({ capabilities, definition, prefix,
      request: () => assert.fail('Unavailable Google verification must not make requests') });
    assert.equal(evidence.unprivilegedGoogleParentDenied, false);
    assert.equal(evidence.googleParentAuthorization.status, 'skipped');
    assert.match(evidence.googleParentAuthorization.reason, /unavailable/);
  });
}

test('available Google verification passes only after denial and saved-workflow absence', async () => {
  const calls = [];
  const evidence = await verifyGoogleParentAuthorization({ capabilities: [google], definition, prefix,
    request: async (path, body) => {
      calls.push({ path, body });
      return body ? { status: 403 } : { status: 200, value: { workflows: [{ definition }] } };
    } });
  assert.deepEqual(calls.map(c => c.path), ['/capabilities/workflows/save', '/capabilities/workflows']);
  assert.equal(calls[0].body.nodes.at(-1).kaRef, google.kaRef);
  assert.notEqual(calls[0].body.id, definition.id);
  assert.deepEqual(definition, { id: 'original', nodes: [{ id: 'map' }], edges: [] });
  assert.deepEqual(evidence, { unprivilegedGoogleParentDenied: true, googleParentAuthorization: { status: 'passed' } });
});

test('Google verification rejects an accepted save or a denied request that still persisted the workflow', async () => {
  await assert.rejects(verifyGoogleParentAuthorization({ capabilities: [google], definition, prefix,
    request: async () => ({ status: 200 }) }), { code: 'ERR_ASSERTION' });
  let saved;
  await assert.rejects(verifyGoogleParentAuthorization({ capabilities: [google], definition, prefix,
    request: async (_path, body) => {
      if (body) { saved = body; return { status: 403 }; }
      return { status: 200, value: { workflows: [{ definition: saved }] } };
    } }), { code: 'ERR_ASSERTION' });
});
