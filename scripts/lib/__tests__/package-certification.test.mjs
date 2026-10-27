import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCertificate, verifyBundle, digest, readJson, tarFiles, fileIdentity, hash, dependencies, validatePackedManifest } from '../package-certification/bundle.mjs';
import { preparedRelease, checkRegistrySet } from '../package-certification/publish.mjs';
import { fixture, writeJson, archive, releaseGitFixture, fakeDistTags } from './package-certification-fixture.mjs';
import { startRegistry } from '../package-certification/registry.mjs';
import { archiveRecords } from '../package-certification/npm-cache.mjs';

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
for (const [name, damage, error] of [
  ['missing package', m => m.packages.pop(), /missing\/duplicate package/],
  ['duplicate package', m => m.packages.push(m.packages[0]), /missing\/duplicate package/],
  ['wrong internal dependency', m => { m.expectedPackages[0].dependencies.dependencies['@origintrail-official/dkg-core'] = '9.0.0'; }, /missing\/duplicate\/unexpected package or dependency/],
]) test(`rehashed manifest enforces intended policy: ${name}`, t => {
  const f = fixture(t), expected = structuredClone(f.expected);
  damage(f.manifest);
  delete f.manifest.packageSetDigest;
  f.manifest.packageSetDigest = digest(f.manifest);
  writeJson(path.join(f.bundle, 'manifest.json'), f.manifest);
  assert.throws(() => verifyBundle(f.bundle, expected), error);
});
for (const [name, damage] of [
  ['missing case', r => r.cases.pop()], ['zero cases', r => { r.cases = []; }],
  ['skipped case', r => { r.cases[0].outcome = 'SKIP'; }],
  ['cancelled case', r => { r.cases[0].outcome = 'CANCELLED'; }],
  ['timed-out case', r => { r.cases[0].outcome = 'TIMEOUT'; }],
  ['malformed time', r => { r.cases[0].endedAt = 'unknown'; }],
  ['no daemon logs', r => { r.logs = []; }],
  ['missing cache reader', r => { delete r.cacheReader; }],
  ['wrong cache installer', r => { r.cacheReader.npmVersion = '10.0.0'; }],
  ['unsupported cache dependency', r => { r.cacheReader.cacacheVersion = '20.0.0'; }],
]) test(`rejects internally rehashed execution evidence: ${name}`, t => {
  const f = fixture(t), file = path.join(f.attempt, 'core-slot-report.json');
  const report = readJson(file); damage(report); writeJson(file, report); f.seal();
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, f.expected));
});

for (const phase of ['initial', 'restarted']) for (const [name, damage] of [
  ['missing observation', (r, phase) => { delete r.observations[phase]; }],
  ['wrong version', (r, phase) => { r.observations[phase].identity.version = '0.0.0'; }],
  ['wrong commit', (r, phase) => { r.observations[phase].identity.commit = 'b'.repeat(40); }],
  ['wrong build time', (r, phase) => { r.observations[phase].identity.buildTime = '2000-01-01T00:00:00Z'; }],
  ['wrong store', (r, phase) => { r.observations[phase].identity.storeBackend = 'memory'; }],
  ['wrong readback', (r, phase) => { r.observations[phase].rdfResponse.result.bindings[0].value = '"different"'; }],
  ['empty readback', (r, phase) => { r.observations[phase].rdfResponse.result.bindings = []; }],
  ['legacy response shape', (r, phase) => { r.observations[phase].rdfResponse = r.observations[phase].rdfResponse.result; }],
]) test(`rejects rehashed ${phase} observation: ${name}`, t => {
  const f = fixture(t), file = path.join(f.attempt, 'core-slot-report.json');
  const report = readJson(file); damage(report, phase); writeJson(file, report); f.seal();
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, f.expected));
});

test('cache adapter hashes fetched candidate bytes and records only fetched third-party versions', async t => {
  const f = fixture(t), pkg = f.manifest.packages[0];
  const prefix = 'make-fetch-happen:request-cache:';
  const metadata = Buffer.from(JSON.stringify({ name: 'third-party', versions: {
    '1.0.0': { version: '1.0.0', dist: { integrity: 'sha512-fetched', tarball: 'https://registry.npmjs.org/third-party/-/1.tgz' } },
    '2.0.0': { version: '2.0.0', dist: { integrity: 'sha512-not-fetched', tarball: 'https://registry.npmjs.org/third-party/-/2.tgz' } },
  } }));
  const entries = [
    { key: `${prefix}http://fixture:4873/registry/${pkg.tarball}`, integrity: 'candidate-cache-key' },
    { key: `${prefix}http://fixture:4873/registry/third-party`, integrity: 'metadata-cache-key' },
    { key: `${prefix}https://registry.npmjs.org/third-party/-/1.tgz`, integrity: 'sha512-fetched' },
  ];
  const records = await archiveRecords({ entries, manifest: f.manifest,
    readBytes: key => key === 'candidate-cache-key' ? fs.readFileSync(path.join(f.bundle, pkg.tarball)) : metadata,
  });
  assert.equal(records[`${pkg.name}@${pkg.version}`].integrity, pkg.integrity);
  assert.equal(records['third-party@1.0.0'].integrity, 'sha512-fetched');
  assert.equal(records['third-party@2.0.0'], undefined);
});

test('cache adapter refuses substituted candidate bytes even when the cache key claims expected integrity', async t => {
  const f = fixture(t), pkg = f.manifest.packages[0];
  await assert.rejects(archiveRecords({ manifest: f.manifest,
    entries: [{ key: `make-fetch-happen:request-cache:http://fixture:4873/registry/${pkg.tarball}`, integrity: pkg.integrity }],
    readBytes: () => Buffer.from('public package with the same version'),
  }), /candidate cache archive differs/);
});
for (const [name, damage] of [
  ['public same-version substitution', tree => { tree.packages[0].integrity = 'sha512-public'; }],
  ['changed installed asset', tree => { tree.packages[0].filesDigest = 'modified'; }],
  ['missing internal package', tree => { tree.packages.splice(1, 1); }],
  ['family drift', tree => { tree.packages[2].version = '99.0.0'; }],
  ['family duplicate', tree => { tree.packages.push({ ...tree.packages[2], path: 'nested/libp2p' }); }],
  ['swapped layout tree', tree => { tree.layout = 'edge-global'; }],
]) test(`rejects resolved dependency evidence: ${name}`, t => {
  const f = fixture(t), file = path.join(f.attempt, 'core-slot-tree.json');
  const tree = readJson(file); damage(tree); writeJson(file, tree);
  f.receipt.layouts[0].treeDigest = digest(tree); f.seal();
  assert.throws(() => verifyCertificate(f.bundle, f.receiptFile, f.expected));
});
test('tar reader refuses unsafe package paths and invalid checksums', () => {
  assert.throws(() => tarFiles(archive({ '../escape': 'bad' })), /unsafe/);
});
test('private build-only workspace references are rewritten but never accepted as runtime dependencies', () => {
  const name = '@origintrail-official/dkg-chain', privateName = '@origintrail-official/dkg-evm-module';
  const pkg = { name, version: '10.0.25', devDependencies: { [privateName]: '10.0.25' } };
  const validate = candidate => validatePackedManifest(candidate, { name, version: pkg.version, dependencies: dependencies(candidate) }, new Set([name]));
  validate(pkg);
  assert.throws(() => validate({ ...pkg, devDependencies: { [privateName]: 'workspace:*' } }), /local dependency escaped/);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => validate({ ...pkg, [field]: pkg.devDependencies }), /internal package absent/);
  }
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
  return { mode: 'publish', bundle: f.bundle, receiptFile: f.receiptFile, expected: f.expected, tags: ['canary'], ...releaseGitFixture(f.expected), readDist: () => null, readTags: () => ({}), askOtp: null, settle: 0, log: () => {}, ...extra };
}
for (const mode of ['publish', 'promote']) for (const matches of [true, false]) {
  test(`${mode} default authorization ${matches ? 'accepts' : 'rejects'} the resolved tag subject`, async t => {
    const f = fixture(t), tag = `v${f.expected.version}`, object = 'c'.repeat(40);
    const responses = new Map([
      [`rev-parse --verify refs/tags/${tag}`, object],
      [`cat-file -t refs/tags/${tag}`, 'tag'],
      [`cat-file tag refs/tags/${tag}`, '-----BEGIN SSH SIGNATURE-----'],
      [`merge-base --is-ancestor ${tag}^{commit} origin/main`, ''],
      [`ls-remote origin refs/tags/${tag}`, `${object}\trefs/tags/${tag}`],
      [`rev-parse ${tag}^{commit}`, matches ? f.expected.commit : 'b'.repeat(40)],
    ]);
    let reads = 0, mutations = 0;
    const options = releaseOptions(f, { mode, tag,
      gitRunner: (command, args) => {
        assert.equal(command, 'git');
        assert.ok(responses.has(args.join(' ')), `unexpected git operation: ${args.join(' ')}`);
        return responses.get(args.join(' '));
      },
      readDist: pkg => { reads++; return mode === 'promote' ? { integrity: pkg.integrity } : null; },
      ...fakeDistTags({ write: () => { mutations++; } }),
    });
    if (matches) {
      await preparedRelease(options);
      assert.equal(reads, f.manifest.packages.length);
      assert.equal(mutations, f.manifest.packages.length);
    } else {
      await assert.rejects(preparedRelease(options), /tag does not identify prepared source/);
      assert.equal(reads, 0, 'authorization must precede registry acquisition');
      assert.equal(mutations, 0, 'authorization must precede mutation');
    }
  });
}
test('publication plan exposes consumers only after their candidate dependencies; uses exact tarballs', async t => {
  const f = fixture(t), calls = [], available = new Set();
  const progress = await preparedRelease(releaseOptions(f, { runner: (command, args) => {
    const pkg = f.manifest.packages.find(p => path.join(f.bundle, p.tarball) === args[1]);
    const policy = f.expected.packages.find(p => p.name === pkg.name);
    for (const name of Object.keys(policy.dependencies.dependencies)) {
      if (name.startsWith('@origintrail-official/')) assert.ok(available.has(name), `unpublished dependency: ${name}`);
    }
    available.add(pkg.name);
    calls.push([command, args]);
  } }));
  assert.equal(progress.completed.length, 2);
  assert.deepEqual(progress.completed, progress.planned);
  assert.deepEqual(calls.map(([, args]) => args[1]), [...f.manifest.packages].reverse().map(p => path.join(f.bundle, p.tarball)));
  assert.ok(calls.every(([command, args]) => command === 'npm' && args[0] === 'publish'));
});
test('validation and authorization failures invoke no mutating runner', async t => {
  const f = fixture(t); let mutations = 0;
  const runner = () => { mutations++; };
  await assert.rejects(preparedRelease(releaseOptions(f, { runner, gitRunner: () => { throw new Error('tag unavailable'); } })));
  fs.appendFileSync(path.join(f.bundle, f.manifest.packages[1].tarball), 'damaged');
  await assert.rejects(preparedRelease(releaseOptions(f, { runner })));
  assert.equal(mutations, 0);
});
test('preflights whole registry set before publish or promotion; rejects same-version mismatch', async t => {
  const f = fixture(t);
  for (const mode of ['publish', 'promote']) {
    let calls = 0;
    await assert.rejects(preparedRelease(releaseOptions(f, { mode, readDist: p => ({ integrity: p.name === f.manifest.packages[1].name ? 'wrong' : p.integrity }), runner: () => { calls++; } })), /integrity mismatch/);
    assert.equal(calls, 0);
  }
  assert.throws(() => checkRegistrySet(f.manifest, () => null), /unpublished/);
});
test('partial publication reports exact completed set and only reuses matching bytes', async t => {
  const f = fixture(t), published = new Map();
  let error;
  try {
    await preparedRelease(releaseOptions(f, { runner: (_command, args) => {
      if (published.size) throw new Error('OTP=secret must not leak');
      const pkg = f.manifest.packages.find(p => path.join(f.bundle, p.tarball) === args[1]);
      published.set(pkg.name, { integrity: pkg.integrity });
    } }));
  } catch (e) { error = e; }
  assert.deepEqual(error.progress.completed, error.progress.planned.slice(0, 1));
  assert.deepEqual(error.progress.completed, [{ package: f.manifest.packages[1].name, tag: 'canary' }]);
  assert.ok(!error.message.includes('secret'));
  const resumed = await preparedRelease(releaseOptions(f, { readDist: p => published.get(p.name) ?? null, runner: () => {} }));
  assert.deepEqual(resumed.reused, [f.manifest.packages[1].name]);
  assert.deepEqual(resumed.completed, [{ package: f.manifest.packages[0].name, tag: 'canary' }]);
});
test('partial promotion reports non-atomic progress; dry-run is nonmutating and secret-free', async t => {
  const f = fixture(t), lines = []; let count = 0;
  const options = releaseOptions(f, { mode: 'promote', readDist: p => ({ integrity: p.integrity }), otp: '135791', tags: ['testnet', 'mainnet'], ...fakeDistTags({ write: () => { if (++count === 2) throw new Error('expired'); } }), log: line => lines.push(line) });
  await assert.rejects(preparedRelease(options), error => {
    assert.equal(error.progress.planned.length, 4);
    assert.deepEqual(error.progress.completed, error.progress.planned.slice(0, 1));
    return true;
  });
  await preparedRelease({ ...options, dryRun: true, runner: () => assert.fail('dry-run mutated') });
  assert.ok(lines.every(line => !line.includes('135791')));
});
test('registry acquisition cannot change bytes between verification and mutation', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(preparedRelease(releaseOptions(f, { runner: () => { calls++; }, readDist: () => {
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

test('cyclic internal runtime dependencies fail publication before mutation', async t => {
  const initial = fixture(t);
  const expected = structuredClone(initial.expected);
  expected.packages[1].dependencies.optionalDependencies[expected.packages[0].name] = expected.version;
  const f = fixture(t, { expected });
  await assert.rejects(preparedRelease(releaseOptions(f, { runner: () => assert.fail('cycle mutated') })), /cyclic internal publication dependency/);
});


test('promotion and direct stable publication cannot omit the decision or mutate after it fails', async t => {
  const f = fixture(t);
  for (const extra of [{ mode: 'promote' }, { tags: ['latest'] }, { tags: ['mainnet'] }]) {
    const options = releaseOptions(f, { ...extra, evidenceFile: undefined, runner: () => assert.fail('mutated without decision') });
    await assert.rejects(preparedRelease(options), /decision file is required/);
    options.evidenceFile = 'decision.json';
    options.prepareEvidence = () => { throw new Error('decision invalid'); };
    await assert.rejects(preparedRelease(options), /decision invalid/);
  }
});

for (const mode of ['promote', 'publish']) for (const dryRun of [false, true]) test(`${mode}: evidence invalidated during registry acquisition blocks ${dryRun ? 'dry-run planning' : 'every mutation'}`, async t => {
  const f = fixture(t);
  let verified = 0, acquired = 0, mutations = 0, valid = true;
  const options = releaseOptions(f, { mode, tags: ['mainnet'], dryRun, evidenceFile: 'decision.json',
    prepareEvidence: () => { verified++; assert.ok(valid, 'qualification changed during acquisition'); },
    readTags: async () => ({}), askOtp: null, settle: 0,
    readDist: pkg => { acquired++; valid = false; return mode === 'publish' ? null : { integrity: pkg.integrity }; },
    runner: () => { mutations++; },
  });
  await assert.rejects(preparedRelease(options), /qualification changed during acquisition/);
  assert.equal(verified, 2);
  assert.equal(acquired, f.manifest.packages.length);
  assert.equal(mutations, 0);
});

for (const channel of ['latest', 'mainnet']) for (const damage of ['certificate', 'changed report', 'missing report']) {
  test(`direct ${channel} publication rechecks ${damage} after final evidence acquisition`, async t => {
    const f = fixture(t);
    let acquisitions = 0, mutations = 0;
    const options = releaseOptions(f, { tags: [channel], readDist: () => null,
      prepareEvidence: async () => {
        if (++acquisitions === 2) {
          if (damage === 'certificate') writeJson(f.receiptFile, {});
          else if (damage === 'changed report') fs.appendFileSync(path.join(f.attempt, 'core-slot-report.json'), ' ');
          else fs.unlinkSync(path.join(f.attempt, 'core-slot-report.json'));
        }
        return { recheckLocalIntegrity: () => {} };
      },
      runner: () => { mutations++; },
    });
    await assert.rejects(preparedRelease(options));
    assert.equal(acquisitions, 2);
    assert.equal(mutations, 0);
  });
}

test('canary publication remains available without stable-release evidence', async t => {
  const f = fixture(t); let mutations = 0;
  await preparedRelease(releaseOptions(f, { evidenceFile: undefined,
    prepareEvidence: () => { throw new Error('canary should not acquire stable-release evidence'); },
    runner: () => { mutations++; },
  }));
  assert.equal(mutations, f.manifest.packages.length);
});
