// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KA_UAL = 'http://dkg.io/ontology/kaUal';
const SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';
const CONTEXT_GRAPH_ID = 'http://dkg.io/ontology/contextGraphId';
const WORKSPACE_OPERATION = 'http://dkg.io/ontology/WorkspaceOperation';
const SWM_HEAD_SUFFIX = '#dkg-swm-head';

export interface LegacySwmBoundaryFixtureV1 {
  readonly graph: string;
  readonly contextGraphId: string;
  readonly ual: string;
  readonly operation: string;
  readonly head?: {
    readonly subject?: string;
    readonly shareOperationId: string;
  };
  readonly operationShareOperationIds: readonly string[];
}

/** Canonical legacy SWM RDF shape shared by unit and live-backend tests. */
export function legacySwmBoundaryFixtureQuadsV1(
  fixture: LegacySwmBoundaryFixtureV1,
): Quad[] {
  const quads: Quad[] = [];
  if (fixture.head !== undefined) {
    const subject = fixture.head.subject ?? `${fixture.ual}${SWM_HEAD_SUFFIX}`;
    quads.push(
      { graph: fixture.graph, subject, predicate: KA_UAL, object: fixture.ual },
      {
        graph: fixture.graph,
        subject,
        predicate: SHARE_OPERATION_ID,
        object: JSON.stringify(fixture.head.shareOperationId),
      },
    );
  }
  quads.push(
    {
      graph: fixture.graph,
      subject: fixture.operation,
      predicate: RDF_TYPE,
      object: WORKSPACE_OPERATION,
    },
    {
      graph: fixture.graph,
      subject: fixture.operation,
      predicate: KA_UAL,
      object: fixture.ual,
    },
    ...fixture.operationShareOperationIds.map((shareOperationId) => ({
      graph: fixture.graph,
      subject: fixture.operation,
      predicate: SHARE_OPERATION_ID,
      object: JSON.stringify(shareOperationId),
    })),
    {
      graph: fixture.graph,
      subject: fixture.operation,
      predicate: CONTEXT_GRAPH_ID,
      object: JSON.stringify(fixture.contextGraphId),
    },
  );
  return quads;
}
