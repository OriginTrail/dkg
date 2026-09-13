// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { types as utilTypes } from 'node:util';

export const RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY =
  'file-fsync-rename-directory-fsync';
export const RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY =
  'file-flush-rename-no-directory-flush';
export const RFC64_ARTIFACT_POSIX_ACCESS_POLICY =
  'posix-owner-read-write-mode-0600';
export const RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY =
  'windows-inherited-acl';

export class Rfc64EvidenceValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'Rfc64EvidenceValidationError';
  }
}

/** @param {string} left @param {string} right @returns {number} */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {string} text @returns {`sha256:${string}`} */
function sha256Text(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requiredLabel(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Rfc64EvidenceValidationError(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Rfc64EvidenceValidationError(
      `${label} must not contain surrounding whitespace`,
    );
  }
  return value;
}

/** Resolve the one exact target used by alias checks and artifact publication. */
/** @param {string} path @returns {string} */
export function resolveStableJsonArtifactPathV1(path) {
  const target = resolve(requiredLabel(path, 'path'));
  if (basename(target).length === 0) {
    throw new Rfc64EvidenceValidationError('path must identify an artifact file');
  }
  return target;
}

/**
 * Capture a value as stable JSON without exposing the recursive walker's
 * mutable cycle-detection state to callers.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {unknown}
 */
export function normalizeStableJsonValue(value, label = '$') {
  return stableJsonValue(value, label, new Set());
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<object>} ancestors
 * @returns {unknown}
 */
function stableJsonValue(value, path, ancestors) {
  if (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value)
  ) {
    throw new Rfc64EvidenceValidationError(`${path} must not be a proxy`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Rfc64EvidenceValidationError(
        `${path} must not use a custom array prototype`,
      );
    }
    if (ancestors.has(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a cycle`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Rfc64EvidenceValidationError(`${path} must not contain symbol keys`);
    }
    const allowedKeys = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) {
      allowedKeys.add(String(index));
      if (!Object.hasOwn(value, index)) {
        throw new Rfc64EvidenceValidationError(`${path} must not be a sparse array`);
      }
    }
    for (const key of /** @type {string[]} */ (ownKeys)) {
      if (!allowedKeys.has(key)) {
        throw new Rfc64EvidenceValidationError(
          `${path} must not contain custom array property ${JSON.stringify(key)}`,
        );
      }
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Rfc64EvidenceValidationError(
          `${path}[${key}] must be an enumerable data property`,
        );
      }
    }
    ancestors.add(value);
    const result = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Rfc64EvidenceValidationError(
          `${path}[${index}] must be an enumerable data property`,
        );
      }
      return stableJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
    });
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a cycle`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Rfc64EvidenceValidationError(
        `${path} must contain only plain JSON objects`,
      );
    }
    ancestors.add(value);
    const source = /** @type {Record<string, unknown>} */ (value);
    const ownKeys = Reflect.ownKeys(source);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Rfc64EvidenceValidationError(`${path} must not contain symbol keys`);
    }
    /** @type {Record<string, unknown>} */
    const result = Object.create(null);
    for (const key of /** @type {string[]} */ (ownKeys).sort(compareText)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} must not be an accessor property`,
        );
      }
      if (!descriptor.enumerable) {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} must not be a hidden non-enumerable property`,
        );
      }
      const entry = descriptor.value;
      if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function') {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} is not a stable JSON value`,
        );
      }
      result[key] = stableJsonValue(entry, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new Rfc64EvidenceValidationError(`${path} is not a stable JSON value`);
}

/** Recursively sort object keys and append exactly one LF. */
/** @param {unknown} value @returns {string} */
export function stableJsonStringify(value) {
  return `${JSON.stringify(normalizeStableJsonValue(value), null, 2)}\n`;
}

/** @typedef {Readonly<{ path: string, dev: number, ino: number }>} DirectoryTopologyEntry */

/** @param {string} path @returns {import('node:fs').Stats | null} */
function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** @param {unknown} error @param {string} code @returns {boolean} */
function hasErrorCode(error, code) {
  return error !== null
    && typeof error === 'object'
    && /** @type {{ code?: unknown }} */ (error).code === code;
}

/** @param {string} path @param {import('node:fs').Stats} stat */
function assertDirectory(path, stat) {
  if (stat.isSymbolicLink()) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory topology contains a symbolic link: ${path}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory topology contains a non-directory: ${path}`,
    );
  }
}

/** @param {string} directory @returns {readonly DirectoryTopologyEntry[]} */
function ensureArtifactDirectoryTopology(directory) {
  const root = parsePath(directory).root;
  const relativeDirectory = relative(root, directory);
  const components = relativeDirectory.length === 0 ? [] : relativeDirectory.split(sep);
  /** @type {DirectoryTopologyEntry[]} */
  const entries = [];
  let current = root;

  const rootStat = lstatSync(root);
  assertDirectory(root, rootStat);
  entries.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });

  for (const component of components) {
    current = join(current, component);
    let stat = lstatOptional(current);
    let observedMissing = false;
    if (stat === null) {
      observedMissing = true;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }
      stat = lstatSync(current);
    }
    assertDirectory(current, stat);
    if (observedMissing) fsyncArtifactDirectory(dirname(current), entries);
    entries.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/** @param {readonly DirectoryTopologyEntry[]} entries */
function assertArtifactDirectoryTopology(entries) {
  for (const expected of entries) {
    const actual = lstatOptional(expected.path);
    if (actual === null) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory disappeared during publication: ${expected.path}`,
      );
    }
    assertDirectory(expected.path, actual);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory topology changed during publication: ${expected.path}`,
      );
    }
  }
}

/** @param {string} target */
function assertArtifactTargetReplaceable(target) {
  const stat = lstatOptional(target);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new Rfc64EvidenceValidationError(
      `artifact target must not be a symbolic link: ${target}`,
    );
  }
  if (!stat.isFile()) {
    throw new Rfc64EvidenceValidationError(
      `artifact target must be a regular file: ${target}`,
    );
  }
}

/** @param {string} target @param {string} expectedJson */
function verifyPublishedArtifact(target, expectedJson) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(target, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Rfc64EvidenceValidationError(
        `published artifact is not a regular file: ${target}`,
      );
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      throw new Rfc64EvidenceValidationError(
        `published artifact mode must be 0600, got 0${(stat.mode & 0o777).toString(8)}`,
      );
    }
    if (readFileSync(fd, 'utf8') !== expectedJson) {
      throw new Rfc64EvidenceValidationError(
        `published artifact bytes changed during publication: ${target}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** @param {string} directory @param {readonly DirectoryTopologyEntry[]} topology */
function fsyncArtifactDirectory(directory, topology) {
  if (process.platform === 'win32') return;
  const expected = topology.at(-1);
  if (expected === undefined || expected.path !== directory) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory barrier does not match checked topology: ${directory}`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
  const fd = openSync(directory, fsConstants.O_RDONLY | noFollow | directoryOnly);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory handle does not match checked topology: ${directory}`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** @param {string} temporaryPath @param {readonly DirectoryTopologyEntry[]} topology */
function cleanupTemporaryArtifact(temporaryPath, topology) {
  try {
    assertArtifactDirectoryTopology(topology);
  } catch {
    return;
  }
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

/**
 * Atomically publish canonical JSON through a same-directory temporary file.
 * The strict plain-data serializer, target policy, and durability barriers are
 * shared by every RFC-64 gate runner.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {Readonly<{
 *   byteLength: number,
 *   sha256: `sha256:${string}`,
 *   namespaceDurability: typeof RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY | typeof RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY,
 *   accessPolicy: typeof RFC64_ARTIFACT_POSIX_ACCESS_POLICY | typeof RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY,
 * }>}
 */
export function writeStableJsonArtifact(path, value) {
  const target = resolveStableJsonArtifactPathV1(path);
  const targetName = basename(target);
  const json = stableJsonStringify(value);
  const directory = dirname(target);
  const topology = ensureArtifactDirectoryTopology(directory);
  assertArtifactDirectoryTopology(topology);
  assertArtifactTargetReplaceable(target);

  const temporaryPath = join(
    directory,
    `.${targetName}.${process.pid}.${randomUUID()}.tmp`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  /** @type {number | null} */
  let temporaryFd = null;
  let renamed = false;
  try {
    temporaryFd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    const opened = fstatSync(temporaryFd);
    if (!opened.isFile()) {
      throw new Rfc64EvidenceValidationError(
        `temporary artifact is not a regular file: ${temporaryPath}`,
      );
    }
    if (process.platform !== 'win32') fchmodSync(temporaryFd, 0o600);
    writeFileSync(temporaryFd, json, { encoding: 'utf8' });
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = null;

    assertArtifactDirectoryTopology(topology);
    assertArtifactTargetReplaceable(target);
    renameSync(temporaryPath, target);
    renamed = true;

    assertArtifactDirectoryTopology(topology);
    verifyPublishedArtifact(target, json);
    fsyncArtifactDirectory(directory, topology);
    assertArtifactDirectoryTopology(topology);
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        closeSync(temporaryFd);
      } catch {
        // Preserve the primary publication error.
      }
    }
    if (!renamed) cleanupTemporaryArtifact(temporaryPath, topology);
    throw error;
  }
  return Object.freeze({
    byteLength: Buffer.byteLength(json, 'utf8'),
    sha256: sha256Text(json),
    namespaceDurability: process.platform === 'win32'
      ? RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY
      : RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY,
    accessPolicy: process.platform === 'win32'
      ? RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY
      : RFC64_ARTIFACT_POSIX_ACCESS_POLICY,
  });
}
