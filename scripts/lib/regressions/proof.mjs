import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { profileFor, replayConfig, REQUIRED_ROUTE } from './profiles.mjs';
import { inspectExecution, verifyDiscovery } from './results.mjs';
import { sha256, inside, proofIdentity, verifyIdentity } from './identity.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).trim();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Own only the spawned process group. Never kill a service discovered by port.
export function runCommand(command, args, cwd, log, timeoutMs, signal) {
  return new Promise((resolve) => {
    const output = fs.openSync(log, 'wx');
    let stdout = '', stderr = '', timedOut = false, error, bytes = 0;
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (kind, data) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) { error = 'phase output exceeds 8 MiB'; stop(); return; }
      fs.writeSync(output, data);
      if (kind === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', (data) => collect('stdout', data));
    child.stderr.on('data', (data) => collect('stderr', data));
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* process already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.on('error', (failure) => { error = failure.message; });
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); fs.closeSync(output);
      resolve({ command, args, code, signal: terminationSignal, timedOut, ...(error ? { error } : {}), stdout, stderr });
    });
  });
}
function requireSetup(result, phase) {
  if (result.code !== 0 || result.signal || result.error || result.timedOut) throw new Error(`${phase} failed; no behavioral proof (${result.code ?? result.error ?? result.signal})`);
}
function sourceIdentity(root) {
  return { commit: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    lockfileSha256: sha256(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))),
    packageManager: readJson(path.join(root, 'package.json')).packageManager,
    nodeRequirement: fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim() };
}

export async function proveRegression(root, record, badRef, destination, { signal, onProgress = console.log } = {}) {
  const profile = profileFor(record);
  if (!badRef || badRef.startsWith('-') || /[\0\r\n]/.test(badRef)) throw new Error('invalid bad ref');
  if (!process.version.startsWith('v22.')) throw new Error('these historical profiles require Node 22 (.nvmrc); select Node 22 before pnpm');
  const badCommit = git(root, ['rev-parse', '--verify', `${badRef}^{commit}`]);
  const candidateCommit = git(root, ['rev-parse', 'HEAD']);
  // Candidate production is always committed source, never a hidden dirty overlay.
  if (git(root, ['status', '--porcelain', '--', 'packages/*/src', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches']).length) {
    throw new Error('commit candidate production/dependency changes before proving');
  }
  const identity = proofIdentity(root, profile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(destination); // Refuse to overwrite any previous evidence.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-regression-')));
  const worktrees = [];
  const receipt = { schemaVersion: 1, caseId: record.id, method: 'historical-replay', status: 'inconclusive',
    requestedBadRef: badRef, patch: null, identity, toolchain: { node: process.version, executable: process.execPath,
      nodeSha256: sha256(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch },
    overlay: [{ file: profile.file, sha256: identity[profile.file] }], phases: [], cleanup: {} };
  let failure;
  try {
    for (const [side, commit] of [['bad', badCommit], ['candidate', candidateCommit]]) {
      if (signal?.aborted) throw new Error('proof cancelled');
      const checkout = path.join(scratch, side);
      git(root, ['worktree', 'add', '--detach', checkout, commit]); worktrees.push(checkout);
      receipt[side] = { source: sourceIdentity(checkout) };
      const lockHash = receipt[side].source.lockfileSha256;
      const manifest = readJson(path.join(checkout, 'package.json'));
      if (manifest.packageManager !== 'pnpm@10.28.1' || receipt[side].source.nodeRequirement !== '22') throw new Error('unreviewed historical dependency/toolchain profile');
      const overlayPath = path.join(checkout, profile.file);
      fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
      fs.writeFileSync(overlayPath, fs.readFileSync(inside(root, profile.file)));
      // Only the declared detector and this repository-owned test config are overlaid.
      const configRelative = side === 'bad' ? 'vitest.regression-replay.config.mts' : REQUIRED_ROUTE.config;
      const configPath = path.join(checkout, 'packages/agent', configRelative);
      const config = side === 'bad' ? replayConfig(profile)
        : fs.readFileSync(configPath, 'utf8');
      if (side === 'candidate' && config !== fs.readFileSync(path.join(root, 'packages/agent', REQUIRED_ROUTE.config), 'utf8')) {
        throw new Error('commit the candidate unit config before proving its required lane');
      }
      if (side === 'bad') fs.writeFileSync(configPath, config);
      fs.writeFileSync(path.join(destination, `${side}-config.txt`), config);
      receipt[side].config = { file: `packages/agent/${configRelative}`, sha256: sha256(config),
        purpose: side === 'bad' ? 'minimal historical test-only config; no global setup' : 'normal required unit lane config' };
      const phase = async (name, command, args, timeout) => {
        onProgress(`${record.id}: ${side} ${name}`);
        const result = await runCommand(command, args, checkout, path.join(destination, `${side}-${name}.log`), timeout, signal);
        receipt.phases.push({ side, name, command, args, code: result.code, signal: result.signal,
          timedOut: result.timedOut, ...(result.error ? { error: result.error } : {}) });
        return result;
      };
      const version = await phase('pnpm-version', pnpm, ['--version'], 30000);
      requireSetup(version, 'pnpm');
      receipt[side].pnpmVersion = version.stdout.trim();
      if (receipt[side].pnpmVersion !== '10.28.1') throw new Error('wrong pnpm version');
      requireSetup(await phase('install', pnpm, ['install', '--frozen-lockfile'], 180000), 'frozen install');
      if (sha256(fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'))) !== lockHash) throw new Error('historical lockfile was modified');
      // Build only historical workspace dependencies of the source-loaded agent.
      requireSetup(await phase('build', pnpm, ['-r', '--filter', '@origintrail-official/dkg-agent^...',
        '--filter', '!@origintrail-official/dkg-evm-module', 'run', 'build'], 180000), 'dependency build');
      const testArgs = ['--dir', 'packages/agent', 'exec', 'vitest'];
      const file = profile.file.replace('packages/agent/', '');
      const discovered = await phase('discovery', pnpm, [...testArgs, 'list', '--config', configRelative, file, '--json'], 60000);
      requireSetup(discovered, 'assertion discovery');
      const discovery = JSON.parse(discovered.stdout);
      verifyDiscovery(discovery, profile, checkout);
      fs.writeFileSync(path.join(destination, `${side}-discovery.json`), JSON.stringify(discovery, null, 2) + '\n');
      const reportPath = path.join(checkout, `${side}-report.json`);
      const execution = await phase('execution', pnpm, [...testArgs, 'run', '--config', configRelative, file,
        '-t', `^${profile.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, '--reporter=json', `--outputFile=${reportPath}`], 45000);
      if (!fs.existsSync(reportPath)) throw new Error('runner produced no report; no behavioral proof');
      const reportBytes = fs.readFileSync(reportPath);
      fs.writeFileSync(path.join(destination, `${side}-report.json`), reportBytes);
      receipt[side].execution = inspectExecution(JSON.parse(reportBytes), execution, profile, checkout, side);
      receipt[side].reportRoot = checkout;
      // Recheck dependencies and overlays after execution, including install side effects.
      if (sha256(fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'))) !== lockHash
          || sha256(fs.readFileSync(overlayPath)) !== identity[profile.file]) throw new Error('stale/modified execution inputs');
      const changes = git(checkout, ['diff', '--name-only']).split('\n').filter(Boolean);
      if (changes.some((file) => ![profile.file, `packages/agent/${configRelative}`].includes(file))) throw new Error(`unexpected tracked replay edits: ${changes.join(', ')}`);
      receipt[side].dependencyInputs = Object.fromEntries(git(checkout, ['ls-files', '--', '**/package.json', 'package.json', 'pnpm-workspace.yaml', '.npmrc', 'patches'])
        .split('\n').filter(Boolean).map((file) => [file, sha256(fs.readFileSync(path.join(checkout, file)))]));
    }
    verifyIdentity(proofIdentity(root, profile), identity);
    receipt.status = 'proven';
  } catch (error) {
    failure = error; receipt.limitation = error.message;
  } finally {
    for (const checkout of worktrees.reverse()) {
      try { git(root, ['worktree', 'remove', '--force', checkout]); receipt.cleanup[path.basename(checkout)] = 'removed'; }
      catch (error) { receipt.cleanup[path.basename(checkout)] = `failed: ${error.message}`; failure ??= error; receipt.status = 'inconclusive'; }
    }
    // Do not unlink a checkout Git failed to remove: retain it for investigation.
    if (Object.values(receipt.cleanup).every((value) => value === 'removed')) fs.rmSync(scratch, { recursive: true, force: true });
    receipt.artifacts = Object.fromEntries(fs.readdirSync(destination).sort().map((file) => [file, sha256(fs.readFileSync(path.join(destination, file)))]));
    fs.writeFileSync(path.join(destination, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  if (failure) throw new Error(`${record.id}: INCONCLUSIVE: ${failure.message}; evidence: ${destination}`);
  return receipt;
}
