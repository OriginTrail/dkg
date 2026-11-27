import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { faultEvidenceFixture } from './fault-evidence-fixture.mjs';
import { validateCapturedShareIdentity } from './captured-share-identity.mjs';

for (const missing of ['all', 'shareOperationId', 'promoteOperationIntent', 'authorAttestationR']) {
  test(`fault proof refuses missing original ${missing} despite matching payload`, () => {
    const { fault, rows } = faultEvidenceFixture();
    fault.metadataAtFault.quads = missing === 'all' ? [] : fault.metadataAtFault.quads.filter(q => !q.predicate.endsWith('/' + missing));
    assert.equal(validateCapturedShareIdentity(fault).captureComplete, false);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-identity-'));
    try {
      const root = path.join(cwd, '.tmp/2963/evidence/fixture'), home = path.join(cwd, '.tmp/2963/fixture-home');
      fs.mkdirSync(path.join(root, 'final'), { recursive: true }); fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(root, 'campaign-manifest.json'), JSON.stringify({ version: 1, arm: 'fixture', faults: [{ name: 'asset' }] }));
      fs.writeFileSync(path.join(root, 'final/rdf.json'), JSON.stringify({ results: { bindings: rows } }));
      fs.writeFileSync(path.join(home, '2963-fault-asset.json'), JSON.stringify(fault));
      execFileSync(process.execPath, [fileURLToPath(new URL('./fault-identity-proof.mjs', import.meta.url)), 'fixture', 'final'], { cwd });
      const [proof] = JSON.parse(fs.readFileSync(path.join(root, 'fault-identity-proof.json')));
      assert.equal(proof.originalSealOperationAndContentPreserved, false);
      assert.equal(proof.captureComplete, false); assert.ok(proof.captureErrors.length > 0);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}
test('requires complete, unique and valid original seal and operation', () => {
  const { fault } = faultEvidenceFixture();
  assert.equal(validateCapturedShareIdentity(fault).captureComplete, true);
  for (const predicate of ['assertionMerkleRoot', 'shareOperationId', 'promoteOperationIntent']) {
    const duplicate = structuredClone(fault);
    duplicate.metadataAtFault.quads.push(duplicate.metadataAtFault.quads.find(q => q.predicate.endsWith('/' + predicate)));
    assert.equal(validateCapturedShareIdentity(duplicate).captureComplete, false);
  }
  const corrupt = structuredClone(fault);
  corrupt.metadataAtFault.quads.find(q => q.predicate.endsWith('/promoteOperationIntent')).object = '"not-json"';
  assert.equal(validateCapturedShareIdentity(corrupt).captureComplete, false);
});
