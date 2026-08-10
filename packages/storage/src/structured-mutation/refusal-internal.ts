import { isBoundedMutationBudgetError } from './primitives.js';

export const STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE =
  'STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL';

export function isStructuredMutationPreDispatchRefusal(
  error: unknown,
): boolean {
  return isBoundedMutationBudgetError(error)
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE);
}

export function structuredMutationPreDispatchRefusalCode(
  error: unknown,
): typeof STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE | undefined {
  return isStructuredMutationPreDispatchRefusal(error)
    ? STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL_CODE
    : undefined;
}
