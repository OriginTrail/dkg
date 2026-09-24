// The home config file: which file is the source of truth, how it is read,
// and how a patch is written back to it in the same format. It is read with
// js-yaml, as loadConfig always has been; a YAML file is edited in place with
// the yaml package, which keeps comments and layout.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import jsYaml from 'js-yaml';
import { parseDocument, type Document } from 'yaml';
import { hasErrorCode } from '@origintrail-official/dkg-core';
import type { DkgConfig } from './config.js';
import { replaceFileDurably } from './durable-file-replace.js';
import { withFileLock } from './file-lock.js';

/**
 * A change to the persisted home config. It receives the file's own object
 * (no defaults merged in) and must mutate only the keys its caller owns:
 * copying a whole in-memory config back would overwrite whatever another
 * process wrote since that copy was loaded. It runs while the config lock is
 * held, so it must be synchronous; the `undefined` return type makes
 * TypeScript reject an async patch.
 */
export type DkgConfigFilePatch = (config: Partial<DkgConfig>) => undefined;

/** Where a config update was written, and whether the patch changed anything. */
export interface DkgConfigFileUpdate {
  path: string;
  changed: boolean;
}

/** A home config file and how to parse it. */
export interface HomeConfigSource {
  path: string;
  format: 'json' | 'yaml';
  parse(text: string): unknown;
}

const CONFIG_LOCK_TIMEOUT_MS = 10_000;

export function homeConfigPaths(home: string): { json: string; yaml: string; lock: string } {
  return { json: join(home, 'config.json'), yaml: join(home, 'config.yaml'), lock: join(home, 'config.lock') };
}

/**
 * The config files in precedence order: the first one that exists is the
 * source of truth for every read and write, and a home without either gets
 * the first on its first write.
 */
export function homeConfigSources(home: string): readonly HomeConfigSource[] {
  const paths = homeConfigPaths(home);
  return [
    { path: paths.json, format: 'json', parse: (text) => JSON.parse(text) },
    { path: paths.yaml, format: 'yaml', parse: (text) => jsYaml.load(text) },
  ];
}

/**
 * Read and parse the source-of-truth config file, or undefined when the home
 * has none. A file that cannot be read or parsed throws; only a missing one
 * falls through to the next.
 */
export async function readHomeConfigSource(
  home: string,
): Promise<(HomeConfigSource & { text: string; raw: unknown }) | undefined> {
  for (const source of homeConfigSources(home)) {
    try {
      const text = await readFile(source.path, 'utf-8');
      return { ...source, text, raw: source.parse(text) };
    } catch (err) {
      if (!hasErrorCode(err, 'ENOENT')) throw err;
    }
  }
  return undefined;
}

/** The synchronous read, for callers that cannot await; undefined when the home has no config. */
export function readHomeConfigSourceSync(home: string): { path: string; raw: unknown } | undefined {
  const source = homeConfigSources(home).find(({ path }) => existsSync(path));
  return source ? { path: source.path, raw: source.parse(readFileSync(source.path, 'utf-8')) } : undefined;
}

/**
 * Apply `patch` under a lock the daemon and CLI share: re-read the file that
 * is the source of truth, patch its object, and replace the file atomically
 * in the same format. A patch that changes nothing writes nothing.
 */
export async function updateHomeConfigFile(home: string, patch: DkgConfigFilePatch): Promise<DkgConfigFileUpdate> {
  await mkdir(home, { recursive: true });
  return withFileLock(homeConfigPaths(home).lock, async () => {
    const source = await readHomeConfigSource(home) ?? { ...homeConfigSources(home)[0], text: '', raw: {} };
    const config = configFileObject(source.raw, source.path);
    const before = JSON.stringify(config, null, 2);
    // A caller outside the type system can still pass an async patch.
    const result: unknown = patch(config);
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {});
      throw new TypeError('A config file patch must be synchronous');
    }
    const after = JSON.stringify(config, null, 2);
    if (after === before) return { path: source.path, changed: false };
    // Compare through JSON in both formats so YAML persists exactly what JSON
    // would: undefined keys are dropped instead of failing the dump.
    const content = source.format === 'yaml'
      ? patchYamlText(source.text, JSON.parse(before), JSON.parse(after))
      : `${after}\n`;
    await replaceFileDurably(source.path, content);
    return { path: source.path, changed: true };
  }, { timeoutMs: CONFIG_LOCK_TIMEOUT_MS, label: 'config' });
}

/**
 * Apply the difference between the parsed and the patched config to the YAML
 * text itself, so comments, blank lines and untouched keys keep their layout.
 * A change the document cannot take in place, such as one reached through an
 * alias, falls back to writing the whole config.
 */
function patchYamlText(text: string, before: unknown, after: unknown): string {
  const doc = parseDocument(text);
  try {
    if (doc.errors.length > 0) throw doc.errors[0];
    applyYamlChanges(doc, [], before, after);
    return doc.toString({ lineWidth: 0 });
  } catch {
    return jsYaml.dump(after, { noRefs: true, lineWidth: -1 });
  }
}

function applyYamlChanges(doc: Document, path: string[], before: unknown, after: unknown): void {
  if (!isJsonObject(before) || !isJsonObject(after)) {
    doc.setIn(path, after);
    return;
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) doc.deleteIn([...path, key]);
  }
  for (const [key, value] of Object.entries(after)) {
    if (!isDeepStrictEqual(before[key], value)) applyYamlChanges(doc, [...path, key], before[key], value);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An empty config file holds an empty config; anything but an object is refused. */
function configFileObject(raw: unknown, path: string): Partial<DkgConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path} does not contain a config object; refusing to update it`);
  }
  return raw as Partial<DkgConfig>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
