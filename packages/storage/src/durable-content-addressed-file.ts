// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Sync verified immutable bytes and any newly created directory entries before their RDF reference is acknowledged. */
export async function persistContentAddressedFile(
  path: string, createdDirectory?: string, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const absolutePath = resolve(path);
  const file = await open(absolutePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  // Windows exposes file FlushFileBuffers but cannot open directories this way.
  if (platform === 'win32') return;
  const last = createdDirectory === undefined ? dirname(dirname(absolutePath)) : dirname(resolve(createdDirectory));
  for (let directory = dirname(absolutePath);; directory = dirname(directory)) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (directory === last || dirname(directory) === directory) break;
  }
}
