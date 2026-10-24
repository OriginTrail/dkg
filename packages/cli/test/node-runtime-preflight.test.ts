import { describe, expect, it, vi } from 'vitest';
import {
  assertNodeRuntimeSupported,
  inspectNodeRuntime,
  nodeRuntimeFailureMessage,
  NODE_SQLITE_SUPPORTED_RANGE,
} from '../src/node-runtime-preflight.js';
import { runNodeRuntimeCheck } from '../src/doctor/checks/node-runtime.js';
import type { StateSummary } from '../src/doctor/types.js';
import {
  inspectInstallNodeRuntime,
  installNodeRuntimeFailureMessage,
} from '../scripts/verify-node-sqlite-runtime.mjs';

function stateFor(runtime: StateSummary['runtime']): StateSummary {
  return { runtime } as StateSummary;
}

describe('node runtime preflight', () => {
  it('uses the builtin capability even when the version is below the declared floor', () => {
    const runtime = {
      version: 'v22.10.0',
      getBuiltinModule: vi.fn(() => ({ DatabaseSync: class {} })),
    };
    expect(inspectNodeRuntime(runtime)).toEqual({
      nodeVersion: 'v22.10.0',
      nodeSqliteAvailable: true,
      probe: 'getBuiltinModule',
    });
    expect(nodeRuntimeFailureMessage(runtime)).toBeNull();
    expect(assertNodeRuntimeSupported(vi.fn(), runtime)).toBe(true);
  });

  it('fails closed when the capability API is absent or throws', () => {
    const log = vi.fn();
    const runtime = { version: 'v22.12.0' };
    expect(assertNodeRuntimeSupported(log, runtime)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(NODE_SQLITE_SUPPORTED_RANGE));

    const throwing = {
      version: 'v23.2.0',
      getBuiltinModule: () => { throw new Error('disabled'); },
    };
    expect(inspectNodeRuntime(throwing).nodeSqliteAvailable).toBe(false);
    expect(nodeRuntimeFailureMessage(throwing)).toContain('v23.2.0');
  });

  it('applies the same capability contract before package installation', () => {
    const supported = {
      version: 'v22.13.0',
      getBuiltinModule: vi.fn(() => ({ DatabaseSync: class {} })),
    };
    expect(inspectInstallNodeRuntime(supported)).toMatchObject({
      nodeVersion: 'v22.13.0',
      nodeSqliteAvailable: true,
    });
    expect(installNodeRuntimeFailureMessage(supported)).toBeNull();

    const unsupported = { version: 'v22.12.0' };
    expect(inspectInstallNodeRuntime(unsupported)).toMatchObject({
      nodeVersion: 'v22.12.0',
      nodeSqliteAvailable: false,
    });
    expect(installNodeRuntimeFailureMessage(unsupported)).toContain(
      'Refusing to install DKG',
    );
  });

  it('surfaces an error finding through the doctor check', () => {
    const findings = runNodeRuntimeCheck(stateFor({
      nodeVersion: 'v22.12.0',
      nodeSqliteAvailable: false,
      probe: 'unavailable',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: 'node-runtime',
      severity: 'error',
      subject: 'v22.12.0',
      details: { supportedRange: NODE_SQLITE_SUPPORTED_RANGE },
    });
  });
});
