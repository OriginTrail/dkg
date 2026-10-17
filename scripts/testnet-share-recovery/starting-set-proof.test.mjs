import { projectionProofFixture } from './projection-proof-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCampaign } from './campaign-manifest.mjs';
import { ASSERTION_SEAL_PREDICATES } from '../../packages/core/dist/index.js';

test('starting gate requires the exact authoritative prepared seal subjects', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'starting-evidence-'));
  try {
    const arm = 'fixture', name = 'initial', campaign = defineCampaign(arm);
    campaign.author = '0x1111111111111111111111111111111111111111';
    campaign.cohorts = { initial: [name], shares: [], publications: [], restart: [] };
    const graph = `did:dkg:context-graph:${campaign.contextGraphId}/_meta`;
    const subject = `did:dkg:context-graph:${campaign.contextGraphId}/assertion/${campaign.author}/${name}`;
    const scopeFixture = projectionProofFixture(campaign, name, `operation-${name}`);
    const rows = scopeFixture.rdf;
    const dir = path.join(cwd, '.tmp/2963/evidence', arm); fs.mkdirSync(path.join(dir, 'pre-workload'), { recursive: true });
    const write = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
    write('campaign-manifest.json', campaign);
    write('pre-workload/inventory.json', scopeFixture.capture); write('pre-workload/catalogs.json', scopeFixture.catalogs); write('pre-workload/-api-status.json', scopeFixture.status);
    const run = () => execFileSync(process.execPath, [fileURLToPath(new URL('./starting-set-proof.mjs', import.meta.url)), arm], { cwd, stdio: 'pipe' });
    write('pre-workload/rdf.json', { results: { bindings: rows } }); run();
    for (const [predicate, value] of [
      [ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT, 'cd'.repeat(32)],
      [ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION, '2'],
      [ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS, '0x2222222222222222222222222222222222222222'],
    ]) {
      const original = rows.find(row => row.p.value === predicate);
      assert.ok(original);
      const conflict = { ...original, o: { ...original.o, value } };
      for (const ambiguous of [[conflict, ...rows], [...rows, conflict]]) {
        write('pre-workload/rdf.json', { results: { bindings: ambiguous } });
        assert.throws(run, 'Conflicting seal metadata must fail in either order');
      }
    }
    for (const transform of [
      r => ({ ...r, g: { type: 'uri', value: graph + '-relocated' } }),
      r => ({ ...r, s: { type: 'uri', value: subject.replace(campaign.author, 'wrong-author') } }),
      r => ({ ...r, s: { type: 'literal', value: subject } }),
    ]) {
      write('pre-workload/rdf.json', { results: { bindings: rows.map(transform) } });
      assert.throws(run, 'An unchanged catalog/inventory must not bless an unauthoritative seal');
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
