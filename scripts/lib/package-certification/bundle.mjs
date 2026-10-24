// Read-only validation. No build, installation, registry access or evidence creation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

export const PROFILE = 'installed-local-rdf-v1';
export const LAYOUTS = ['core-slot', 'edge-global'];
export const CASES = ['install', 'dependency-policy', 'cli-identity', 'runtime-assets', 'daemon-status', 'rdf-readback', 'graceful-restart'];
export const SCHEMA = 1;
export const CLI = '@origintrail-official/dkg';
export const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => hash(canonical(value));
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function fileIdentity(file) {
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, sha256: hash(bytes), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` };
}
export function relativeFile(root, relative) {
  assert.equal(typeof relative, 'string', 'relative path required');
  assert.ok(relative && !relative.includes('\\') && !relative.startsWith('/') && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe artifact path');
  const file = path.join(root, relative);
  assert.ok(fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`), 'artifact escapes bundle');
  assert.ok(fs.statSync(file).isFile(), 'artifact must be a regular file');
  return file;
}

/** npm/pnpm's POSIX ustar package format. Reject links, duplicate files and extensions
 * we cannot interpret, rather than extracting untrusted archive paths onto disk. */
export function tarFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const size = Number.parseInt(string(124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'invalid tar size');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(sum, Number.parseInt(string(148, 8).trim(), 8), 'invalid tar checksum');
    const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    const type = string(156, 1);
    assert.ok(['', '0', '5'].includes(type), `unsupported tar entry ${type}: ${name}`);
    if (type !== '5') {
      assert.ok(name.startsWith('package/') && !name.includes('\\') && name.split('/').every(p => p && p !== '..' && p !== '.'), `unsafe tar path ${name}`);
      const relative = name.slice(8);
      assert.ok(!files.has(relative), `duplicate tar path ${relative}`);
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(files.has('package.json'), 'tarball has no package.json');
  return files;
}
export const dependencies = pkg => Object.fromEntries(['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].map(field => [field, pkg[field] ?? {}]));
export function validatePackedManifest(pkg, expected, names) {
  assert.equal(pkg.name, expected.name, 'wrong package name');
  assert.equal(pkg.version, expected.version, `wrong version: ${pkg.name}`);
  assert.notEqual(pkg.private, true, 'private package in prepared set');
  assert.deepEqual(dependencies(pkg), expected.dependencies, `wrong internal/dependency relationships: ${pkg.name}`);
  for (const deps of Object.values(dependencies(pkg))) for (const [name, spec] of Object.entries(deps)) {
    assert.ok(!/^(workspace:|link:|file:|\/|\.\.?\/)/.test(spec), `local dependency escaped: ${pkg.name} ${name}`);
    if (name.startsWith('@origintrail-official/')) {
      assert.ok(names.has(name), `internal package absent: ${name}`);
      assert.equal(spec, expected.version, `internal dependency must resolve exact candidate: ${name}`);
    }
  }
}
export function validateManifest(manifest, expected) {
  assert.equal(manifest.schemaVersion, SCHEMA, 'manifest schema');
  assert.match(expected.commit, /^[a-f0-9]{40}$/, 'full intended source commit required');
  assert.equal(manifest.source.commit, expected.commit, 'stale/wrong subject commit');
  assert.equal(manifest.version, expected.version, 'wrong candidate version');
  assert.equal(expected.profile, PROFILE, 'unsupported required profile');
  assert.equal(manifest.source.repository, 'https://github.com/OriginTrail/dkg');
  const { packageSetDigest, ...contents } = manifest;
  assert.equal(packageSetDigest, digest(contents), 'wrong package-set digest');
  assert.deepEqual(manifest.expectedPackages, expected.packages, 'missing/duplicate/unexpected package or dependency');
  assert.deepEqual(manifest.familyPolicy, expected.familyPolicy, 'family policy differs from intended source');
  assert.deepEqual(manifest.requiredAssets, expected.requiredAssets, 'asset contract differs from intended source');
  assert.deepEqual(manifest.packages.map(p => ({ name: p.name, version: p.version })), expected.packages.map(p => ({ name: p.name, version: p.version })), 'missing/duplicate package');
  assert.equal(manifest.buildIdentity.commit, expected.commit, 'wrong build identity');
  assert.equal(manifest.buildIdentity.dirty, false, 'unclean build identity');
  assert.ok(Date.parse(manifest.buildIdentity.buildTime), 'missing build time');
}
export function verifyBundle(bundle, expected) {
  const manifest = readJson(path.join(bundle, 'manifest.json'));
  validateManifest(manifest, expected);
  for (const input of manifest.inputs) assert.equal(fileIdentity(relativeFile(bundle, input.path)).sha256, input.sha256, `changed build input: ${input.path}`);
  const names = new Set(expected.packages.map(p => p.name));
  for (let i = 0; i < manifest.packages.length; i++) {
    const pkg = manifest.packages[i];
    const file = relativeFile(bundle, pkg.tarball);
    assert.deepEqual(fileIdentity(file), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `changed tarball: ${pkg.name}`);
    const files = tarFiles(fs.readFileSync(file));
    validatePackedManifest(JSON.parse(files.get('package.json')), expected.packages[i], names);
    assert.deepEqual(Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])), pkg.files, `changed packaged file inventory: ${pkg.name}`);
    for (const asset of manifest.requiredAssets[pkg.name] ?? []) assert.ok(files.has(asset) && files.get(asset).length > 0, `missing required asset: ${pkg.name}/${asset}`);
    if (pkg.name === CLI) assert.deepEqual(JSON.parse(files.get('build-info.json')), manifest.buildIdentity, 'wrong packed build identity');
  }
  return manifest;
}

export function validateTree(tree, manifest) {
  assert.ok(Array.isArray(tree.packages) && tree.packages.length > 0, 'empty dependency tree');
  const byName = new Map();
  for (const pkg of tree.packages) {
    assert.ok(typeof pkg.path === 'string' && typeof pkg.version === 'string');
    if (!byName.has(pkg.name)) byName.set(pkg.name, []);
    byName.get(pkg.name).push(pkg);
    if (pkg.name.startsWith('@origintrail-official/')) {
      const prepared = manifest.packages.find(p => p.name === pkg.name);
      assert.ok(prepared, `unexpected internal package ${pkg.name}`);
      assert.equal(pkg.version, prepared.version, `wrong installed internal version ${pkg.name}`);
      assert.equal(pkg.integrity, prepared.integrity, `public-registry substitution: ${pkg.name}`);
      assert.equal(pkg.filesDigest, digest(prepared.files), `modified installed package: ${pkg.name}`);
    }
  }
  const visit = (name, seen = new Set()) => {
    if (seen.has(name)) return;
    seen.add(name);
    assert.ok(byName.has(name), `missing installed internal package: ${name}`);
    const pkg = manifest.expectedPackages.find(p => p.name === name);
    for (const dep of Object.keys(pkg.dependencies.dependencies)) if (dep.startsWith('@origintrail-official/')) visit(dep, seen);
  };
  visit(CLI);
  for (const [name, version] of Object.entries(manifest.familyPolicy)) {
    const installed = byName.get(name) ?? [];
    assert.equal(installed.length, 1, `missing or duplicate family dependency: ${name}`);
    assert.equal(installed[0].version, version, `unacceptable family dependency drift: ${name}`);
  }
}
export function verifyCertificate(bundle, receiptFile, expected) {
  const manifest = verifyBundle(bundle, expected);
  const receipt = readJson(receiptFile);
  const evidenceRoot = path.dirname(receiptFile);
  assert.equal(receipt.schemaVersion, SCHEMA, 'receipt schema');
  assert.equal(receipt.packageSetDigest, manifest.packageSetDigest, 'receipt package-set digest');
  assert.equal(receipt.commit, expected.commit, 'receipt subject commit');
  assert.equal(receipt.profile, expected.profile, 'wrong profile');
  assert.equal(receipt.outcome, 'PASS', 'certification did not pass');
  assert.deepEqual(receipt.errors, [], 'receipt contains errors');
  assert.equal(receipt.toolRevision, expected.toolRevision ?? expected.commit, 'wrong certification tool revision');
  assert.match(receipt.runId, /^[a-z0-9-]+$/);
  assert.ok(Date.parse(receipt.startedAt) <= Date.parse(receipt.endedAt), 'invalid receipt interval');
  assert.deepEqual(receipt.requiredCases, CASES, 'wrong required cases');
  assert.deepEqual(receipt.layouts.map(l => l.layout), LAYOUTS, 'absent/duplicate install layout');
  assert.ok(receipt.evidence.length > 0, 'missing evidence');
  const evidence = new Map();
  for (const item of receipt.evidence) {
    assert.ok(!evidence.has(item.path), 'duplicate evidence');
    const file = relativeFile(evidenceRoot, item.path);
    assert.equal(fileIdentity(file).sha256, item.sha256, `changed report: ${item.path}`);
    evidence.set(item.path, file);
  }
  for (const layout of receipt.layouts) {
    assert.ok(evidence.has(layout.report) && evidence.has(layout.tree) && evidence.has(layout.installLog), 'missing layout evidence');
    const report = readJson(evidence.get(layout.report));
    const tree = readJson(evidence.get(layout.tree));
    assert.equal(digest(tree), layout.treeDigest, 'dependency-tree digest');
    validateTree(tree, manifest);
    assert.equal(report.profile, expected.profile, 'report profile');
    assert.ok(!report.error && !report.cleanupError, 'report contains execution/cleanup error');
    assert.equal(report.layout, layout.layout);
    assert.equal(report.runId, receipt.runId);
    assert.equal(report.packageSetDigest, manifest.packageSetDigest);
    assert.equal(report.runtime.os, 'linux');
    assert.ok(['arm64', 'x64'].includes(report.runtime.arch));
    assert.match(report.runtime.node, /^v22\.\d+\.\d+$/);
    assert.ok(Number(report.runtime.node.split('.')[1]) >= 13, 'unsupported installed Node runtime');
    assert.match(report.runtime.npm, /^\d+\./);
    assert.deepEqual(report.cases.map(c => c.id), CASES, 'missing/duplicate/zero executed cases');
    for (const result of report.cases) {
      assert.equal(result.outcome, 'PASS', `required case ${result.id} did not pass`);
      assert.ok(Date.parse(result.startedAt) <= Date.parse(result.endedAt), 'invalid case interval');
      assert.ok(Date.parse(result.startedAt) >= Date.parse(receipt.startedAt) && Date.parse(result.endedAt) <= Date.parse(receipt.endedAt), 'case lies outside receipt interval');
    }
    assert.equal(report.identity.version, expected.version);
    for (const key of ['commit', 'buildTime', 'distTag']) assert.equal(report.identity[key], manifest.buildIdentity[key], `wrong observed build ${key}`);
    assert.equal(report.identity.storeBackend, 'oxigraph-worker');
    assert.equal(report.restartedIdentity.version, expected.version);
    for (const key of ['commit', 'buildTime', 'distTag']) assert.equal(report.restartedIdentity[key], manifest.buildIdentity[key], `wrong restarted build ${key}`);
    assert.equal(report.restartedIdentity.storeBackend, 'oxigraph-worker');
    assert.equal(report.rdfValue, 'installed-package-certification');
    assert.equal(report.restartedRdfValue, report.rdfValue);
    for (const log of report.logs) assert.ok(evidence.has(log), `missing runtime log ${log}`);
    assert.ok(report.logs.length >= 2, 'restart logs missing');
  }
  return { manifest, receipt };
}
