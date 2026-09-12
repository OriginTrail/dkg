// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityIndexRevisionReader } from
  '@origintrail-official/dkg-chain';

import {
  mapRfc64CatalogAuthorityRevisionsToLocalV1,
  projectRfc64CatalogAuthorityRevisionTargetsV1,
} from './catalog-authority-revision-projection-v1.js';
import {
  Rfc64CatalogAuthorityRefreshLoopV1,
  Rfc64CatalogAuthorityRevisionReadFailureV1,
  type Rfc64CatalogAuthorityRefreshResultV1,
  type Rfc64CatalogAuthorityRefreshSchedulerV1,
  type Rfc64CatalogAuthorityRevisionReadV1,
  type Rfc64CatalogAuthorityRevisionSourceV1,
} from './catalog-authority-refresh-loop-v1.js';
import {
  selectRfc64CatalogAuthorityRefreshWorkloadV1,
  type Rfc64CatalogAuthorityRefreshCandidateV1,
} from './catalog-rollout-authority-v1.js';
import type { Rfc64CatalogExecutionPlanV1 } from
  './public-catalog-activation-config-v1.js';

export interface Rfc64CatalogAuthorityRevisionSourceBindingV1 {
  readonly revisionReader?: ContextGraphAuthorityIndexRevisionReader;
  readonly resolveBinding: (contextGraphId: string) => string | undefined;
  readonly runAuthorityRead: <T>(
    signal: AbortSignal,
    read: (signal: AbortSignal | undefined) => Promise<T>,
  ) => Promise<T>;
}

/** Build the paired local projection and physical lifecycle capability. */
export function createRfc64CatalogAuthorityRevisionSourceV1(
  binding: Rfc64CatalogAuthorityRevisionSourceBindingV1,
): Rfc64CatalogAuthorityRevisionSourceV1 | undefined {
  const reader = binding.revisionReader;
  if (reader === undefined) return undefined;
  return Object.freeze({
    read: async (
      contextGraphIds: readonly string[],
      signal: AbortSignal,
    ): Promise<Rfc64CatalogAuthorityRevisionReadV1> => {
      const targets = projectRfc64CatalogAuthorityRevisionTargetsV1(
        contextGraphIds,
        binding.resolveBinding,
      );
      const fallbackContextGraphIds = new Set(contextGraphIds);
      for (const localContextGraphIds of targets.localContextGraphIdsByOnChainId.values()) {
        for (const contextGraphId of localContextGraphIds) {
          fallbackContextGraphIds.delete(contextGraphId);
        }
      }
      if (targets.onChainContextGraphIds.length === 0) return new Map();
      let revisions: Awaited<ReturnType<
        typeof reader.readContextGraphAuthorityIndexRevisions
      >>;
      try {
        revisions = await binding.runAuthorityRead(
          signal,
          (readSignal) => reader.readContextGraphAuthorityIndexRevisions(
            targets.onChainContextGraphIds,
            { signal: readSignal },
          ),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Rfc64CatalogAuthorityRevisionReadFailureV1(
          error,
          fallbackContextGraphIds,
        );
      }
      return mapRfc64CatalogAuthorityRevisionsToLocalV1(
        revisions,
        targets.localContextGraphIdsByOnChainId,
      );
    },
    whenIdle: () => reader.whenIdle(),
  });
}

export interface Rfc64CatalogAuthorityRefreshBindingV1 {
  readonly executionPlan: Rfc64CatalogExecutionPlanV1;
  readonly readResponsibilities:
    () => readonly Rfc64CatalogAuthorityRefreshCandidateV1[];
  readonly revisionSource: Rfc64CatalogAuthorityRevisionSourceBindingV1;
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<Rfc64CatalogAuthorityRefreshResultV1>;
  readonly onActiveContextGraphIdsReadFailure: (error: unknown) => void;
  readonly onAuthorityRevisionsReadFailure: (error: unknown) => void;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
}

/** Bind construction-only authority selection, revision, and lane wiring. */
export function createRfc64CatalogAuthorityRefreshOwnerV1(
  binding: Rfc64CatalogAuthorityRefreshBindingV1,
): Rfc64CatalogAuthorityRefreshLoopV1 {
  return new Rfc64CatalogAuthorityRefreshLoopV1({
    readActiveContextGraphIds: () => selectRfc64CatalogAuthorityRefreshWorkloadV1(
      binding.executionPlan,
      binding.readResponsibilities(),
    ).map(({ contextGraphId }) => contextGraphId),
    authorityRevisionSource: createRfc64CatalogAuthorityRevisionSourceV1(
      binding.revisionSource,
    ),
    refreshContextGraph: binding.refreshContextGraph,
    onActiveContextGraphIdsReadFailure: binding.onActiveContextGraphIdsReadFailure,
    onAuthorityRevisionsReadFailure: binding.onAuthorityRevisionsReadFailure,
    onRefreshFailure: binding.onRefreshFailure,
    ...(binding.scheduler === undefined ? {} : { scheduler: binding.scheduler }),
  });
}
