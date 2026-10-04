import { stat, statfs } from 'node:fs/promises';
import { BLAZEGRAPH_JOURNAL_FILE, waitForBlazegraphReady, type DockerRunner } from '../blazegraph-docker.js';
import { askOk, identityTagPresent } from './verify.js';
import { parseInspect, type HardenStateInfo } from './state.js';
import { HARDEN_DISK_PREFLIGHT_FACTOR, type HardenStep, type HardenStepDefsInput } from './steps.js';
import type { ExecuteHardenMigrationOptions } from './executor.js';

export interface HardenWorkflowInputs extends Readonly<HardenStepDefsInput> {
  readonly opts: ExecuteHardenMigrationOptions;
  readonly docker: DockerRunner;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly info: HardenStateInfo;
  readonly sourceName: string;
  readonly backupName: string;
  readonly exportPath: string;
  readonly baseUrl: string;
  readonly sparqlUrl: string;
  readonly stoppedHint: string;
  readonly log: (message: string) => void;
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
async function mustRun(docker: DockerRunner, args: string[], what: string,
  opts?: { timeoutMs?: number; hint?: string }): Promise<string> {
  const result = await docker.run(args, opts?.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${what} failed — docker ${args[0]} exited ${result.exitCode}. `
    + `stderr: ${result.stderr.trim() || '(empty)'}` + (opts?.hint ? ` ${opts.hint}` : ''));
  return result.stdout;
}
function command(step: HardenStep): string[] {
  if (step.dockerArgs === undefined) throw new Error(`Migration phase ${step.id} has no Docker command`);
  return step.dockerArgs;
}
async function stoppedSnapshot(ctx: HardenWorkflowInputs, step: HardenStep, what: string): Promise<StoppedContainerSnapshot> {
  const out = await mustRun(ctx.docker, command(step), what, { hint: ctx.stoppedHint });
  const info = parseInspect(out);
  if (info === null) throw new Error(`${what} returned unparseable docker inspect output. ${ctx.stoppedHint}`);
  return Object.freeze({ running: info.State?.Running === true, startedAt: info.State?.StartedAt,
    finishedAt: info.State?.FinishedAt, sizeRw: typeof info.SizeRw === 'number' ? info.SizeRw : undefined });
}
export async function readJournalSize(ctx: HardenWorkflowInputs, step: HardenStep): Promise<number | null> {
  if (!ctx.info.running) {
    ctx.log('WARNING: container is stopped — in-container journal size unknown; export validation falls back to size > 0.');
    return null;
  }
  const out = await mustRun(ctx.docker, command(step), 'reading in-container journal size');
  const preSize = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(preSize) || preSize <= 0) throw new Error(
    `Unexpected journal size "${out.trim()}" from ${ctx.sourceName}:${BLAZEGRAPH_JOURNAL_FILE} — refusing to migrate.`);
  ctx.log(`Journal size in container: ${preSize} bytes.`);
  return preSize;
}
export async function checkFreeDisk(ctx: HardenWorkflowInputs, preSize: number | null): Promise<void> {
  if (preSize === null) return;
  const free = await (ctx.opts.freeDiskBytes ?? defaultFreeDiskBytes)(ctx.migrationDir);
  const needed = Math.ceil(preSize * HARDEN_DISK_PREFLIGHT_FACTOR);
  if (free < needed) throw new Error(`Not enough free disk at ${ctx.migrationDir}: need ~${needed} bytes `
    + `(${HARDEN_DISK_PREFLIGHT_FACTOR}x journal — the export copy plus the docker-volume seed copy typically share the root filesystem), `
    + `have ${free}. Pass --migration-dir <dir> on a larger mount.`);
}
export async function stopSource(ctx: HardenWorkflowInputs, step: HardenStep, integrity: HardenStep): Promise<StoppedContainerSnapshot> {
  ctx.log(`Stopping ${ctx.sourceName} (up to 120s for a clean RWStore flush)…`);
  await mustRun(ctx.docker, command(step), 'stopping the legacy container', { timeoutMs: 180_000 });
  const snapshot = await stoppedSnapshot(ctx, integrity, 'inspecting the stopped legacy container');
  if (snapshot.running) throw new Error(`Container "${ctx.sourceName}" reports Running=true immediately after docker stop — `
    + 'something restarted it (the daemon\'s store monitor? systemd? another operator?). Stop the daemon (dkg stop) '
    + 'or find the interfering process, then re-run harden. Nothing was migrated; the legacy container remains authoritative.');
  return snapshot;
}
export async function exportJournal(ctx: HardenWorkflowInputs, step: HardenStep): Promise<void> {
  ctx.log(`Exporting current journal from ${ctx.sourceName} to ${ctx.exportPath}…`);
  await mustRun(ctx.docker, command(step), 'exporting the journal (docker cp)', { hint: ctx.stoppedHint });
}
export async function verifyExport(ctx: HardenWorkflowInputs, baseline: StoppedContainerSnapshot,
  preSize: number | null, integrity: HardenStep): Promise<VerifiedJournalExport> {
  const after = await stoppedSnapshot(ctx, integrity, 're-inspecting the legacy container after the export');
  if (after.running || after.startedAt !== baseline.startedAt || after.finishedAt !== baseline.finishedAt) {
    throw new Error(`Journal export integrity check failed: container "${ctx.sourceName}" ran during the export `
      + `(Running=${after.running}, StartedAt ${baseline.startedAt ?? '<unknown>'} → ${after.startedAt ?? '<unknown>'}). `
      + 'Something restarted it mid-copy — most likely the daemon\'s runtime store monitor, systemd, or another operator. '
      + 'The exported copy may be torn and will NOT be used; no rename happened and the legacy container remains authoritative. '
      + (after.running ? 'The legacy container is currently RUNNING again — service is up; re-run harden once the interference is resolved.' : ctx.stoppedHint));
  }
  if (baseline.sizeRw !== undefined && after.sizeRw !== undefined) {
    if (after.sizeRw !== baseline.sizeRw) throw new Error(
      `Journal export integrity check failed: the container's writable layer changed during the export `
      + `(SizeRw ${baseline.sizeRw} → ${after.sizeRw} bytes) — the journal was written while docker cp read it. `
      + `The exported copy may be torn and will NOT be used; no rename happened. ${ctx.stoppedHint}`);
  } else ctx.log('WARNING: docker inspect --size returned no SizeRw — skipping the byte-level export integrity check (the Running/StartedAt checks above still passed).');
  const measured = await fileSize(ctx.exportPath);
  if (measured === null || measured <= 0 || (preSize !== null && measured < preSize)) throw new Error(
    `Journal export validation failed: exported ${measured ?? 'nothing'} bytes, expected ${preSize ?? '> 0'}. `
    + `Legacy container "${ctx.sourceName}" is untouched; re-run to retry. ${ctx.stoppedHint}`);
  ctx.log(`Export verified: ${measured} bytes.`);
  return Object.freeze({ path: ctx.exportPath, bytes: measured });
}
export async function createVolume(ctx: HardenWorkflowInputs, step: HardenStep): Promise<void> {
  await mustRun(ctx.docker, command(step), 'creating the journal volume', { hint: ctx.stoppedHint });
}
export async function seedVolume(ctx: HardenWorkflowInputs, step: HardenStep, exported: VerifiedJournalExport): Promise<void> {
  ctx.log(`Seeding replacement journal volume from the current export…`);
  const out = await mustRun(ctx.docker, command(step), 'seeding the journal volume', { hint: ctx.stoppedHint });
  if (Number.parseInt(out.trim(), 10) !== exported.bytes) throw new Error(
    `Volume seed validation failed: volume journal is ${out.trim()} bytes, export is ${exported.bytes}. `
    + `Legacy container "${ctx.sourceName}" is untouched; re-run to retry. ${ctx.stoppedHint}`);
}
export async function renameBackup(ctx: HardenWorkflowInputs, step: HardenStep): Promise<void> {
  ctx.log(`Renaming ${ctx.containerName} → ${ctx.backupName} (kept until you remove it).`);
  await mustRun(ctx.docker, command(step), 'renaming the legacy container', { hint: ctx.stoppedHint });
}
export async function disableBackupRestart(ctx: HardenWorkflowInputs, step: HardenStep): Promise<void> {
  await mustRun(ctx.docker, command(step), 'disabling the backup restart policy');
}
export async function runHardened(ctx: HardenWorkflowInputs, step: HardenStep): Promise<void> {
  ctx.log(`Creating hardened container ${ctx.containerName} (heap ${ctx.heapMb} MB)…`);
  await mustRun(ctx.docker, command(step), 'creating the hardened container');
}
export async function verifyExisting(ctx: HardenWorkflowInputs): Promise<void> {
  ctx.log(`Container "${ctx.containerName}" already has the journal volume mounted — verifying.`);
  if (!await askOk(ctx.fetchImpl, ctx.sparqlUrl, ctx.opts.probeTimeoutMs)) throw new Error(
    `Hardened container "${ctx.containerName}" exists but ASK probe failed at ${ctx.sparqlUrl}. `
    + `Check \`docker ps\` / \`docker logs ${ctx.containerName}\`.`);
  ctx.log(`ASK probe OK at ${ctx.sparqlUrl} — nothing to do.`);
}
export async function verifyReplacement(ctx: HardenWorkflowInputs, step: HardenStep, exported: VerifiedJournalExport): Promise<void> {
  await waitForBlazegraphReady({ url: ctx.baseUrl, fetch: ctx.fetchImpl, log: ctx.log,
    intervalMs: ctx.opts.readyIntervalMs ?? 2_000, timeoutMs: ctx.opts.readyTimeoutMs ?? 180_000,
    probeTimeoutMs: ctx.opts.probeTimeoutMs });
  if (!await askOk(ctx.fetchImpl, ctx.sparqlUrl, ctx.opts.probeTimeoutMs)) throw new Error(`ASK probe failed at ${ctx.sparqlUrl}`);
  if (!await identityTagPresent(ctx.fetchImpl, ctx.sparqlUrl, ctx.opts.probeTimeoutMs)) throw new Error(
    `identity-tag probe returned no binding at ${ctx.sparqlUrl} — the migrated data did not follow`);
  const out = await mustRun(ctx.docker, command(step), 'reading the migrated journal size');
  const size = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(size) || size < exported.bytes) throw new Error(
    `migrated journal is ${out.trim()} bytes, expected >= ${exported.bytes}`);
}
