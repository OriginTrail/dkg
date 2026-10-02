import { afterEach, describe, expect, it, vi } from 'vitest';

import { WasmStrategyAdmissionClient } from '../src/admission.js';
import { ComponentWorkerClient } from '../src/component-supervisor.js';
import { SemanticRuntimeHost } from '../src/host.js';
import { assertSemanticRuntimeSupport } from '../src/runtime-support.js';

afterEach(() => vi.unstubAllGlobals());

describe('semantic runtime platform support', () => {
  it('accepts the supported Node.js runtime with native JSPI', () => {
    expect(() => assertSemanticRuntimeSupport()).not.toThrow();
  });

  it.each(['Suspending', 'promising'] as const)(
    'rejects missing %s before host or admission touches artifacts or starts Workers',
    async (missingApi) => {
      vi.stubGlobal('WebAssembly', Object.create(WebAssembly, {
        [missingApi]: { value: undefined },
      }));
      const expected = /requires WebAssembly JSPI .*use Node\.js 26 or newer/;
      const options = { artifactRoot: '/missing-semantic-runtime-artifacts', log: vi.fn() };

      expect(() => assertSemanticRuntimeSupport()).toThrow(expected);
      const host = new SemanticRuntimeHost(options);
      await expect(host.start()).rejects.toThrow(expected);
      expect(host.activeComponentExecutions).toBe(0);
      expect(options.log).not.toHaveBeenCalled();

      const component = new ComponentWorkerClient(options);
      await expect(component.start()).rejects.toThrow(expected);
      expect(component.instanceId).toBeNull();

      const admission = new WasmStrategyAdmissionClient(options);
      await expect(admission.compileStrategy('(invalid)')).rejects.toThrow(expected);
      await expect(admission.admitPlan(new Uint8Array())).rejects.toThrow(expected);
    },
  );
});
