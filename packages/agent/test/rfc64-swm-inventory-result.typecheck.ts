import type { Rfc64SwmAuthorInventoryShadowMutationResultV1 } from '../dist/rfc64/swm-inventory-shadow-runtime-v1.js';

type Result = Rfc64SwmAuthorInventoryShadowMutationResultV1;
const metadata = { attempts: 0, headObjectDigest: null, error: 'read refused' } as const;
const preparationFailure: Result = {
  ...metadata, status: 'failed', action: 'upsert', failurePhase: 'preparation-read',
};
const ordinaryFailure: Result = { ...metadata, status: 'failed', action: 'upsert' };
const successfulRemoval: Result = { ...metadata, status: 'applied', action: 'remove', error: null };

// @ts-expect-error Successful upserts cannot carry preparation-read retry authority.
const appliedRetry: Result = { ...preparationFailure, status: 'applied' };
// @ts-expect-error Existing rows cannot carry preparation-read retry authority.
const existingRetry: Result = { ...preparationFailure, status: 'existing' };
// @ts-expect-error Failed removals cannot carry preparation-read retry authority.
const removalRetry: Result = { ...preparationFailure, action: 'remove' };
// @ts-expect-error A successful removal cannot carry preparation-read retry authority.
const successfulRemovalRetry: Result = { ...preparationFailure, status: 'applied', action: 'remove' };
// @ts-expect-error Retry authority is a closed preparation-read variant, not an arbitrary phase.
const writeFailureRetry: Result = { ...preparationFailure, failurePhase: 'inventory-write' };
// @ts-expect-error The old uncorrelated boolean is no longer a supported marker.
const oldMarker: Result = { ...ordinaryFailure, retryablePreparationRead: true };

function requirePreparationFailure(result: Result): void {
  if (result.failurePhase === 'preparation-read') {
    const status: 'failed' = result.status;
    const action: 'upsert' = result.action;
    void [status, action];
  }
}
void [preparationFailure, ordinaryFailure, successfulRemoval, appliedRetry, existingRetry,
  removalRetry, successfulRemovalRetry, writeFailureRetry, oldMarker, requirePreparationFailure];