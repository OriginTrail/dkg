// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Write stable JSON through an exclusive same-directory temporary and atomic rename. */
export async function writeRfc64ArtifactAtomicV1(artifactPath, artifact) {
  const artifactDirectory = dirname(artifactPath);
  await mkdir(artifactDirectory, { recursive: true });
  const temporaryPath = join(
    artifactDirectory,
    `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${stableJsonV1(artifact)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await rename(temporaryPath, artifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function stableJsonV1(value) {
  return JSON.stringify(sortKeysV1(value), null, 2);
}

function sortKeysV1(value) {
  if (Array.isArray(value)) return value.map(sortKeysV1);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysV1(value[key])]),
    );
  }
  return value;
}
