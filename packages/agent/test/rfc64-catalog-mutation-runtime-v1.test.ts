// SPDX-License-Identifier: Apache-2.0

import {
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  Rfc64CatalogMutationCoordinatorV1,
  rfc64CatalogMutationScopeKeyV1,
} from '../src/rfc64/catalog-mutation-runtime-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';

function catalogScope(contextGraphId: string): Readonly<AuthorCatalogScopeV1> {
  return Object.freeze({
    networkId: 'hardhat1',
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
}

class RecordingCatalogMutationCoordinatorV1 extends Rfc64CatalogMutationCoordinatorV1 {
  readonly admissions: string[] = [];

  override run<T>(
    scope: Readonly<AuthorCatalogScopeV1>,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.admissions.push(rfc64CatalogMutationScopeKeyV1(scope));
    return super.run(scope, operation, signal);
  }
}

describe('RFC-64 catalog mutation coordinator', () => {
  it('deduplicates and acquires multiple scopes in canonical order', async () => {
    const coordinator = new RecordingCatalogMutationCoordinatorV1();
    const alpha = catalogScope(`${AUTHOR}/alpha`);
    const omega = catalogScope(`${AUTHOR}/omega`);
    const expectedOrder = [
      rfc64CatalogMutationScopeKeyV1(alpha),
      rfc64CatalogMutationScopeKeyV1(omega),
    ].sort();

    await expect(coordinator.runMany(
      [omega, alpha, omega],
      async () => 'complete',
    )).resolves.toBe('complete');
    expect(coordinator.admissions).toEqual(expectedOrder);
    expect(coordinator.activeScopeCount).toBe(0);
  });

  it('holds every requested scope until the multi-scope operation completes', async () => {
    const coordinator = new RecordingCatalogMutationCoordinatorV1();
    const alpha = catalogScope(`${AUTHOR}/alpha`);
    const omega = catalogScope(`${AUTHOR}/omega`);
    const expectedOrder = [
      rfc64CatalogMutationScopeKeyV1(alpha),
      rfc64CatalogMutationScopeKeyV1(omega),
    ].sort();
    let releaseOperation!: () => void;
    let markOperationEntered!: () => void;
    const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const operationEntered = new Promise<void>((resolve) => { markOperationEntered = resolve; });
    const runMany = coordinator.runMany([omega, alpha, omega], async () => {
      markOperationEntered();
      await operationGate;
      return 'complete';
    });
    await operationEntered;
    expect(coordinator.admissions).toEqual(expectedOrder);

    let alphaContenderEntered = false;
    let omegaContenderEntered = false;
    const contenders = [
      coordinator.run(alpha, async () => { alphaContenderEntered = true; }),
      coordinator.run(omega, async () => { omegaContenderEntered = true; }),
    ];
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(alphaContenderEntered).toBe(false);
    expect(omegaContenderEntered).toBe(false);

    releaseOperation();
    await expect(runMany).resolves.toBe('complete');
    await expect(Promise.all(contenders)).resolves.toEqual([undefined, undefined]);
    expect(alphaContenderEntered).toBe(true);
    expect(omegaContenderEntered).toBe(true);
    expect(coordinator.activeScopeCount).toBe(0);
  });

  it('keeps every acquired scope locked after caller cancellation until physical completion', async () => {
    const coordinator = new Rfc64CatalogMutationCoordinatorV1();
    const alpha = catalogScope(`${AUTHOR}/alpha`);
    const omega = catalogScope(`${AUTHOR}/omega`);
    const controller = new AbortController();
    const abortReason = new Error('caller stopped waiting');
    let releaseOperation!: () => void;
    let markOperationEntered!: () => void;
    const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const operationEntered = new Promise<void>((resolve) => { markOperationEntered = resolve; });
    const canceled = coordinator.runMany([omega, alpha], async () => {
      markOperationEntered();
      await operationGate;
    }, controller.signal);
    await operationEntered;

    controller.abort(abortReason);
    await expect(canceled).rejects.toBe(abortReason);
    let alphaContenderEntered = false;
    let omegaContenderEntered = false;
    const contenders = [
      coordinator.run(alpha, async () => { alphaContenderEntered = true; }),
      coordinator.run(omega, async () => { omegaContenderEntered = true; }),
    ];
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(alphaContenderEntered).toBe(false);
    expect(omegaContenderEntered).toBe(false);

    releaseOperation();
    await expect(Promise.all(contenders)).resolves.toEqual([undefined, undefined]);
    expect(alphaContenderEntered).toBe(true);
    expect(omegaContenderEntered).toBe(true);
    expect(coordinator.activeScopeCount).toBe(0);
  });

  it('does not start an empty-scope operation for an already aborted caller', async () => {
    const coordinator = new Rfc64CatalogMutationCoordinatorV1();
    const controller = new AbortController();
    const abortReason = new Error('caller already stopped');
    let operationStarted = false;
    controller.abort(abortReason);

    await expect(coordinator.runMany([], async () => {
      operationStarted = true;
    }, controller.signal)).rejects.toBe(abortReason);
    expect(operationStarted).toBe(false);
    expect(coordinator.activeScopeCount).toBe(0);
  });
});
