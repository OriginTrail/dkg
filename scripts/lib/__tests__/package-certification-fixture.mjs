import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { BUILD_INPUTS, CASES, CLI, LAYOUTS, PROFILE, digest, hash, fileIdentity } from '../package-certification/bundle.mjs';

export const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
export function releaseGitFixture(expected) {
  const tag = `v${expected.version}`, object = 'c'.repeat(40);
  const responses = new Map([
    [`rev-parse --verify refs/tags/${tag}`, object],
    [`cat-file -t refs/tags/${tag}`, 'tag'],
    [`cat-file tag refs/tags/${tag}`, '-----BEGIN SSH SIGNATURE-----'],
    [`merge-base --is-ancestor ${tag}^{commit} origin/main`, ''],
    [`ls-remote origin refs/tags/${tag}`, `${object}\trefs/tags/${tag}`],
    [`rev-parse ${tag}^{commit}`, expected.commit],
  ]);
  return { tag, gitRunner: (command, args) => {
    assert.equal(command, 'git');
    assert.ok(responses.has(args.join(' ')), `unexpected git operation: ${args.join(' ')}`);
    return responses.get(args.join(' '));
  } };
}
// A registry's dist-tags, faked for promotion: what `runner` writes is what
// `readTags` reads back. `write` sees every npm call first; throwing fails it.
export function fakeDistTags({ write = () => {} } = {}) {
  const tags = new Map();
  return {
    readTags: pkg => ({ ...tags.get(pkg.name) }),
    runner: (command, args, options) => {
      write(command, args, options);
      if (args[0] !== 'dist-tag') return;
      const [, , spec, channel] = args, at = spec.lastIndexOf('@');
      tags.set(spec.slice(0, at), { ...tags.get(spec.slice(0, at)), [channel]: spec.slice(at + 1) });
    },
  };
}
export function archive(files) {
  const records = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write('0000644\0', 100);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}
export function fixture(t, { expected: suppliedExpected, inputRoot } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-certification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const attempt = path.join(root, 'attempt');
  fs.mkdirSync(bundle); fs.mkdirSync(attempt);
  fs.mkdirSync(path.join(bundle, 'tarballs'));
  fs.mkdirSync(path.join(bundle, 'inputs'));
  const inputs = BUILD_INPUTS.map(name => {
    const bytes = inputRoot ? fs.readFileSync(path.join(inputRoot, name)) : Buffer.from('fixture');
    fs.writeFileSync(path.join(bundle, 'inputs', name), bytes);
    return { path: `inputs/${name}`, sha256: hash(bytes) };
  });
  const commit = suppliedExpected?.commit ?? 'a'.repeat(40), version = suppliedExpected?.version ?? '10.0.25';
  const buildIdentity = { commit, commitShort: commit.slice(0, 8), dirty: false, buildTime: '2026-10-24T00:00:00.000Z', distTag: 'monorepo', ciRun: null };
  const expected = suppliedExpected ?? { commit, version, profile: PROFILE, sourceInputsDigest: hash('tracked'), inputHashes: Object.fromEntries(inputs.map(i => [i.path, i.sha256])), familyPolicy: { libp2p: '3.5.1' }, requiredAssets: { [CLI]: ['build-info.json', 'dist/cli.js'] }, packages: [
    { name: CLI, version, dependencies: { dependencies: { '@origintrail-official/dkg-core': version }, optionalDependencies: {}, peerDependencies: {}, devDependencies: {} } },
    { name: '@origintrail-official/dkg-core', version, dependencies: { dependencies: { libp2p: '3.5.1' }, optionalDependencies: {}, peerDependencies: {}, devDependencies: {} } },
  ] };
  const packages = expected.packages.map((pkg, i) => {
    const files = { ...Object.fromEntries((expected.requiredAssets[pkg.name] ?? []).map(asset => [asset, 'fixture asset'])), 'package.json': JSON.stringify({ name: pkg.name, version, ...pkg.dependencies }), 'dist/cli.js': 'export {};', ...(pkg.name === CLI ? { 'build-info.json': JSON.stringify(buildIdentity) } : {}) };
    const tarball = `tarballs/${i}.tgz`;
    fs.writeFileSync(path.join(bundle, tarball), archive(files));
    return { name: pkg.name, version, tarball, ...fileIdentity(path.join(bundle, tarball)), files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])) };
  });
  const manifest = { schemaVersion: 1, preparedAt: buildIdentity.buildTime, tools: { node: 'v22.23.4', pnpm: '10.28.1', npm: '10.9.8' }, lockPackages: ['libp2p@3.5.1'], source: { commit, sourceInputsDigest: expected.sourceInputsDigest, repository: 'https://github.com/OriginTrail/dkg' }, version, expectedPackages: expected.packages, packages, familyPolicy: expected.familyPolicy, requiredAssets: expected.requiredAssets, buildIdentity, inputs };
  manifest.packageSetDigest = digest(manifest);
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  const receiptFile = path.join(attempt, 'receipt.json');
  const receipt = { schemaVersion: 1, runId: 'test-run', profile: PROFILE, commit, toolRevision: commit, packageSetDigest: manifest.packageSetDigest, outcome: 'PASS', errors: [], startedAt: buildIdentity.buildTime, endedAt: buildIdentity.buildTime, requiredCases: CASES, layouts: [], evidence: [] };
  for (const layout of LAYOUTS) {
    const tree = { layout, packages: [...packages.map(p => ({ path: `node_modules/${p.name}`, name: p.name, version, integrity: p.integrity, filesDigest: digest(p.files) })), ...Object.entries(expected.familyPolicy).map(([name, version]) => ({ name, version, path: `node_modules/${name}` }))] };
    const report = {
      profile: PROFILE, layout, runId: receipt.runId, packageSetDigest: manifest.packageSetDigest,
      runtime: { os: 'linux', arch: 'arm64', node: 'v22.23.4', npm: '10.9.8' },
      cacheReader: { id: 'npm10-cacache19-v1', npmVersion: '10.9.8', cacacheVersion: '19.0.1' },
      cases: CASES.map(id => ({ id, outcome: 'PASS', errors: [], startedAt: receipt.startedAt, endedAt: receipt.endedAt })),
      observations: Object.fromEntries(['initial', 'restarted'].map(phase => [phase, {
        identity: { version, ...buildIdentity, storeBackend: 'oxigraph-worker' },
        rdfResponse: { result: { type: 'bindings', bindings: [{ value: '"installed-package-certification"' }] } },
      }])),
      logs: [`${layout}-daemon-1.log`, `${layout}-daemon-2.log`],
    };
    writeJson(path.join(attempt, `${layout}-tree.json`), tree);
    writeJson(path.join(attempt, `${layout}-report.json`), report);
    for (const log of [...report.logs, `${layout}-install.log`]) fs.writeFileSync(path.join(attempt, log), 'observed fixture output');
    receipt.layouts.push({ layout, tree: `${layout}-tree.json`, treeDigest: digest(tree), report: `${layout}-report.json`, installLog: `${layout}-install.log` });
  }
  const seal = () => {
    receipt.evidence = fs.readdirSync(attempt).filter(name => name !== 'receipt.json').map(name => ({ path: name, sha256: fileIdentity(path.join(attempt, name)).sha256 }));
    writeJson(receiptFile, receipt);
  };
  seal();
  return { root, bundle, attempt, expected, manifest, receipt, receiptFile, seal };
}
