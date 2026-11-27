export type OwnedSqliteModuleV1 = typeof import('node:sqlite');

export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

export interface OwnedSqliteModuleLoaderDeps {
  /** Injectable for deterministic coverage of the fail-closed path. */
  load?: (moduleName: string) => Promise<OwnedSqliteModuleV1>;
}

export async function loadOwnedSqliteModuleV1(
  feature: string,
  deps: OwnedSqliteModuleLoaderDeps = {},
): Promise<OwnedSqliteModuleV1> {
  const moduleName = 'node:sqlite';
  const load = deps.load ?? ((name: string) => import(name));
  try {
    return await load(moduleName);
  } catch (cause) {
    throw new Error(
      `${feature} requires Node.js ${NODE_SQLITE_SUPPORTED_RANGE} with node:sqlite support (current ${process.version})`,
      { cause },
    );
  }
}
