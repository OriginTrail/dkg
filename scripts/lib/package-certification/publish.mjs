import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyReleaseTag } from '../release-policy.mjs';
import { fileIdentity, verifyCertificate } from './bundle.mjs';
import { run } from '../release-process.mjs';
import { verifyReleaseEvidence } from '../release-evidence.mjs';

function validateRegistry(registry) {
  if (!registry) return;
  const url = new URL(registry);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'registry URL must not contain credentials or query secrets');
}
export function registryDist(pkg, registry) {
  validateRegistry(registry);
  const result = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist', '--json', ...(registry ? ['--registry', registry] : [])], { encoding: 'utf8' });
  if (result.status !== 0) {
    // Only a positively identified missing version permits publication. Network,
    // auth, malformed metadata and all other acquisition errors fail closed.
    let error;
    try { error = JSON.parse(result.stdout)?.error; } catch { /* malformed is not absence */ }
    if (error?.code === 'E404') return null;
    throw new Error(`Registry metadata unavailable for ${pkg.name}`);
  }
  const dist = JSON.parse(result.stdout);
  assert.ok(typeof dist?.integrity === 'string', `Registry integrity absent for ${pkg.name}`);
  return dist;
}
export function checkRegistrySet(manifest, readDist, { allowMissing = false } = {}) {
  return manifest.packages.map(pkg => {
    const dist = readDist(pkg);
    if (dist === null) { assert.ok(allowMissing, `unpublished package: ${pkg.name}`); return { pkg, exists: false }; }
    assert.equal(dist.integrity, pkg.integrity, `registry integrity mismatch: ${pkg.name}@${pkg.version}`);
    return { pkg, exists: true };
  });
}
// Publication exposes a dist-tag immediately. Publish every internal runtime
// dependency first so a failed later command cannot strand an exposed consumer.
function publicationOrder(manifest) {
  const packages = new Map(manifest.packages.map(pkg => [pkg.name, pkg]));
  const policies = new Map(manifest.expectedPackages.map(pkg => [pkg.name, pkg.dependencies]));
  const active = new Set(), visited = new Set(), ordered = [];
  const visit = name => {
    if (visited.has(name)) return;
    assert.ok(!active.has(name), `cyclic internal publication dependency: ${name}`);
    active.add(name);
    const deps = policies.get(name);
    for (const dependency of Object.keys({ ...deps.dependencies, ...deps.optionalDependencies, ...deps.peerDependencies }).sort()) {
      if (packages.has(dependency)) visit(dependency);
    }
    active.delete(name);
    visited.add(name);
    ordered.push(packages.get(name));
  };
  for (const pkg of manifest.packages) visit(pkg.name);
  return ordered;
}
function mutate(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('npm mutation failed; inspect npm output and obtain a fresh OTP if needed');
}
export function preparedRelease({
  mode, bundle, receiptFile, expected, rootDir, tag, tags, registry, otp, evidenceFile,
  dryRun = false, readDist = pkg => registryDist(pkg, registry), runner = mutate,
  gitRunner = (cmd, args) => run(cmd, args, { cwd: rootDir }),
  log = console.log, verifyEvidence = verifyReleaseEvidence,
}) {
  assert.ok(['publish', 'promote'].includes(mode));
  validateRegistry(registry);
  assert.ok(tags?.length > 0 && new Set(tags).size === tags.length && tags.every(t => /^[a-z][a-z0-9-]*$/.test(t)), 'invalid/duplicate dist-tags');
  if (mode === 'publish') assert.equal(tags.length, 1, 'publish accepts exactly one initial dist-tag');
  if (mode === 'promote' || tags.some(channel => ['latest', 'mainnet'].includes(channel))) {
    assert.ok(typeof evidenceFile === 'string' && evidenceFile, 'release decision file is required for promotion');
  }
  const { manifest } = verifyCertificate(bundle, receiptFile, expected);
  if (evidenceFile) verifyEvidence({ evidenceFile, expected, manifest, rootDir });
  const problems = verifyReleaseTag({ tag, version: expected.version, runner: gitRunner });
  assert.deepEqual(problems, [], 'release signed-tag/version/ancestry preflight failed');
  assert.equal(gitRunner('git', ['rev-parse', `${tag}^{commit}`]), expected.commit, 'tag does not identify prepared source');
  // Preflight EVERY package before even the first mutation. A matching version
  // alone cannot make a partial publication safe to resume.
  const state = checkRegistrySet(manifest, readDist, { allowMissing: mode === 'publish' });
  const existing = new Set(state.filter(s => s.exists).map(s => s.pkg.name));
  const ordered = mode === 'publish' ? publicationOrder(manifest) : manifest.packages;
  const operations = ordered.filter(pkg => mode !== 'publish' || !existing.has(pkg.name)).flatMap(pkg => tags.map(channel => ({
    pkg, channel, tarball: path.join(bundle, pkg.tarball),
    args: mode === 'publish'
      ? ['publish', path.join(bundle, pkg.tarball), '--access', 'public', '--tag', channel]
      : ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, channel],
  })));
  const describe = ({ pkg, channel }) => ({ package: pkg.name, tag: channel });
  const progress = { mode, dryRun, reused: state.filter(s => mode === 'publish' && s.exists).map(s => s.pkg.name), completed: [], planned: operations.map(describe) };
  // Recheck package AND evidence bytes after acquisition and immediately before
  // mutation; no build-info generation/build/repack exists in this path.
  verifyCertificate(bundle, receiptFile, expected);
  if (evidenceFile) verifyEvidence({ evidenceFile, expected, manifest, rootDir });
  try {
    for (const operation of operations) {
      const { pkg, channel, tarball, args } = operation;
      assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed before mutation: ${pkg.name}`);
      // Neither dry-run nor errors interpolate OTPs or registry credentials.
      log(`${dryRun ? 'Would' : 'Will'} ${mode} ${pkg.name}@${pkg.version} (${channel})`);
      if (dryRun) continue;
      runner('npm', [...args, ...(registry ? ['--registry', registry] : []), ...(otp ? [`--otp=${otp}`] : [])]);
      progress.completed.push(describe(operation));
      assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed during publication: ${pkg.name}`);
    }
  } catch (cause) {
    // Do not repeat runner exceptions: npm wrappers can include their secret args.
    const error = new Error(`Partial ${mode}; completed ${JSON.stringify(progress.completed)}; reused ${JSON.stringify(progress.reused)}. Re-run only after registry integrity verification.`);
    error.progress = progress;
    error.cause = cause;
    throw error;
  }
  return progress;
}
