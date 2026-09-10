/**
 * `dkg doctor` orchestrator (OT-RFC-41 §4.7).
 *
 * Wires the state summary + six anomaly checks into a single
 * {@link DoctorReport}. Used by the `dkg doctor` CLI command and
 * (in a narrow subset form) by `dkg update`'s pre-flight check.
 *
 * Each check is pure — given a {@link DoctorDeps} and a
 * {@link StateSummary}, it returns findings. The orchestrator
 * threads real I/O through {@link createProductionDeps} in
 * production, and tests inject stub deps.
 */
import { existsSync, statSync, readlinkSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dkgDir, isDkgMonorepo, repoDir } from '../config.js';
import { findDkgMonorepoRoot } from '@origintrail-official/dkg-core';
import { runNodeRuntimeCheck } from './checks/node-runtime.js';
import { collectStateSummary } from './state-summary.js';
import { runOrphanReposCheck } from './checks/orphan-repos.js';
import { runConfigSanityCheck } from './checks/config-sanity.js';
import { runInstallLayoutCheck } from './checks/install-layout.js';
import { runVersionSkewCheck } from './checks/version-skew.js';
import { runServedUiMismatchCheck } from './checks/served-ui-mismatch.js';
import { runPluginRootCheck } from './checks/plugin-root.js';
import { ALL_CHECK_IDS, type CheckId } from './policy.js';
import type { DoctorDeps, DoctorReport, Finding, StateSummary } from './types.js';

export type { DoctorDeps, DoctorReport, Finding, StateSummary } from './types.js';
export { collectStateSummary } from './state-summary.js';

export { ALL_CHECK_IDS, UPDATE_PREFLIGHT_CHECKS, type CheckId } from './policy.js';

export interface RunDoctorOptions {
  /** Which checks to run; defaults to all six. */
  checks?: readonly CheckId[];
  /** API port to probe. Defaults to 9200. */
  apiPort?: number;
}

/**
 * Run the doctor with the given deps + options. Returns the full
 * {@link DoctorReport} (state summary + findings + exit code).
 */
export async function runDoctor(
  deps: DoctorDeps,
  opts: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const state = await collectStateSummary(deps);
  const checks = (opts.checks ?? ALL_CHECK_IDS).filter((id) => !deps.skipChecks.includes(id));
  const findings: Finding[] = [];

  for (const id of checks) {
    try {
      let next: Finding[] = [];
      switch (id) {
        case 'node-runtime':
          next = runNodeRuntimeCheck(deps, state);
          break;
        case 'orphan-repos':
          next = await runOrphanReposCheck(deps, state);
          break;
        case 'config-sanity':
          next = await runConfigSanityCheck(deps);
          break;
        case 'install-layout':
          next = await runInstallLayoutCheck(deps, state);
          break;
        case 'version-skew':
          next = await runVersionSkewCheck(deps, state);
          break;
        case 'served-ui-mismatch':
          next = await runServedUiMismatchCheck(deps, state);
          break;
        case 'plugin-root':
          next = await runPluginRootCheck(deps);
          break;
        default: {
          // Defensive: unknown id — surface it but keep going.
          const exhaustive: never = id;
          void exhaustive;
        }
      }
      findings.push(...next);
    } catch (err: any) {
      findings.push({
        check: id,
        severity: 'error',
        message: `Check '${id}' crashed`,
        advisory: `Internal error: ${err?.message ?? err}. Open a bug at https://github.com/OriginTrail/dkg/issues.`,
      });
    }
  }

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  const exitCode: 0 | 1 | 2 = hasError ? 2 : hasWarning ? 1 : 0;

  return {
    state,
    findings,
    exitCode,
    schemaVersion: 1,
  };
}

/**
 * Build the production {@link DoctorDeps} surface — real Node `fs`,
 * `child_process`, and `fetch` calls. Tests inject their own.
 */
export function createProductionDeps(opts: { apiPort?: number } = {}): DoctorDeps {
  const cwd = process.cwd();
  const home = homedir();
  const monoRoot = repoDir();
  const isMono = isDkgMonorepo();

  return {
    dkgHome: dkgDir(),
    dkgHomeEnv: process.env.DKG_HOME ?? null,
    cwd,
    home,
    apiPort: opts.apiPort ?? 9200,
    isMonorepo: isMono,
    monorepoRoot: monoRoot ?? (isMono ? findDkgMonorepoRoot(cwd) : null),
    // Doctor scanRoots / skipChecks come from config; the orchestrator
    // doesn't load the config itself — the caller may pre-populate
    // these from `loadConfig()` before calling `createProductionDeps`.
    // For now we default to []; cli.ts overlays the config values.
    extraScanRoots: [],
    skipChecks: [],

    exists(path: string): boolean {
      try { return existsSync(path); } catch { return false; }
    },
    async readFile(path: string): Promise<string | null> {
      try { return readFileSync(path, 'utf-8'); } catch { return null; }
    },
    async readlink(path: string): Promise<string | null> {
      try { return readlinkSync(path); } catch { return null; }
    },
    async stat(path: string) {
      try {
        const s = statSync(path);
        return {
          mtimeMs: s.mtimeMs,
          uid: s.uid,
          isDirectory: s.isDirectory(),
          isSymbolicLink: s.isSymbolicLink(),
        };
      } catch {
        return null;
      }
    },
    async readdir(path: string) {
      try {
        return readdirSync(path, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink(),
        }));
      } catch {
        return [];
      }
    },
    async runCommand(cmd, args) {
      return new Promise((resolve) => {
        try {
          const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
          child.on('error', () => resolve(null));
          child.on('exit', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
        } catch {
          resolve(null);
        }
      });
    },
    async fetchJson(url: string): Promise<Record<string, unknown> | null> {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        const text = await res.text();
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    },
    async fetchText(url: string): Promise<string | null> {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Render a {@link DoctorReport} as a human-readable string. Matches
 * the layout the agent SKILL guidance teaches operators to expect.
 * The first block is the state summary; the second is findings,
 * grouped by severity.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('DKG doctor — state summary');
  lines.push('─'.repeat(60));
  const s = report.state;
  const fmt = (label: string, value: unknown): string => {
    const display = value === null || value === undefined ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value);
    return `  ${label.padEnd(28)} ${display}`;
  };
  lines.push(fmt('daemon.pid', s.daemon.pid));
  lines.push(fmt('daemon.entryPoint', s.daemon.entryPoint));
  lines.push(fmt('daemon.version', s.daemon.version));
  lines.push(fmt('daemon.commit', s.daemon.commit));
  lines.push(fmt('daemon.commitShort', s.daemon.commitShort));
  lines.push(fmt('daemon.buildTime', s.daemon.buildTime));
  lines.push(fmt('daemon.distTag', s.daemon.distTag));
  lines.push(fmt('daemon.installMode', s.daemon.installMode));
  lines.push(fmt('daemon.nodeRole', s.daemon.nodeRole));
  if (s.daemon.unreachableReason) lines.push(fmt('daemon (unreachable)', s.daemon.unreachableReason));
  lines.push(fmt('cli.globalPath', s.cli.globalPath));
  lines.push(fmt('cli.version', s.cli.version));
  lines.push(fmt('paths.dkgHome', s.paths.dkgHome));
  lines.push(fmt('paths.dkgHomeEnv', s.paths.dkgHomeEnv));
  lines.push(fmt('paths.activeSlot', s.paths.activeSlot));
  lines.push(fmt('paths.npmGlobalDkg', s.paths.npmGlobalDkg));
  lines.push(fmt('paths.pluginsRoot', s.paths.pluginsRoot));
  lines.push(fmt('autoUpdate.enabled', s.autoUpdate.enabled));
  lines.push(fmt('autoUpdate.checkInterval', `${s.autoUpdate.checkIntervalMinutes} min`));
  lines.push(fmt('autoUpdate.allowPrerelease', s.autoUpdate.allowPrerelease));
  lines.push(fmt('autoUpdate.source', s.autoUpdate.source));
  lines.push(fmt('autoUpdate.lastCheck', s.autoUpdate.lastCheck));
  lines.push(fmt('autoUpdate.lastError', s.autoUpdate.lastError ? '(set — see report below)' : null));
  lines.push(fmt('previousVersion', s.previousVersion));
  lines.push('');

  const order: Array<Finding['severity']> = ['error', 'warning', 'info'];
  const grouped = new Map<Finding['severity'], Finding[]>();
  for (const sev of order) grouped.set(sev, []);
  for (const f of report.findings) grouped.get(f.severity)!.push(f);

  if (report.findings.length === 0) {
    lines.push('No anomalies detected. (exit 0)');
    return lines.join('\n');
  }

  lines.push('Findings');
  lines.push('─'.repeat(60));
  for (const sev of order) {
    const group = grouped.get(sev)!;
    if (group.length === 0) continue;
    lines.push(`[${sev.toUpperCase()}] ${group.length} finding${group.length === 1 ? '' : 's'}`);
    for (const f of group) {
      lines.push(`  • [${f.check}] ${f.message}`);
      if (f.advisory) lines.push(`      → ${f.advisory}`);
    }
    lines.push('');
  }
  lines.push(`Exit code: ${report.exitCode}`);
  return lines.join('\n');
}
