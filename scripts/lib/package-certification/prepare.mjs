import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { discoverPublishablePackages, findReleaseVersionMismatches, findNodeSqliteInstallGuardViolations, findNodeSqliteEngineViolations } from '../../release-packages.mjs';
import { cliRuntimeAssetManifest, copyCliRuntimeAssets } from '../../copy-cli-runtime-assets.mjs';
import { CLI, PROFILE, SCHEMA, dependencies, digest, hash, fileIdentity, tarFiles, readJson, verifyBundle } from './bundle.mjs';

export function run(command, args, { cwd, log, env = {}, timeout = 30 * 60_000 } = {}) {
  const fd = log ? fs.openSync(log, 'a') : undefined;
  try {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, ...env },
      ...(fd === undefined ? {} : { stdio: ['ignore', fd, fd] }),
    });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unavailable'}); ${log ? 'see retained log' : result.stderr ?? ''}`, { cause: result.error });
    return result.stdout?.trim();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
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
export async function preparePackages({ rootDir, output, version }) {
  const commit = requireCleanSource(rootDir);
  const before = trackedSnapshot(rootDir);
  assert.deepEqual(findNodeSqliteInstallGuardViolations(rootDir), []);
  assert.deepEqual(findNodeSqliteEngineViolations(rootDir), []);
  assert.match(process.version, /^v22\./, 'prepare with supported Node 22');
  fs.mkdirSync(output); // Never reuse or overwrite another run.
  for (const directory of ['tarballs', 'inputs', 'logs']) fs.mkdirSync(path.join(output, directory));
  const timings = {};
  const timed = (name, command, args, cwd = rootDir) => {
    const start = Date.now();
    run(command, args, { cwd, log: path.join(output, 'logs', `${name}.log`), env: { TURBO_FORCE: 'true' } });
    timings[name] = Date.now() - start;
  };
  timed('install', 'pnpm', ['install', '--frozen-lockfile']);
  const expected = await expectedPolicy(rootDir, { commit, version });
  timed('build', 'pnpm', ['build']); // UI-inclusive full build; compiler stamps metadata once.
  copyCliRuntimeAssets({ rootDir });
  const buildIdentity = readJson(path.join(rootDir, 'packages/cli/build-info.json'));
  assert.equal(buildIdentity.commit, commit, 'compiler did not stamp this clean candidate');
  assert.equal(buildIdentity.dirty, false);
  const packageRecords = [];
  for (const pkg of discoverPublishablePackages(rootDir)) {
    const destination = path.join(output, 'tarballs');
    const beforeNames = new Set(fs.readdirSync(destination));
    timed(`pack-${pkg.name.split('/')[1]}`, 'pnpm', ['pack', '--pack-destination', destination], path.dirname(pkg.packageJsonPath));
    const added = fs.readdirSync(destination).filter(name => !beforeNames.has(name));
    assert.equal(added.length, 1, `expected exactly one packed artifact for ${pkg.name}`);
    const tarball = `tarballs/${added[0]}`;
    const file = path.join(output, tarball);
    const files = tarFiles(fs.readFileSync(file));
    packageRecords.push({ name: pkg.name, version, tarball, ...fileIdentity(file), files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) });
  }
  assert.equal(requireCleanSource(rootDir), commit, 'source commit changed during preparation');
  assert.deepEqual(trackedSnapshot(rootDir), before, 'tracked build inputs changed during preparation');
  // Retain policy/build inputs without checkout paths; full tracked source content is
  // additionally identified by sourceInputsDigest and Git commit.
  const inputNames = ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc', 'turbo.json'];
  const inputs = inputNames.map(name => {
    const target = `inputs/${name}`;
    fs.copyFileSync(path.join(rootDir, name), path.join(output, target));
    return { path: target, sha256: before[name] };
  });
  const { parse } = await import('yaml');
  const lock = parse(fs.readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'));
  const manifest = {
    schemaVersion: SCHEMA,
    source: { repository: 'https://github.com/OriginTrail/dkg', commit, sourceInputsDigest: digest(before) },
    version, preparedAt: new Date().toISOString(),
    tools: { node: process.version, pnpm: run('pnpm', ['--version'], { cwd: rootDir }), npm: run('npm', ['--version'], { cwd: rootDir }) },
    inputs, expectedPackages: expected.packages, familyPolicy: expected.familyPolicy, requiredAssets: expected.requiredAssets,
    // Unrelated transitives remain ranges. Preserve the entire baseline to make
    // npm drift visible rather than claiming family pins freeze the whole tree.
    lockPackages: Object.keys(lock.packages).sort(),
    buildIdentity, packages: packageRecords, timings,
  };
  manifest.packageSetDigest = digest(manifest);
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyBundle(output, expected);
  return manifest;
}
