import { createHash } from 'node:crypto';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  checksumPathFor,
  hasVerifiedBundledBinary,
  metadataMatchesExpected,
  metadataPathFor,
  parseSha256File,
} from './markitdown-bundle-validation.mjs';

const execFile = promisify(execFileCb);

const MARKITDOWN_BUILD_INFO = JSON.parse(readFileSync(new URL('../markitdown-build-info.json', import.meta.url), 'utf-8'));
if (
  typeof MARKITDOWN_BUILD_INFO.markItDownUpstreamVersion !== 'string'
  || MARKITDOWN_BUILD_INFO.markItDownUpstreamVersion.length === 0
  || typeof MARKITDOWN_BUILD_INFO.pyInstallerVersion !== 'string'
  || MARKITDOWN_BUILD_INFO.pyInstallerVersion.length === 0
) {
  throw new Error('markitdown-build-info.json must define non-empty markItDownUpstreamVersion and pyInstallerVersion strings');
}
export const MARKITDOWN_UPSTREAM_VERSION = MARKITDOWN_BUILD_INFO.markItDownUpstreamVersion;
export const PYINSTALLER_VERSION = MARKITDOWN_BUILD_INFO.pyInstallerVersion;
export const RELEASE_BINARY_FETCH_TIMEOUT_MS = 15_000;
export const RELEASE_CHECKSUM_FETCH_TIMEOUT_MS = 5_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadDefaultReleaseRepo() {
  // From packages/cli/scripts/:
  //   ..        → packages/cli/           (post-build artifact copy; lives here only in the published tarball or after a `pnpm --filter dkg build`)
  //   ../../..  → <repo root>             (monorepo source of truth)
  // Prefer the monorepo root so source edits to project.json always
  // take effect in a fresh checkout; fall back to the package-local
  // copy for published installs where the repo root is absent.
  const scriptDir = __dirname;
  for (const base of [resolve(scriptDir, '..', '..', '..'), resolve(scriptDir, '..')]) {
    try {
      const proj = JSON.parse(readFileSync(join(base, 'project.json'), 'utf-8'));
      if (proj.repo) return proj.repo;
    } catch { /* try next */ }
  }
  return 'OriginTrail/dkg';
}
export const DEFAULT_RELEASE_REPO = loadDefaultReleaseRepo();
const DEFAULT_PACKAGE_DIR = resolve(__dirname, '..');

function loadSupportedTargets(packageDir = DEFAULT_PACKAGE_DIR) {
  const raw = readFileSync(join(resolvePackageDir(packageDir), 'markitdown-targets.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('markitdown-targets.json must contain an array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`markitdown-targets.json entry ${index} must be an object`);
    }
    const { platform, arch, assetName, runner } = entry;
    if (typeof platform !== 'string' || typeof arch !== 'string' || typeof assetName !== 'string') {
      throw new Error(`markitdown-targets.json entry ${index} is missing platform/arch/assetName`);
    }
    if (runner != null && typeof runner !== 'string') {
      throw new Error(`markitdown-targets.json entry ${index} has an invalid runner`);
    }
    return { platform, arch, assetName, ...(runner ? { runner } : {}) };
  });
}

export const SUPPORTED_TARGETS = loadSupportedTargets();

function logLine(message) {
  process.stdout.write(`${message}\n`);
}

function warnLine(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const opts = {
    packageDir: DEFAULT_PACKAGE_DIR,
    outputDir: null,
    version: null,
    all: false,
    currentPlatform: false,
    buildCurrentPlatform: false,
    bestEffort: false,
    force: false,
    releaseBaseUrl: null,
    releaseRepo: DEFAULT_RELEASE_REPO,
    quiet: false,
    verifyReleaseArtifacts: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--current-platform') {
      opts.currentPlatform = true;
    } else if (arg === '--build-current-platform') {
      opts.buildCurrentPlatform = true;
    } else if (arg === '--best-effort') {
      opts.bestEffort = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--package-dir') {
      opts.packageDir = resolve(argv[++i]);
    } else if (arg === '--output-dir') {
      opts.outputDir = resolve(argv[++i]);
    } else if (arg === '--version') {
      opts.version = argv[++i];
    } else if (arg === '--release-base-url') {
      opts.releaseBaseUrl = argv[++i];
    } else if (arg === '--release-repo') {
      opts.releaseRepo = argv[++i];
    } else if (arg === '--verify-release-artifacts') {
      opts.verifyReleaseArtifacts = resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.all && !opts.currentPlatform && !opts.buildCurrentPlatform && !opts.verifyReleaseArtifacts) {
    opts.currentPlatform = true;
  }

  return opts;
}

export function resolvePackageDir(packageDir = DEFAULT_PACKAGE_DIR) {
  return resolve(packageDir);
}

export function resolveBinDir(packageDir = DEFAULT_PACKAGE_DIR, outputDir = null) {
  return outputDir ? resolve(outputDir) : join(resolvePackageDir(packageDir), 'bin');
}

export function readCliVersion(packageDir = DEFAULT_PACKAGE_DIR) {
  const raw = readFileSync(join(resolvePackageDir(packageDir), 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  return String(pkg.version ?? '').trim();
}

export function isWorkspaceCheckout(packageDir = DEFAULT_PACKAGE_DIR) {
  const dir = resolvePackageDir(packageDir);
  return existsSync(join(dir, 'src')) && existsSync(join(dir, 'tsconfig.json'));
}

export function getSupportedTarget(platform = process.platform, arch = process.arch) {
  return SUPPORTED_TARGETS.find((target) => target.platform === platform && target.arch === arch) ?? null;
}

export function targetBinaryPath(target, packageDir = DEFAULT_PACKAGE_DIR, outputDir = null) {
  return join(resolveBinDir(packageDir, outputDir), target.assetName);
}

export function pyInstallerNameForTarget(target) {
  return target.assetName.replace(/\.exe$/i, '');
}

export { checksumPathFor, metadataPathFor, parseSha256File };

export function releaseTagForVersion(version) {
  return `v${version.replace(/^v/, '')}`;
}

export function releaseBaseUrl(version, releaseRepo = DEFAULT_RELEASE_REPO) {
  return `https://github.com/${releaseRepo}/releases/download/${releaseTagForVersion(version)}`;
}

export function releaseAssetUrl(baseUrl, assetName) {
  return `${baseUrl}/${assetName}`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildFingerprintForPackage(packageDir = DEFAULT_PACKAGE_DIR) {
  const resolvedPackageDir = resolvePackageDir(packageDir);
  const entryScript = readFileSync(join(resolvedPackageDir, 'scripts', 'markitdown-entry.py'));
  const bundlerScript = readFileSync(__filename);
  return sha256Hex([
    MARKITDOWN_UPSTREAM_VERSION,
    PYINSTALLER_VERSION,
    sha256Hex(entryScript),
    sha256Hex(bundlerScript),
  ].join('\n'));
}

function parseMetadataText(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Malformed metadata file');
  }
  return parsed;
}

async function writeMetadataFile(binaryPath, metadata) {
  await writeFile(metadataPathFor(binaryPath), `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
}

async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(RELEASE_BINARY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(RELEASE_CHECKSUM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return await res.text();
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

function ensureExecutable(path) {
  if (process.platform === 'win32') return;
  chmodSync(path, 0o755);
}

async function writeChecksumFile(binaryPath, hash) {
  const assetName = binaryPath.split(/[\\/]/).pop();
  await writeFile(checksumPathFor(binaryPath), `${hash}  ${assetName}\n`, 'utf-8');
}

async function verifyChecksum(binaryPath, expectedHash) {
  const bytes = await readFile(binaryPath);
  const actualHash = sha256Hex(bytes);
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${binaryPath}: expected ${expectedHash}, got ${actualHash}`);
  }
  return actualHash;
}

async function removeIfExists(path) {
  await rm(path, { force: true });
}

export async function downloadBinaryAsset({
  assetName,
  destinationDir,
  baseUrl,
  cliVersion,
  force = false,
}) {
  const destination = join(destinationDir, assetName);
  const destinationChecksumPath = checksumPathFor(destination);
  const destinationMetadataPath = metadataPathFor(destination);
  const expectedMetadata = { source: 'release', cliVersion };
  if (!force && existsSync(destination)) {
    if (await hasVerifiedBundledBinary(destination, expectedMetadata)) {
      return { status: 'present', binaryPath: destination };
    }
  }

  await ensureDir(destinationDir);
  const assetUrl = releaseAssetUrl(baseUrl, assetName);
  const checksumUrl = `${assetUrl}.sha256`;
  const metadataUrl = `${assetUrl}.meta.json`;
  const [bytes, checksumText, metadataText] = await Promise.all([
    fetchBytes(assetUrl),
    fetchText(checksumUrl),
    fetchText(metadataUrl),
  ]);
  const expectedHash = parseSha256File(checksumText);
  const actualHash = sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`);
  }
  const releaseMetadata = parseMetadataText(metadataText);
  if (!metadataMatchesExpected(releaseMetadata, expectedMetadata)) {
    throw new Error(
      `Metadata mismatch for ${assetName}: expected ${JSON.stringify(expectedMetadata)}, got ${JSON.stringify(releaseMetadata)}`,
    );
  }

  const tempSuffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDestination = `${destination}${tempSuffix}`;
  const tempChecksumPath = `${destinationChecksumPath}${tempSuffix}`;
  const tempMetadataPath = `${destinationMetadataPath}${tempSuffix}`;
  const backupSuffix = `.bak-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backupDestination = existsSync(destination) ? `${destination}${backupSuffix}` : null;
  const backupChecksumPath = existsSync(destinationChecksumPath) ? `${destinationChecksumPath}${backupSuffix}` : null;
  const backupMetadataPath = existsSync(destinationMetadataPath) ? `${destinationMetadataPath}${backupSuffix}` : null;
  let movedDestinationToBackup = false;
  let movedChecksumToBackup = false;
  let movedMetadataToBackup = false;
  let promotedDestination = false;
  let promotedChecksum = false;
  let promotedMetadata = false;
  try {
    await writeFile(tempDestination, bytes);
    ensureExecutable(tempDestination);
    await writeFile(tempChecksumPath, `${expectedHash}  ${assetName}\n`, 'utf-8');
    await writeFile(tempMetadataPath, metadataText.endsWith('\n') ? metadataText : `${metadataText}\n`, 'utf-8');
    if (backupDestination) {
      await rename(destination, backupDestination);
      movedDestinationToBackup = true;
    }
    if (backupChecksumPath) {
      await rename(destinationChecksumPath, backupChecksumPath);
      movedChecksumToBackup = true;
    }
    if (backupMetadataPath) {
      await rename(destinationMetadataPath, backupMetadataPath);
      movedMetadataToBackup = true;
    }
    await rename(tempDestination, destination);
    promotedDestination = true;
    await rename(tempChecksumPath, destinationChecksumPath);
    promotedChecksum = true;
    await rename(tempMetadataPath, destinationMetadataPath);
    promotedMetadata = true;
    await Promise.all([
      movedDestinationToBackup && backupDestination ? removeIfExists(backupDestination) : Promise.resolve(),
      movedChecksumToBackup && backupChecksumPath ? removeIfExists(backupChecksumPath) : Promise.resolve(),
      movedMetadataToBackup && backupMetadataPath ? removeIfExists(backupMetadataPath) : Promise.resolve(),
    ]);
  } catch (err) {
    await Promise.all([
      removeIfExists(tempDestination),
      removeIfExists(tempChecksumPath),
      removeIfExists(tempMetadataPath),
      promotedDestination ? removeIfExists(destination) : Promise.resolve(),
      promotedChecksum ? removeIfExists(destinationChecksumPath) : Promise.resolve(),
      promotedMetadata ? removeIfExists(destinationMetadataPath) : Promise.resolve(),
    ]);
    if (movedDestinationToBackup && backupDestination && existsSync(backupDestination)) {
      await rename(backupDestination, destination);
    }
    if (movedChecksumToBackup && backupChecksumPath && existsSync(backupChecksumPath)) {
      await rename(backupChecksumPath, destinationChecksumPath);
    }
    if (movedMetadataToBackup && backupMetadataPath && existsSync(backupMetadataPath)) {
      await rename(backupMetadataPath, destinationMetadataPath);
    }
    throw err;
  }
  return { status: 'downloaded', binaryPath: destination, hash: actualHash };
}

function resolvePythonCommand() {
  if (process.env.PYTHON) return { command: process.env.PYTHON, args: [] };
  const candidates = process.platform === 'win32'
    ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, '--version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(rewriteVenvErrorMessage(
    'Python executable not found. Install python3/python or set the PYTHON environment variable.',
    'missing-python',
  ));
}

// Per-OS install hints used when the build-from-source path fails because
// python3-venv (or python itself) is not present on the host. The bundle
// script's main `--best-effort` postinstall path does NOT invoke the
// build-from-source flow, so this hint only fires for explicit
// `markitdown:build` runs.
const VENV_INSTALL_HINTS = [
  '  Debian / Ubuntu / WSL: `sudo apt install -y python3-venv python3-pip`',
  '  Fedora / RHEL:         `sudo dnf install -y python3 python3-pip`',
  '  macOS (Homebrew):      `brew install python@3`',
  '  Windows:               install Python 3.11+ from python.org and reopen the shell',
];

function rewriteVenvErrorMessage(originalMessage, kind) {
  const header = kind === 'missing-python'
    ? 'MarkItDown build: a working Python 3 is required for the build-from-source path.'
    : 'MarkItDown build: python3 venv support is required for the build-from-source path.';
  return [
    header,
    ...VENV_INSTALL_HINTS,
    'Then re-run: pnpm --filter @origintrail-official/dkg run markitdown:build',
    `(underlying error: ${originalMessage.trim()})`,
  ].join('\n');
}

export function rewriteVenvError(err) {
  const stderr = String(err?.stderr ?? '');
  const stdout = String(err?.stdout ?? '');
  const message = String(err?.message ?? '');
  const text = `${stderr}\n${stdout}\n${message}`;
  const venvSupportMissing =
    /ensurepip is not available/i.test(text)
    || /No module named ['"]?venv['"]?/i.test(text)
    || /python3-venv/i.test(text);
  const pythonMissing =
    /command not found.*python/i.test(text)
    || /ENOENT/i.test(text)
    || /is not recognized as an internal or external command/i.test(text);
  if (!venvSupportMissing && !pythonMissing) return err;
  const wrapped = new Error(rewriteVenvErrorMessage(message, venvSupportMissing ? 'missing-venv' : 'missing-python'));
  wrapped.cause = err;
  return wrapped;
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

export async function buildCurrentPlatformBinary({
  packageDir = DEFAULT_PACKAGE_DIR,
  outputDir = null,
  force = false,
}) {
  const target = getSupportedTarget();
  if (!target) {
    return { status: 'unsupported' };
  }

  const binDir = resolveBinDir(packageDir, outputDir);
  const binaryPath = targetBinaryPath(target, packageDir, outputDir);
  const expectedMetadata = {
    source: 'build',
    cliVersion: readCliVersion(packageDir),
    buildFingerprint: buildFingerprintForPackage(packageDir),
  };
  if (!force && existsSync(binaryPath)) {
    if (await hasVerifiedBundledBinary(binaryPath, expectedMetadata)) {
      return { status: 'present', binaryPath };
    }
  }

  await ensureDir(binDir);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'dkg-markitdown-build-'));
  const venvDir = join(tmpRoot, 'venv');
  const workDir = join(tmpRoot, 'pyi-work');
  const specDir = join(tmpRoot, 'pyi-spec');
  const python = resolvePythonCommand();

  try {
    try {
      await execFile(python.command, [...python.args, '-m', 'venv', venvDir], { cwd: tmpRoot, timeout: 120_000 });
    } catch (venvErr) {
      throw rewriteVenvError(venvErr);
    }
    const venvPython = venvPythonPath(venvDir);

    await execFile(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
      cwd: tmpRoot,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    await execFile(venvPython, [
      '-m',
      'pip',
      'install',
      `pyinstaller==${PYINSTALLER_VERSION}`,
      `markitdown[pdf,docx,pptx,xlsx]==${MARKITDOWN_UPSTREAM_VERSION}`,
    ], {
      cwd: tmpRoot,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    await execFile(venvPython, [
      '-m',
      'PyInstaller',
      '--clean',
      '--onefile',
      '--name',
      pyInstallerNameForTarget(target),
      '--collect-data',
      'magika',
      '--distpath',
      binDir,
      '--workpath',
      workDir,
      '--specpath',
      specDir,
      join(resolvePackageDir(packageDir), 'scripts', 'markitdown-entry.py'),
    ], {
      cwd: tmpRoot,
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (!existsSync(binaryPath)) {
      throw new Error(`PyInstaller completed without producing ${binaryPath}`);
    }
    ensureExecutable(binaryPath);
    const hash = await verifyChecksum(binaryPath, sha256Hex(await readFile(binaryPath)));
    await writeChecksumFile(binaryPath, hash);
    await writeMetadataFile(binaryPath, expectedMetadata);
    return { status: 'built', binaryPath, hash };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function bundleReleasedBinaries({
  packageDir = DEFAULT_PACKAGE_DIR,
  outputDir = null,
  version,
  releaseBaseUrlOverride = null,
  releaseRepo = DEFAULT_RELEASE_REPO,
  force = false,
}) {
  const resolvedVersion = version ?? readCliVersion(packageDir);
  const baseUrl = releaseBaseUrlOverride ?? releaseBaseUrl(resolvedVersion, releaseRepo);
  const binDir = resolveBinDir(packageDir, outputDir);
  await ensureDir(binDir);
  const results = [];
  for (const target of SUPPORTED_TARGETS) {
    results.push(await downloadBinaryAsset({
      assetName: target.assetName,
      destinationDir: binDir,
      baseUrl,
      cliVersion: resolvedVersion,
      force,
    }));
  }
  return { status: 'downloaded-all', version: resolvedVersion, results };
}

export async function ensureCurrentPlatformBinary({
  packageDir = DEFAULT_PACKAGE_DIR,
  outputDir = null,
  version = null,
  releaseBaseUrlOverride = null,
  releaseRepo = DEFAULT_RELEASE_REPO,
  force = false,
  allowBuildFromSource = false,
}) {
  const target = getSupportedTarget();
  if (!target) {
    return { status: 'unsupported' };
  }

  const binaryPath = targetBinaryPath(target, packageDir, outputDir);
  const resolvedVersion = version ?? readCliVersion(packageDir);
  const expectedMetadata = { source: 'release', cliVersion: resolvedVersion };
  if (!force && existsSync(binaryPath)) {
    if (await hasVerifiedBundledBinary(binaryPath, expectedMetadata)) {
      return { status: 'present', binaryPath };
    }
  }
  const baseUrl = releaseBaseUrlOverride ?? releaseBaseUrl(resolvedVersion, releaseRepo);
  try {
    const result = await downloadBinaryAsset({
      assetName: target.assetName,
      destinationDir: resolveBinDir(packageDir, outputDir),
      baseUrl,
      cliVersion: resolvedVersion,
      force,
    });
    return { ...result, source: 'release' };
  } catch (downloadErr) {
    if (!allowBuildFromSource) throw downloadErr;
    const built = await buildCurrentPlatformBinary({ packageDir, outputDir, force });
    if (built.status === 'unsupported') {
      return built;
    }
    return { ...built, source: 'build' };
  }
}

function isHttp404Error(err) {
  return /returned 404/.test(String(err?.message ?? ''));
}

export async function fetchLatestReleaseTag(repo) {
  // GitHub's /releases/latest endpoint excludes prereleases and returns 404
  // for repos that only publish prereleases (the OriginTrail/dkg case — all
  // v10.0.0-rc.* tags are flagged prerelease). Use the listing endpoint so
  // both stable and prerelease tags are eligible. Drafts are skipped.
  const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(RELEASE_CHECKSUM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.draft === true) continue;
    if (typeof entry.tag_name === 'string' && entry.tag_name.length > 0) {
      return entry.tag_name;
    }
  }
  return null;
}

function emitMissingBinaryRemediation(warn, version, reason) {
  warn(`MarkItDown bundle: could not stage the binary automatically (${reason}).`);
  warn('PDF / DOCX / PPTX / XLSX / CSV / HTML / EPUB / XML extraction will be unavailable on this node.');
  warn('To enable, once you have network access:');
  warn('  pnpm --filter @origintrail-official/dkg run markitdown:bundle');
  warn('Or to build locally from source (requires python3-venv):');
  warn('  pnpm --filter @origintrail-official/dkg run markitdown:build');
  warn('Then restart any running `dkg start` daemon.');
}

function maybeLogRestartHint(log) {
  // Postinstall fires before the daemon is ever started, so the restart hint
  // is noise there. Only surface it for explicit top-level runs of
  // `markitdown:bundle` / `markitdown:build` where a running daemon is plausible.
  if (process.env.npm_lifecycle_event === 'postinstall') return;
  log('Restart any running `dkg start` daemon to pick up the new extraction pipelines.');
}

export async function verifyReleaseArtifacts({ directory, version, packageDir = DEFAULT_PACKAGE_DIR }) {
  const expectedVersion = version ?? readCliVersion(packageDir);
  const errors = [];
  for (const target of SUPPORTED_TARGETS) {
    const binaryPath = join(directory, target.assetName);
    const checksumPath = checksumPathFor(binaryPath);
    const metadataPath = metadataPathFor(binaryPath);
    if (!existsSync(binaryPath)) {
      errors.push(`${target.assetName}: binary missing at ${binaryPath}`);
      continue;
    }
    if (!existsSync(checksumPath)) {
      errors.push(`${target.assetName}: .sha256 sidecar missing`);
      continue;
    }
    if (!existsSync(metadataPath)) {
      errors.push(`${target.assetName}: .meta.json sidecar missing`);
      continue;
    }
    let expectedHash;
    try {
      expectedHash = parseSha256File(await readFile(checksumPath, 'utf-8'));
    } catch (err) {
      errors.push(`${target.assetName}: malformed .sha256 (${err?.message ?? err})`);
      continue;
    }
    const actualHash = sha256Hex(await readFile(binaryPath));
    if (actualHash !== expectedHash) {
      errors.push(`${target.assetName}: checksum mismatch (expected ${expectedHash}, got ${actualHash})`);
      continue;
    }
    let metadata;
    try {
      metadata = parseMetadataText(await readFile(metadataPath, 'utf-8'));
    } catch (err) {
      errors.push(`${target.assetName}: malformed .meta.json (${err?.message ?? err})`);
      continue;
    }
    if (metadata?.cliVersion !== expectedVersion) {
      errors.push(`${target.assetName}: meta.cliVersion is "${metadata?.cliVersion}" but expected "${expectedVersion}"`);
    }
  }
  return { ok: errors.length === 0, errors, expectedVersion, targetCount: SUPPORTED_TARGETS.length };
}

/**
 * Implicit current-platform postinstall flow (issue #467).
 *
 * Workspace and published-install both attempt the release-asset download.
 * The workspace-only branch falls back to the latest published tag when the
 * local version has no matching asset yet.
 *
 * Pure-ish: env-var inputs (DKG_SKIP_MARKITDOWN_DOWNLOAD, CI, DKG_FORCE_…) and
 * the latest-tag fetcher are passed in, not read here — so tests can inject
 * mocks without mutating process.env.
 *
 * Returns a status object describing what happened. Never throws on failure
 * paths; the caller decides whether to surface them.
 */
export async function bundleImplicitCurrentPlatform({
  packageDir,
  outputDir = null,
  version = null,
  workspace = null,
  releaseBaseUrl: releaseBaseUrlOverride = null,
  releaseRepo = DEFAULT_RELEASE_REPO,
  force = false,
  skipDownload = false,
  ciMode = false,
  log,
  warn,
  showRestartHint = true,
  fetchLatestTag = fetchLatestReleaseTag,
}) {
  const resolvedPackageDir = resolvePackageDir(packageDir);
  const resolvedVersion = version ?? readCliVersion(resolvedPackageDir);
  const resolvedWorkspace = workspace ?? isWorkspaceCheckout(resolvedPackageDir);

  if (skipDownload) {
    log('MarkItDown bundle: DKG_SKIP_MARKITDOWN_DOWNLOAD=1; skipping implicit release-asset download.');
    emitMissingBinaryRemediation(log, resolvedVersion, 'opt-out via DKG_SKIP_MARKITDOWN_DOWNLOAD=1');
    return { status: 'opted-out' };
  }

  const target = getSupportedTarget();
  if (!target) {
    log(`MarkItDown bundle: ${process.platform}-${process.arch} is not a supported bundled target. Skipping.`);
    return { status: 'unsupported' };
  }
  const binaryPath = targetBinaryPath(target, resolvedPackageDir, outputDir);

  if (!force && existsSync(binaryPath)) {
    const releaseExpected = { source: 'release', cliVersion: resolvedVersion };
    let buildExpected = null;
    try {
      buildExpected = {
        source: 'build',
        cliVersion: resolvedVersion,
        buildFingerprint: buildFingerprintForPackage(resolvedPackageDir),
      };
    } catch {
      // Entry script may be absent in test fixtures — fall back to release-only check.
    }
    const alreadyStaged =
      (await hasVerifiedBundledBinary(binaryPath, releaseExpected))
      || (buildExpected ? await hasVerifiedBundledBinary(binaryPath, buildExpected) : false);
    if (alreadyStaged) {
      log(`MarkItDown bundle: already staged ${binaryPath}.`);
      return { status: 'already-staged', binaryPath };
    }
  }

  if (ciMode) {
    log('MarkItDown bundle: CI environment detected; skipping implicit release-asset download. Set DKG_FORCE_MARKITDOWN_DOWNLOAD=1 to override.');
    return { status: 'ci-skipped' };
  }

  const baseUrl = releaseBaseUrlOverride ?? releaseBaseUrl(resolvedVersion, releaseRepo);
  try {
    const result = await downloadBinaryAsset({
      assetName: target.assetName,
      destinationDir: resolveBinDir(resolvedPackageDir, outputDir),
      baseUrl,
      cliVersion: resolvedVersion,
      force,
    });
    log(`MarkItDown bundle: staged ${result.binaryPath} (release v${resolvedVersion}).`);
    if (showRestartHint) maybeLogRestartHint(log);
    return { status: 'staged', binaryPath: result.binaryPath, releaseTag: `v${resolvedVersion}` };
  } catch (versionedErr) {
    // Workspace-mode fallback only — published installs at a known release
    // version should not silently swap in a different version's binary.
    if (resolvedWorkspace && releaseBaseUrlOverride == null && isHttp404Error(versionedErr)) {
      let latestTag = null;
      try {
        latestTag = await fetchLatestTag(releaseRepo);
      } catch (latestErr) {
        emitMissingBinaryRemediation(warn, resolvedVersion, `latest-release lookup failed: ${latestErr?.message ?? latestErr}`);
        return { status: 'failed', reason: 'latest-lookup-error' };
      }
      if (!latestTag) {
        emitMissingBinaryRemediation(warn, resolvedVersion, 'no published releases found for repo');
        return { status: 'failed', reason: 'no-releases' };
      }
      const latestVersion = latestTag.replace(/^v/, '');
      log(`MarkItDown bundle: v${resolvedVersion} has no release asset; falling back to latest tag ${latestTag}.`);
      const latestBaseUrl = releaseBaseUrl(latestVersion, releaseRepo);
      try {
        const fallbackResult = await downloadBinaryAsset({
          assetName: target.assetName,
          destinationDir: resolveBinDir(resolvedPackageDir, outputDir),
          baseUrl: latestBaseUrl,
          cliVersion: latestVersion,
          force,
        });
        // The downloaded meta.json claims cliVersion=latestVersion (matches the
        // release we actually pulled from). But the daemon's converter check
        // requires meta.cliVersion === local-package version, otherwise it
        // logs "Ignoring bundled MarkItDown binary with incompatible metadata"
        // and refuses to register the converter. For the workspace fallback
        // path we rewrite the meta to reflect the LOCAL cliVersion (so the
        // binary is actually usable), while preserving the actual release
        // provenance in `effectiveTag` for operator inspection.
        const overrideMeta = {
          source: 'release',
          cliVersion: resolvedVersion,
          effectiveTag: latestTag,
        };
        await writeMetadataFile(fallbackResult.binaryPath, overrideMeta);
        log(`MarkItDown bundle: staged ${fallbackResult.binaryPath} (release ${latestTag}, meta tagged v${resolvedVersion}).`);
        if (showRestartHint) maybeLogRestartHint(log);
        return { status: 'fallback-staged', binaryPath: fallbackResult.binaryPath, releaseTag: latestTag };
      } catch (fallbackErr) {
        emitMissingBinaryRemediation(warn, resolvedVersion, `latest-release download failed: ${fallbackErr?.message ?? fallbackErr}`);
        return { status: 'failed', reason: 'fallback-download-error' };
      }
    }
    emitMissingBinaryRemediation(warn, resolvedVersion, versionedErr?.message ?? String(versionedErr));
    return { status: 'failed', reason: 'download-error' };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const packageDir = resolvePackageDir(opts.packageDir);
  const version = opts.version ?? readCliVersion(packageDir);
  const workspace = isWorkspaceCheckout(packageDir);
  const log = opts.quiet ? () => {} : logLine;
  const warn = opts.quiet ? () => {} : warnLine;

  // --verify-release-artifacts: standalone validation mode used by the release
  // workflow before publishing assets. Fails loudly so a broken matrix job
  // can't ship a Release with missing/mismatched sidecars.
  if (opts.verifyReleaseArtifacts) {
    const result = await verifyReleaseArtifacts({
      directory: opts.verifyReleaseArtifacts,
      version,
      packageDir,
    });
    if (!result.ok) {
      for (const err of result.errors) warn(`MarkItDown release verification: ${err}`);
      throw new Error(`MarkItDown release verification failed for v${result.expectedVersion}: ${result.errors.length} error(s) across ${result.targetCount} supported target(s).`);
    }
    log(`MarkItDown release verification: ok (${result.targetCount} target(s), v${result.expectedVersion}).`);
    return;
  }

  if (opts.all) {
    const result = await bundleReleasedBinaries({
      packageDir,
      outputDir: opts.outputDir,
      version,
      releaseBaseUrlOverride: opts.releaseBaseUrl,
      releaseRepo: opts.releaseRepo,
      force: opts.force,
    });
    log(`MarkItDown bundle: staged ${result.results.length} release asset(s) for v${version}.`);
    maybeLogRestartHint(log);
    return;
  }

  if (opts.buildCurrentPlatform) {
    const result = await buildCurrentPlatformBinary({
      packageDir,
      outputDir: opts.outputDir,
      force: opts.force,
    });
    if (result.status === 'unsupported') {
      log(`MarkItDown bundle: ${process.platform}-${process.arch} is not a supported bundled target.`);
      return;
    }
    log(`MarkItDown bundle: built ${result.binaryPath}.`);
    maybeLogRestartHint(log);
    return;
  }

  await bundleImplicitCurrentPlatform({
    packageDir,
    outputDir: opts.outputDir,
    version,
    workspace,
    releaseBaseUrl: opts.releaseBaseUrl,
    releaseRepo: opts.releaseRepo,
    force: opts.force,
    skipDownload: process.env.DKG_SKIP_MARKITDOWN_DOWNLOAD === '1',
    ciMode: process.env.CI === 'true' && process.env.DKG_FORCE_MARKITDOWN_DOWNLOAD !== '1',
    log,
    warn,
    showRestartHint: true,
  });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main().catch((err) => {
    const args = process.argv.slice(2);
    const bestEffort = args.includes('--best-effort');
    const message = `MarkItDown bundle: ${err?.message ?? String(err)}`;
    if (bestEffort) {
      warnLine(`${message} (continuing without a bundled binary)`);
      process.exit(0);
    }
    warnLine(message);
    process.exit(1);
  });
}
