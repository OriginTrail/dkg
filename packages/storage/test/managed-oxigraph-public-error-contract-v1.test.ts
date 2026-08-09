import { describe, expect, it } from 'vitest';
import { ManagedOxigraphBackendUnownedError } from '../src/index.js';

describe('managed Oxigraph public error contract', () => {
  it('keeps the fail-closed error recognizable without exposing the authority mint', () => {
    const error = new ManagedOxigraphBackendUnownedError(
      'sparql-http.update',
      true,
      'port-release-unproven',
    );

    expect(error).toBeInstanceOf(ManagedOxigraphBackendUnownedError);
    expect(error.code).toBe('MANAGED_OXIGRAPH_BACKEND_UNOWNED');
    expect(error.operation).toBe('sparql-http.update');
    expect(error.terminal).toBe(true);
  });
});
