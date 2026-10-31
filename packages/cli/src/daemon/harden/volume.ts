// SPDX-License-Identifier: Apache-2.0
import { classifyBlazegraphContainerInspection, classifyBlazegraphVolumeInspection } from '../blazegraph-container-inspection.js';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_CONTAINER_PORT } from '../blazegraph-docker.js';
import type { HardenWorkflowInputs } from './actions.js';

export const HARDEN_VOLUME_ATTEMPT_LABEL = 'org.origintrail.dkg.harden-attempt';
export const HARDEN_VOLUME_ATTEMPT_PLACEHOLDER = '<new-migration-attempt>';

/** An old replacement can have acknowledged writes even after its container disappears. */
export async function requireMissingReplacementVolume(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  const volume = args.at(-1)!;
  const inspected = classifyBlazegraphVolumeInspection(await ctx.docker.run(args), volume);
  if (inspected.kind === 'missing') return;
  throw new Error(`Refusing to reseed an existing or unproven replacement journal volume "${volume}". `
    + `Its journal may be authoritative; preserve it and the backup for manual recovery. `
    + (inspected.kind === 'failed' ? `Cannot verify volume absence: ${inspected.detail}` : ''));
}

/** Idempotent Docker create cannot prove freshness; certify the actual unique attempt label. */
export async function certifyReplacementVolume(ctx: HardenWorkflowInputs, args: readonly string[]): Promise<void> {
  const volume = args.at(-1)!;
  const inspected = classifyBlazegraphVolumeInspection(await ctx.docker.run(args), volume);
  if (!ctx.specification.volumeAttemptId || ctx.specification.volumeAttemptId === HARDEN_VOLUME_ATTEMPT_PLACEHOLDER
    || inspected.kind !== 'found' || inspected.labels[HARDEN_VOLUME_ATTEMPT_LABEL] !== ctx.specification.volumeAttemptId) {
    throw new Error(`Refusing to reseed an unproven replacement journal volume "${volume}". `
      + 'The created volume does not belong to this fresh migration attempt; preserve both journals for manual recovery.');
  }
}

/** An orphan certificate belongs to the mounted replacement, not a different healthy store. */
export async function verifyInterruptedReplacementVolume(ctx: HardenWorkflowInputs, volumeAttemptId: string): Promise<void> {
  const spec = ctx.specification;
  const actual = classifyBlazegraphContainerInspection(await ctx.docker.run(['inspect', spec.containerName]), spec.containerName,
    { containerName: spec.containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT,
      journalVolumeNames: [spec.volumeName], journalMountType: 'volume-or-unspecified' });
  if (actual.kind !== 'found' || actual.facts.journalVolumeName !== spec.volumeName)
    throw new Error('Interrupted replacement no longer mounts the certified migration volume; startup remains blocked.');
  await certifyReplacementVolume({ ...ctx, specification: { ...spec, volumeAttemptId } }, ['volume', 'inspect', spec.volumeName]);
}
