import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCertificate, verifyBundle, digest, readJson, tarFiles, fileIdentity, hash } from '../package-certification/bundle.mjs';
import { preparedRelease, checkRegistrySet } from '../package-certification/publish.mjs';
import { fixture, writeJson, archive } from './package-certification-fixture.mjs';
import { startRegistry } from '../package-certification/registry.mjs';

test('portable bundle and complete observed receipt verify against independently supplied candidate', t => {
  const f = fixture(t);
  assert.equal(verifyCertificate(f.bundle, f.receiptFile, f.expected).receipt.outcome, 'PASS');
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, { ...f.expected, commit: 'b'.repeat(40) }), /subject commit/);
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, { ...f.expected, version: '10.0.26' }), /candidate version/);
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, { ...f.expected, profile: 'network-acceptance' }), /profile/);
});
for (const [name, damage] of [
  ['changed tarball', f => fs.appendFileSync(path.join(f.bundle, f.manifest.packages[0].tarball), 'tamper')],
  ['wrong tool revision', f => { f.receipt.toolRevision = 'b'.repeat(40); }],
  ['wrong digest', f => { f.manifest.packageSetDigest = 'bad'; }],
  ['missing package', f => { f.manifest.packages.pop(); }],
  ['duplicate package', f => { f.manifest.packages.push(f.manifest.packages[0]); }],
  ['wrong internal dependency', f => { f.manifest.expectedPackages[0].dependencies.dependencies['@origintrail-official/dkg-core'] = '9.0.0'; }],
  ['missing report', f => fs.unlinkSync(path.join(f.attempt, 'core-slot-report.json'))],
  ['changed report', f => fs.appendFileSync(path.join(f.attempt, 'core-slot-report.json'), ' ')],
  ['absent layout', f => { f.receipt.layouts.pop(); }],
  ['zero layouts', f => { f.receipt.layouts = []; }],
  ['duplicate layout', f => { f.receipt.layouts[1] = f.receipt.layouts[0]; }],
  ['failed outcome', f => { f.receipt.outcome = 'FAIL'; }],
  ['missing evidence', f => { f.receipt.evidence = []; }],
  ['unsafe evidence path', f => { f.receipt.evidence[0].path = '../outside'; }],
]) test(`fails closed: ${name}`, t => {
  const f = fixture(t);
  const originalExpected = structuredClone(f.expected);
  damage(f);
  writeJson(path.join(f.bundle, 'manifest.json'), f.manifest);
  writeJson(f.receiptFile, f.receipt);
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, originalExpected));
});
for (const [name, damage] of [
  ['missing case', r => r.cases.pop()], ['zero cases', r => { r.cases = []; }],
  ['skipped case', r => { r.cases[0].outcome = 'SKIP'; }],
  ['cancelled case', r => { r.cases[0].outcome = 'CANCELLED'; }],
  ['timed-out case', r => { r.cases[0].outcome = 'TIMEOUT'; }],
  ['malformed time', r => { r.cases[0].endedAt = 'unknown'; }],
  ['wrong build identity', r => { r.identity.commit = 'b'.repeat(40); }],
  ['wrong restart', r => { r.restartedIdentity.commit = 'b'.repeat(40); }],
  ['wrong readback', r => { r.rdfValue = 'something else'; }],
  ['no daemon logs', r => { r.logs = []; }],
]) test(`rejects internally rehashed execution evidence: ${name}`, t => {
  const f = fixture(t), file = path.join(f.attempt, 'core-slot-report.json');
  const report = readJson(file); damage(report); writeJson(file, report); f.seal();
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, f.expected));
});
for (const [name, damage] of [
  ['public same-version substitution', tree => { tree.packages[0].integrity = 'sha512-public'; }],
  ['changed installed asset', tree => { tree.packages[0].filesDigest = 'modified'; }],
  ['missing internal package', tree => { tree.packages.splice(1, 1); }],
  ['family drift', tree => { tree.packages[2].version = '99.0.0'; }],
  ['family duplicate', tree => { tree.packages.push({ ...tree.packages[2], path: 'nested/libp2p' }); }],
]) test(`rejects resolved dependency evidence: ${name}`, t => {
  const f = fixture(t), file = path.join(f.attempt, 'core-slot-tree.json');
  const tree = readJson(file); damage(tree); writeJson(file, tree);
  f.receipt.layouts[0].treeDigest = digest(tree); f.seal();
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, f.expected));
});
test('tar reader refuses unsafe package paths and invalid checksums', () => {
  assert.throws(() => tarFiles(archive({ '../escape': 'bad' })), /unsafe/);
});
test('self-consistent missing runtime asset is rejected by independent asset contract', t => {
  const f = fixture(t);
  const changed = structuredClone(f.manifest);
  changed.requiredAssets = {};
  delete changed.packageSetDigest; changed.packageSetDigest = digest(changed);
  writeJson(path.join(f.bundle, 'manifest.json'), changed);
  assert.throws(() => verifyBundle(f.bundle, f.expected), /asset contract/);
});
for (const [name, alter, message] of [
  ['wrong packed version', files => { const pkg = JSON.parse(files['package.json']); pkg.version = '9.0.0'; files['package.json'] = JSON.stringify(pkg); }, /wrong version/],
  ['wrong packed internal dependency', files => { const pkg = JSON.parse(files['package.json']); pkg.dependencies['@origintrail-official/dkg-core'] = 'workspace:*'; files['package.json'] = JSON.stringify(pkg); }, /relationships/],
  ['missing required packed asset', files => { delete files['dist/cli.js']; }, /missing required asset/],
  ['wrong packed build identity', files => { const identity = JSON.parse(files['build-info.json']); identity.commit = 'b'.repeat(40); files['build-info.json'] = JSON.stringify(identity); }, /wrong packed build identity/],
]) test(`rehashed real archive still fails intended policy: ${name}`, t => {
  const f = fixture(t), pkg = f.manifest.packages[0], file = path.join(f.bundle, pkg.tarball);
  const files = Object.fromEntries(tarFiles(fs.readFileSync(file)));
  alter(files);
  fs.writeFileSync(file, archive(files));
  Object.assign(pkg, fileIdentity(file), { files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) });
  delete f.manifest.packageSetDigest;
  f.manifest.packageSetDigest = digest(f.manifest);
  writeJson(path.join(f.bundle, 'manifest.json'), f.manifest);
  assert.throws(() => verifyBundle(f.bundle, f.expected), message);
});
function releaseOptions(f, extra = {}) {
  return { mode: 'publish', bundle: f.bundle, receiptFile: f.receiptFile, expected: f.expected, tags: ['canary'], authorize: () => {}, readDist: () => null, log: () => {}, ...extra };
}
test('publisher receives exact verified tarballs; no build/repack commands', t => {
  const f = fixture(t), calls = [];
  const progress = preparedRelease(releaseOptions(f, { runner: (...args) => calls.push(args) }));
  assert.equal(progress.completed.length, 2);
  assert.deepEqual(calls.map(([, args]) => args[1]), f.manifest.packages.map(p => path.join(f.bundle, p.tarball)));
  assert.ok(calls.every(([command, args]) => command === 'npm' && args[0] === 'publish'));
});
test('validation and authorization failures invoke no mutating runner', t => {
  const f = fixture(t); let mutations = 0;
  const runner = () => { mutations++; };
  assert.throws(() => preparedRelease(releaseOptions(f, { runner, authorize: () => { throw new Error('wrong tag source'); } })));
  fs.appendFileSync(path.join(f.bundle, f.manifest.packages[1].tarball), 'damaged');
  assert.throws(() => preparedRelease(releaseOptions(f, { runner })));
  assert.equal(mutations, 0);
});
test('preflights whole registry set before publish or promotion; rejects same-version mismatch', t => {
  const f = fixture(t);
  for (const mode of ['publish', 'promote']) {
    let calls = 0;
    assert.throws(() => preparedRelease(releaseOptions(f, { mode, readDist: p => ({ integrity: p.name === f.manifest.packages[1].name ? 'wrong' : p.integrity }), runner: () => { calls++; } })), /integrity mismatch/);
    assert.equal(calls, 0);
  }
  assert.throws(() => checkRegistrySet(f.manifest, () => null), /unpublished/);
});
test('partial publication reports exact completed set and only reuses matching bytes', t => {
  const f = fixture(t), published = new Map();
  let error;
  try {
    preparedRelease(releaseOptions(f, { runner: (_command, args) => {
      if (published.size) throw new Error('OTP=secret must not leak');
      const pkg = f.manifest.packages.find(p => path.join(f.bundle, p.tarball) === args[1]);
      published.set(pkg.name, { integrity: pkg.integrity });
    } }));
  } catch (e) { error = e; }
  assert.deepEqual(error.progress.completed, [{ package: f.manifest.packages[0].name, tag: 'canary' }]);
  assert.ok(!error.message.includes('secret'));
  const resumed = preparedRelease(releaseOptions(f, { readDist: p => published.get(p.name) ?? null, runner: () => {} }));
  assert.deepEqual(resumed.reused, [f.manifest.packages[0].name]);
  assert.deepEqual(resumed.completed, [{ package: f.manifest.packages[1].name, tag: 'canary' }]);
});
test('partial promotion reports non-atomic progress; dry-run is nonmutating and secret-free', t => {
  const f = fixture(t), lines = []; let count = 0;
  const options = releaseOptions(f, { mode: 'promote', readDist: p => ({ integrity: p.integrity }), otp: 'secret', tags: ['testnet', 'mainnet'], runner: () => { if (++count === 2) throw new Error('expired'); }, log: line => lines.push(line) });
  assert.throws(() => preparedRelease(options), error => error.progress.completed.length === 1);
  preparedRelease({ ...options, dryRun: true, runner: () => assert.fail('dry-run mutated') });
  assert.ok(lines.every(line => !line.includes('secret')));
});
test('registry acquisition cannot change bytes between verification and mutation', t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => preparedRelease(releaseOptions(f, { runner: () => { calls++; }, readDist: () => {
    fs.appendFileSync(path.join(f.bundle, f.manifest.packages[0].tarball), 'changed'); return null;
  } })));
  assert.equal(calls, 0);
});

test('candidate registry serves actual bytes and refuses scope fallback or runtime registry access', async t => {
  const f = fixture(t);
  const server = await startRegistry({ bundle: f.bundle, manifest: f.manifest, rpcUrl: 'http://127.0.0.1:1', upstream: 'http://127.0.0.1:1', log: path.join(f.root, 'registry.log') });
  try {
    const base = `http://127.0.0.1:${server.port}/registry/`;
    const response = await fetch(`${base}@origintrail-official%2fdkg`);
    const metadata = await response.json();
    assert.equal(metadata.versions[f.expected.version].dist.integrity, f.manifest.packages[0].integrity);
    const tarball = await fetch(`${base}${f.manifest.packages[0].tarball}`);
    assert.deepEqual(Buffer.from(await tarball.arrayBuffer()), fs.readFileSync(path.join(f.bundle, f.manifest.packages[0].tarball)));
    assert.equal((await fetch(`${base}@origintrail-official%2funknown`)).status, 404);
    assert.equal((await fetch(`${base}@origintrail-official`)).status, 404);
    server.setInstalling(false);
    assert.equal((await fetch(`${base}@origintrail-official%2fdkg`)).status, 403);
  } finally { await server.close(); }
});
