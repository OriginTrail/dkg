import { isDeepStrictEqual } from 'node:util';
import { configFileStore, type ConfigFileStore, type ConfigFileWriter } from './config-file.js';
import type { DkgConfig, DkgHomeFiles } from './config.js';
import { immutableConfig, type DkgConfigActivation, type DkgConfigUpdate, type ImmutableDkgConfig } from './config-snapshot.js';

export { mutableConfigSnapshot } from './config-snapshot.js';
export type { DeepReadonly, DkgConfigActivation, DkgConfigUpdate, DkgRuntimeActivation, ImmutableDkgConfig } from './config-snapshot.js';

declare const configRevisionBrand: unique symbol;

/** Opaque semantic snapshot captured from one committed configuration. */
export interface DkgConfigRevision<Selected> {
  readonly [configRevisionBrand]: Selected;
}

export type DkgConfigConditionalUpdate = (current: ImmutableDkgConfig) =>
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly next: DkgConfig | ImmutableDkgConfig;
    };

export interface DkgConfigUpdateResult {
  readonly current: ImmutableDkgConfig;
  readonly changed: boolean;
}

const configRevisionValues = new WeakMap<object, unknown>();

/** The sole live configuration owner; the file lane has no daemon state. */
export class DkgConfigStore {
  static readonly #handles = new WeakMap<ConfigFileStore, Promise<DkgConfigStore>>();
  #current: ImmutableDkgConfig;
  #closing?: Promise<void>;

  private constructor(readonly files: DkgHomeFiles, private readonly file: ConfigFileStore, private readonly writer: ConfigFileWriter, initial: DkgConfig | ImmutableDkgConfig) {
    this.#current = immutableConfig(initial);
  }

  static open(files: DkgHomeFiles, initialConfig: DkgConfig | ImmutableDkgConfig | (() => Promise<DkgConfig>)): Promise<DkgConfigStore> {
    const file = configFileStore(files.configPath);
    let handle = this.#handles.get(file);
    if (!handle) {
      const initial = typeof initialConfig === 'function' ? initialConfig : immutableConfig(initialConfig);
      const writer = file.claim();
      // Completed saves are full snapshots: overlaying them onto stale startup
      // state would resurrect optional settings deliberately removed by a save.
      handle = writer.ready.then(async contents => new DkgConfigStore(files, file, writer,
        typeof initial === 'function' ? await initial() : contents === undefined ? initial : JSON.parse(contents)))
        .catch(async error => {
          await writer.close();
          if (this.#handles.get(file) === handle) this.#handles.delete(file);
          throw error;
        });
      this.#handles.set(file, handle);
    }
    return handle;
  }

  get current(): ImmutableDkgConfig {
    return this.#current;
  }

  /** Capture a property-order-independent revision for a selected config slice. */
  captureRevision<Selected>(
    select: (current: ImmutableDkgConfig) => Selected,
  ): DkgConfigRevision<Selected> {
    const revision = Object.freeze({}) as DkgConfigRevision<Selected>;
    configRevisionValues.set(revision, structuredClone(select(this.#current)));
    return revision;
  }

  /** Drain admitted updates before allowing a new owner or standalone writer. */
  close(): Promise<void> {
    return this.#closing ??= this.writer.close().then(() => {
      DkgConfigStore.#handles.delete(this.file);
    });
  }

  /** Rebase inside the publication lane; preparation must not mutate runtime state. */
  update(update: DkgConfigUpdate, prepare: DkgConfigActivation): Promise<ImmutableDkgConfig> {
    return this.updateConditional(
      current => ({ changed: true, next: update(current) }),
      prepare,
    ).then(result => result.current);
  }

  /**
   * Rebase and conditionally publish inside the owner lane. An unchanged
   * decision skips file publication and runtime activation entirely.
   */
  updateConditional(
    update: DkgConfigConditionalUpdate,
    prepare: DkgConfigActivation,
  ): Promise<DkgConfigUpdateResult> {
    return this.writer.commit<DkgConfigUpdateResult>(() => {
      const previous = this.#current;
      const decision = update(previous);
      if (!decision.changed) {
        return { unchanged: { current: previous, changed: false } };
      }
      const next = immutableConfig(decision.next);
      const activation = prepare === 'configuration-only'
        ? { apply() {}, rollback() {} }
        : prepare(next, previous);
      return {
        contents: JSON.stringify(next, null, 2) + '\n',
        activation: {
          apply: async () => {
            await activation.apply();
            this.#current = next;
            return { current: next, changed: true };
          },
          rollback: () => activation.rollback(),
        },
      };
    });
  }

  /** Publish only while the selected config slice still matches its revision. */
  updateIfRevision<Selected>(
    revision: DkgConfigRevision<Selected>,
    select: (current: ImmutableDkgConfig) => Selected,
    update: DkgConfigUpdate,
    prepare: DkgConfigActivation,
  ): Promise<DkgConfigUpdateResult> {
    if (!configRevisionValues.has(revision)) {
      return Promise.reject(new Error('Unknown configuration revision'));
    }
    const expected = configRevisionValues.get(revision);
    return this.updateConditional(current => (
      isDeepStrictEqual(select(current), expected)
        ? { changed: true, next: update(current) }
        : { changed: false }
    ), prepare);
  }
}
