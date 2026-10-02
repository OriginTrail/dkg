// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  tryUpdateWithTouchedGraphs,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

export type LocalContextGraphRegistrationStatus =
  | 'unregistered'
  | 'pending'
  | 'registered';

export interface LocalContextGraphRegistrationStatusStoreOptions {
  readonly store: TripleStore;
  readonly markProjectionDirty: (contextGraphId: string) => void;
}

function stripRegistrationStatusLiteral(value: string): string {
  return value.replace(/^"|"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/gu, '');
}

/**
 * One storage boundary for the registration-status state machine.
 *
 * Atomic stores replace the value in one UPDATE. Compatibility stores install
 * and flush the new fence before retiring prior values, so interruption can
 * leave an explicit multi-value `pending` state but never a local-first gap.
 */
export class LocalContextGraphRegistrationStatusStore {
  readonly #store: TripleStore;
  readonly #markProjectionDirty: (contextGraphId: string) => void;

  constructor(options: LocalContextGraphRegistrationStatusStoreOptions) {
    this.#store = options.store;
    this.#markProjectionDirty = options.markProjectionDirty;
  }

  async read(contextGraphId: string): Promise<LocalContextGraphRegistrationStatus | null> {
    const graph = contextGraphMetaGraphUri(contextGraphId);
    const subject = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.#store.query(
      `SELECT ?status WHERE { GRAPH <${graph}> { <${subject}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } }`,
      { source: 'agent.contextGraph.registrationStatus' },
    );
    if (result.type !== 'bindings') return null;
    const statuses = new Set(result.bindings
      .map((binding) => binding['status'])
      .filter((status): status is string => status !== undefined)
      .map(stripRegistrationStatusLiteral));
    if (statuses.size !== 1) return statuses.size > 1 ? 'pending' : null;
    const status = [...statuses][0];
    return status === 'registered' || status === 'unregistered' || status === 'pending'
      ? status
      : null;
  }

  async set(
    contextGraphId: string,
    status: LocalContextGraphRegistrationStatus,
  ): Promise<void> {
    const graph = contextGraphMetaGraphUri(contextGraphId);
    const subject = `did:dkg:context-graph:${contextGraphId}`;
    const statusQuad: Quad = {
      subject,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
      object: `"${status}"`,
      graph,
    };
    const updatedAtomically = await tryUpdateWithTouchedGraphs(
      this.#store,
      `DELETE {
        GRAPH <${graph}> {
          <${subject}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?previousStatus
        }
      }
      INSERT {
        GRAPH <${graph}> {
          <${subject}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> "${status}"
        }
      }
      WHERE {
        OPTIONAL {
          GRAPH <${graph}> {
            <${subject}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?previousStatus
          }
        }
      }`,
      [graph],
      { source: 'agent.contextGraph.registrationStatus.persist' },
    );
    if (!updatedAtomically) {
      const previousResult = await this.#store.query(
        `SELECT ?status WHERE {
          GRAPH <${graph}> {
            <${subject}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status
          }
        }`,
        { source: 'agent.contextGraph.registrationStatus.previous' },
      );
      const previousQuads = previousResult.type === 'bindings'
        ? previousResult.bindings
          .map((binding) => binding['status'])
          .filter((object): object is string => (
            object !== undefined && object !== statusQuad.object
          ))
          .map((object): Quad => ({ ...statusQuad, object }))
        : [];
      await this.#store.insert([statusQuad], {
        source: 'agent.contextGraph.registrationStatus.install',
      });
      this.#markProjectionDirty(contextGraphId);
      await this.#store.flush?.();
      if (previousQuads.length > 0) {
        await this.#store.delete(previousQuads, {
          source: 'agent.contextGraph.registrationStatus.retirePrevious',
        });
      }
    }
    this.#markProjectionDirty(contextGraphId);
    await this.#store.flush?.();
  }
}
