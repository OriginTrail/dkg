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
import { withFileLock } from './file-lock.js';

/** Keys older releases wrote that the config type no longer declares; they are only ever removed. */
type LegacyConfigKey = 'openclawAdapter' | 'openclawChannel';

/** A top-level key of the config file. */
export type DkgConfigFileKey = keyof DkgConfig | LegacyConfigKey;

/**
 * A key a config update owns, or the path to one nested under it, such as
 * `['telemetry', 'enabled']` or `['localAgentIntegrations', 'hermes']`.
 */
export type DkgConfigKeyPath<K extends DkgConfigFileKey = DkgConfigFileKey> = K | readonly [K, ...string[]];

/**
 * A change to the persisted home config. It receives the file's own object
 * (no defaults merged in), typed down to the top-level keys its update owns,
 * and may change only what the update owns: anything else it changes makes
 * the update fail. Copying a whole in-memory config back would overwrite what
 * another process wrote since that copy was loaded. It runs while the config
 * lock is held, so it must be synchronous; the `undefined` return type makes
 * TypeScript reject an async patch.
 */
export type DkgConfigFilePatch<K extends DkgConfigFileKey = DkgConfigFileKey> =
  (config: Pick<Partial<DkgConfig>, Extract<K, keyof DkgConfig>>) => undefined;

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
 * in the same format. The update owns the keys in `owns`, and fails, writing
 * nothing, if the patch changes anything else. A patch that changes nothing
 * writes nothing, and a writer that lost the lock while it worked writes
 * nothing either.
 */
export async function updateHomeConfigFile<const K extends DkgConfigFileKey>(
  home: string,
  owns: readonly DkgConfigKeyPath<K>[],
  patch: DkgConfigFilePatch<K>,
): Promise<DkgConfigFileUpdate> {
  await mkdir(home, { recursive: true });
  return withFileLock(homeConfigPaths(home).lock, async (lock) => {
    const source = await readHomeConfigSource(home) ?? { ...homeConfigSources(home)[0], text: '', raw: {} };
    const { before, after, changed } = applyConfigFilePatch(configFileObject(source.raw, source.path), owns, patch);
    if (!changed) return { path: source.path, changed: false };
    const content = source.format === 'yaml'
      ? patchYamlText(source.text, before, after)
      : `${JSON.stringify(after, null, 2)}\n`;
    await lock.replaceFile(source.path, content);
    return { path: source.path, changed: true };
  }, { timeoutMs: CONFIG_LOCK_TIMEOUT_MS, label: 'config' });
}

/** The config file's data before and after a patch, as both formats persist it. */
export interface DkgConfigFilePatchResult {
  before: unknown;
  after: unknown;
  changed: boolean;
}

/**
 * Apply `patch` to a config file's object, in place, and return the data
 * before and after it. Throws if the patch is async or changes anything the
 * update does not own; the object may then be partly patched, and is not
 * to be written.
 */
export function applyConfigFilePatch<const K extends DkgConfigFileKey>(
  config: Partial<DkgConfig>,
  owns: readonly DkgConfigKeyPath<K>[],
  patch: DkgConfigFilePatch<K>,
): DkgConfigFilePatchResult {
  const before = toJsonData(config);
  // A caller outside the type system can still pass an async patch.
  const result: unknown = patch(config);
  if (isThenable(result)) {
    Promise.resolve(result).catch(() => {});
    throw new TypeError('A config file patch must be synchronous');
  }
  const after = toJsonData(config);
  const ownedPaths = owns.map((path): readonly string[] => (typeof path === 'string' ? [path] : path));
  const unowned = findUnownedChange(before, after, ownedPaths);
  if (unowned) {
    throw new Error(
      `A config update changed ${unowned.join('.')}, which it does not own `
      + `(it owns ${ownedPaths.map((path) => path.join('.')).join(', ')}); nothing was written`,
    );
  }
  return { before, after, changed: !isDeepStrictEqual(before, after) };
}

/**
 * The path of a change the patch made outside every owned path, or undefined
 * when there is none. A key on the way to an owned path must stay an object,
 * holding the same keys as before apart from owned ones; it may be created,
 * or replace a value that was not an object, to hold them.
 */
function findUnownedChange(
  before: unknown,
  after: unknown,
  owned: readonly (readonly string[])[],
  path: readonly string[] = [],
): readonly string[] | undefined {
  if (isDeepStrictEqual(before, after)) return undefined;
  if (owned.some((ownedPath) => startsWith(path, ownedPath))) return undefined;
  if (!owned.some((ownedPath) => startsWith(ownedPath, path))) return path;
  if (after !== undefined && !isJsonObject(after)) return path;
  const was = isJsonObject(before) ? before : {};
  const now = after ?? {};
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const change = findUnownedChange(was[key], now[key], owned, [...path, key]);
    if (change) return change;
  }
  return undefined;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}

/**
 * The data both formats persist, and the form both are compared in: what JSON
 * keeps of a value (undefined keys dropped, dates as ISO strings).
 */
function toJsonData(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Apply the difference between the parsed and the patched config to the YAML
 * text itself, so comments, blank lines and untouched keys keep their layout.
 * The document is edited under YAML 1.1 rules so that new strings which js-yaml
 * would read as another type (timestamps, yes/no) are quoted. If the edit
 * cannot be made in place (through an alias) or does not read back as the
 * patched config, the whole config is written instead.
 */
function patchYamlText(text: string, before: unknown, after: unknown): string {
  try {
    const doc = parseDocument(text, { version: '1.1' });
    if (doc.errors.length > 0) throw doc.errors[0];
    applyYamlChanges(doc, [], before, after);
    const edited = doc.toString({ lineWidth: 0 });
    if (isDeepStrictEqual(toJsonData(jsYaml.load(edited)), after)) return edited;
  } catch {
    // Fall back to writing the whole config below.
  }
  return jsYaml.dump(after, { noRefs: true, lineWidth: -1 });
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
