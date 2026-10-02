import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { replaceFileDurably } from './durable-file-replace.js';
import { hasErrorCode } from './errors.js';
import { withFileLock } from './file-lock.js';

const CONFIG_LOCK_TIMEOUT_MS = 10_000;

/** A home config file and how to parse it. */
export interface HomeConfigSource {
  path: string;
  format: 'json' | 'yaml';
  parse(text: string): unknown;
}

/** The config file an update read under the lock. */
export interface HomeConfigFile {
  /** config.json, else config.yaml; config.json in a home that has no config yet. */
  path: string;
  format: 'json' | 'yaml';
  /** False only when the home had neither config.json nor config.yaml. */
  existed: boolean;
}

/**
 * A change to the persisted home config. It receives the file's own object
 * (no defaults merged in) and must mutate only the keys its caller owns:
 * copying a whole in-memory config back would overwrite whatever another
 * process wrote since that copy was loaded. It runs while the lock is held,
 * so it must be synchronous.
 */
export type HomeConfigFilePatch<T extends object = Record<string, unknown>> =
  (config: T, file: HomeConfigFile) => void;

export interface HomeConfigFileUpdate {
  /** The file that holds the config. */
  path: string;
  /** False when the patch changed nothing, in which case nothing was written. */
  changed: boolean;
}

/**
 * The lock every writer of a home's config takes (the CLI, the daemon and
 * the adapter setup flows), so their read-patch-write cycles never overlap.
 */
export function homeConfigLockPath(home: string): string {
  return join(home, 'config.lock');
}

/**
 * The config files of the DKG home `home` in precedence order: the first one
 * that exists is the source of truth for every read and write (the daemon,
 * the CLI and the setup flows), and a home with neither gets the first on its
 * first write.
 */
export function homeConfigSources(home: string): readonly HomeConfigSource[] {
  return [
    { path: join(home, 'config.json'), format: 'json', parse: (text) => JSON.parse(text) },
    { path: join(home, 'config.yaml'), format: 'yaml', parse: (text) => yaml.load(text) },
  ];
}

/**
 * Read the source-of-truth config file of `home`, or undefined when it has
 * none. Only a missing file falls through to the next; one that cannot be
 * read throws. The text comes back unparsed so each caller keeps its own
 * parse policy: the daemon's `loadConfig` rethrows a parse error as it is,
 * and an update names the file it refuses.
 */
export async function readHomeConfigSource(
  home: string,
): Promise<(HomeConfigSource & { text: string }) | undefined> {
  for (const source of homeConfigSources(home)) {
    try {
      return { ...source, text: await readFile(source.path, 'utf-8') };
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return undefined;
}

/**
 * The file an update of `home`'s config patches: config.json, else
 * config.yaml, else a new config.json. For messages only; an update decides
 * again under the lock.
 */
export function homeConfigFilePath(home: string): string {
  const sources = homeConfigSources(home);
  return (sources.find(({ path }) => existsSync(path)) ?? sources[0]).path;
}

/**
 * Apply `patch` to the config of the DKG home `home` under the shared config
 * lock: re-read the file that is the source of truth (config.json, else
 * config.yaml), patch its object, and replace the file atomically in the same
 * format, keeping its permission bits. A patch that changes nothing writes
 * nothing. A file that cannot be parsed, or that holds something other than
 * an object, is refused and left as it is.
 */
export async function updateHomeConfigFile<T extends object = Record<string, unknown>>(
  home: string,
  patch: HomeConfigFilePatch<T>,
): Promise<HomeConfigFileUpdate> {
  await mkdir(home, { recursive: true });
  return withFileLock(homeConfigLockPath(home), async () => {
    const source = await readHomeConfigSource(home);
    const [first] = homeConfigSources(home);
    const file: HomeConfigFile = source
      ? { path: source.path, format: source.format, existed: true }
      : { path: first.path, format: first.format, existed: false };
    const config = source ? parseConfigObject<T>(source) : ({} as T);
    const before = JSON.stringify(config, null, 2);
    const result: unknown = patch(config, file);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new TypeError('A config file patch must be synchronous');
    }
    const after = JSON.stringify(config, null, 2);
    if (after === before) return { path: file.path, changed: false };
    // Serialize through JSON in both formats so YAML persists exactly what
    // JSON would: undefined keys are dropped instead of failing the dump.
    const content = file.format === 'yaml'
      ? yaml.dump(JSON.parse(after), { noRefs: true, lineWidth: -1 })
      : `${after}\n`;
    await replaceFileDurably(file.path, content);
    return { path: file.path, changed: true };
  }, { timeoutMs: CONFIG_LOCK_TIMEOUT_MS, label: 'config' });
}

/**
 * The file's own object, without defaults, for an update. An empty config
 * file holds an empty config; a file that does not parse, or holds anything
 * but an object, is refused.
 */
function parseConfigObject<T extends object>(source: HomeConfigSource & { text: string }): T {
  let raw: unknown;
  try {
    raw = source.parse(source.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${source.path} is not valid ${source.format.toUpperCase()} (${reason}); refusing to update it`,
      { cause: error },
    );
  }
  if (raw === undefined || raw === null) return {} as T;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source.path} does not contain a config object; refusing to update it`);
  }
  return raw as T;
}
