import type { HardenMigrationResult } from '../src/daemon/blazegraph-harden.js';
const common = { containerName: 'store', hostPort: 9999, heapMb: 2048 };
const preview: HardenMigrationResult = { ...common, outcome: 'dry-run', steps: [], exportPath: null, journalBytes: null, backupContainerName: null };
const completed: HardenMigrationResult = { ...common, outcome: 'hardened', exportPath: '/export', journalBytes: 1024, backupContainerName: 'backup' };
const recovered: HardenMigrationResult = { ...common, outcome: 'recovered', exportPath: '/export', journalBytes: 1024, backupContainerName: null };
const already: HardenMigrationResult = { ...common, outcome: 'already-hardened', exportPath: null, journalBytes: null, backupContainerName: null };
// @ts-expect-error preview must have the rendered step list
const missingSteps: HardenMigrationResult = { ...common, outcome: 'dry-run', exportPath: null, journalBytes: null, backupContainerName: null };
// @ts-expect-error successful migration must have export evidence
const missingExport: HardenMigrationResult = { ...common, outcome: 'hardened', exportPath: null, journalBytes: null, backupContainerName: 'backup' };
// @ts-expect-error recovery must have verified journal bytes
const missingRecoveryBytes: HardenMigrationResult = { ...common, outcome: 'recovered', exportPath: '/export', journalBytes: null, backupContainerName: null };
// @ts-expect-error hardened migration retains its backup
const missingBackup: HardenMigrationResult = { ...common, outcome: 'hardened', exportPath: '/export', journalBytes: 1024, backupContainerName: null };
// @ts-expect-error retained export path and bytes must be correlated
const mixedAlready: HardenMigrationResult = { ...common, outcome: 'already-hardened', exportPath: '/export', journalBytes: null, backupContainerName: null };
// @ts-expect-error backup presence requires a retained export
const backupWithoutExport: HardenMigrationResult = { ...common, outcome: 'already-hardened', exportPath: null, journalBytes: null, backupContainerName: 'backup' };
const wrongSteps = { ...common, outcome: 'recovered' as const, exportPath: '/export', journalBytes: 1024, backupContainerName: null, steps: [] };
// @ts-expect-error only a preview may carry steps, including structural assignments
const completedWithSteps: HardenMigrationResult = wrongSteps;
function consume(result: HardenMigrationResult) {
  if (result.outcome === 'dry-run') { const steps: unknown[] = result.steps; return steps; }
  if (result.outcome === 'hardened' || result.outcome === 'recovered') {
    const path: string = result.exportPath, bytes: number = result.journalBytes; return [path, bytes];
  }
  if (result.exportPath === null) { const bytes: null = result.journalBytes, backup: null = result.backupContainerName; return [bytes, backup]; }
  const bytes: number = result.journalBytes; return bytes;
}
void [preview, completed, recovered, already, missingSteps, missingExport, missingRecoveryBytes, missingBackup,
  mixedAlready, backupWithoutExport, completedWithSteps, consume];
