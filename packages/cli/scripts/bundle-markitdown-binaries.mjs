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
export const DEFAULT_RELEASE_REPO = 'OriginTrail/dkg-v9';
export const RELEASE_BINARY_FETCH_TIMEOUT_MS = 15_000;
export const RELEASE_CHECKSUM_FETCH_TIMEOUT_MS = 5_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.all && !opts.currentPlatform && !opts.buildCurrentPlatform) {
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
  throw new Error('Python executable not found. Install python3/python or set the PYTHON environment variable.');
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
    await execFile(python.command, [...python.args, '-m', 'venv', venvDir], { cwd: tmpRoot, timeout: 120_000 });
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const packageDir = resolvePackageDir(opts.packageDir);
  const version = opts.version ?? readCliVersion(packageDir);
  const workspace = isWorkspaceCheckout(packageDir);
  const log = opts.quiet ? () => {} : logLine;

  if (workspace && !opts.all && !opts.buildCurrentPlatform) {
    log('MarkItDown bundle: workspace checkout detected; skipping implicit release-asset download.');
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
    return;
  }

  const result = await ensureCurrentPlatformBinary({
    packageDir,
    outputDir: opts.outputDir,
    version,
    releaseBaseUrlOverride: opts.releaseBaseUrl,
    releaseRepo: opts.releaseRepo,
    force: opts.force,
    allowBuildFromSource: workspace,
  });
  if (result.status === 'unsupported') {
    log(`MarkItDown bundle: ${process.platform}-${process.arch} is not a supported bundled target.`);
    return;
  }
  log(`MarkItDown bundle: staged ${result.binaryPath} (${result.source ?? result.status}).`);
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
