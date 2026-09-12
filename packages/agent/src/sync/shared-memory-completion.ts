/** One coherent internal outcome for bounded shared-memory work. */
export type SharedMemoryWorkOutcome =
  | 'completed'
  | 'timed-out'
  | 'local-budget-yield'
  | 'incomplete';

/** Compatibility fields exposed by existing page/result boundaries. */
export type SharedMemoryCompletionFields =
  | { readonly completed: true; readonly timedOut: false; readonly localYield?: never }
  | { readonly completed: false; readonly timedOut: true; readonly localYield?: never }
  | { readonly completed: false; readonly timedOut: false; readonly localYield: true }
  | { readonly completed: false; readonly timedOut: false; readonly localYield?: never };

/** Derive the internal outcome once from compatibility-facing result fields. */
export function sharedMemoryWorkOutcome(
  fields: SharedMemoryCompletionFields,
): SharedMemoryWorkOutcome {
  if (fields.completed) return 'completed';
  if (fields.localYield === true) return 'local-budget-yield';
  if (fields.timedOut) return 'timed-out';
  return 'incomplete';
}

/** Adapt an internal outcome to the existing public result fields at the edge. */
export function sharedMemoryCompletionFields(
  outcome: SharedMemoryWorkOutcome,
): SharedMemoryCompletionFields {
  switch (outcome) {
    case 'completed':
      return { completed: true, timedOut: false };
    case 'timed-out':
      return { completed: false, timedOut: true };
    case 'local-budget-yield':
      return { completed: false, timedOut: false, localYield: true };
    case 'incomplete':
      return { completed: false, timedOut: false };
  }
}

/** Aggregate evidence is a boolean, independent of any single work outcome. */
export function mergeLocalBudgetYieldEvidence(
  a: true | undefined,
  b: true | undefined,
): true | undefined {
  return a === true || b === true ? true : undefined;
}
