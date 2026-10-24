#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliRuntimeAssetManifest } from './copy-cli-runtime-assets.mjs';
import { writeBuildMetadata } from './lib/build-info.mjs';
import { run } from './lib/release-process.mjs';
import { NODE_SQLITE_INSTALL_GUARD, releasePackageJsonPaths, discoverPublishablePackages, findNodeSqliteEngineViolations, findNodeSqliteInstallGuardViolations, findReleaseVersionMismatches, verifyReleaseTag } from './lib/release-policy.mjs';
export { NODE_SQLITE_SUPPORTED_RANGE, NODE_SQLITE_INSTALL_GUARD, releasePackageJsonPaths, discoverPublishablePackages, findNodeSqliteEngineViolations, findNodeSqliteInstallGuardViolations, findReleaseVersionMismatches, verifyReleaseTag } from './lib/release-policy.mjs';
export { buildInfoPayload } from './lib/build-info.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..');
function gitHead(rootDir) {
  return run('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
}

export function writeBuildInfo({ rootDir = ROOT_DIR, commit, ...identity } = {}) {
  return writeBuildMetadata({ rootDir, commit: commit ?? gitHead(rootDir), ...identity });
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

async function packageContext(args, certificate = true) {
  const { expectedPolicy, requireCleanSource } = await import('./lib/package-certification/source.mjs');
  const commit = requireArg(args, 'commit');
  if (requireCleanSource(ROOT_DIR) !== commit) {
    throw new Error('Use the intended candidate checkout to supply the independent package policy');
  }
  return {
    rootDir: ROOT_DIR,
    bundle: path.resolve(requireArg(args, 'bundle')),
    ...(certificate ? { receiptFile: path.resolve(requireArg(args, 'certificate')) } : {}),
    expected: await expectedPolicy(ROOT_DIR, { commit, version: requireArg(args, 'version'), profile: requireArg(args, 'profile') }),
  };
}

async function commandPreparedRelease(args, mode) {
  const { preparedRelease } = await import('./lib/package-certification/publish.mjs');
  const progress = preparedRelease({
    ...await packageContext(args), mode,
    tag: requireArg(args, 'tag'),
    tags: parseTags(requireArg(args, mode === 'publish' ? 'dist-tag' : 'tags')),
    otp: typeof args.otp === 'string' ? args.otp : process.env.NPM_CONFIG_OTP,
    registry: typeof args.registry === 'string' ? args.registry : undefined,
    dryRun: Boolean(args['dry-run']),
  });
  console.log(JSON.stringify(progress, null, 2));
}

async function commandVerifyPublished(args) {
  const { verifyBundle } = await import('./lib/package-certification/bundle.mjs');
  const { registryDist, checkRegistrySet } = await import('./lib/package-certification/publish.mjs');
  const context = await packageContext(args, false);
  const manifest = verifyBundle(context.bundle, context.expected);
  checkRegistrySet(manifest, pkg => registryDist(pkg, args.registry));
  for (const pkg of manifest.packages) {
    const tags = parseTags(args.tags);
    if (!tags.length) continue;
    const distTags = npmViewJson([pkg.name, 'dist-tags', ...(args.registry ? ['--registry', args.registry] : [])]);
    for (const tag of tags) {
      if (distTags[tag] !== manifest.version) throw new Error(`${pkg.name}: dist-tag ${tag} does not match ${manifest.version}`);
    }
  }
  console.log(`Published integrity verification passed for ${manifest.packageSetDigest}.`);
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
 * The child processes each subcommand runs, with repository-relative working
 * directories: `verify-pack` packs the CLI with npm, which runs its pack
 * lifecycle (prepack) first. The subcommands run exactly these, and the CI
 * routing guard's execution graph (scripts/lib/__tests__/ci-execution-graph.mjs)
 * reads them as the commands a subcommand runs; release-packages.test.mjs
 * checks the two agree.
 */
export const SUBCOMMAND_CHILD_COMMANDS = Object.freeze({
  'verify-pack': Object.freeze([
    Object.freeze({ command: 'npm', args: Object.freeze(['pack', '--dry-run', '--json']), cwd: 'packages/cli' }),
  ]),
});
const [CLI_PACK] = SUBCOMMAND_CHILD_COMMANDS['verify-pack'];

/**
 * The runtime-config assets that `@origintrail-official/dkg` (packages/cli)
 * must ship in its tarball. The manifest distinguishes repo-root files copied
 * at pack time from package-local runtime helpers. These assets were silently
 * dropped from the 10.0.4 publish, so this preflight hard-fails a release that
 * would ship without them.
 */
export function findMissingCliPackAssets(rootDir = ROOT_DIR, runner = run) {
  // The fail-closed manifest supplies the explicit complete pack contract:
  // copied repo-root assets plus package-local runtime helpers. build-info.json
  // is generated by `release:build-info`, so it remains a release-only extension.
  const required = [
    ...cliRuntimeAssetManifest({ rootDir }).requiredPackAssets,
    'build-info.json',
    NODE_SQLITE_INSTALL_GUARD.cliAsset,
  ];
  // `npm pack --dry-run --json` reports exactly what would be published,
  // running the package's `prepack` first — so this reflects the real tarball.
  const raw = runner(CLI_PACK.command, [...CLI_PACK.args], {
    cwd: path.join(rootDir, CLI_PACK.cwd),
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

/**
 * What `verify-pack` finds, stopping at the first check that fails: the
 * node:sqlite install-guard violations, the node:sqlite engine violations,
 * then the CLI tarball's missing runtime assets. `runner` runs its child
 * commands (SUBCOMMAND_CHILD_COMMANDS['verify-pack']).
 */
export function verifyPack({ rootDir = ROOT_DIR, runner = run } = {}) {
  const installGuardViolations = findNodeSqliteInstallGuardViolations(rootDir);
  if (installGuardViolations.length > 0) return { installGuardViolations, runtimeViolations: [], missing: [] };
  const runtimeViolations = findNodeSqliteEngineViolations(rootDir);
  if (runtimeViolations.length > 0) return { installGuardViolations, runtimeViolations, missing: [] };
  return { installGuardViolations, runtimeViolations, missing: findMissingCliPackAssets(rootDir, runner) };
}

function commandVerifyPack() {
  const { installGuardViolations, runtimeViolations, missing } = verifyPack();
  if (installGuardViolations.length > 0) {
    console.error('Release pack check failed — node:sqlite install guards must protect predecessor update paths:');
    for (const violation of installGuardViolations) {
      console.error(`- ${violation.path}: ${violation.actual} (expected ${violation.expected})`);
    }
    process.exitCode = 1;
    return;
  }
  if (runtimeViolations.length > 0) {
    console.error('Release pack check failed — publishable node:sqlite consumers must declare the supported Node.js range:');
    for (const violation of runtimeViolations) {
      console.error(`- ${violation.path}: ${violation.actual ?? '<missing>'} (${violation.name})`);
    }
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    console.error('Release pack check failed — @origintrail-official/dkg tarball is missing runtime assets:');
    for (const asset of missing) console.error(`- ${asset}`);
    console.error('Materialize them before publishing: network/*.json + project.json + blazegraph-image.json come from the CLI build/prepack; blazegraph-image-metadata.cjs is package-local source; build-info.json comes from `pnpm release:build-info --dist-tag <tag>`.');
    process.exitCode = 1;
    return;
  }
  console.log('Release pack check passed: package runtime floors and @origintrail-official/dkg tarball assets are valid.');
}

function usage() {
  console.log(`Usage:
  node scripts/release-packages.mjs list [--json]
  node scripts/release-packages.mjs verify-versions --version X.Y.Z
  node scripts/release-packages.mjs verify-tag --tag vX.Y.Z [--version X.Y.Z] [--base origin/main]
  node scripts/release-packages.mjs verify-pack
  node scripts/release-packages.mjs build-info --dist-tag latest|rc|beta|alpha [--commit SHA] [--ci-run ID]
  node scripts/release-packages.mjs prepare-packages --version X.Y.Z --out NEW_DIRECTORY
  node scripts/release-packages.mjs certify-install --bundle DIR --commit SHA --version X.Y.Z --profile installed-local-rdf-v1 --out NEW_ATTEMPT [--image IMAGE] [--negative-control missing-ui]
  node scripts/release-packages.mjs verify-package-certificate --bundle DIR --certificate RECEIPT --commit SHA --version X.Y.Z --profile installed-local-rdf-v1
  node scripts/release-packages.mjs publish-prepared --bundle DIR --certificate RECEIPT --commit SHA --version X.Y.Z --profile installed-local-rdf-v1 --tag vX.Y.Z --dist-tag canary [--dry-run]
  node scripts/release-packages.mjs promote --bundle DIR --certificate RECEIPT --commit SHA --version X.Y.Z --profile installed-local-rdf-v1 --tag vX.Y.Z --tags testnet [--dry-run]
  node scripts/release-packages.mjs verify-published --bundle DIR --commit SHA --version X.Y.Z --profile installed-local-rdf-v1 [--tags latest,mainnet,testnet]`);
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
    case 'prepare-packages': {
      const { preparePackages } = await import('./lib/package-certification/prepare.mjs');
      const manifest = await preparePackages({ rootDir: ROOT_DIR, output: path.resolve(requireArg(args, 'out')), version: requireArg(args, 'version') });
      console.log(`Prepared ${manifest.packages.length} packages: ${manifest.packageSetDigest}`);
      break;
    }
    case 'certify-install': {
      const { certifyInstall } = await import('./lib/package-certification/certify.mjs');
      await certifyInstall({ ...await packageContext(args, false), output: path.resolve(requireArg(args, 'out')), image: args.image, negativeControl: args['negative-control'] });
      console.log('Installed package certification PASS');
      break;
    }
    case 'verify-package-certificate': {
      const { verifyCertificate } = await import('./lib/package-certification/bundle.mjs');
      const { bundle, receiptFile, expected } = await packageContext(args);
      verifyCertificate(bundle, receiptFile, expected);
      console.log('Package certificate consistency verification PASS');
      break;
    }
    case 'publish-prepared':
      await commandPreparedRelease(args, 'publish');
      break;
    case 'promote':
      await commandPreparedRelease(args, 'promote');
      break;
    case 'verify-published':
      await commandVerifyPublished(args);
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
