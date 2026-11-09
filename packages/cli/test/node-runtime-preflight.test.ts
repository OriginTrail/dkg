import { describe, expect, it, vi } from 'vitest';
import {
  assertNodeRuntimeSupported,
  inspectNodeRuntime,
  nodeRuntimeFailureMessage,
  nodeSecurityAdvisory,
  NODE_SECURITY_RELEASES,
  NODE_SQLITE_SUPPORTED_RANGE,
} from '../src/node-runtime-preflight.js';
import { runNodeRuntimeCheck, runNodeSecurityCheck } from '../src/doctor/checks/node-runtime.js';
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

describe('node security advisory', () => {
  it('flags releases older than the patched one on each supported line', () => {
    expect(nodeSecurityAdvisory('v22.23.3')).toContain('Upgrade to Node.js 22.23.4 or later');
    expect(nodeSecurityAdvisory('v22.13.0')).toContain('CVE-2026-111497');
    expect(nodeSecurityAdvisory('v24.22.0')).toContain('24.22.1');
    expect(nodeSecurityAdvisory('v24.9.5')).toContain('24.22.1');
    expect(nodeSecurityAdvisory('v26.12.0')).toContain('26.12.1');
  });

  it('accepts the patched releases and anything newer on the same line', () => {
    for (const release of Object.values(NODE_SECURITY_RELEASES)) {
      expect(nodeSecurityAdvisory(`v${release}`)).toBeNull();
    }
    expect(nodeSecurityAdvisory('v22.24.0')).toBeNull();
    expect(nodeSecurityAdvisory('v24.22.10')).toBeNull();
  });

  it('calls out end-of-life lines and leaves newer lines and unparsable versions alone', () => {
    for (const version of ['v20.19.2', 'v23.11.0', 'v25.1.0']) {
      expect(nodeSecurityAdvisory(version)).toContain('end-of-life');
    }
    expect(nodeSecurityAdvisory('v23.11.0')).toContain('22.23.4+, 24.22.1+ or 26.12.1+');
    expect(nodeSecurityAdvisory('v28.0.0')).toBeNull();
    expect(nodeSecurityAdvisory('unknown')).toBeNull();
  });

  it('warns without blocking when the runtime works but misses the fixes', () => {
    const log = vi.fn();
    const sqlite = vi.fn(() => ({ DatabaseSync: class {} }));
    expect(assertNodeRuntimeSupported(log, { version: 'v22.20.0', getBuiltinModule: sqlite })).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^WARNING: .*22\.23\.4/));

    log.mockClear();
    expect(assertNodeRuntimeSupported(log, { version: 'v22.23.4', getBuiltinModule: sqlite })).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('surfaces a warning finding through the node-security doctor check', () => {
    const findings = runNodeSecurityCheck(stateFor({
      nodeVersion: 'v22.20.0',
      nodeSqliteAvailable: true,
      probe: 'getBuiltinModule',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: 'node-security',
      severity: 'warning',
      subject: 'v22.20.0',
      details: { patchedReleases: { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' } },
    });
    expect(runNodeSecurityCheck(stateFor({
      nodeVersion: 'v24.22.1',
      nodeSqliteAvailable: true,
      probe: 'getBuiltinModule',
    }))).toEqual([]);
  });
});
