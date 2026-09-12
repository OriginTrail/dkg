import { configFileStore, type ConfigFileStore, type ConfigFileWriter } from './config-file.js';
import type { DkgConfig, DkgHomeFiles } from './config.js';
import { immutableConfig, type DkgConfigActivation, type DkgConfigUpdate, type ImmutableDkgConfig } from './config-snapshot.js';

export { mutableConfigSnapshot } from './config-snapshot.js';
export type { DeepReadonly, DkgConfigActivation, DkgConfigUpdate, DkgRuntimeActivation, ImmutableDkgConfig } from './config-snapshot.js';

/** The sole live configuration owner; the file lane has no daemon state. */
export class DkgConfigStore {
  static readonly #handles = new WeakMap<ConfigFileStore, Promise<DkgConfigStore>>();
  #current: ImmutableDkgConfig;

  private constructor(readonly files: DkgHomeFiles, private readonly writer: ConfigFileWriter, initial: DkgConfig | ImmutableDkgConfig) {
    this.#current = immutableConfig(initial);
  }

  static open(files: DkgHomeFiles, initialConfig: DkgConfig | ImmutableDkgConfig): Promise<DkgConfigStore> {
    const file = configFileStore(files.configPath);
    let handle = this.#handles.get(file);
    if (!handle) {
      const writer = file.claim();
      const initial = immutableConfig(initialConfig);
      handle = writer.ready.then(contents => new DkgConfigStore(files, writer,
        contents === undefined ? initial : { ...initial, ...JSON.parse(contents) }));
      this.#handles.set(file, handle);
    }
    return handle;
  }

  get current(): ImmutableDkgConfig {
    return this.#current;
  }

  /** Rebase inside the publication lane; preparation must not mutate runtime state. */
  update(update: DkgConfigUpdate, prepare: DkgConfigActivation): Promise<ImmutableDkgConfig> {
    return this.writer.commit(() => {
      const previous = this.#current;
      const next = immutableConfig(update(previous));
      const activation = prepare === 'configuration-only'
        ? { apply() {}, rollback() {} }
        : prepare(next, previous);
      return {
        contents: JSON.stringify(next, null, 2) + '\n',
        activation: {
          apply: async () => {
            await activation.apply();
            this.#current = next;
            return next;
          },
          rollback: () => activation.rollback(),
        },
      };
    });
  }
}
