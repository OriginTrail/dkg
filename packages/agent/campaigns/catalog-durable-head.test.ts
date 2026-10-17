import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { createNativeGate1FixtureOwner } from '../test/helpers/native-gate1-fixture.js';
import { runCatalogDurabilityScenario, type CatalogDurabilityBoundary } from '../test/helpers/catalog-durability-scenario.js';

// Only this dedicated, disposable worker reads campaign configuration. Ordinary
// Gate1 tests and their reusable fixture have no process-lifecycle mode switches.
const rootDirectory = process.env.DKG_CATALOG_DURABILITY_ROOT;
const receiverDirectory = process.env.DKG_CATALOG_DURABILITY_RESTART || undefined;
const requestedBoundary = process.env.DKG_CATALOG_DURABILITY_CRASH;
const boundaries: readonly string[] = ['before-flush', 'before-cas', 'after-cas'];
if (!rootDirectory || (receiverDirectory ? !!requestedBoundary : !boundaries.includes(requestedBoundary ?? ''))) {
  throw new Error('Run this worker through scripts/repro/rfc64-catalog-durable-head.mts');
}

it('runs the explicitly configured durability transition or restart', async () => {
  const owner = createNativeGate1FixtureOwner({ rootDirectory, receiverDirectory });
  try {
    await runCatalogDurabilityScenario(await owner.setupLiveReceiver(), {
      mode: receiverDirectory ? 'restart' : 'transition',
      onBoundary: (stage: CatalogDurabilityBoundary, evidence) => {
        if (stage !== requestedBoundary) return;
        writeFileSync(join(rootDirectory, 'boundary.json'), JSON.stringify({
          ...evidence, stage, pid: process.pid, signal: 'SIGKILL',
        }));
        // Kill only this campaign-owned worker, without close/flush/cleanup.
        process.kill(process.pid, 'SIGKILL');
        throw new Error('SIGKILL unexpectedly returned');
      },
    });
  } finally {
    await owner.dispose();
  }
}, 30_000);
