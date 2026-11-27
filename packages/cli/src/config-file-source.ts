import { join } from 'node:path';
import yaml from 'js-yaml';

export interface ConfigFileSource {
  path: string;
  format: 'json' | 'yaml';
}

/** JSON wins whenever present; consumers fall back to YAML only on absence. */
export function configFileSources(home: string): ConfigFileSource[] {
  return [
    { path: join(home, 'config.json'), format: 'json' },
    { path: join(home, 'config.yaml'), format: 'yaml' },
  ];
}

/** Raw syntax parsing, shared by daemon config loading and diagnostics. */
export function parseConfigText(source: ConfigFileSource, raw: string): unknown {
  return source.format === 'json' ? JSON.parse(raw) : yaml.load(raw);
}
