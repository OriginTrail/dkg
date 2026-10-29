import { expect, it } from 'vitest';
import { SparqlHttpStore, createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import { asStoreRecoveryGenerationReader, readStoreOperationExecutionGeneration, storeWorkerExecutionFailure } from '../src/store-recovery-generation.js';

const options = { queryEndpoint: 'http://127.0.0.1:9/query', updateEndpoint: 'http://127.0.0.1:9/update' };
it('exposes one supervised epoch/readiness snapshot without granting early proof admission', async () => {
  let state = { generation: 0, recovering: false, admissionsPaused: false };
  const store = createManagedOxigraphSparqlStoreV1(options, { getRecoveryState: () => state });
  try {
    const read = asStoreRecoveryGenerationReader({ innerStore: store })!;
    expect(read()).toEqual({ generation: 0, ready: true });
    state = { generation: 0, recovering: false, admissionsPaused: true };
    expect(read()).toEqual({ generation: 0, ready: false }); // Signalling is not termination.
    state = { generation: 1, recovering: true, admissionsPaused: false };
    expect(read()).toEqual({ generation: 1, ready: false });
    state = { generation: 1, recovering: false, admissionsPaused: false };
    expect(read()).toEqual({ generation: 1, ready: true });
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


it('binds worker failure evidence to the actual posted operation and refuses structural forgeries', () => {
  const error = storeWorkerExecutionFailure(new Error('worker exited'), 'insert', 0);
  expect(readStoreOperationExecutionGeneration(error, 'insert')).toBe(0);
  expect(readStoreOperationExecutionGeneration(error, 'update')).toBeUndefined();
  expect(readStoreOperationExecutionGeneration({ operation: 'insert', generation: 0 }, 'insert')).toBeUndefined();
});
