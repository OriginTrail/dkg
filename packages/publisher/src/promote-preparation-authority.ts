import type { PromoteExecutionAuthority } from './assertion-promote-types.js';

/** Called inside a lifecycle fence, immediately before a preparation mutation. */
export async function guardPromotePreparation<T>(authority: PromoteExecutionAuthority | undefined,
  work: () => Promise<T>): Promise<T> {
  await authority?.assertCurrent();
  return work();
}
