import { describe, expect, it } from 'vitest';
import {
  loadOwnedSqliteModuleV1,
  NODE_SQLITE_SUPPORTED_RANGE,
} from '../src/sqlite/module-loader-v1.js';

describe('owned node:sqlite module loader', () => {
  it('reports the supported runtime range when capability loading fails', async () => {
    await expect(loadOwnedSqliteModuleV1('Durable test feature', {
      load: async () => {
        throw new Error('simulated missing capability');
      },
    })).rejects.toThrow(
      `Durable test feature requires Node.js ${NODE_SQLITE_SUPPORTED_RANGE}`,
    );
  });

  it('loads the native module through the default loader', async () => {
    const sqlite = await loadOwnedSqliteModuleV1('Durable test feature');
    expect(sqlite).toHaveProperty('DatabaseSync');
  });
});
