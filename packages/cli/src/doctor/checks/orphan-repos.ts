/** Inspect the selected node's install paths; broader discovery requires doctor.scanRoots. */
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

const DEFAULT_MAX_DEPTH = 4;
const IGNORE_SENTINEL = '.dkg-ignore-by-doctor';
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.npm',
  '.cache',
  '.git',
  '.next',
  '.turbo',
  '.cargo',
  '.rustup',
  '.pnpm-store',
  'dist',
  'build',
]);
const ORIGIN_PATTERN = /OriginTrail\/dkg|origintrail-official\/dkg/i;
const PACKAGE_NAME_MATCHES = new Set(['@origintrail-official/dkg', 'dkg-v9', 'dkg-v10']);

/** A single discovered candidate. Exported for downstream consumption (e.g. CLI rendering). */
export interface OrphanCandidate {
  path: string;
  matchedBy: 'git-origin' | 'package-name' | 'both';
  origin?: string;
  packageName?: string;
  /** Whether this directory IS the active daemon (entryPoint resolves inside it). */
  isActiveDaemon: boolean;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

type Relevance = 'active-daemon' | 'selected-install' | 'selected-dkg-home' | 'explicit-scan-root';
interface ScanTarget {
  path: string;
  mode: 'probe' | 'discover';
  relevance: Relevance;
}

/** Known installs are exact probes; only the selected home and opt-in roots recurse. */
function resolveScanTargets(deps: DoctorDeps, state: StateSummary): ScanTarget[] {
  const activeSlotPath = state.paths.activeSlot
    ? resolve(deps.dkgHome, 'releases', state.paths.activeSlot)
    : null;
  const targets: ScanTarget[] = [
    ...[deps.monorepoRoot, activeSlotPath, state.paths.npmGlobalDkg]
      .filter((path): path is string => Boolean(path))
      .map((path): ScanTarget => ({ path: resolve(deps.cwd, path), mode: 'probe', relevance: 'selected-install' })),
    { path: resolve(deps.cwd, deps.dkgHome), mode: 'discover', relevance: 'selected-dkg-home' },
    ...deps.extraScanRoots.map((path): ScanTarget => ({
      path: resolve(deps.cwd, path), mode: 'discover', relevance: 'explicit-scan-root',
    })),
  ];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.mode}:${target.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Check whether `dir` is a DKG repo clone by reading the two signal
 * files. Returns the matched candidate or `null` if neither signal
 * fires.
 */
async function probeDirectory(
  deps: DoctorDeps,
  dir: string,
  daemonEntryPoint: string | null,
): Promise<OrphanCandidate | null> {
  const gitConfigPath = join(dir, '.git', 'config');
  const packageJsonPath = join(dir, 'package.json');

  let origin: string | null = null;
  if (deps.exists(gitConfigPath)) {
    const raw = await deps.readFile(gitConfigPath);
    if (raw) {
      const originMatch = raw.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*([^\s]+)/i);
      if (originMatch && ORIGIN_PATTERN.test(originMatch[1])) {
        origin = originMatch[1];
      }
    }
  }

  let packageName: string | null = null;
  if (deps.exists(packageJsonPath)) {
    const raw = await deps.readFile(packageJsonPath);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const name = (parsed as { name?: unknown }).name;
        if (typeof name === 'string' && PACKAGE_NAME_MATCHES.has(name)) {
          packageName = name;
        }
      } catch {
        // ignore malformed package.json — that's its own concern
      }
    }
  }

  if (!origin && !packageName) return null;

  const matchedBy: OrphanCandidate['matchedBy'] =
    origin && packageName ? 'both' : origin ? 'git-origin' : 'package-name';

  const isActiveDaemon = daemonEntryPoint
    ? isWithin(daemonEntryPoint, dir)
    : false;

  return {
    path: dir,
    matchedBy,
    ...(origin ? { origin } : {}),
    ...(packageName ? { packageName } : {}),
    isActiveDaemon,
  };
}

/**
 * Run the orphan-repos check. Returns the list of findings; the
 * orchestrator picks them up and rolls them into the report.
 */
export async function runOrphanReposCheck(
  deps: DoctorDeps,
  state: StateSummary,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const candidates: Array<OrphanCandidate & { relevance: Relevance }> = [];

  // 5-second budget + a max-50-candidate ceiling. Both bounds are
  // belt-and-braces — DEFAULT_MAX_DEPTH and the dot-dir skip should
  // keep the scan fast on a normal home tree.
  const budget = { count: 50, deadlineMs: Date.now() + 5000 };
  const targets = resolveScanTargets(deps, state);
  const daemonEntryPoint = state.daemon.entryPoint ? resolve(deps.cwd, state.daemon.entryPoint) : null;
  const hasBudget = () => budget.count > 0 && Date.now() <= budget.deadlineMs;
  const probes = new Map<string, { candidate: OrphanCandidate | null; descend: boolean }>();
  // A later, deeper explicit root can extend discovery beyond an earlier root's
  // depth limit, while completed subtrees and all exact probes remain reusable.
  const expandedDepth = new Map<string, number>();

  async function probe(path: string, relevance: Relevance) {
    const cached = probes.get(path);
    if (cached) return cached;
    if (!hasBudget()) return undefined;
    if (!deps.exists(path) || deps.exists(join(path, IGNORE_SENTINEL))) {
      const skipped = { candidate: null, descend: false };
      probes.set(path, skipped);
      return skipped;
    }
    const candidate = await probeDirectory(deps, path, daemonEntryPoint);
    const result = { candidate, descend: candidate === null };
    probes.set(path, result);
    if (candidate) {
      candidates.push({ ...candidate, relevance: candidate.isActiveDaemon ? 'active-daemon' : relevance });
      budget.count--;
    }
    return result;
  }

  async function discover(path: string, relevance: Relevance, depth = 0): Promise<void> {
    if (depth > DEFAULT_MAX_DEPTH || !hasBudget()) return;
    const remainingDepth = DEFAULT_MAX_DEPTH - depth;
    if ((expandedDepth.get(path) ?? -1) >= remainingDepth) return;
    if (!(await probe(path, relevance))?.descend) return;
    expandedDepth.set(path, remainingDepth);
    for (const entry of await deps.readdir(path)) {
      if (!entry.isDirectory || entry.isSymbolicLink || SKIP_DIRECTORIES.has(entry.name)) continue;
      if (entry.name.startsWith('.') && depth > 0) continue;
      await discover(join(path, entry.name), relevance, depth + 1);
      if (!hasBudget()) break;
    }
  }

  // Preserve known-install provenance and budget before broader discovery starts.
  for (const target of targets.filter((target) => target.mode === 'probe')) {
    await probe(target.path, target.relevance);
  }

  // Probe the known daemon's ancestors directly, without traversing siblings.
  if (daemonEntryPoint) {
    let dir = dirname(daemonEntryPoint);
    while (dirname(dir) !== dir && dir !== resolve(deps.cwd, deps.home) && hasBudget()) {
      if ((await probe(dir, 'active-daemon'))?.candidate) break;
      dir = dirname(dir);
    }
  }

  for (const target of targets.filter((target) => target.mode === 'discover')) {
    await discover(target.path, target.relevance);
    if (!hasBudget()) break;
  }

  for (const c of candidates) {
    const { relevance } = c;
    findings.push({
      check: 'orphan-repos',
      severity: 'info',
      message: `DKG repository clone at ${c.path} (${relevance})`,
      subject: c.path,
      details: { relevance, matchedBy: c.matchedBy, isActiveDaemon: c.isActiveDaemon,
        ...(c.origin ? { origin: c.origin } : {}), ...(c.packageName ? { packageName: c.packageName } : {}) },
    });
  }
  return findings;
}
