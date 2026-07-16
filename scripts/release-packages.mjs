#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cliRuntimeAssetManifest } from './copy-cli-runtime-assets.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function releasePackageJsonPaths(rootDir = ROOT_DIR) {
  const files = [path.join(rootDir, 'package.json')];
  const packagesDir = path.join(rootDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = path.join(packagesDir, entry.name, 'package.json');
      if (fs.existsSync(packageJsonPath)) files.push(packageJsonPath);
    }
  }
  return files;
}

export function discoverPublishablePackages(rootDir = ROOT_DIR) {
  return releasePackageJsonPaths(rootDir)
    .map((packageJsonPath) => ({ packageJsonPath, packageJson: readJson(packageJsonPath) }))
    .filter(({ packageJson }) =>
      packageJson.private !== true &&
      typeof packageJson.name === 'string' &&
      packageJson.name.startsWith('@origintrail-official/'))
    .map(({ packageJsonPath, packageJson }) => ({
      name: packageJson.name,
      version: packageJson.version,
      packageJsonPath,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findReleaseVersionMismatches(version, rootDir = ROOT_DIR) {
  return releasePackageJsonPaths(rootDir)
    .map((packageJsonPath) => ({ packageJsonPath, packageJson: readJson(packageJsonPath) }))
    .filter(({ packageJson }) => packageJson.version !== version)
    .map(({ packageJsonPath, packageJson }) => ({
      path: path.relative(rootDir, packageJsonPath),
      name: packageJson.name ?? path.basename(path.dirname(packageJsonPath)),
      actual: packageJson.version,
      expected: version,
    }));
}

function runCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT_DIR,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...(options.env ?? {}) },
    // Needed to resolve `npm`/`npm.cmd` on Windows; harmless on POSIX.
    shell: options.shell ?? false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}${details ? `\n${details}` : ''}`);
  }
  return result.stdout.trim();
}

function runInteractive(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function gitHead(rootDir) {
  return runCapture('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
}

export function buildInfoPayload({ commit, distTag, ciRun = null, buildTime = new Date().toISOString() }) {
  if (typeof distTag !== 'string' || distTag.length === 0) {
    throw new Error('--dist-tag is required for build-info generation');
  }
  const resolvedCommit = commit && commit.length > 0 ? commit : 'unknown';
  return {
    commit: resolvedCommit,
    commitShort: resolvedCommit.slice(0, 8) || '00000000',
    buildTime,
    distTag,
    ciRun,
  };
}

export function writeBuildInfo({ rootDir = ROOT_DIR, distTag, commit, ciRun, buildTime } = {}) {
  const resolvedCommit = commit ?? gitHead(rootDir);
  const payload = buildInfoPayload({ commit: resolvedCommit, distTag, ciRun, buildTime });
  const outputPath = path.join(rootDir, 'packages', 'cli', 'build-info.json');
  writeJson(outputPath, payload);
  return { outputPath, payload };
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function parseTags(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function npmViewJson(args) {
  return JSON.parse(runCapture('npm', ['view', ...args, '--json']));
}

export function verifyReleaseTag({ tag, version, bases = ['origin/main'], runner = runCapture } = {}) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('--tag is required (e.g. v10.0.4)');
  }
  const problems = [];
  const attempt = (args) => {
    try {
      return { ok: true, output: runner('git', args) };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  };
  if (typeof version === 'string' && version.length > 0 && tag !== `v${version}`) {
    problems.push(`tag ${tag} does not match --version ${version} (expected v${version})`);
  }
  const local = attempt(['rev-parse', '--verify', `refs/tags/${tag}`]);
  if (!local.ok) {
    problems.push(`tag ${tag} not found locally — run: git fetch --force origin --tags`);
    return problems;
  }
  const objectType = attempt(['cat-file', '-t', `refs/tags/${tag}`]);
  if (!objectType.ok || objectType.output !== 'tag') {
    problems.push(`tag ${tag} is not an annotated tag object (got: ${objectType.output || 'nothing'}) — create it with git tag -s`);
  } else {
    const tagBody = attempt(['cat-file', 'tag', `refs/tags/${tag}`]);
    if (!tagBody.ok || !/-----BEGIN (PGP|SSH) SIGNATURE-----/.test(tagBody.output)) {
      problems.push(`tag ${tag} carries no PGP/SSH signature block — sign it with git tag -s`);
    }
  }
  const isAncestorOfSomeBase = bases.some(
    (base) => attempt(['merge-base', '--is-ancestor', `${tag}^{commit}`, base]).ok,
  );
  if (!isAncestorOfSomeBase) {
    problems.push(`tag ${tag} commit is not reachable from ${bases.join(' or ')} — fetch first (git fetch origin) or retag from a release branch`);
  }
  const remote = attempt(['ls-remote', 'origin', `refs/tags/${tag}`]);
  const remoteSha = remote.ok
    ? remote.output
        .split('\n')
        .map((line) => line.split(/\s+/))
        .find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? ''
    : '';
  if (remoteSha.length === 0) {
    problems.push(`tag ${tag} is not on origin — push it: git push origin ${tag}`);
  } else if (remoteSha !== local.output) {
    problems.push(`local tag ${tag} (${local.output.slice(0, 12)}) differs from origin (${remoteSha.slice(0, 12)}) — the remote tag moved; do not release from it`);
  }
  return problems;
}

function commandList(args) {
  const packages = discoverPublishablePackages(ROOT_DIR);
  if (args.json) {
    console.log(JSON.stringify(packages.map(({ name, version }) => ({ name, version })), null, 2));
  } else {
    for (const pkg of packages) console.log(pkg.name);
  }
}

function commandVerifyVersions(args) {
  const version = requireArg(args, 'version');
  const mismatches = findReleaseVersionMismatches(version, ROOT_DIR);
  if (mismatches.length > 0) {
    console.error(`Release package version check failed; expected ${version}:`);
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch.path}: ${mismatch.actual ?? '<missing>'} (${mismatch.name})`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Release package version check passed: ${releasePackageJsonPaths(ROOT_DIR).length} package.json files at ${version}.`);
}

function commandBuildInfo(args) {
  const distTag = requireArg(args, 'dist-tag');
  const { outputPath, payload } = writeBuildInfo({
    rootDir: ROOT_DIR,
    distTag,
    commit: typeof args.commit === 'string' ? args.commit : undefined,
    ciRun: typeof args['ci-run'] === 'string' ? args['ci-run'] : null,
  });
  console.log(`Wrote ${path.relative(ROOT_DIR, outputPath)} for ${payload.commitShort} (${payload.distTag}).`);
}

function commandPromote(args) {
  const version = requireArg(args, 'version');
  const tags = parseTags(requireArg(args, 'tags'));
  const otp = typeof args.otp === 'string' ? args.otp : process.env.NPM_CONFIG_OTP;
  const dryRun = Boolean(args['dry-run']);
  if (tags.length === 0) throw new Error('--tags must include at least one dist-tag');
  if (!dryRun && (!otp || otp.length === 0)) {
    throw new Error('Provide --otp <code> or NPM_CONFIG_OTP for npm dist-tag promotion');
  }
  for (const pkg of discoverPublishablePackages(ROOT_DIR)) {
    for (const tag of tags) {
      const cmd = ['dist-tag', 'add', `${pkg.name}@${version}`, tag, ...(otp ? [`--otp=${otp}`] : [])];
      if (dryRun) {
        console.log(`npm ${cmd.join(' ')}`);
      } else {
        runInteractive('npm', cmd);
      }
    }
  }
}

function commandVerifyPublished(args) {
  const version = requireArg(args, 'version');
  const tags = parseTags(args.tags);
  const failures = [];
  for (const pkg of discoverPublishablePackages(ROOT_DIR)) {
    try {
      const publishedVersion = npmViewJson([`${pkg.name}@${version}`, 'version']);
      if (publishedVersion !== version) {
        failures.push(`${pkg.name}: version ${publishedVersion} !== ${version}`);
      }
      if (tags.length > 0) {
        const distTags = npmViewJson([pkg.name, 'dist-tags']);
        for (const tag of tags) {
          if (distTags[tag] !== version) {
            failures.push(`${pkg.name}: dist-tag ${tag}=${distTags[tag] ?? '<missing>'} !== ${version}`);
          }
        }
      }
    } catch (err) {
      failures.push(`${pkg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    console.error('Published package verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Published package verification passed for ${version}${tags.length ? ` (${tags.join(', ')})` : ''}.`);
}

function commandVerifyTag(args) {
  const tag = requireArg(args, 'tag');
  const version = typeof args.version === 'string' ? args.version : undefined;
  const parsedBases = parseTags(typeof args.base === 'string' ? args.base : undefined);
  const bases = parsedBases.length > 0 ? parsedBases : ['origin/main'];
  const problems = verifyReleaseTag({ tag, version, bases });
  if (problems.length > 0) {
    console.error(`Release tag verification failed for ${tag}:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release tag verification passed: ${tag} is annotated, signature-bearing, on origin unmoved, and reachable from ${bases.join(', ')}.`);
}

/**
 * The runtime-config assets that `@origintrail-official/dkg` (packages/cli)
 * must ship in its tarball. The manifest distinguishes repo-root files copied
 * at pack time from package-local runtime helpers. These assets were silently
 * dropped from the 10.0.4 publish, so this preflight hard-fails a release that
 * would ship without them.
 */
export function findMissingCliPackAssets(rootDir = ROOT_DIR, runner = runCapture) {
  const cliDir = path.join(rootDir, 'packages', 'cli');
  // The fail-closed manifest supplies the explicit complete pack contract:
  // copied repo-root assets plus package-local runtime helpers. build-info.json
  // is generated by `release:build-info`, so it remains a release-only extension.
  const required = [
    ...cliRuntimeAssetManifest({ rootDir }).requiredPackAssets,
    'build-info.json',
  ];
  // `npm pack --dry-run --json` reports exactly what would be published,
  // running the package's `prepack` first — so this reflects the real tarball.
  const raw = runner('npm', ['pack', '--dry-run', '--json'], {
    cwd: cliDir,
    shell: process.platform === 'win32',
  });
  const report = JSON.parse(raw);
  const packed = new Set(
    (Array.isArray(report) ? report : [report])
      .flatMap((entry) => entry.files ?? [])
      .map((file) => file.path.replace(/\\/g, '/')),
  );
  return required.filter((asset) => !packed.has(asset));
}

function commandVerifyPack() {
  const missing = findMissingCliPackAssets(ROOT_DIR);
  if (missing.length > 0) {
    console.error('Release pack check failed — @origintrail-official/dkg tarball is missing runtime assets:');
    for (const asset of missing) console.error(`- ${asset}`);
    console.error('Materialize them before publishing: network/*.json + project.json + blazegraph-image.json come from the CLI build/prepack; blazegraph-image-metadata.cjs is package-local source; build-info.json comes from `pnpm release:build-info --dist-tag <tag>`.');
    process.exitCode = 1;
    return;
  }
  console.log('Release pack check passed: @origintrail-official/dkg tarball includes project/build metadata, the Blazegraph runtime contract, and all network overlays.');
}

function usage() {
  console.log(`Usage:
  node scripts/release-packages.mjs list [--json]
  node scripts/release-packages.mjs verify-versions --version X.Y.Z
  node scripts/release-packages.mjs verify-tag --tag vX.Y.Z [--version X.Y.Z] [--base origin/main]
  node scripts/release-packages.mjs verify-pack
  node scripts/release-packages.mjs build-info --dist-tag latest|rc|beta|alpha [--commit SHA] [--ci-run ID]
  node scripts/release-packages.mjs promote --version X.Y.Z --tags mainnet,testnet --otp 123456 [--dry-run]
  node scripts/release-packages.mjs verify-published --version X.Y.Z [--tags latest,mainnet,testnet]`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'list':
      commandList(args);
      break;
    case 'verify-versions':
      commandVerifyVersions(args);
      break;
    case 'verify-tag':
      commandVerifyTag(args);
      break;
    case 'verify-pack':
      commandVerifyPack();
      break;
    case 'build-info':
      commandBuildInfo(args);
      break;
    case 'promote':
      commandPromote(args);
      break;
    case 'verify-published':
      commandVerifyPublished(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

if (process.argv[1] === SCRIPT_PATH) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
