import { expect, it, vi } from 'vitest';
import { withSwmProbeSeed } from '../bench/swm-probe-seed.mjs';

it('deletes a remotely committed probe even when insert loses its response', async () => {
  const persisted = new Set<string>();
  const quads = [{ subject: 'urn:probe:unique-run', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }];
  const store = {
    insert: vi.fn(async (rows: typeof quads) => {
      rows.forEach((row) => persisted.add(row.subject));
      throw new Error('seed response lost');
    }),
    delete: vi.fn(async (rows: typeof quads) => {
      rows.forEach((row) => persisted.delete(row.subject));
    }),
    close: vi.fn(async () => undefined),
  };
  const read = vi.fn(async () => undefined);
  await expect(withSwmProbeSeed(store, quads, read)).rejects.toThrow('seed response lost');
  expect(read).not.toHaveBeenCalled();
  expect(store.delete).toHaveBeenCalledWith(quads);
  expect(store.close).toHaveBeenCalledOnce();
  expect(persisted.size).toBe(0);
});
