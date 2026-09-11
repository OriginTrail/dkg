// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  executeRemoteCanaryCertificationV1,
} from './certify.mjs';
import { createCertificationRuntime } from './orchestration-fixture.mjs';
import { baseConfig } from './test-support.mjs';

test('full-run fixture rejects every missing or renamed daemon request field', async () => {
  const requiredFields = [
    ['/api/knowledge-assets', 'contextGraphId'],
    ['/api/knowledge-assets', 'name'],
    ['/api/knowledge-assets', 'quads'],
    ['/api/knowledge-assets', 'alsoShareSwm'],
    ['/api/query', 'contextGraphId'],
    ['/api/query', 'view'],
    ['/api/query', 'sparql'],
  ];
  for (const [path, field] of requiredFields) {
    for (const mutation of ['missing', 'renamed']) {
      let mutated = false;
      const runtime = createCertificationRuntime({
        mutateJsonBody: ({ path: requestPath, body }) => {
          if (requestPath !== path) return body;
          mutated = true;
          const altered = structuredClone(body);
          const value = altered[field];
          delete altered[field];
          if (mutation === 'renamed') altered[`renamed${field}`] = value;
          return altered;
        },
      });
      const config = baseConfig({
        timing: {
          requestTimeoutMs: 1_000,
          pollIntervalMs: 250,
          propagationTimeoutMs: 1_000,
          catchupTimeoutMs: 1_000,
          parityTimeoutMs: 1_000,
        },
      });
      await assert.rejects(
        executeRemoteCanaryCertificationV1(config, runtime),
        (error) => error instanceof RemoteCanaryError
          && error.code === (
            path === '/api/query' ? 'swm-propagation-timeout' : 'node-http-status-failed'
          ),
        `${mutation} ${path} ${field}`,
      );
      assert.equal(mutated, true, `${mutation} ${path} ${field}`);
    }
  }
});
