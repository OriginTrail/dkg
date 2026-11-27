// SPDX-License-Identifier: Apache-2.0

import type { ReadGraphRegistrySnapshot } from './membership.js';
import type { ReadGraphBackendRuntime } from './runtime.js';

/**
 * What each backend's stored registry records hold, as this process last read
 * or wrote them (`./registry-record.ts`). Kept apart so the layer can forget
 * them without importing the record's statements.
 */
export const RECORDED_REGISTRIES = new WeakMap<ReadGraphBackendRuntime, Map<string, ReadGraphRegistrySnapshot>>();
