/**
 * The node config file `dkg doctor` reads, resolved with the daemon's
 * precedence (`DkgHomeFiles.loadConfig` in `config.ts`): `config.json`
 * whenever it exists, `config.yaml` otherwise. The daemon falls through to
 * YAML only when the JSON file is absent, so an unreadable or malformed
 * `config.json` still wins over a valid `config.yaml`. Each format is parsed
 * with the parser the daemon uses for it.
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import yaml from 'js-yaml';
import type { DoctorDeps } from './types.js';

export interface ConfigFileSource {
  path: string;
  format: 'json' | 'yaml';
}

/** The file the daemon would load, or `null` when neither exists. */
export function resolveConfigFile(deps: Pick<DoctorDeps, 'dkgHome' | 'exists'>): ConfigFileSource | null {
  const candidates: ConfigFileSource[] = [
    { path: join(deps.dkgHome, 'config.json'), format: 'json' },
    { path: join(deps.dkgHome, 'config.yaml'), format: 'yaml' },
  ];
  return candidates.find((candidate) => deps.exists(candidate.path)) ?? null;
}

/** Parse a config file's text. Throws on a syntax error. */
export function parseConfigText(source: ConfigFileSource, raw: string): unknown {
  return source.format === 'json' ? JSON.parse(raw) : yaml.load(raw);
}

export function isConfigMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The config as a plain object, for readers that report nothing about the
 * file itself. `null` when it is missing, unreadable, malformed or not a
 * mapping; the config-sanity check reports those.
 */
export async function readConfigMapping(
  deps: Pick<DoctorDeps, 'dkgHome' | 'exists' | 'readFile'>,
): Promise<{ source: ConfigFileSource; config: Record<string, unknown> } | null> {
  const source = resolveConfigFile(deps);
  if (!source) return null;
  const raw = await deps.readFile(source.path);
  if (raw === null) return null;
  try {
    const config = parseConfigText(source, raw);
    return isConfigMapping(config) ? { source, config } : null;
  } catch {
    return null;
  }
}

/** The file as advisories name it: `~/…` inside the user's home, else the absolute path. */
export function configFileLabel(deps: Pick<DoctorDeps, 'home'>, path: string): string {
  const rel = relative(deps.home, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return `~/${rel.split(sep).join('/')}`;
}
