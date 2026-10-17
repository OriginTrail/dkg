import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { defineCampaign } from './campaign-manifest.mjs';
import { validatePublicationCohort } from './publication-evidence.mjs';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const { Interface } = require('ethers');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const script = name => fileURLToPath(new URL(name, import.meta.url));

function fixture() {
  const campaign = defineCampaign('fixture');
  campaign.cohorts = { initial: ['A', 'B'], shares: [], publications: ['A', 'B'], restart: [] };
  campaign.faults = [];
  const seals = ['A', 'B'].map((name, i) => ({ name, unchanged: true, seal: {
    kaUal: `did:dkg:base:84532/${campaign.author.toLowerCase()}/${i + 1}`, assertionVersion: '1',
    assertionMerkleRoot: '0x' + (i ? 'bb' : 'aa').repeat(32), authorAddress: campaign.author.toLowerCase(), reservedKaId: String(i + 1),
  } }));
  const admissions = seals.map(({ name, seal }) => ({ label: `publish:${name}`, route: `/api/knowledge-assets/${name}/vm/publish-async`, status: 202,
    value: { jobId: `job-${name}`, name, contextGraphId: campaign.contextGraphId, agentAddress: campaign.author,
      kaUal: seal.kaUal, assertionVersion: seal.assertionVersion, sealMerkleRoot: seal.assertionMerkleRoot,
      shareOperationId: `operation-${name}`, intentKey: `intent-${name}` } }));
  const jobs = admissions.map(({ value }) => ({ jobId: value.jobId, status: 'finalized',
    request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: { ...value } },
    timestamps: { acceptedAt: 0, finalizedAt: 1 }, broadcast: { txHash: 'tx', nonce: 0, walletId: campaign.author },
    inclusion: { txHash: 'tx' }, finalization: { txHash: 'tx', ual: value.kaUal } }));
  return { campaign, admissions, jobs, seals };
}
const validate = f => validatePublicationCohort(f.campaign, f.admissions, f.jobs, f.seals);

test('publication identity binds manifest, admission job IDs and original coordinates without depending on row order', () => {
  const f = fixture();
  assert.equal(validate(f).valid, true);
  f.jobs.reverse(); f.admissions.reverse(); f.seals.reverse();
  assert.equal(validate(f).valid, true);
  for (const mutate of [
    f => { f.campaign.cohorts.publications = ['A', 'A']; },
    f => { f.admissions[0].label = 'publish:other'; },
    f => { f.admissions[0].route = '/api/knowledge-assets/B/vm/publish-async'; },
    f => { f.admissions[0].status = 503; },
    f => { f.admissions[0].value.jobId = f.admissions[1].value.jobId; },
    f => { [f.admissions[0].value.jobId, f.admissions[1].value.jobId] = [f.admissions[1].value.jobId, f.admissions[0].value.jobId]; },
    f => { f.jobs[0] = f.jobs[1]; },
    f => { f.jobs.pop(); },
    f => { f.jobs.push({ ...f.jobs[0], jobId: 'extra' }); },
    ...['name', 'contextGraphId', 'agentAddress', 'kaUal', 'assertionVersion', 'sealMerkleRoot', 'shareOperationId', 'intentKey']
      .map(field => f => { f.jobs[0].request.knowledgeAssetVmPublish[field] = 'wrong'; }),
    f => { f.seals[0].unchanged = false; },
    f => { f.seals[0].unchanged = 'false'; },
  ]) {
    const bad = fixture(); mutate(bad);
    assert.equal(validate(bad).valid, false);
    assert.ok(validate(bad).errors.length);
  }
});

test('proof entry points reject a different published asset with unchanged counts and otherwise valid payloads', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-cohort-'));
  try {
    const abiPath = 'packages/chain/abi/DKGKnowledgeAssets.json';
    fs.mkdirSync(path.dirname(path.join(cwd, abiPath)), { recursive: true });
    fs.copyFileSync(path.join(repo, abiPath), path.join(cwd, abiPath));
    const f = fixture(), { campaign, seals } = f;
    campaign.cohorts.publications = ['A'];
    const arm = campaign.arm, cg = campaign.contextGraphId, author = campaign.author, meta = `did:dkg:context-graph:${cg}/_meta`;
    const root = path.join(cwd, '.tmp/2963/evidence', arm);
    const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const rdf = bindings => ({ results: { bindings } });
    const row = (g, s, p, value, type = 'literal') => ({ g: { type: 'uri', value: g }, s: { type: 'uri', value: s },
      p: { type: 'uri', value: `http://dkg.io/ontology/${p}` }, o: { type, value } });
    const before = seals.flatMap(({ name, seal }) => {
      const subject = `did:dkg:context-graph:${cg}/assertion/${author}/${name}`, life = `urn:dkg:assertion:${cg}:${author}:${name}`;
      return [...['kaUal', 'assertionVersion', 'assertionMerkleRoot'].map(p => row(meta, subject, p, seal[p])),
        row(meta, life, 'shareOperationId', `operation-${name}`), row(meta, life, 'promoteOperationIntent', JSON.stringify({
          version: 1, operationId: `operation-${name}`, timestampMs: 1, confirmationRequired: false, accessPolicy: 'public', allowedPeers: [] }))];
    });
    function captures(publishedName) {
      return [...before, ...seals.flatMap(({ name, seal }, i) => {
        const published = name === publishedName, graph = `did:dkg:context-graph:${cg}/${published ? '_verifiable_memory' : '_shared_memory'}/${author.toLowerCase()}/${i + 1}`;
        const life = `urn:dkg:assertion:${cg}:${author}:${name}`;
        const payload = Array.from({ length: 8 }, (_, j) => ({ g: { type: 'uri', value: graph }, s: { type: 'uri', value: `urn:2963:${arm}:${name}` },
          p: { type: 'uri', value: `https://schema.org/p${j}` }, o: { type: 'literal', value: `${name} value ${j}` } }));
        return [row(meta, life, 'state', published ? 'published' : 'promoted'), row(meta, life, 'memoryLayer', published ? 'VM' : 'SWM'),
          row(meta, life, 'assertionGraph', graph, 'uri'), row(meta, life, published ? 'vmCurrentAssertion' : 'swmCurrentAssertion', seal.assertionMerkleRoot),
          row(meta, life, 'swmShareComplete', 'true'), ...payload,
          ...(published ? payload.map(r => ({ ...r, g: { type: 'uri', value: `did:dkg:context-graph:${cg}/context/1` } })) : [])];
      })];
    }
    const admission = structuredClone(f.admissions[0]);
    const expectedContract = '0x5555555555555555555555555555555555555555';
    const install = (name, contract = expectedContract) => {
      const i = name === 'A' ? 0 : 1, job = structuredClone(f.jobs[i]);
      // Preserve A's admission/job ID even when the actual request, receipt and payload are B.
      job.jobId = admission.value.jobId;
      for (const label of ['fixed-deadline', 'restart-readback']) {
        write(`${label}/rdf.json`, rdf(captures(name)));
        write(`${label}/-api-publisher-jobs.json`, { value: { jobs: [job] } });
      }
      const abi = JSON.parse(fs.readFileSync(path.join(repo, 'packages/chain/abi/DKGKnowledgeAssets.json'))), iface = new Interface(abi.abi ?? abi);
      const event = iface.encodeEventLog(iface.getEvent('KnowledgeAssetCreated'), [i + 1, author, 'publish', seals[i].seal.assertionMerkleRoot, 1, 1, 2, 1, false]);
      write('reconciliation.json', { receipts: [{ jobId: job.jobId, hash: 'tx', from: author, nonce: 0, blockNumber: 123,
        logs: [{ address: contract, ...event }] }] });
    };
    const hub = '0x6666666666666666666666666666666666666666';
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(path.join(root, '..', 'baseline-balances-nonces.json'), JSON.stringify({ chainId: 84532, hub }));
    write('chain-deployment.json', { arm, chainId: '84532', hub, provenance: 'historical-hub-read-at-receipt-block',
      blocks: [{ blockNumber: 123, blockHash: '0x' + '77'.repeat(32), knowledgeAssets: expectedContract }] });
    write('campaign-manifest.json', campaign); write('seal-proof.json', seals); write('pre-workload/rdf.json', rdf(before));
    write('publication-admissions.json', [admission]); write('synchronous-shares.json', []);
    write('protocol.json', { startedAt: '1970-01-01T00:00:00Z' }); write('context-graph.json', { value: { onChainId: 1 } });
    write('fixed-deadline/inventory.json', { swm: seals.map(s => ({ assertion_coordinate: s.name })) });
    write('fixed-deadline/catalogs.json', [{ rows: seals.map(s => ({ assertionCoordinate: s.name })) }]);
    write('restart-readback/manifest.json', { observedAt: '2026-10-17T00:00:00Z' });
    fs.mkdirSync(path.join(root, 'restart-regression'));
    const home = path.join(cwd, 'home'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ contextGraphs: [cg], store: { options: { url: 'http://127.0.0.1:1' } } }));
    const run = (file, args = [arm]) => spawnSync(file.endsWith('.py') ? 'python3' : process.execPath, [script(file), ...args], { cwd, env: { ...process.env, DKG_HOME: home }, encoding: 'utf8' });
    install('A');
    for (const file of ['verify.py', 'chain-proof.mjs', 'restart-content-proof.py']) {
      const result = run(file, file === 'restart-content-proof.py' ? [arm] : [arm, 'fixed-deadline']);
      assert.equal(result.status, 0, result.stderr);
    }
    const valid = JSON.parse(fs.readFileSync(path.join(root, 'verification.json')));
    for (const key of ['sealChanged', 'lifecycleErrors', 'operationErrors', 'contentErrors']) assert.deepEqual(valid[key], []);
    const binding = JSON.parse(fs.readFileSync(path.join(root, 'chain-deployment.json')));
    for (const invalidBinding of [
      { ...binding, hub: expectedContract }, { ...binding, blocks: [] },
      { ...binding, blocks: [...binding.blocks, ...binding.blocks] },
      { ...binding, blocks: [{ ...binding.blocks[0], knowledgeAssets: '0x' + '0'.repeat(40) }] },
    ]) {
      write('chain-deployment.json', invalidBinding);
      assert.notEqual(run('chain-proof.mjs', [arm, 'fixed-deadline']).status, 0, 'accepted invalid deployment binding');
    }
    write('chain-deployment.json', binding);
    install('A', '0x8888888888888888888888888888888888888888');
    const foreign = run('chain-proof.mjs', [arm, 'fixed-deadline']);
    assert.notEqual(foreign.status, 0, 'chain proof accepted an otherwise identical foreign-contract event');
    const foreignProof = JSON.parse(fs.readFileSync(path.join(root, 'chain-proof.json')));
    assert.equal(foreignProof[0].createdEvents, 1);
    assert.equal(foreignProof[0].carrierMatches, true);
    assert.equal(foreignProof[0].contractMatches, false);
    assert.equal(foreignProof[0].identityMatches, false);
    install('B');
    for (const file of ['verify.py', 'chain-proof.mjs', 'restart-content-proof.py']) {
      const result = run(file, file === 'restart-content-proof.py' ? [arm] : [arm, 'fixed-deadline']);
      if (file === 'verify.py' && result.status === 0) {
        const oldProof = JSON.parse(fs.readFileSync(path.join(root, 'verification.json')));
        for (const key of ['sealChanged', 'lifecycleErrors', 'operationErrors', 'contentErrors']) assert.deepEqual(oldProof[key], []);
        assert.equal(oldProof.publications.states.finalized, 1);
      }
      assert.notEqual(result.status, 0, `${file} accepted the wrong publication cohort`);
    }
    const invalid = JSON.parse(fs.readFileSync(path.join(root, 'verification.json')));
    assert.equal(invalid.publications.admissions, 1); assert.equal(invalid.publications.states.finalized, 1);
    assert.equal(invalid.publications.identity.valid, false);
    assert.ok(invalid.publications.identity.errors.some(e => e.includes('job name mismatch')));
    for (const mode of ['before', 'after']) assert.match(run('restart-identity-proof.mjs', [arm, mode]).stderr, /Publication cohort mismatch/);
    // A corrupted restart snapshot must fail even if the main snapshot was valid.
    write('fixed-deadline/-api-publisher-jobs.json', { value: { jobs: [f.jobs[0]] } });
    assert.match(run('restart-identity-proof.mjs', [arm, 'after']).stderr, /Publication cohort mismatch/);
    assert.notEqual(run('restart-content-proof.py').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'restart-regression/whole-cohort-content-proof.json'))).restartPublicationIdentity.valid, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
