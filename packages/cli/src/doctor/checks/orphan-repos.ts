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

/** Never infer relevance by recursively scanning the operator's home. */
function resolveScanRoots(deps: DoctorDeps, installRoots: Array<string | null>): string[] {
  return [...new Set([
    deps.dkgHome, ...installRoots,
    ...deps.extraScanRoots,
  ].filter((root): root is string => Boolean(root)))];
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
 * Bounded recursive scan from `root` looking for candidate
 * directories. Walks depth-first up to `maxDepth` levels deep,
 * skipping ignored directory names + any directory containing the
 * `.dkg-ignore-by-doctor` sentinel.
 */
async function scan(
  deps: DoctorDeps,
  root: string,
  daemonEntryPoint: string | null,
  candidates: OrphanCandidate[],
  remainingBudget: { count: number; deadlineMs: number },
  depth = 0,
): Promise<void> {
  if (depth > DEFAULT_MAX_DEPTH) return;
  if (Date.now() > remainingBudget.deadlineMs) return;
  if (remainingBudget.count <= 0) return;

  if (!deps.exists(root)) return;
  if (deps.exists(join(root, IGNORE_SENTINEL))) return;

  const probed = await probeDirectory(deps, root, daemonEntryPoint);
  if (probed) {
    candidates.push(probed);
    remainingBudget.count--;
    // Don't recurse into a discovered DKG checkout — its sub-trees
    // are uninteresting (nested node_modules, packages/, etc.).
    return;
  }

  const entries = await deps.readdir(root);
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith('.') && depth > 0) {
      // Allow dot-dirs at depth 0 (some operators keep ~/.dotfiles/
      // organisations); skip nested dot-dirs.
      continue;
    }
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    if (entry.isSymbolicLink) continue;
    await scan(deps, join(root, entry.name), daemonEntryPoint, candidates, remainingBudget, depth + 1);
    if (Date.now() > remainingBudget.deadlineMs) return;
    if (remainingBudget.count <= 0) return;
  }
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
  const candidates: OrphanCandidate[] = [];

  // 5-second budget + a max-50-candidate ceiling. Both bounds are
  // belt-and-braces — DEFAULT_MAX_DEPTH and the dot-dir skip should
  // keep the scan fast on a normal home tree.
  const budget = { count: 50, deadlineMs: Date.now() + 5000 };
  // activeSlot is the raw releases/current link target, which may be relative.
  const activeSlotPath = state.paths.activeSlot
    ? resolve(deps.dkgHome, 'releases', state.paths.activeSlot)
    : null;
  const installRoots = [deps.monorepoRoot, activeSlotPath, state.paths.npmGlobalDkg];
  const roots = resolveScanRoots(deps, installRoots);
  for (const root of roots) {
    await scan(deps, root, state.daemon.entryPoint, candidates, budget);
    if (Date.now() > budget.deadlineMs) break;
    if (budget.count <= 0) break;
  }

  // Probe the known daemon's ancestors directly, without traversing siblings.
  if (state.daemon.entryPoint) {
    let dir = dirname(state.daemon.entryPoint);
    while (dirname(dir) !== dir && dir !== deps.home) {
      const candidate = await probeDirectory(deps, dir, state.daemon.entryPoint);
      if (candidate) { candidates.push(candidate); break; }
      dir = dirname(dir);
    }
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const relevance = c.isActiveDaemon ? 'active-daemon'
      : installRoots.some((root) => root && isWithin(c.path, root)) ? 'selected-install'
      : isWithin(c.path, deps.dkgHome) ? 'selected-dkg-home'
      : 'explicit-scan-root';
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
