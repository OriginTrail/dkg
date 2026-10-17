import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexAuthoritativeMetadata } from './authoritative-metadata.mjs';
test('main seal and lifecycle lookup reject relocated non-injected metadata', () => {
  const graph = 'did:dkg:context-graph:cg/_meta', seal = 'did:dkg:context-graph:cg/assertion/author/catalog-000';
  const lifecycle = 'urn:dkg:assertion:cg:author:catalog-000';
  const rows = [seal, lifecycle].map(subject => ({ g: { type: 'uri', value: graph }, s: { type: 'uri', value: subject },
    p: { type: 'uri', value: 'urn:p' }, o: { type: 'literal', value: 'original' } }));
  assert.equal(indexAuthoritativeMetadata(rows, graph).size, 2);
  const moved = rows.map(row => ({ ...row, g: { type: 'uri', value: graph + '-relocated' } }));
  assert.equal(indexAuthoritativeMetadata(moved, graph).has(seal), false);
  assert.equal(indexAuthoritativeMetadata(moved, graph).has(lifecycle), false);
});

// Exercise the entry points as well as their selector: missing final metadata must
// produce explicit failed proofs, not disappear from the full denominator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildAssertionSealQuads } from '../../packages/core/dist/index.js';
import { capturedTermIdentity } from './rdf-term-identity.mjs';
import { defineCampaign } from './campaign-manifest.mjs';
test('main reducer entry points retain a relocated asset as a failed proof', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'share-evidence-'));
  try {
    const arm = 'fixture', name = 'catalog-000', campaign = defineCampaign(arm);
    campaign.cohorts = { initial: [], shares: [name], publications: [], restart: [] }; campaign.faults = [];
    const cg = campaign.contextGraphId, author = campaign.author, graph = `did:dkg:context-graph:${cg}/_meta`;
    const seal = `did:dkg:context-graph:${cg}/assertion/${author}/${name}`, life = `urn:dkg:assertion:${cg}:${author}:${name}`;
    const ual = `did:dkg:base:84532/${author.toLowerCase()}/1`;
    const quads = buildAssertionSealQuads({ assertionUri: seal, metaGraph: graph,
      merkleRoot: new Uint8Array(32).fill(0xab), authorAddress: author,
      authorAttestationR: new Uint8Array(32).fill(0x11), authorAttestationVS: new Uint8Array(32).fill(0x22),
      authorSchemeVersion: 1, chainId: 84532n, kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
      reservedKaId: (BigInt(author) << 96n) | 1n, finalizedAtIso: '2026-10-16T00:00:00.000Z',
      contentScopeVersion: 2, kaUal: ual, assertionVersion: '1', publicTripleCount: 8, privateTripleCount: 0 });
    const term = text => { const [type, value, datatype, language] = capturedTermIdentity(text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text);
      return { type, value, ...(type === 'literal' && datatype !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype } : {}),
        ...(language ? { 'xml:lang': language } : {}) }; };
    const binding = q => ({ s: term(q.subject), p: term(q.predicate), o: term(q.object), g: term(q.graph) });
    const before = quads.map(binding);
    const swmGraph = `did:dkg:context-graph:${cg}/_shared_memory/${author.toLowerCase()}/1`;
    const rootValue = before.find(r => r.p.value.endsWith('/assertionMerkleRoot')).o.value;
    const metadata = [...before, ...[['state', '"promoted"'], ['memoryLayer', '"SWM"'], ['swmShareComplete', '"true"'],
      ['swmCurrentAssertion', JSON.stringify(rootValue)], ['assertionGraph', swmGraph]]
      .map(([p, object]) => binding({ subject: life, predicate: 'http://dkg.io/ontology/' + p, object, graph }))];
    const payload = Array.from({ length: 8 }, (_, i) => binding({ subject: `urn:2963:${arm}:${name}`,
      predicate: `https://schema.org/p${i}`, object: JSON.stringify(`${name} value ${i}`),
      graph: `did:dkg:context-graph:${cg}/_shared_memory/${author.toLowerCase()}/1` }));
    const root = path.join(cwd, '.tmp/2963/evidence', arm);
    const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(value)); };
    const rdf = bindings => ({ results: { bindings } });
    write('campaign-manifest.json', campaign); write('pre-workload/rdf.json', rdf(before));
    write('fixed-deadline/rdf.json', rdf([...metadata, ...payload]));
    write('fixed-deadline/inventory.json', { swm: [{ assertion_coordinate: name }] });
    write('fixed-deadline/catalogs.json', [{ rows: [{ assertionCoordinate: name }] }]);
    write('fixed-deadline/-api-publisher-jobs.json', { value: { jobs: [] } });
    write('synchronous-shares.json', [{ label: `share:${name}`, status: 200 }]); write('publication-admissions.json', []);
    write('protocol.json', { startedAt: '2026-10-16T00:00:00Z' }); write('context-graph.json', { value: { onChainId: 1 } });
    const run = () => {
      execFileSync(process.execPath, [fileURLToPath(new URL('./seal-proof.mjs', import.meta.url)), arm, 'fixed-deadline'], { cwd });
      execFileSync('python3', [fileURLToPath(new URL('./verify.py', import.meta.url)), arm, 'fixed-deadline'], { cwd });
      return { seals: JSON.parse(fs.readFileSync(path.join(root, 'seal-proof.json'))), proof: JSON.parse(fs.readFileSync(path.join(root, 'verification.json'))) };
    };
    const original = run(); assert.equal(original.seals.length, 1); assert.equal(original.seals[0].unchanged, true);
    assert.deepEqual(original.proof.sealChanged, []); assert.deepEqual(original.proof.missingLifecycle, []); assert.deepEqual(original.proof.lifecycleErrors, [], JSON.stringify(original.proof.assets));
    write('fixed-deadline/rdf.json', rdf([...metadata.map(r => ({ ...r, g: { type: 'uri', value: graph + '-relocated' } })), ...payload]));
    const moved = run(); assert.equal(moved.seals.length, 1); assert.equal(moved.seals[0].unchanged, false);
    assert.deepEqual(moved.proof.sealChanged, [name]); assert.deepEqual(moved.proof.missingLifecycle, [name]); assert.deepEqual(moved.proof.lifecycleErrors, [name]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
