// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { resolveAuthorityScanDeploymentV1 } from '../src/evm-context-graph-authority-deployment.js';

describe('authority scan deployment bounds', () => {
  it('uses a pinned lookup as it is and never reads the stored block', async () => {
    let storedReads = 0;
    const deployment = await resolveAuthorityScanDeploymentV1(
      async () => ({ blockNumber: 40, pinned: true }),
      async () => {
        storedReads += 1;
        return 10;
      },
    );
    expect(deployment.coverageFrom).toBe(40);
    expect(deployment.scanBounds(500)).toEqual({ deploymentBlockNumber: 40 });
    expect(storedReads).toBe(0);
  });

  it('resumes an unpinned lookup from the stored block, with the lookup as the rebuild bound', async () => {
    const deployment = await resolveAuthorityScanDeploymentV1(
      async () => ({ blockNumber: 0, pinned: false }),
      async () => 10,
    );
    expect(deployment.coverageFrom).toBe(10);
    expect(deployment.scanBounds(10)).toEqual({ deploymentBlockNumber: 10, rebuildFromBlockNumber: 0 });
    expect(deployment.scanBounds(500)).toEqual({ deploymentBlockNumber: 10, rebuildFromBlockNumber: 0 });
  });

  it('falls back to the lookup for an anchor below the stored block, or with nothing stored', async () => {
    const reset = await resolveAuthorityScanDeploymentV1(
      async () => ({ blockNumber: 0, pinned: false }),
      async () => 10,
    );
    expect(reset.scanBounds(9)).toEqual({ deploymentBlockNumber: 0 });

    const fresh = await resolveAuthorityScanDeploymentV1(
      async () => ({ blockNumber: 0, pinned: false }),
      async () => undefined,
    );
    expect(fresh.coverageFrom).toBe(0);
    expect(fresh.scanBounds(500)).toEqual({ deploymentBlockNumber: 0 });
  });
});
