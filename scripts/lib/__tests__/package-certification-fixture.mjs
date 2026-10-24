import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { CASES, CLI, LAYOUTS, PROFILE, digest, hash, fileIdentity } from '../package-certification/bundle.mjs';

export const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-certification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const attempt = path.join(root, 'attempt');
  fs.mkdirSync(bundle); fs.mkdirSync(attempt);
  fs.mkdirSync(path.join(bundle, 'tarballs'));
  const commit = 'a'.repeat(40), version = '10.0.25';
  const buildIdentity = { commit, commitShort: commit.slice(0, 8), dirty: false, buildTime: '2026-10-24T00:00:00.000Z', distTag: 'monorepo', ciRun: null };
  const expected = { commit, version, profile: PROFILE, familyPolicy: { libp2p: '3.5.1' }, requiredAssets: { [CLI]: ['build-info.json', 'dist/cli.js'] }, packages: [
    { name: CLI, version, dependencies: { dependencies: { '@origintrail-official/dkg-core': version }, optionalDependencies: {}, peerDependencies: {} } },
    { name: '@origintrail-official/dkg-core', version, dependencies: { dependencies: { libp2p: '3.5.1' }, optionalDependencies: {}, peerDependencies: {} } },
  ] };
  const packages = expected.packages.map((pkg, i) => {
    const files = { 'package.json': JSON.stringify({ name: pkg.name, version, ...pkg.dependencies }), 'dist/cli.js': 'export {};', ...(i === 0 ? { 'build-info.json': JSON.stringify(buildIdentity) } : {}) };
    const tarball = `tarballs/${i}.tgz`;
    fs.writeFileSync(path.join(bundle, tarball), archive(files));
    return { name: pkg.name, version, tarball, ...fileIdentity(path.join(bundle, tarball)), files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])) };
  });
  const manifest = { schemaVersion: 1, source: { commit, repository: 'https://github.com/OriginTrail/dkg' }, version, expectedPackages: expected.packages, packages, familyPolicy: expected.familyPolicy, requiredAssets: expected.requiredAssets, buildIdentity, inputs: [] };
  manifest.packageSetDigest = digest(manifest);
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  const receiptFile = path.join(attempt, 'receipt.json');
  const receipt = { schemaVersion: 1, runId: 'test-run', profile: PROFILE, commit, toolRevision: commit, packageSetDigest: manifest.packageSetDigest, outcome: 'PASS', errors: [], startedAt: buildIdentity.buildTime, endedAt: buildIdentity.buildTime, requiredCases: CASES, layouts: [], evidence: [] };
  for (const layout of LAYOUTS) {
    const tree = { packages: [...packages.map(p => ({ path: `node_modules/${p.name}`, name: p.name, version, integrity: p.integrity, filesDigest: digest(p.files) })), { name: 'libp2p', version: '3.5.1', path: 'node_modules/libp2p' }] };
    const report = {
      profile: PROFILE, layout, runId: receipt.runId, packageSetDigest: manifest.packageSetDigest,
      runtime: { os: 'linux', arch: 'arm64', node: 'v22.23.4', npm: '10.9.8' },
      cases: CASES.map(id => ({ id, outcome: 'PASS', errors: [], startedAt: receipt.startedAt, endedAt: receipt.endedAt })),
      identity: { version, ...buildIdentity, storeBackend: 'oxigraph-worker' }, restartedIdentity: { version, ...buildIdentity, storeBackend: 'oxigraph-worker' },
      rdfValue: 'installed-package-certification', restartedRdfValue: 'installed-package-certification',
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
