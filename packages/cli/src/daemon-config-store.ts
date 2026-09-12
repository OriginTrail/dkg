import { configFileStore, type ConfigFileStore } from './config-file.js';
import type { DkgConfig, DkgHomeFiles } from './config.js';
import type { DkgConfigActivation, DkgConfigUpdate, ImmutableDkgConfig } from './config-snapshot.js';

export { mutableConfigSnapshot } from './config-snapshot.js';
export type { DeepReadonly, DkgConfigActivation, DkgConfigUpdate, ImmutableDkgConfig } from './config-snapshot.js';

/** A daemon handle to the file owner's single immutable state and commit queue. */
export class DkgConfigStore {
  static readonly #handles = new WeakMap<ConfigFileStore, DkgConfigStore>();

  private constructor(readonly files: DkgHomeFiles, private readonly owner: ConfigFileStore) {}

  static open(files: DkgHomeFiles, initialConfig: DkgConfig | ImmutableDkgConfig): DkgConfigStore {
    const owner = configFileStore(files.configPath);
    let handle = this.#handles.get(owner);
    if (!handle) {
      owner.initializeConfig(initialConfig);
      handle = new DkgConfigStore(files, owner);
      this.#handles.set(owner, handle);
    }
    return handle;
  }

  get current(): ImmutableDkgConfig {
    return this.owner.currentConfig;
  }

  update(update: DkgConfigUpdate, activate?: DkgConfigActivation): Promise<ImmutableDkgConfig> {
    return this.owner.updateConfig(update, activate);
  }
}
