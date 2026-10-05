// SPDX-License-Identifier: Apache-2.0
import { classifyBlazegraphVolumeInspection } from '../blazegraph-container-inspection.js';
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
  if (!ctx.volumeAttemptId || ctx.volumeAttemptId === HARDEN_VOLUME_ATTEMPT_PLACEHOLDER
    || inspected.kind !== 'found' || inspected.labels[HARDEN_VOLUME_ATTEMPT_LABEL] !== ctx.volumeAttemptId) {
    throw new Error(`Refusing to reseed an unproven replacement journal volume "${volume}". `
      + 'The created volume does not belong to this fresh migration attempt; preserve both journals for manual recovery.');
  }
}
