import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyReleaseTag } from '../../release-packages.mjs';
import { fileIdentity, verifyCertificate } from './bundle.mjs';
import { run } from './prepare.mjs';

export function registryDist(pkg, registry) {
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
function mutate(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('npm mutation failed; inspect npm output and obtain a fresh OTP if needed');
}
export function preparedRelease({
  mode, bundle, receiptFile, expected, rootDir, tag, tags, registry, otp,
  dryRun = false, readDist = pkg => registryDist(pkg, registry), runner = mutate,
  verify = () => verifyCertificate(bundle, receiptFile, expected),
  authorize = () => {
    const git = (cmd, args) => run(cmd, args, { cwd: rootDir });
    const problems = verifyReleaseTag({ tag, version: expected.version, runner: git });
    assert.deepEqual(problems, [], 'release signed-tag/version/ancestry preflight failed');
    assert.equal(git('git', ['rev-parse', `${tag}^{commit}`]), expected.commit, 'tag does not identify prepared source');
  },
  log = console.log,
}) {
  assert.ok(['publish', 'promote'].includes(mode));
  assert.ok(tags?.length > 0 && new Set(tags).size === tags.length && tags.every(t => /^[a-z][a-z0-9-]*$/.test(t)), 'invalid/duplicate dist-tags');
  if (mode === 'publish') assert.equal(tags.length, 1, 'publish accepts exactly one initial dist-tag');
  const { manifest } = verify();
  authorize();
  // Preflight EVERY package before even the first mutation. A matching version
  // alone cannot make a partial publication safe to resume.
  const state = checkRegistrySet(manifest, readDist, { allowMissing: mode === 'publish' });
  const progress = { mode, dryRun, reused: state.filter(s => mode === 'publish' && s.exists).map(s => s.pkg.name), completed: [], planned: [] };
  for (const { pkg, exists } of state) {
    if (mode === 'publish' && exists) continue;
    for (const channel of tags) progress.planned.push({ package: pkg.name, tag: channel });
  }
  // Recheck package AND evidence bytes after acquisition and immediately before
  // mutation; no build-info generation/build/repack exists in this path.
  verify();
  try {
    for (const { pkg, exists } of state) {
      if (mode === 'publish' && exists) continue;
      for (const channel of tags) {
        const tarball = path.join(bundle, pkg.tarball);
        assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed before mutation: ${pkg.name}`);
        const args = mode === 'publish'
          ? ['publish', tarball, '--access', 'public', '--tag', channel]
          : ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, channel];
        // Neither dry-run nor errors interpolate OTPs or registry credentials.
        log(`${dryRun ? 'Would' : 'Will'} ${mode} ${pkg.name}@${pkg.version} (${channel})`);
        if (dryRun) continue;
        runner('npm', [...args, ...(registry ? ['--registry', registry] : []), ...(otp ? [`--otp=${otp}`] : [])]);
        progress.completed.push({ package: pkg.name, tag: channel });
        assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed during publication: ${pkg.name}`);
      }
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
