import type { ReducerModule, ReducerConfig } from './types.js';

export class ReducerRegistry {
  private reducers = new Map<string, ReducerModule>();

  register(reducer: ReducerModule): void {
    const key = this.key(reducer.name, reducer.version);
    this.reducers.set(key, reducer);
  }

  unregister(name: string, version: string): void {
    this.reducers.delete(this.key(name, version));
  }

  get(name: string, version: string): ReducerModule | undefined {
    return this.reducers.get(this.key(name, version));
  }

  has(name: string, version: string): boolean {
    return this.reducers.has(this.key(name, version));
  }

  matches(config: ReducerConfig): boolean {
    const reducer = this.get(config.name, config.version);
    return reducer !== undefined && reducer.hash === config.hash;
  }

  resolve(config: ReducerConfig): ReducerModule | undefined {
    const reducer = this.get(config.name, config.version);
    if (reducer && reducer.hash === config.hash) return reducer;
    return undefined;
  }

  listRegistered(): Array<{ name: string; version: string; hash: string }> {
    return Array.from(this.reducers.values()).map((r) => ({
      name: r.name,
      version: r.version,
      hash: r.hash,
    }));
  }

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }
}
