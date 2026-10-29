import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INVENTORY_SCHEMA_FIRST_RELEASES_V1,
  planRfc64InventoryRollbackV1,
  prepareRfc64InventoryForRollbackV1,
  RFC64_CONFIRMED_CATALOG_PLACEMENT_FIRST_RELEASE_V1,
  RFC64_INVENTORY_ROLLBACK_FLOOR_USER_VERSION_V1,
  Rfc64InventoryRollbackRefusedErrorV1,
} from '@origintrail-official/dkg-agent/rfc64/inventory-v1/rollback';
import { compareSemver } from './npm-registry.js';

// A store that a newer release migrated must be handed back in a form the
// rollback target opens, or the target stops at start. Each store whose
// migrated form an older release refuses is readied here.

export interface RollbackStoresIo {
  log(message: string): void;
  error(message: string): void;
}

/** Stores readied for the target version; release once the target is installed. */
export interface PreparedRollbackStores {
  release(): void;
}

export const consoleRollbackStoresIo: RollbackStoresIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** The release in a blue-green slot, from its git or npm layout. */
export function readSlotVersion(slotDir: string): string | null {
  for (const pkgPath of [
    join(slotDir, 'packages', 'cli', 'package.json'),
    join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
  ]) {
    try {
      const version = String((JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }).version ?? '').trim();
      if (version) return version;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * The newest inventory schema `release` opens: 0 for releases before the
 * inventory, null when the version cannot be read. A prerelease counts as
 * older than its release, as in update target selection.
 */
export function inventoryUserVersionForRelease(release: string): number | null {
  let userVersion = 0;
  for (const entry of INVENTORY_SCHEMA_FIRST_RELEASES_V1) {
    const order = compareSemver(release, entry.release);
    if (Number.isNaN(order)) return null;
    if (order >= 0) userVersion = entry.userVersion;
  }
  return userVersion;
}

function inventoryUserVersionFor(targetVersion: string | null): number {
  const known = targetVersion === null ? null : inventoryUserVersionForRelease(targetVersion);
  // A release this build cannot read gets the oldest schema it can write
  // without losing a row, which every release since 10.0.17 opens.
  return known ?? RFC64_INVENTORY_ROLLBACK_FLOOR_USER_VERSION_V1;
}

function targetName(targetVersion: string | null): string {
  return targetVersion ?? 'the rollback target';
}

/** A release before 10.0.27, or one this build cannot read, reads only version 1 placement repairs. */
export function readsOnlyLegacyPlacementRepairs(targetVersion: string | null): boolean {
  if (targetVersion === null) return true;
  const order = compareSemver(targetVersion, RFC64_CONFIRMED_CATALOG_PLACEMENT_FIRST_RELEASE_V1);
  return Number.isNaN(order) || order < 0;
}

function removedPlacementsLine(ualsRemoved: readonly string[], target: string): string {
  const shown = ualsRemoved.slice(0, 3).join(', ');
  const more = ualsRemoved.length > 3 ? ` and ${ualsRemoved.length - 3} more` : '';
  return `Removed ${ualsRemoved.length} confirmed catalog placement(s) that ${target} cannot read (${shown}${more}): `
    + `these publications are confirmed on chain, and ${target} does not finish their catalog step.`;
}

function refusalLines(
  refusal: Rfc64InventoryRollbackRefusedErrorV1,
  targetVersion: string | null,
  currentVersion: string,
  state: string,
): string[] {
  const target = targetName(targetVersion);
  const lines = [`Rollback refused: ${refusal.message}.`];
  if (refusal.reason === 'in-use') {
    lines.push(
      'Stop the node first. If a service manager restarts it, stop the service, then run "dkg rollback" again.',
    );
  } else if (refusal.reason === 'pending-rebuild') {
    lines.push(
      `Start ${currentVersion} once so it finishes rebuilding the database, stop it, then run "dkg rollback" again.`,
    );
  } else {
    lines.push(
      `${target} opens inventory schema v${refusal.maxUserVersion} at most. To roll back anyway, move `
        + `${refusal.databasePath} aside first: ${target} then starts with an empty inventory and syncs its `
        + 'catalog state again, and work recorded only in that database, such as pending private '
        + 'placement repairs, is lost.',
    );
  }
  lines.push(state);
  return lines;
}

/**
 * Before anything stops: false, after saying why, when the target could not
 * be given stores it opens. The node keeps running in that case.
 */
export function checkRollbackStores(
  dataDir: string,
  targetVersion: string | null,
  currentVersion: string,
  io: RollbackStoresIo = consoleRollbackStoresIo,
): boolean {
  try {
    planRfc64InventoryRollbackV1(dataDir, inventoryUserVersionFor(targetVersion));
    return true;
  } catch (error) {
    if (!(error instanceof Rfc64InventoryRollbackRefusedErrorV1)) throw error;
    for (const line of refusalLines(error, targetVersion, currentVersion, 'Nothing was changed.')) {
      io.error(line);
    }
    return false;
  }
}

/**
 * With the daemon stopped, ready the stores for the target version. Holds
 * the inventory lease until `release()`, so a node restarted before the
 * version switch cannot migrate the stores forward again. Null, after saying
 * why, when the rollback must stop.
 */
export async function prepareRollbackStores(
  dataDir: string,
  targetVersion: string | null,
  currentVersion: string,
  io: RollbackStoresIo = consoleRollbackStoresIo,
  stoppedState = `Nothing was changed. The daemon is stopped: run "dkg start" to start ${currentVersion} again.`,
): Promise<PreparedRollbackStores | null> {
  const target = targetName(targetVersion);
  try {
    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, inventoryUserVersionFor(targetVersion), {
      removeConfirmedCatalogPlacements: readsOnlyLegacyPlacementRepairs(targetVersion),
    });
    if (prepared.removedConfirmedCatalogPlacements.length > 0) {
      io.log(removedPlacementsLine(prepared.removedConfirmedCatalogPlacements, target));
    }
    if (prepared.outcome === 'downgraded') {
      io.log(
        `Lowered the RFC-64 inventory database from schema v${prepared.fromVersion} to v${prepared.toVersion} `
          + `for ${target}, keeping every row ${target} reads.`,
      );
    } else if (prepared.outcome === 'restored') {
      io.log(
        `Restored the RFC-64 inventory database from its schema v${prepared.toVersion} pre-migration copy `
          + `for ${target}; the replaced schema v${prepared.fromVersion} database is kept at ${prepared.keptPath}.`,
      );
    }
    return prepared;
  } catch (error) {
    if (error instanceof Rfc64InventoryRollbackRefusedErrorV1) {
      for (const line of refusalLines(error, targetVersion, currentVersion, stoppedState)) io.error(line);
    } else {
      io.error(`Rollback stopped: ${error instanceof Error ? error.message : String(error)}.`);
      io.error(`The version was not switched. Check the RFC-64 inventory database before starting the node.`);
    }
    return null;
  }
}
