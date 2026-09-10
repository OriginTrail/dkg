import { configFileStore } from './config-file.js';
import type { DkgConfig, DkgHomeFiles } from './config.js';

export type DkgConfigUpdate = (
  current: Readonly<DkgConfig>,
) => DkgConfig | Promise<DkgConfig>;

export type DkgConfigActivation = (
  next: Readonly<DkgConfig>,
  previous: Readonly<DkgConfig>,
) => void;

/**
 * The explicit owner of one daemon's durable and in-memory configuration.
 * Every mutation is serialized and derived from the latest immutable commit.
 */
export class DkgConfigStore {
  readonly files: DkgHomeFiles;
  #current: Readonly<DkgConfig>;

  constructor(files: DkgHomeFiles, initialConfig: Readonly<DkgConfig>) {
    this.files = files;
    this.#current = immutableConfig(initialConfig);
  }

  get current(): Readonly<DkgConfig> {
    return this.#current;
  }

  update(
    update: DkgConfigUpdate,
    activate: DkgConfigActivation = () => undefined,
  ): Promise<Readonly<DkgConfig>> {
    return configFileStore(this.files.configPath).transition(async () => {
      const previous = this.#current;
      const next = immutableConfig(await update(previous));
      return {
        contents: JSON.stringify(next, null, 2) + '\n',
        activate: () => {
          activate(next, previous);
          this.#current = next;
          return next;
        },
      };
    });
  }
}

export function mutableConfigSnapshot(config: Readonly<DkgConfig>): DkgConfig {
  return JSON.parse(JSON.stringify(config)) as DkgConfig;
}

function immutableConfig(config: Readonly<DkgConfig>): Readonly<DkgConfig> {
  return deepFreeze(mutableConfigSnapshot(config));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
