import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Opt-in real process-death seam used only by the disposable crash campaign. */
export function captureCatalogDurabilityBoundary(
  stage: 'before-flush' | 'before-cas' | 'after-cas',
  evidence: Readonly<Record<string, unknown>>,
): void {
  const directory = process.env.DKG_CATALOG_DURABILITY_ROOT;
  if (!directory || process.env.DKG_CATALOG_DURABILITY_CRASH !== stage) return;
  writeFileSync(join(directory, 'boundary.json'), JSON.stringify({
    ...evidence, stage, pid: process.pid, signal: 'SIGKILL',
  }));
  // Kill only this harness-owned Vitest worker. No close/flush/cleanup runs.
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL unexpectedly returned');
}
