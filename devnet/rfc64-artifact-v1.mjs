// SPDX-License-Identifier: Apache-2.0

import {
  stableJsonStringify,
  writeStableJsonArtifact,
} from './rfc64-artifact-publication-v1.mjs';

/** Write stable JSON through an exclusive same-directory temporary and atomic rename. */
/** @param {string} artifactPath @param {unknown} artifact */
export async function writeRfc64ArtifactAtomicV1(artifactPath, artifact) {
  return writeStableJsonArtifact(artifactPath, artifact);
}

/** @param {unknown} value @returns {string} */
export function stableJsonV1(value) {
  return stableJsonStringify(value).slice(0, -1);
}
