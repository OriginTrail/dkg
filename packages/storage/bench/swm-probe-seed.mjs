/**
 * Run one uniquely named local probe and clean it up even when the seed write
 * commits remotely but its response is lost. Deleting absent quads is safe.
 */
export async function withSwmProbeSeed(store, quads, read) {
  try {
    await store.insert(quads);
    return await read();
  } finally {
    try {
      await store.delete(quads);
    } finally {
      await store.close();
    }
  }
}
