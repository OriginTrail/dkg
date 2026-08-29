// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedRfc64CatalogRolloutConfigV1 } from
  './catalog-rollout-authority-v1.js';

const FILE_NAME_V1 = 'rfc64-catalog-rollout-authority-v1.json';

interface StoredRfc64CatalogAuthorityV1 {
  readonly version: 1;
  readonly catalogContextGraphs: readonly string[];
}
/**
 * Persist the set of catalog-authoritative CGs before any runtime worker starts.
 * A catalog downgrade requires a separate semantic deactivation migration; until
 * that exists, refusing the boot prevents stale catalog projections from
 * overlapping newly admitted legacy synchronization.
 */
export async function persistRfc64CatalogAuthorityPlanV1(
  dataDir: string,
  activation: Readonly<{
    readonly selectedContextGraphs: readonly string[];
    readonly rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = join(dataDir, FILE_NAME_V1);
  const previous = await readStoredPlanV1(filePath);
  const nextCatalogGraphs = Object.freeze(activation.selectedContextGraphs.filter(
    (contextGraphId) => activation.rollout.contextGraphModes[contextGraphId] === 'catalog',
  ));
  const nextCatalogSet = new Set(nextCatalogGraphs);
  const unsafeDowngrades = previous?.catalogContextGraphs.filter(
    (contextGraphId) => !nextCatalogSet.has(contextGraphId),
  ) ?? [];
  if (unsafeDowngrades.length > 0) {
    throw new Error(
      'RFC-64 catalog authority downgrade requires semantic deactivation before legacy sync: '
      + unsafeDowngrades.join(', '),
    );
  }

  const plan: StoredRfc64CatalogAuthorityV1 = Object.freeze({
    version: 1,
    catalogContextGraphs: nextCatalogGraphs,
  });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(plan)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readStoredPlanV1(filePath: string): Promise<StoredRfc64CatalogAuthorityV1 | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('RFC-64 catalog authority state is not valid JSON', { cause: error });
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { catalogContextGraphs?: unknown }).catalogContextGraphs)
    || (parsed as { catalogContextGraphs: unknown[] }).catalogContextGraphs.some(
      (value) => typeof value !== 'string' || value.length === 0,
    )
  ) {
    throw new Error('RFC-64 catalog authority state is malformed');
  }
  const catalogContextGraphs = (parsed as { catalogContextGraphs: string[] })
    .catalogContextGraphs;
  if (new Set(catalogContextGraphs).size !== catalogContextGraphs.length) {
    throw new Error('RFC-64 catalog authority state contains duplicate CGs');
  }
  return Object.freeze({
    version: 1,
    catalogContextGraphs: Object.freeze([...catalogContextGraphs]),
  });
}
