// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphMetaProjection } from '../../src/context-graph-meta-projection.js';

/** One projection dependency for stable fixtures and scenario-owned revision races. */
export function createContextGraphProjectionFenceFixture(
  readCurrentRevision: () => number = () => 0,
): Pick<ContextGraphMetaProjection, 'readAuthorityFactsRevision' | 'captureContextGraphAuthorityFactsFence'> {
  return Object.freeze({
    get readAuthorityFactsRevision() { return readCurrentRevision(); },
    captureContextGraphAuthorityFactsFence() {
      const revision = readCurrentRevision();
      return Object.freeze({ assertCurrent: () => readCurrentRevision() === revision });
    },
  });
}
