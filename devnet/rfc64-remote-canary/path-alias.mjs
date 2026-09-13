// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Compare lexical, normalized, symlink-resolved, and existing inode identity.
 * Missing leaves are resolved through their nearest existing ancestor.
 * @param {string} left
 * @param {string} right
 */
export async function pathsAliasV1(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  const [canonicalLeft, canonicalRight, leftStat, rightStat] = await Promise.all([
    canonicalizePotentialPathV1(resolvedLeft),
    canonicalizePotentialPathV1(resolvedRight),
    statIfPresentV1(resolvedLeft),
    statIfPresentV1(resolvedRight),
  ]);
  return canonicalLeft === canonicalRight || (
    leftStat !== null
    && rightStat !== null
    && leftStat.dev === rightStat.dev
    && leftStat.ino === rightStat.ino
  );
}

/** @param {string} path */
async function canonicalizePotentialPathV1(path) {
  let cursor = path;
  const missingSegments = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!hasErrorCodeV1(error, 'ENOENT')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return path;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** @param {string} path */
async function statIfPresentV1(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (hasErrorCodeV1(error, 'ENOENT')) return null;
    throw error;
  }
}

/** @param {unknown} error @param {string} code */
function hasErrorCodeV1(error, code) {
  return error !== null
    && typeof error === 'object'
    && /** @type {{ code?: unknown }} */ (error).code === code;
}
