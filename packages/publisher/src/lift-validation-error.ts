/** Closed diagnostics only: causes may contain private RDF, URLs or response bodies. */
export const LIFT_VALIDATION_STAGES = [
  'initial_preflight', 'workspace_read', 'content_validation', 'payload_preparation', 'final_preflight',
] as const;
export const LIFT_VALIDATION_CAUSES = [
  'store_read_transport', 'rpc_transport', 'store_not_started', 'content', 'precondition', 'unknown',
] as const;
export interface LiftValidationDiagnostic {
  readonly stage?: (typeof LIFT_VALIDATION_STAGES)[number];
  readonly cause: (typeof LIFT_VALIDATION_CAUSES)[number];
}

/** Raised only by explicit deterministic payload guards, never by a catch-all. */
export class LiftPayloadValidationError extends Error {}

/** The worker owns this boundary; arbitrary third-party cause chains are not proof. */
export class LiftValidationStageError extends Error {
  constructor(readonly stage: NonNullable<LiftValidationDiagnostic['stage']>, cause: unknown) {
    super(`Publication validation failed at ${stage}`, { cause });
  }
}

export async function atLiftValidationStage<T>(
  stage: NonNullable<LiftValidationDiagnostic['stage']>, operation: () => T | Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (cause) { throw new LiftValidationStageError(stage, cause); }
}
