/**
 * §4.7.1 Check: orphan repository clones.
 *
 * Walks operator $HOME (plus common dev-folder children: `Projects`,
 * `repos`, `src`, `dev`, plus any operator-configured `doctor.scanRoots`)
 * up to a bounded depth, looking for directories that look like a
 * stray DKG repository clone. Each match is reported as a finding
 * with severity `warning` (or `info` if the directory IS the active
 * daemon — that's just describing reality).
 *
 * Detection signals:
 *   - `.git/config` whose `[remote "origin"]` URL contains
 *     `OriginTrail/dkg` or `origintrail-official/dkg`, OR
 *   - `package.json` whose `name` field is `@origintrail-official/dkg`
 *     or `dkg-v9` (legacy name).
 *
 * Performance constraint: the scan MUST complete in < 5 s on a
 * laptop-sized home directory. We skip `node_modules`, `.npm`,
 * `.cache`, `.npmrc`, any dot-directory other than the configured
 * roots themselves, and any directory containing a
 * `.dkg-ignore-by-doctor` sentinel.
 */
import { join } from 'node:path';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

const DEFAULT_SCAN_ROOT_CHILDREN = ['Projects', 'repos', 'src', 'dev'];
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
const PACKAGE_NAME_MATCHES = new Set(['@origintrail-official/dkg', 'dkg-v9']);

/** A single discovered candidate. Exported for downstream consumption (e.g. CLI rendering). */
export interface OrphanCandidate {
  path: string;
  matchedBy: 'git-origin' | 'package-name' | 'both';
  origin?: string;
  packageName?: string;
  /** Whether this directory IS the active daemon (entryPoint resolves inside it). */
  isActiveDaemon: boolean;
}

/** Compute the set of roots we will scan. */
function resolveScanRoots(deps: DoctorDeps): string[] {
  const roots = new Set<string>([deps.home]);
  for (const child of DEFAULT_SCAN_ROOT_CHILDREN) {
    roots.add(join(deps.home, child));
  }
  for (const extra of deps.extraScanRoots) {
    roots.add(extra);
  }
  return Array.from(roots);
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
    ? daemonEntryPoint.startsWith(dir + '/') || daemonEntryPoint === dir
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
  const roots = resolveScanRoots(deps);
  for (const root of roots) {
    await scan(deps, root, state.daemon.entryPoint, candidates, budget);
    if (Date.now() > budget.deadlineMs) break;
    if (budget.count <= 0) break;
  }

  for (const c of candidates) {
    if (c.isActiveDaemon) {
      findings.push({
        check: 'orphan-repos',
        severity: 'info',
        message: `DKG repository clone at ${c.path} (active daemon's source tree)`,
        subject: c.path,
        details: { matchedBy: c.matchedBy, isActiveDaemon: true, ...(c.origin ? { origin: c.origin } : {}), ...(c.packageName ? { packageName: c.packageName } : {}) },
      });
    } else {
      findings.push({
        check: 'orphan-repos',
        severity: 'warning',
        message: `Stray DKG repository clone at ${c.path}`,
        advisory: "This is not the running daemon. Do not 'git pull' here. Run 'dkg update' instead.",
        subject: c.path,
        details: { matchedBy: c.matchedBy, isActiveDaemon: false, ...(c.origin ? { origin: c.origin } : {}), ...(c.packageName ? { packageName: c.packageName } : {}) },
      });
    }
  }

  return findings;
}
