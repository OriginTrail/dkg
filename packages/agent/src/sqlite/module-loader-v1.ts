export type OwnedSqliteModuleV1 = typeof import('node:sqlite');

export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

export async function loadOwnedSqliteModuleV1(feature: string): Promise<OwnedSqliteModuleV1> {
  const moduleName = 'node:sqlite';
  try {
    return await import(moduleName);
  } catch (cause) {
    throw new Error(
      `${feature} requires Node.js ${NODE_SQLITE_SUPPORTED_RANGE} with node:sqlite support (current ${process.version})`,
      { cause },
    );
  }
}
