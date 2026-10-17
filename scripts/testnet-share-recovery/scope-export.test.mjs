import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defineCampaign } from './campaign-manifest.mjs';
import { inventoryScopeFixture } from './inventory-scope-fixture.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';

for (const exporter of ['reviewer-evidence.py', 'export-restart.py']) {
  test(`${exporter} exports only committed current identities and explicit excluded-scope provenance`, () => {
    for (const reverse of [false, true]) for (const empty of ['inventory', 'catalog']) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-export-'));
      try {
        const campaign = defineCampaign('fixture'); campaign.faults = [];
        const old = inventoryScopeFixture(campaign, [{ assertion_coordinate: 'asset' }], [{ assertionCoordinate: 'asset' }], '0');
        const current = inventoryScopeFixture(campaign, empty === 'inventory' ? [] : [{ assertion_coordinate: 'asset' }],
          empty === 'catalog' ? [] : [{ assertionCoordinate: 'asset' }], '1');
        const scopes = [...old.capture.scopes, ...current.capture.scopes], catalogs = [...old.catalogs, ...current.catalogs];
        if (reverse) { scopes.reverse(); catalogs.reverse(); }
        const capture = { ...current.capture, scopes, swm: old.capture.swm };
        const proof = verifyInventoryScope(campaign, capture, catalogs, current.status); assert.equal(proof.valid, true, proof.errors.join('; '));
        const { rows, catalogRows, ...provenance } = proof;
        const root = path.join(cwd, '.tmp/2963/evidence/fixture');
        const write = (name, value) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); };
        write('campaign-manifest.json', campaign); write('verification.json', { assets: [] }); write('seal-proof.json', []);
        write('identity-proof.json', { identityErrors: [], inventoryScope: provenance });
        write('restart-regression/identity-proof.json', { inventoryScope: provenance });
        write('protocol.json', { startedAt: '2026-10-17T00:00:00Z', publicationDeadlineMs: 1200000 });
        for (const name of ['environment', 'starting-set-proof', 'traffic-end']) write(name + '.json', {});
        for (const name of ['descriptor-proof', 'chain-proof', 'fault-identity-proof', 'nonce-proof', 'publication-admissions', 'synchronous-shares']) write(name + '.json', []);
        for (const label of ['fixed-deadline', 'restart-readback']) {
          write(label + '/inventory.json', capture); write(label + '/catalogs.json', catalogs); write(label + '/-api-status.json', current.status);
          write(label + '/manifest.json', { label }); write(label + '/-api-publisher-jobs.json', { value: { jobs: [] } });
          write(label + '/-api-knowledge-assets-swm-share-jobs.json', { value: { jobs: [] } });
        }
        fs.writeFileSync(path.join(root, 'requests.jsonl'), ''); fs.writeFileSync(path.join(root, 'restart-regression/observations.jsonl'), '');
        const args = [fileURLToPath(new URL(exporter, import.meta.url)), 'fixture', ...(exporter === 'reviewer-evidence.py' ? ['fixed-deadline'] : [])];
        const run = spawnSync('python3', args, { cwd, encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr);
        const out = path.join(cwd, '.tmp/2963/exported-evidence/fixture', exporter === 'export-restart.py' ? 'restart-regression' : '');
        const read = name => JSON.parse(fs.readFileSync(path.join(out, name)));
        const catalogFile = exporter === 'export-restart.py' ? 'catalogs.json' : 'catalog-identities.json';
        const inventoryFile = exporter === 'export-restart.py' ? 'inventory.json' : 'inventory-identities.json';
        assert.equal(read(catalogFile).length, catalogRows.length, `${exporter} exported obsolete catalog identities`);
        assert.equal(read(inventoryFile).length, rows.length, `${exporter} exported obsolete inventory identities`);
        const evidence = read('inventory-scope-proof.json');
        assert.equal(evidence.catalogHeadDigest, provenance.catalogHeadDigest); assert.equal(evidence.rowCommitmentsVerified, true);
        assert.equal(evidence.excludedInventoryScopes.length, 1); assert.equal(evidence.excludedCatalogHeads.length, 1);
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    }
  });
}
