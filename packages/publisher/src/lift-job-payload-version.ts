import type { LiftJob } from './lift-job.js';

/** Version written by every current lift-job payload serializer. */
export const LIFT_JOB_PAYLOAD_SCHEMA_VERSION = 1 as const;

/** Durable current payload. The schema marker belongs to persistence, not the runtime state model. */
export type CurrentLiftJobPayload = LiftJob & {
  readonly schemaVersion: typeof LIFT_JOB_PAYLOAD_SCHEMA_VERSION;
};

/** Stamp the current durable envelope without leaking persistence metadata into runtime jobs. */
export function encodeCurrentLiftJobPayload(job: LiftJob): string {
  return JSON.stringify({
    ...job,
    schemaVersion: LIFT_JOB_PAYLOAD_SCHEMA_VERSION,
  } satisfies CurrentLiftJobPayload);
}

/** Offline/test migration helper for faithfully restoring an already-persisted v0 row. */
export function encodeLegacyV0LiftJobPayload(job: LiftJob): string {
  return JSON.stringify(job);
}
