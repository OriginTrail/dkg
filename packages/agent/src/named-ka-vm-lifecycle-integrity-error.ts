// SPDX-License-Identifier: Apache-2.0
/** Permanent evidence failure: retained for diagnosis and never retried as a transient outage. */
export class NamedKaVmLifecycleIntegrityError extends Error {
  readonly code = 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY';
  constructor(message: string) {
    super(message);
    this.name = 'NamedKaVmLifecycleIntegrityError';
  }
}
export function isNamedKaVmLifecycleIntegrityError(error: unknown): error is NamedKaVmLifecycleIntegrityError {
  return error instanceof NamedKaVmLifecycleIntegrityError;
}
