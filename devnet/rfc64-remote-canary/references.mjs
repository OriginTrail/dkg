// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

/** @param {string} namespace @param {unknown} value @returns {string} */
export function opaqueRef(namespace, value) {
  return `${namespace}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}
