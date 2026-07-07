#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT_DIR,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}${details ? `\n${details}` : ''}`);
  }
  return result.stdout.trim();
}

function gitHead(rootDir) {
  return run('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
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
  return JSON.parse(run('npm', ['view', ...args, '--json']));
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
        run('npm', cmd, { stdio: 'inherit' });
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

function usage() {
  console.log(`Usage:
  node scripts/release-packages.mjs list [--json]
  node scripts/release-packages.mjs verify-versions --version X.Y.Z
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
