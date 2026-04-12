import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const MARKITDOWN_UPSTREAM_VERSION = '0.1.5';
export const PYINSTALLER_VERSION = '6.19.0';
export const DEFAULT_RELEASE_REPO = 'OriginTrail/dkg-v9';

export const SUPPORTED_TARGETS = [
  { platform: 'linux', arch: 'x64', assetName: 'markitdown-linux-x64' },
  { platform: 'darwin', arch: 'arm64', assetName: 'markitdown-darwin-arm64' },
  { platform: 'win32', arch: 'x64', assetName: 'markitdown-win32-x64.exe' },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PACKAGE_DIR = resolve(__dirname, '..');

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

export function checksumPathFor(binaryPath) {
  return `${binaryPath}.sha256`;
}

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

export function parseSha256File(text) {
  const [hash] = text.trim().split(/\s+/);
  if (!hash) throw new Error('Malformed sha256 file');
  return hash.toLowerCase();
}

async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(30_000),
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

export async function downloadBinaryAsset({
  assetName,
  destinationDir,
  baseUrl,
  force = false,
}) {
  const destination = join(destinationDir, assetName);
  if (!force && existsSync(destination)) {
    return { status: 'present', binaryPath: destination };
  }

  await ensureDir(destinationDir);
  const assetUrl = releaseAssetUrl(baseUrl, assetName);
  const checksumUrl = `${assetUrl}.sha256`;
  const [bytes, checksumText] = await Promise.all([
    fetchBytes(assetUrl),
    fetchText(checksumUrl),
  ]);
  const expectedHash = parseSha256File(checksumText);
  const actualHash = sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}`);
  }

  await writeFile(destination, bytes);
  ensureExecutable(destination);
  await writeFile(checksumPathFor(destination), checksumText, 'utf-8');
  return { status: 'downloaded', binaryPath: destination, hash: actualHash };
}

function resolvePythonCommand() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
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
    throw new Error(`Unsupported MarkItDown bundle target: ${process.platform}-${process.arch}`);
  }

  const binDir = resolveBinDir(packageDir, outputDir);
  const binaryPath = targetBinaryPath(target, packageDir, outputDir);
  if (!force && existsSync(binaryPath)) {
    return { status: 'present', binaryPath };
  }

  await ensureDir(binDir);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'dkg-markitdown-build-'));
  const venvDir = join(tmpRoot, 'venv');
  const workDir = join(tmpRoot, 'pyi-work');
  const specDir = join(tmpRoot, 'pyi-spec');
  const python = resolvePythonCommand();

  try {
    await execFile(python, ['-m', 'venv', venvDir], { cwd: tmpRoot, timeout: 120_000 });
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
      target.assetName,
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
  if (!force && existsSync(binaryPath)) {
    return { status: 'present', binaryPath };
  }

  const resolvedVersion = version ?? readCliVersion(packageDir);
  const baseUrl = releaseBaseUrlOverride ?? releaseBaseUrl(resolvedVersion, releaseRepo);
  try {
    const result = await downloadBinaryAsset({
      assetName: target.assetName,
      destinationDir: resolveBinDir(packageDir, outputDir),
      baseUrl,
      force,
    });
    return { ...result, source: 'release' };
  } catch (downloadErr) {
    if (!allowBuildFromSource) throw downloadErr;
    const built = await buildCurrentPlatformBinary({ packageDir, outputDir, force });
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
