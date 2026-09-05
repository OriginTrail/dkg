import { describe, expect, it } from 'vitest';
import { inspectNodeRuntime, nodeRuntimeError } from '../src/node-runtime-preflight.js';
import { UPDATE_PREFLIGHT_CHECKS } from '../src/doctor/policy.js';

// Capability is authoritative: this also represents --experimental-sqlite on
// older builds, and custom builds without SQLite on newer version strings.
describe('SQLite runtime capability preflight', () => {
  it.each(['v22.12.0', 'v22.13.0', 'v23.2.0', 'v23.4.0', 'v24.0.0'])('reports capability rather than guessing from %s', (version) => {
    const supported = inspectNodeRuntime({ version, getBuiltinModule: () => ({ DatabaseSync: class {} }) });
    expect(supported.sqliteAvailable).toBe(true);
    expect(nodeRuntimeError(supported)).toBeUndefined();
    const unavailable = inspectNodeRuntime({ version, getBuiltinModule: () => undefined });
    expect(nodeRuntimeError(unavailable)).toContain(version);
    expect(nodeRuntimeError(unavailable)).toContain('>=22.13.0');
  });
  it.each([undefined, () => { throw new Error('unknown built-in'); }, () => ({}), () => null])('fails closed for a missing or unusable built-in', (getBuiltinModule) => {
    expect(inspectNodeRuntime({ version: 'v24.0.0', getBuiltinModule }).sqliteAvailable).toBe(false);
  });
  it('includes runtime validation in update doctor policy', () => {
    expect(UPDATE_PREFLIGHT_CHECKS).toContain('node-runtime');
  });
});
