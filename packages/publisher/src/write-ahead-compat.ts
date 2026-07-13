// SPDX-License-Identifier: Apache-2.0

import type { PhaseCallbackContext } from './publisher.js';

const WRITE_AHEAD_COMPATIBILITY_BREADCRUMB = Symbol.for(
  '@origintrail-official/dkg-publisher/write-ahead-compatibility-breadcrumb',
);

/** Internal marker for the legacy phase emitted immediately before typed WAL. */
export function markWriteAheadCompatibilityBreadcrumb(
  context: PhaseCallbackContext,
): PhaseCallbackContext {
  Object.defineProperty(context, WRITE_AHEAD_COMPATIBILITY_BREADCRUMB, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return context;
}

/** Keep legacy-only executors durable while suppressing our own breadcrumb. */
export function isWriteAheadCompatibilityBreadcrumb(
  context?: PhaseCallbackContext,
): boolean {
  return context !== undefined
    && Reflect.get(context, WRITE_AHEAD_COMPATIBILITY_BREADCRUMB) === true;
}
