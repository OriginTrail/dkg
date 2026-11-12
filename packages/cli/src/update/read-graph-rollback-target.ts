/**
 * A node keeps read graphs only where the release it would roll back to recognizes them (OT-RFC-74). A release that recognizes read graphs hides their
 * partition, refuses writes into it, marks them all dirty when it starts without maintaining them, and drops them on its own rollback. An older release would
 * read and write them as ordinary graphs. So the daemon refuses `query.readGraphs` other than `off` while its rollback target is older, and turns the modes
 * of its settings table off.
 *
 * The rollback target is what `dkg rollback` and the automatic rollback activate: the other blue-green slot on a Core, the version recorded in
 * `previous-version` on an Edge. Without one there is nothing to roll back to, and nothing is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepsAnyReadGraph } from '@origintrail-official/dkg-storage';
import { activeSlot, dkgDir, releasesDir, slotEntryPoint } from '../config.js';
import { QueryConfigError, nodeReadGraphModes, resolveQuerySection, type QueryPolicy, type QuerySection, type ReadGraphsRefusal } from '../read-graphs-config.js';
import { compareSemver } from './npm-registry.js';
import { readSlotVersion } from './rollback-stores.js';

/** The first release that recognizes read graphs. A prerelease counts as older than its release. */
export const READ_GRAPHS_FIRST_RECOGNIZING_RELEASE = '10.1.2';

/**
 * The read-graph partition guard in a slot's build, in the git and the npm layouts. A slot that holds it recognizes read graphs whatever version it reports,
 * as a build from a branch can report the version of an older release.
 */
const PARTITION_GUARD_PATHS: readonly (readonly string[])[] = [
  ['packages', 'storage', 'dist', 'read-graph-partition-store.js'],
  ['node_modules', '@origintrail-official', 'dkg-storage', 'dist', 'read-graph-partition-store.js'],
  ['node_modules', '@origintrail-official', 'dkg', 'node_modules', '@origintrail-official', 'dkg-storage', 'dist', 'read-graph-partition-store.js'],
];

export type ReadGraphRollbackTarget =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'release';
    /** Where the target is recorded, for messages. */
    readonly source: string;
    /** `null` when the version cannot be read. */
    readonly version: string | null;
    readonly holdsPartitionGuard: boolean;
  };

/** What a rollback would activate on this node, or `none` when `dkg rollback` has nothing to roll back to. */
export async function readGraphRollbackTarget(role: 'core' | 'edge'): Promise<ReadGraphRollbackTarget> {
  if (role === 'edge') {
    const recorded = join(dkgDir(), 'previous-version');
    if (!existsSync(recorded)) return { kind: 'none' };
    const version = readFileSync(recorded, 'utf-8').trim();
    return version ? { kind: 'release', source: recorded, version, holdsPartitionGuard: false } : { kind: 'none' };
  }
  const current = await activeSlot();
  if (current === null) return { kind: 'none' };
  const slot = current === 'a' ? 'b' : 'a';
  const slotDir = join(releasesDir(), slot);
  if (!existsSync(slotDir) || slotEntryPoint(slotDir) === null) return { kind: 'none' };
  return {
    kind: 'release',
    source: `slot ${slot}`,
    version: readSlotVersion(slotDir),
    holdsPartitionGuard: PARTITION_GUARD_PATHS.some((parts) => existsSync(join(slotDir, ...parts))),
  };
}

/** Whether a rollback target recognizes read graphs. A version that cannot be read or compared does not. */
export function rollbackTargetRecognizesReadGraphs(target: ReadGraphRollbackTarget): boolean {
  if (target.kind === 'none' || target.holdsPartitionGuard) return true;
  if (target.version === null) return false;
  const order = compareSemver(target.version, READ_GRAPHS_FIRST_RECOGNIZING_RELEASE);
  return !Number.isNaN(order) && order >= 0;
}

/** Why a rollback target keeps the node from keeping read graphs, or `undefined` when it recognizes them. */
export function rollbackTargetRefusal(target: ReadGraphRollbackTarget): ReadGraphsRefusal | undefined {
  if (target.kind === 'none' || rollbackTargetRecognizesReadGraphs(target)) return undefined;
  return {
    code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER',
    message: `the rollback target (${target.source}: ${target.version ?? 'version unknown'}) is older than ${READ_GRAPHS_FIRST_RECOGNIZING_RELEASE}, `
      + 'the first release that recognizes read graphs',
    rollbackTarget: { source: target.source, version: target.version },
    firstRecognizingRelease: READ_GRAPHS_FIRST_RECOGNIZING_RELEASE,
  };
}

/**
 * The rollback target's refusal of the settings table's modes, at start and for a change: `undefined` when it recognizes read graphs. A target that
 * cannot be read refuses too, so no setting is kept on a target nobody could check.
 */
export async function settingsTableRollbackRefusal(role: 'core' | 'edge'): Promise<ReadGraphsRefusal | undefined> {
  try {
    return rollbackTargetRefusal(await readGraphRollbackTarget(role));
  } catch (error) {
    return { code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER', message: `the rollback target cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The start-up check: throws a `QueryConfigError` naming `query.readGraphs` when the node's own modes, with its policy applied, keep a read graph and the
 * rollback target does not recognize read graphs. The settings table's modes never stop a start.
 */
export async function assertRollbackTargetRecognizesReadGraphs(policy: QueryPolicy, role: 'core' | 'edge'): Promise<void> {
  if (!keepsAnyReadGraph(nodeReadGraphModes(policy))) return;
  const refusal = rollbackTargetRefusal(await readGraphRollbackTarget(role));
  if (refusal !== undefined) throw new QueryConfigError([{ key: 'query.readGraphs', message: `must be "off" while ${refusal.message}` }]);
}

/**
 * The daemon's boot check of the node's own modes. A node that starts from a
 * public checkpoint gets its store from the checkpoint, which keeps no read
 * graphs, so modes that keep one are refused there; elsewhere the rollback
 * target must recognize read graphs.
 */
export async function assertQueryConfigFitsNode(policy: QueryPolicy, role: 'core' | 'edge', checkpoint: boolean): Promise<void> {
  if (checkpoint && keepsAnyReadGraph(nodeReadGraphModes(policy))) {
    throw new QueryConfigError([{
      key: 'query.readGraphs',
      message: 'must be "off" on a node that starts from a public checkpoint, whose store the checkpoint builds',
    }]);
  }
  await assertRollbackTargetRecognizesReadGraphs(policy, role);
}

/**
 * The `dkg start` form, before a detached daemon could hide a problem: resolve the `query` section and check the rollback target, log every offending key and
 * stop the start. Returns the resolved section when it is accepted.
 */
export async function resolveQueryConfigOrExit(
  config: { readonly query?: unknown; readonly nodeRole?: 'core' | 'edge' },
  log: (message: string) => void,
): Promise<QuerySection> {
  try {
    const section = resolveQuerySection(config.query);
    await assertRollbackTargetRecognizesReadGraphs(section.policy, config.nodeRole ?? 'edge');
    return section;
  } catch (error) {
    if (!(error instanceof QueryConfigError)) throw error;
    log(`[QUERY-CONFIG] ${error.issues.length} validation error(s) - refusing to start.`);
    for (const issue of error.issues) log(`  ${issue.key}: ${issue.message}`);
    return process.exit(1);
  }
}
