import { stat, statfs } from 'node:fs/promises';
import { BLAZEGRAPH_JOURNAL_FILE, waitForBlazegraphReady, type DockerRunner } from '../blazegraph-docker.js';
import { askOk, identityTagPresent } from './verify.js';
import { classifyBlazegraphContainerInspection } from '../blazegraph-container-inspection.js';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_CONTAINER_PORT } from '../blazegraph-docker.js';
import { HARDEN_DISK_PREFLIGHT_FACTOR, type HardenMigrationSpecification } from './steps.js';

/** Execution services have no migration targets; phases capture the specification. */
export interface HardenExecutionDependencies {
  readonly docker: DockerRunner;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly log: (message: string) => void;
  readonly freeDiskBytes?: (dir: string) => Promise<number>;
  readonly probeTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly readyIntervalMs?: number;
}
export interface HardenWorkflowInputs extends HardenExecutionDependencies {
  readonly specification: HardenMigrationSpecification & { readonly dkgHome: string };
}
export interface StoppedContainerSnapshot {
  readonly running: boolean; readonly startedAt?: string; readonly finishedAt?: string; readonly sizeRw?: number;
}
export interface VerifiedJournalExport {
  readonly path: string;
  readonly bytes: number;
}
export async function fileSize(path: string): Promise<number | null> {
  try { const info = await stat(path); return info.isFile() ? info.size : null; } catch { return null; }
}
async function defaultFreeDiskBytes(dir: string): Promise<number> {
  const info = await statfs(dir); return info.bsize * info.bavail;
}
async function mustRun(docker: DockerRunner, args: readonly string[], what: string,
  opts?: { timeoutMs?: number; hint?: string }): Promise<string> {
  const result = await docker.run(args, opts?.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${what} failed — docker ${args[0]} exited ${result.exitCode}. `
    + `stderr: ${result.stderr.trim() || '(empty)'}` + (opts?.hint ? ` ${opts.hint}` : ''));
  return result.stdout;
}
async function stoppedSnapshot(ctx: HardenWorkflowInputs, args: readonly string[], what: string): Promise<StoppedContainerSnapshot> {
  const result = await ctx.docker.run(args);
  const outcome = classifyBlazegraphContainerInspection(result, ctx.specification.sourceName,
    { containerName: ctx.specification.containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT });
  if (outcome.kind === 'failed' && outcome.reason === 'output') throw new Error(`${what} returned unparseable docker inspect output. ${ctx.specification.stoppedHint}`);
  if (outcome.kind !== 'found') throw new Error(`${what} failed — docker inspect exited ${result.exitCode}. `
    + `stderr: ${result.stderr.trim() || '(empty)'} ${ctx.specification.stoppedHint}`);
  const info = outcome.facts;
  return Object.freeze({ running: info.running, startedAt: info.startedAt,
    finishedAt: info.finishedAt, sizeRw: info.writableLayerSize });
}
export async function readJournalSize(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<number | null> {
  if (!ctx.specification.running) {
    ctx.log('WARNING: container is stopped — in-container journal size unknown; export validation falls back to size > 0.');
    return null;
  }
  const out = await mustRun(ctx.docker, args, 'reading in-container journal size');
  const preSize = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(preSize) || preSize <= 0) throw new Error(
    `Unexpected journal size "${out.trim()}" from ${ctx.specification.sourceName}:${BLAZEGRAPH_JOURNAL_FILE} — refusing to migrate.`);
  ctx.log(`Journal size in container: ${preSize} bytes.`);
  return preSize;
}
export async function checkFreeDisk(ctx: HardenWorkflowInputs, preSize: number | null): Promise<void> {
  if (preSize === null) return;
  const free = await (ctx.freeDiskBytes ?? defaultFreeDiskBytes)(ctx.specification.migrationDir);
  const needed = Math.ceil(preSize * HARDEN_DISK_PREFLIGHT_FACTOR);
  if (free < needed) throw new Error(`Not enough free disk at ${ctx.specification.migrationDir}: need ~${needed} bytes `
    + `(${HARDEN_DISK_PREFLIGHT_FACTOR}x journal — the export copy plus the docker-volume seed copy typically share the root filesystem), `
    + `have ${free}. Pass --migration-dir <dir> on a larger mount.`);
}
export async function stopSource(ctx: HardenWorkflowInputs, args: readonly string[], integrity: readonly string[]): Promise<StoppedContainerSnapshot> {
  ctx.log(`Stopping ${ctx.specification.sourceName} (up to 120s for a clean RWStore flush)…`);
  await mustRun(ctx.docker, args, 'stopping the legacy container', { timeoutMs: 180_000 });
  const snapshot = await stoppedSnapshot(ctx, integrity, 'inspecting the stopped legacy container');
  if (snapshot.running) throw new Error(`Container "${ctx.specification.sourceName}" reports Running=true immediately after docker stop — `
    + 'something restarted it (the daemon\'s store monitor? systemd? another operator?). Stop the daemon (dkg stop) '
    + 'or find the interfering process, then re-run harden. Nothing was migrated; the legacy container remains authoritative.');
  return snapshot;
}
export async function exportJournal(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  ctx.log(`Exporting current journal from ${ctx.specification.sourceName} to ${ctx.specification.exportPath}…`);
  await mustRun(ctx.docker, args, 'exporting the journal (docker cp)', { hint: ctx.specification.stoppedHint });
}
export async function verifyExport(ctx: HardenWorkflowInputs, baseline: StoppedContainerSnapshot,
  preSize: number | null, integrity: readonly string[]): Promise<VerifiedJournalExport> {
  const after = await stoppedSnapshot(ctx, integrity, 're-inspecting the legacy container after the export');
  if (after.running || after.startedAt !== baseline.startedAt || after.finishedAt !== baseline.finishedAt) {
    throw new Error(`Journal export integrity check failed: container "${ctx.specification.sourceName}" ran during the export `
      + `(Running=${after.running}, StartedAt ${baseline.startedAt ?? '<unknown>'} → ${after.startedAt ?? '<unknown>'}). `
      + 'Something restarted it mid-copy — most likely the daemon\'s runtime store monitor, systemd, or another operator. '
      + 'The exported copy may be torn and will NOT be used; no rename happened and the legacy container remains authoritative. '
      + (after.running ? 'The legacy container is currently RUNNING again — service is up; re-run harden once the interference is resolved.' : ctx.specification.stoppedHint));
  }
  if (baseline.sizeRw !== undefined && after.sizeRw !== undefined) {
    if (after.sizeRw !== baseline.sizeRw) throw new Error(
      `Journal export integrity check failed: the container's writable layer changed during the export `
      + `(SizeRw ${baseline.sizeRw} → ${after.sizeRw} bytes) — the journal was written while docker cp read it. `
      + `The exported copy may be torn and will NOT be used; no rename happened. ${ctx.specification.stoppedHint}`);
  } else ctx.log('WARNING: docker inspect --size returned no SizeRw — skipping the byte-level export integrity check (the Running/StartedAt checks above still passed).');
  const measured = await fileSize(ctx.specification.exportPath);
  if (measured === null || measured <= 0 || (preSize !== null && measured < preSize)) throw new Error(
    `Journal export validation failed: exported ${measured ?? 'nothing'} bytes, expected ${preSize ?? '> 0'}. `
    + `Legacy container "${ctx.specification.sourceName}" is untouched; re-run to retry. ${ctx.specification.stoppedHint}`);
  ctx.log(`Export verified: ${measured} bytes.`);
  return Object.freeze({ path: ctx.specification.exportPath, bytes: measured });
}
export async function createVolume(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  await mustRun(ctx.docker, args, 'creating the journal volume', { hint: ctx.specification.stoppedHint });
}
export async function seedVolume(ctx: HardenWorkflowInputs, args: readonly string[], exported: VerifiedJournalExport): Promise<void> {
  ctx.log(`Seeding replacement journal volume from the current export…`);
  const out = await mustRun(ctx.docker, args, 'seeding the journal volume', { hint: ctx.specification.stoppedHint });
  if (Number.parseInt(out.trim(), 10) !== exported.bytes) throw new Error(
    `Volume seed validation failed: volume journal is ${out.trim()} bytes, export is ${exported.bytes}. `
    + `Legacy container "${ctx.specification.sourceName}" is untouched; re-run to retry. ${ctx.specification.stoppedHint}`);
}
export async function renameBackup(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  ctx.log(`Renaming ${ctx.specification.containerName} → ${ctx.specification.backupName} (kept until you remove it).`);
  await mustRun(ctx.docker, args, 'renaming the legacy container', { hint: ctx.specification.stoppedHint });
}
export async function disableBackupRestart(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  await mustRun(ctx.docker, args, 'disabling the backup restart policy');
}
export async function runHardened(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  ctx.log(`Creating hardened container ${ctx.specification.containerName} (heap ${ctx.specification.heapMb} MB)…`);
  await mustRun(ctx.docker, args, 'creating the hardened container');
}
export async function verifyExisting(ctx: HardenWorkflowInputs): Promise<void> {
  ctx.log(`Container "${ctx.specification.containerName}" already has the journal volume mounted — verifying.`);
  if (!await askOk(ctx.fetchImpl, ctx.specification.sparqlUrl, ctx.probeTimeoutMs)) throw new Error(
    `Hardened container "${ctx.specification.containerName}" exists but ASK probe failed at ${ctx.specification.sparqlUrl}. `
    + `Check \`docker ps\` / \`docker logs ${ctx.specification.containerName}\`.`);
  ctx.log(`ASK probe OK at ${ctx.specification.sparqlUrl} — nothing to do.`);
}
export async function verifyReplacement(ctx: HardenWorkflowInputs, args: readonly string[], exported: VerifiedJournalExport): Promise<void> {
  await waitForBlazegraphReady({ url: ctx.specification.baseUrl, fetch: ctx.fetchImpl, log: ctx.log,
    intervalMs: ctx.readyIntervalMs ?? 2_000, timeoutMs: ctx.readyTimeoutMs ?? 180_000,
    probeTimeoutMs: ctx.probeTimeoutMs });
  if (!await askOk(ctx.fetchImpl, ctx.specification.sparqlUrl, ctx.probeTimeoutMs)) throw new Error(`ASK probe failed at ${ctx.specification.sparqlUrl}`);
  if (!await identityTagPresent(ctx.fetchImpl, ctx.specification.sparqlUrl, ctx.probeTimeoutMs)) throw new Error(
    `identity-tag probe returned no binding at ${ctx.specification.sparqlUrl} — the migrated data did not follow`);
  const out = await mustRun(ctx.docker, args, 'reading the migrated journal size');
  const size = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(size) || size < exported.bytes) throw new Error(
    `migrated journal is ${out.trim()} bytes, expected >= ${exported.bytes}`);
}

/** Retry of a hardened shape still proves retained migration copies, when present. */
export async function verifyAlreadyHardened(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<{
  readonly backupExists: boolean; readonly exported: VerifiedJournalExport | null;
}> {
  const backup = classifyBlazegraphContainerInspection(await ctx.docker.run(['inspect', ctx.specification.backupName]), ctx.specification.backupName,
    { containerName: ctx.specification.containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT });
  if (backup.kind === 'failed') throw new Error(
    `Cannot determine whether migration backup "${ctx.specification.backupName}" remains: ${backup.detail}. `
    + 'Refusing ASK-only verification while migration state is unknown.');
  const backupExists = backup.kind === 'found';
  const savedSize = await fileSize(ctx.specification.exportPath);
  const exported = savedSize === null ? null : Object.freeze({ path: ctx.specification.exportPath, bytes: savedSize });
  if (backupExists || exported !== null) {
    if (exported === null || exported.bytes <= 0) throw new Error(
      `Migration replacement "${ctx.specification.containerName}" has no valid retained export for journal verification. `
      + `Keep backup "${ctx.specification.backupName}" and restore or locate the export before retrying.`);
    // Docker's hardened shape is reached before first-run verification.
    // Retained migration copies require the same identity/size proof on retry.
    await verifyReplacement(ctx, args, exported);
  } else await verifyExisting(ctx);
  return Object.freeze({ backupExists, exported });
}
