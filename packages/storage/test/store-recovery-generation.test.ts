import { expect, it } from 'vitest';
import { SparqlHttpStore, createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import { asStoreRecoveryGenerationReader } from '../src/store-recovery-generation.js';

const options = { queryEndpoint: 'http://127.0.0.1:9/query', updateEndpoint: 'http://127.0.0.1:9/update' };
it('exposes only supervised generations, and withholds them until replacement is ready', async () => {
  let state = { generation: 0, recovering: false, admissionsPaused: false };
  const store = createManagedOxigraphSparqlStoreV1(options, { getRecoveryState: () => state });
  try {
    const read = asStoreRecoveryGenerationReader({ innerStore: store })!;
    expect(read()).toBe(0);
    state = { generation: 0, recovering: false, admissionsPaused: true };
    expect(read()).toBeUndefined(); // Verification/signalling is not termination.
    state = { generation: 1, recovering: true, admissionsPaused: false };
    expect(read()).toBeUndefined();
    state = { generation: 1, recovering: false, admissionsPaused: false };
    expect(read()).toBe(1);
  } finally { await store.close(); }
});
it('does not grant recovery authority to a generic endpoint or a forged object', async () => {
  const generic = new SparqlHttpStore({ ...options, managedRecovery: {
    readState: () => ({ generation: 42, recovering: false }), recover() {},
  } });
  try {
    expect(asStoreRecoveryGenerationReader(generic)).toBeUndefined();
    expect(asStoreRecoveryGenerationReader({ getRecoveryGeneration: () => 42 })).toBeUndefined();
  } finally { await generic.close(); }
});
