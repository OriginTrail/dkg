// The home config file: which file is the source of truth, how it is read,
// and how edits are written back to it in the same format. It is read with
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

/** What the config file holds: the config, and keys older releases wrote that are now only ever removed. */
export type DkgConfigFile = DkgConfig & { openclawAdapter?: unknown; openclawChannel?: unknown };

type ConfigKey = keyof DkgConfigFile & string;

/** The keys under a config key that holds an object (not an array or a scalar). */
type NestedConfigKey<K extends ConfigKey> = NonNullable<DkgConfigFile[K]> extends readonly unknown[]
  ? never
  : NonNullable<DkgConfigFile[K]> extends object ? keyof NonNullable<DkgConfigFile[K]> & string : never;

/**
 * Where a config edit applies: a top-level key, or a key one level below it,
 * such as `['telemetry', 'enabled']` or `['localAgentIntegrations', id]`.
 */
export type DkgConfigPath = {
  [K in ConfigKey]: [NestedConfigKey<K>] extends [never] ? readonly [K] : readonly [K] | readonly [K, NestedConfigKey<K>];
}[ConfigKey];

/** The type of the value at a config path. */
export type DkgConfigValue<P extends DkgConfigPath> =
  P extends readonly [infer K extends ConfigKey, infer N extends string]
    ? N extends keyof NonNullable<DkgConfigFile[K]> ? NonNullable<NonNullable<DkgConfigFile[K]>[N]> : never
    : P extends readonly [infer K extends ConfigKey] ? NonNullable<DkgConfigFile[K]> : never;

let makeConfigEdit: (path: readonly string[], update: (current: unknown) => unknown) => DkgConfigEdit;
let readConfigEdit: (edit: DkgConfigEdit) => { path: readonly string[]; update: (current: unknown) => unknown };

/**
 * One edit of the config file: the value at its path becomes what its update
 * returns for it. Only configEdit and configValues make one, so the value an
 * update returns always has the type at its path.
 */
export class DkgConfigEdit {
  static {
    makeConfigEdit = (path, update) => new DkgConfigEdit(path, update);
    readConfigEdit = (edit) => ({ path: edit.#path, update: edit.#update });
  }

  readonly #path: readonly string[];
  readonly #update: (current: unknown) => unknown;

  private constructor(path: readonly string[], update: (current: unknown) => unknown) {
    this.#path = path;
    this.#update = update;
  }
}

/**
 * An edit that sets the value at `path` to what `update` returns for the
 * current one, removing it when that is undefined. The update is given only
 * that value, so an edit cannot change anything beside it, and a stale copy
 * of the config has nowhere to be written back. It runs under the config
 * lock, on the file as it is then, so it must be synchronous.
 */
export function configEdit<const P extends DkgConfigPath>(
  path: P,
  update: (current: DkgConfigValue<P> | undefined) => DkgConfigValue<P> | undefined,
): DkgConfigEdit {
  return makeConfigEdit(path, update as (current: unknown) => unknown);
}

/** Edits that set each key of `values`, removing the ones set to undefined. */
export function configValues(values: Partial<DkgConfig>): DkgConfigEdit[] {
  return Object.entries(values).map(([key, value]) => makeConfigEdit([key], () => value));
}

/** Where a config update was written, and whether its edits changed anything. */
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
 * Apply `edits`, together, under a lock the daemon and CLI share: re-read the
 * file that is the source of truth, edit its object, and replace the file
 * atomically in the same format. Edits that change nothing write nothing, and
 * a writer that lost the lock while it worked writes nothing either.
 */
export async function updateHomeConfigFile(home: string, edits: readonly DkgConfigEdit[]): Promise<DkgConfigFileUpdate> {
  await mkdir(home, { recursive: true });
  return withFileLock(homeConfigPaths(home).lock, async (lock) => {
    const source = await readHomeConfigSource(home) ?? { ...homeConfigSources(home)[0], text: '', raw: {} };
    const { before, after, changed } = applyConfigEdits(configFileObject(source.raw, source.path), edits);
    if (!changed) return { path: source.path, changed: false };
    const content = source.format === 'yaml'
      ? patchYamlText(source.text, before, after)
      : `${JSON.stringify(after, null, 2)}\n`;
    await lock.replaceFile(source.path, content);
    return { path: source.path, changed: true };
  }, { timeoutMs: CONFIG_LOCK_TIMEOUT_MS, label: 'config' });
}

/** The config file's data before and after its edits, as both formats persist it. */
export interface DkgConfigFileChange {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: boolean;
}

/**
 * Apply `edits`, in order, to a copy of a config file's data, and return the
 * data before and after them; `config` itself is never changed. Each edit
 * changes only the value at its path, and a key above a nested path that
 * holds no mapping gets one. Throws if an edit was not made by configEdit or
 * configValues, or if an update throws or is async.
 */
export function applyConfigEdits(config: Record<string, unknown>, edits: readonly DkgConfigEdit[]): DkgConfigFileChange {
  const before = toJsonRecord(config);
  const working = toJsonRecord(config);
  for (const edit of edits) {
    if (!(edit instanceof DkgConfigEdit)) throw new TypeError('A config edit must be made by configEdit or configValues');
    const { path: [key, nested], update } = readConfigEdit(edit);
    if (nested === undefined) {
      setOwn(working, key, runUpdate(update, getOwn(working, key)));
      continue;
    }
    const parent = getOwn(working, key);
    const next = runUpdate(update, isPlainRecord(parent) ? getOwn(parent, nested) : undefined);
    if (isPlainRecord(parent)) setOwn(parent, nested, next);
    else if (next !== undefined) setOwn(working, key, setOwn({}, nested, next));
  }
  const after = toJsonRecord(working);
  return { before, after, changed: !isDeepStrictEqual(before, after) };
}

function runUpdate(update: (current: unknown) => unknown, current: unknown): unknown {
  const next = update(current);
  // A caller outside the type system can still pass an async update.
  if (isThenable(next)) {
    Promise.resolve(next).catch(() => {});
    throw new TypeError('A config edit must be synchronous');
  }
  return next;
}

// Keys are read and written as own properties, so one such as `__proto__` (a
// valid integration id) is stored like any other instead of reaching the
// object's prototype.
function getOwn(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function setOwn(object: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (value === undefined) {
    if (Object.hasOwn(object, key)) delete object[key];
  } else {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return object;
}

/**
 * The data both formats persist, and the form both are compared in: what JSON
 * keeps of a value (undefined keys dropped, dates as ISO strings).
 */
function toJsonData(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function toJsonRecord(config: Record<string, unknown>): Record<string, unknown> {
  return toJsonData(config) as Record<string, unknown>;
}

/**
 * Apply the difference between the parsed and the edited config to the YAML
 * text itself, so comments, blank lines and untouched keys keep their layout.
 * The document is edited under YAML 1.1 rules so that new strings which js-yaml
 * would read as another type (timestamps, yes/no) are quoted. If the edit
 * cannot be made in place (through an alias) or does not read back as the
 * edited config, the whole config is written instead.
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
  if (!isPlainRecord(before) || !isPlainRecord(after)) {
    doc.setIn(path, after);
    return;
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) doc.deleteIn([...path, key]);
  }
  for (const [key, value] of Object.entries(after)) {
    const was = getOwn(before, key);
    if (!isDeepStrictEqual(was, value)) applyYamlChanges(doc, [...path, key], was, value);
  }
}

/** A mapping, as JSON or YAML parses one: not an array, and not a Date or any other object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * An empty config file holds an empty config; anything but a mapping (a
 * list, or a scalar such as a YAML timestamp) is refused.
 */
function configFileObject(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainRecord(raw)) {
    throw new Error(`${path} does not contain a config object; refusing to update it`);
  }
  return raw;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
