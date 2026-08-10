import { isBoundedMutationBudgetError } from './primitives.js';

export const STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE =
  'STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL';

const TRUSTED_STRUCTURED_MUTATION_REFUSALS = new WeakSet<object>();

export function isStructuredMutationPreDispatchRefusal(
  error: unknown,
): boolean {
  return isBoundedMutationBudgetError(error)
    || (typeof error === 'object'
      && error !== null
      && TRUSTED_STRUCTURED_MUTATION_REFUSALS.has(error));
}

/** Reconstruct the private refusal identity after a trusted worker reports it. */
export function reconstructStructuredMutationPreDispatchRefusal(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {
    value: STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE,
    enumerable: true,
  });
  TRUSTED_STRUCTURED_MUTATION_REFUSALS.add(error);
  return error;
}

export function structuredMutationPreDispatchRefusalCode(
  error: unknown,
): typeof STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE | undefined {
  return isStructuredMutationPreDispatchRefusal(error)
    ? STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE
    : undefined;
}
