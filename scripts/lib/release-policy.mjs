import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './release-process.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';
export const NODE_SQLITE_INSTALL_GUARD = Object.freeze({
  rootCommand: 'node packages/cli/scripts/verify-node-sqlite-runtime.mjs',
  cliCommand: 'node ./scripts/verify-node-sqlite-runtime.mjs',
  cliAsset: 'scripts/verify-node-sqlite-runtime.mjs',
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function sourceFilesUnder(packageDir) {
  const files = [];
  const ignored = new Set(['node_modules', '.git', 'dist', 'test', 'tests', '__tests__']);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (/\.(?:cjs|js|mjs|ts|tsx)$/.test(entry.name)) files.push(path.join(directory, entry.name));
    }
  };
  visit(packageDir);
  return files;
}

/**
 * Every publishable package that imports node:sqlite must publish the same
 * runtime floor as the shared loader. This prevents a new SQLite consumer
 * from silently widening the install contract while engines remain advisory.
 */
export function findNodeSqliteEngineViolations(rootDir = ROOT_DIR) {
  const violations = [];
  for (const pkg of discoverPublishablePackages(rootDir)) {
    const packageDir = path.dirname(pkg.packageJsonPath);
    const importsNodeSqlite = sourceFilesUnder(packageDir).some((filePath) =>
      fs.readFileSync(filePath, 'utf8').includes('node:sqlite'));
    if (!importsNodeSqlite) continue;
    const packageJson = readJson(pkg.packageJsonPath);
    if (packageJson.engines?.node !== NODE_SQLITE_SUPPORTED_RANGE) {
      violations.push({
        path: path.relative(rootDir, pkg.packageJsonPath),
        name: pkg.name,
        actual: packageJson.engines?.node,
        expected: NODE_SQLITE_SUPPORTED_RANGE,
      });
    }
  }
  return violations;
}

/**
 * Older active updaters cannot execute checks added to the target release.
 * Keep a target-owned install hook in both paths those updaters already run:
 * npm installs the published CLI package, while git slots run the workspace
 * root install before building and swapping the target checkout.
 */
export function findNodeSqliteInstallGuardViolations(rootDir = ROOT_DIR) {
  const checks = [
    {
      path: 'package.json',
      expected: NODE_SQLITE_INSTALL_GUARD.rootCommand,
    },
    {
      path: 'packages/cli/package.json',
      expected: NODE_SQLITE_INSTALL_GUARD.cliCommand,
    },
  ];
  const violations = [];
  for (const check of checks) {
    const packageJsonPath = path.join(rootDir, check.path);
    let actual;
    try {
      actual = readJson(packageJsonPath).scripts?.preinstall;
    } catch {
      actual = '<unreadable package metadata>';
    }
    if (actual !== check.expected) {
      violations.push({
        path: check.path,
        actual: actual ?? '<missing>',
        expected: check.expected,
      });
    }
  }
  const assetPath = path.join(
    rootDir,
    'packages',
    'cli',
    ...NODE_SQLITE_INSTALL_GUARD.cliAsset.split('/'),
  );
  if (!fs.existsSync(assetPath)) {
    violations.push({
      path: `packages/cli/${NODE_SQLITE_INSTALL_GUARD.cliAsset}`,
      actual: '<missing>',
      expected: '<present>',
    });
  }
  return violations;
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

export function verifyReleaseTag({ tag, version, bases = ['origin/main'], runner = run } = {}) {
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
