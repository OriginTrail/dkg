import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Evidence is passed only after both denial and absence from saved workflows are checked. */
export async function verifyGoogleParentAuthorization({ capabilities, definition, prefix, request }) {
  const google = capabilities.find(c => c.kind === 'google-sheets-export');
  if (!google?.available) return {
    unprivilegedGoogleParentDenied: false,
    googleParentAuthorization: { status: 'skipped', reason: 'Google Sheets export capability is unavailable.' },
  };
  const withGoogle = structuredClone(definition); withGoogle.id = randomUUID();
  withGoogle.nodes.push({ id: 'google', kind: google.kind, kaRef: google.kaRef, sourceHash: google.sourceHash,
    x: 750, y: 150, config: { title: 'Not dispatched without an export key' } });
  withGoogle.edges.push({ from: 'map', to: 'google' });
  assert.equal((await request(prefix + '/workflows/save', withGoogle)).status, 403);
  const inventory = await request(prefix + '/workflows');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.value.workflows.some(w => w.definition.id === withGoogle.id), false);
  return { unprivilegedGoogleParentDenied: true, googleParentAuthorization: { status: 'passed' } };
}
