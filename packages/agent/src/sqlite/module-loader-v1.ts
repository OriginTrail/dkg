export type OwnedSqliteModuleV1 = typeof import('node:sqlite');

export async function loadOwnedSqliteModuleV1(feature: string): Promise<OwnedSqliteModuleV1> {
  const moduleName = 'node:sqlite';
  try {
    return await import(moduleName);
  } catch (cause) {
    throw new Error(`${feature} requires Node runtime support for node:sqlite (Node.js >=22.13.0 <23.0.0 || >=23.4.0); current runtime: ${process.version}`, { cause });
  }
}
