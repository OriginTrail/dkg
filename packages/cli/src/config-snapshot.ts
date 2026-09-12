import type { DkgConfig } from './config.js';

/** The recursive static counterpart of the committed configuration's freeze. */
export type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T // Keep branded scalar configuration values as scalars.
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ImmutableDkgConfig = DeepReadonly<DkgConfig>;
export type DkgConfigUpdate = (current: ImmutableDkgConfig) => DkgConfig | ImmutableDkgConfig;
export type DkgConfigActivation = (next: ImmutableDkgConfig, previous: ImmutableDkgConfig) => void;

/** An explicit mutable draft; JSON configuration contains only serializable data. */
export function mutableConfigSnapshot(config: DkgConfig | ImmutableDkgConfig): DkgConfig {
  return JSON.parse(JSON.stringify(config)) as DkgConfig;
}

export function immutableConfig(config: DkgConfig | ImmutableDkgConfig): ImmutableDkgConfig {
  return deepFreeze(mutableConfigSnapshot(config));
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value as DeepReadonly<T>;
}
