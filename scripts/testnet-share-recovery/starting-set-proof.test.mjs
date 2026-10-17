import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCampaign } from './campaign-manifest.mjs';
import { faultEvidenceFixture } from './fault-evidence-fixture.mjs';
import { capturedTermIdentity } from './rdf-term-identity.mjs';
import { parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '../../packages/core/dist/index.js';

test('starting gate requires the exact authoritative prepared seal subjects', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'starting-evidence-'));
  try {
    const arm = 'fixture', name = 'initial', campaign = defineCampaign(arm);
    campaign.author = '0x1111111111111111111111111111111111111111';
    campaign.cohorts = { initial: [name], shares: [], publications: [], restart: [] };
    const graph = `did:dkg:context-graph:${campaign.contextGraphId}/_meta`;
    const subject = `did:dkg:context-graph:${campaign.contextGraphId}/assertion/${campaign.author}/${name}`;
    const fixture = faultEvidenceFixture();
    const quads = fixture.fault.metadataAtFault.quads.filter(q => q.subject === 'urn:seal').map(q => ({ ...q, subject, graph }));
    const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(parseAssertionSealQuads(quads, subject));
    const digest = computeCanonicalGraphScopedAuthorSealDigestV1(seal);
    const term = value => { const [type, text, datatype, language] = capturedTermIdentity(value);
      return { type, value: text, ...(type === 'literal' && datatype !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype } : {}), ...(language ? { 'xml:lang': language } : {}) }; };
    const rows = quads.map(q => ({ s: term(q.subject), p: term(q.predicate), o: term(q.object), g: term(q.graph) }));
    const dir = path.join(cwd, '.tmp/2963/evidence', arm); fs.mkdirSync(path.join(dir, 'pre-workload'), { recursive: true });
    const write = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
    write('campaign-manifest.json', campaign);
    write('pre-workload/inventory.json', { swm: [{ assertion_coordinate: name, ka_ual: seal.kaUal, assertion_version_u64be: seal.assertionVersion, seal_digest: digest }] });
    write('pre-workload/catalogs.json', [{ rows: [{ assertionCoordinate: name, kaId: seal.reservedKaId, assertionVersion: seal.assertionVersion, sealDigest: digest }] }]);
    const run = () => execFileSync(process.execPath, [fileURLToPath(new URL('./starting-set-proof.mjs', import.meta.url)), arm], { cwd, stdio: 'pipe' });
    write('pre-workload/rdf.json', { results: { bindings: rows } }); run();
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
