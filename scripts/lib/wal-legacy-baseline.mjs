import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EVIDENCE_SCHEMA = 'dkg-wal-000-evidence-v1';
export const MATRIX_SCHEMA = 'dkg-wal-000-scenario-matrix-v1';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function percentile(values, percentileValue) {
  if (values.length === 0) throw new Error('cannot summarize an empty measurement list');
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return ordered[index];
}

export function summarizeMeasurements(values) {
  return {
    samples: values.length,
    minimum: Math.min(...values),
    median: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    maximum: Math.max(...values),
  };
}

export function validateScenarioMatrix(matrix) {
  if (matrix?.schema !== MATRIX_SCHEMA) throw new Error(`unsupported scenario matrix schema: ${matrix?.schema}`);
  if (!matrix.baselineId || !matrix.baseRef || !/^[0-9a-f]{40}$/.test(matrix.baseCommit ?? '')) {
    throw new Error('scenario matrix requires baselineId, baseRef, and a fixed baseCommit');
  }
  const ids = new Set();
  for (const [profileName, profile] of Object.entries(matrix.profiles ?? {})) {
    if (!Number.isSafeInteger(profile.defaultRepetitions) || profile.defaultRepetitions <= 0) {
      throw new Error(`${profileName}.defaultRepetitions must be a positive integer`);
    }
    if (!Array.isArray(profile.scenarios) || profile.scenarios.length === 0) {
      throw new Error(`${profileName} must contain scenarios`);
    }
    for (const scenario of profile.scenarios) {
      if (!scenario.id || ids.has(scenario.id)) throw new Error(`duplicate or missing scenario id: ${scenario.id}`);
      ids.add(scenario.id);
      if (!scenario.category || !scenario.kind || !Array.isArray(scenario.covers) || scenario.covers.length === 0) {
        throw new Error(`${scenario.id} is missing category, kind, or coverage declarations`);
      }
      if (!['normative-oracle', 'sync-characterization'].includes(scenario.role)) {
        throw new Error(`${scenario.id} has unsupported evidence role ${scenario.role}`);
      }
      if (!Number.isSafeInteger(scenario.timeoutMs) || scenario.timeoutMs <= 0) {
        throw new Error(`${scenario.id}.timeoutMs must be a positive integer`);
      }
      if (scenario.kind === 'vitest' && (!scenario.package || !Array.isArray(scenario.files) || scenario.files.length === 0)) {
        throw new Error(`${scenario.id} requires a package and test files`);
      }
      if (scenario.kind === 'command' && (!scenario.command || !Array.isArray(scenario.args))) {
        throw new Error(`${scenario.id} requires a command and args`);
      }
      if (!['vitest', 'command'].includes(scenario.kind)) throw new Error(`${scenario.id} has unsupported kind ${scenario.kind}`);
    }
  }
  return matrix;
}

export function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function assertSafeOutputPath(repositoryRoot, outputPath) {
  if (isPathInside(repositoryRoot, outputPath)) {
    throw new Error('WAL-000 receipts must be written outside the repository');
  }
}

const ENDPOINT_ENVIRONMENT = /^(?:(?:DKG_|CHAIN_|EVM_|BASE_|GNOSIS_).*(?:URL|URI|ENDPOINT)|(?:RPC|RPC_LOCALHOST|RPC_URL|CHAIN_RPC_URL))$/i;
const SECRET_ENVIRONMENT = /(?:PRIVATE_KEY|MNEMONIC|AUTH_TOKEN|WALLET_KEY|PUBLISHER_KEY)/i;

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function assertNoRemoteDkgEndpoints(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (value && ENDPOINT_ENVIRONMENT.test(name) && !isLoopbackUrl(value)) {
      throw new Error(`refusing WAL-000 execution with non-loopback ${name}`);
    }
  }
}

export function isolatedChildEnvironment(environment, runtimeDirectory) {
  const child = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || SECRET_ENVIRONMENT.test(name) || ENDPOINT_ENVIRONMENT.test(name)) continue;
    child[name] = value;
  }
  child.DKG_HOME = resolve(runtimeDirectory, 'dkg-home');
  child.TMPDIR = resolve(runtimeDirectory, 'tmp');
  child.DKG_NO_BLUE_GREEN = '1';
  child.DKG_SKIP_EVM_BUILD = '1';
  child.CI = '1';
  return child;
}

export function repositoryState(repositoryRoot, baseRef, baseCommit) {
  const git = (...args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, 'HEAD'], { cwd: repositoryRoot });
  return {
    commit: git('rev-parse', 'HEAD'),
    baseCommit: git('rev-parse', baseCommit),
    baseRefCommitAtRun: git('rev-parse', baseRef),
    dirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean),
  };
}

function parseResourceUsage(stderr, platform) {
  const usage = { userCpuSeconds: null, systemCpuSeconds: null, maximumRssBytes: null };
  if (platform === 'darwin') {
    const user = /(?:^|\n)user\s+([\d.]+)/.exec(stderr);
    const system = /(?:^|\n)sys\s+([\d.]+)/.exec(stderr);
    if (user) usage.userCpuSeconds = Number(user[1]);
    if (system) usage.systemCpuSeconds = Number(system[1]);
  } else if (platform === 'linux') {
    const user = /User time \(seconds\):\s*([\d.]+)/.exec(stderr);
    const system = /System time \(seconds\):\s*([\d.]+)/.exec(stderr);
    const rss = /Maximum resident set size \(kbytes\):\s*([0-9]+)/.exec(stderr);
    if (user) usage.userCpuSeconds = Number(user[1]);
    if (system) usage.systemCpuSeconds = Number(system[1]);
    if (rss) usage.maximumRssBytes = Number(rss[1]) * 1024;
  }
  return usage;
}

export function runMeasuredCommand({ command, args, cwd, environment, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeArguments = process.platform === 'darwin'
      ? ['-p', command, ...args]
      : process.platform === 'linux'
        ? ['-v', command, ...args]
        : null;
    const executable = timeArguments ? '/usr/bin/time' : command;
    const executableArguments = timeArguments ?? args;
    const startedAt = performance.now();
    const child = spawn(executable, executableArguments, {
      cwd,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let forceKillTimeout = null;
    let maximumRssBytes = null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const sampleProcessGroupRss = () => {
      if (process.platform === 'win32' || child.pid === undefined) return;
      try {
        const processTable = execFileSync('ps', ['-axo', 'pgid=,rss='], { encoding: 'utf8' });
        const rssKilobytes = processTable.split('\n').reduce((sum, line) => {
          const [pgid, rss] = line.trim().split(/\s+/).map(Number);
          return pgid === child.pid && Number.isFinite(rss) ? sum + rss : sum;
        }, 0);
        if (rssKilobytes > 0) maximumRssBytes = Math.max(maximumRssBytes ?? 0, rssKilobytes * 1024);
      } catch {}
    };
    const initialRssSample = setTimeout(sampleProcessGroupRss, 25);
    const rssInterval = setInterval(sampleProcessGroupRss, 250);
    child.on('error', (error) => {
      clearTimeout(initialRssSample);
      clearInterval(rssInterval);
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      rejectPromise(error);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch {}
      forceKillTimeout = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5000);
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(initialRssSample);
      clearInterval(rssInterval);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const resourceUsage = parseResourceUsage(stderrText, process.platform);
      if (maximumRssBytes !== null) resourceUsage.maximumRssBytes = maximumRssBytes;
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        durationMs: performance.now() - startedAt,
        stdout: stdoutText,
        stderr: stderrText,
        resourceUsage,
      });
    });
  });
}

export async function sourceDigestForScenario(repositoryRoot, packageDirectory, files) {
  const entries = [];
  for (const file of [...files].sort()) {
    const repositoryPath = packageDirectory ? `${packageDirectory}/${file}` : file;
    const bytes = await readFile(resolve(repositoryRoot, repositoryPath));
    entries.push({ path: repositoryPath, sha256: sha256(bytes) });
  }
  return { files: entries, digest: sha256(canonicalJson(entries)) };
}

export function parseVitestEvidence(report) {
  const assertions = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      assertions.push({
        fullName: assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].join(' '),
        status: assertion.status,
      });
    }
  }
  assertions.sort((left, right) => left.fullName.localeCompare(right.fullName));
  const counts = assertions.reduce((result, assertion) => {
    result[assertion.status] = (result[assertion.status] ?? 0) + 1;
    return result;
  }, {});
  return {
    assertions,
    counts,
    assertionCount: assertions.length,
    assertionDigest: sha256(canonicalJson(assertions)),
  };
}

export function parseCommandOutput(parser, stdout) {
  if (parser === 'json-stdout') return JSON.parse(stdout);
  if (parser === 'sync-responder-json') {
    const marker = 'Machine-readable results:';
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) throw new Error('sync responder benchmark omitted machine-readable results');
    return JSON.parse(stdout.slice(markerIndex + marker.length).trim());
  }
  if (parser === undefined) return null;
  throw new Error(`unknown output parser: ${parser}`);
}

export function packageDirectoryForName(packageName) {
  const directories = {
    '@origintrail-official/dkg-agent': 'packages/agent',
    '@origintrail-official/dkg-publisher': 'packages/publisher',
    '@origintrail-official/dkg-chain': 'packages/chain',
    '@origintrail-official/dkg-storage': 'packages/storage',
  };
  const directory = directories[packageName];
  if (!directory) throw new Error(`unknown WAL-000 package: ${packageName}`);
  return directory;
}
