import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverPublishablePackages, findReleaseVersionMismatches } from '../release-policy.mjs';
import { run } from '../release-process.mjs';
import { cliRuntimeAssetManifest } from '../../copy-cli-runtime-assets.mjs';
import { CLI, PROFILE, BUILD_INPUTS, dependencies, digest, hash, readJson } from './bundle.mjs';

export async function expectedPolicy(rootDir, { commit, version, profile = PROFILE }) {
  assert.equal(profile, PROFILE, 'unsupported required profile');
  assert.deepEqual(findReleaseVersionMismatches(version, rootDir), [], 'source version mismatch');
  const packages = discoverPublishablePackages(rootDir).map(pkg => {
    const deps = dependencies(readJson(pkg.packageJsonPath));
    for (const fields of Object.values(deps)) for (const name of Object.keys(fields)) {
      if (fields[name] === 'workspace:*') fields[name] = version;
    }
    return { name: pkg.name, version: pkg.version, dependencies: deps };
  });
  assert.equal(new Set(packages.map(pkg => pkg.name)).size, packages.length, 'duplicate publishable package name');
  const { lockfileFamily, findLibp2pPinViolations } = await import('../libp2p-pins.mjs');
  const family = lockfileFamily(fs.readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(findLibp2pPinViolations({ manifests: discoverPublishablePackages(rootDir).map(p => readJson(p.packageJsonPath)), lockFamily: family }), []);
  return {
    commit, version, profile, packages,
    sourceInputsDigest: digest(trackedSnapshot(rootDir)),
    inputHashes: Object.fromEntries(BUILD_INPUTS.map(name => [`inputs/${name}`, hash(fs.readFileSync(path.join(rootDir, name)))])),
    familyPolicy: Object.fromEntries([...family.versions].sort().map(([name, versions]) => [name, [...versions][0]])),
    requiredAssets: {
      [CLI]: [...cliRuntimeAssetManifest({ rootDir }).requiredPackAssets, 'build-info.json', 'scripts/verify-node-sqlite-runtime.mjs', 'scripts/bundle-markitdown-binaries.mjs', 'dist/cli.js'],
      '@origintrail-official/dkg-node-ui': ['dist/index.js', 'dist-ui/index.html'],
    },
  };
}
export function trackedSnapshot(rootDir) {
  const files = run('git', ['ls-files', '-z'], { cwd: rootDir }).split('\0').filter(Boolean);
  return Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(rootDir, file)))]));
}
export function requireCleanSource(rootDir) {
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: rootDir }), '', 'certification requires clean tracked source');
  return run('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
}
