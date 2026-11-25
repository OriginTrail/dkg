// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import {
  assertCanonicalDeterministicUalV1, assertSafeIri, contextGraphLayerUri, contextGraphMetaUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer,
} from '@origintrail-official/dkg-core';
import { readAssertionLifecycleCandidates } from '@origintrail-official/dkg-publisher';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Required local facts for sealing an existing working copy of a shared asset. */
export interface FinalizeGuard {
  readonly expectedAuthorAddress: string;
  readonly expectedWmAssertionGraph: string;
  readonly expectedPredecessor: {
    readonly reservedUal: string;
    readonly swmAssertionRoot: string;
    readonly vmAssertionRoot?: string;
    readonly shareOperationId?: string;
  };
  readonly expectedTarget: {
    readonly merkleRoot: string;
    readonly publicTripleCount: number;
    readonly privateTripleCount: number;
  };
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseFinalizeGuard(input: unknown): FinalizeGuard {
  if (!record(input)) throw new Error('Invalid finalize guard');
  const p = input.expectedPredecessor;
  const t = input.expectedTarget;
  if (!record(p) || !record(t) || !digest(t.merkleRoot) || !digest(p.swmAssertionRoot)
    || Object.keys(p).some(key => !['reservedUal', 'swmAssertionRoot', 'vmAssertionRoot', 'shareOperationId'].includes(key))
    || Object.keys(t).some(key => !['merkleRoot', 'publicTripleCount', 'privateTripleCount'].includes(key))
    || (p.vmAssertionRoot !== undefined && !digest(p.vmAssertionRoot))
    || (p.shareOperationId !== undefined && (typeof p.shareOperationId !== 'string' || !/^[A-Za-z0-9._:~-]{1,256}$/.test(p.shareOperationId)))
    || !count(t.publicTripleCount) || !count(t.privateTripleCount) || !(t.publicTripleCount || t.privateTripleCount)
    || typeof input.expectedAuthorAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input.expectedAuthorAddress)
    || typeof input.expectedWmAssertionGraph !== 'string' || input.expectedWmAssertionGraph.length > 2048) {
    throw new Error('Invalid finalize preconditions');
  }
  const ka = assertCanonicalDeterministicUalV1(p.reservedUal);
  const author = ethers.getAddress(input.expectedAuthorAddress).toLowerCase();
  if (ka.agentAddress !== author) throw new Error('Expected author and asset disagree');
  return {
    expectedAuthorAddress: author,
    expectedWmAssertionGraph: assertSafeIri(input.expectedWmAssertionGraph),
    expectedPredecessor: {
      reservedUal: ka.ual, swmAssertionRoot: p.swmAssertionRoot,
      ...(p.vmAssertionRoot !== undefined ? { vmAssertionRoot: p.vmAssertionRoot } : {}),
      ...(p.shareOperationId !== undefined ? { shareOperationId: p.shareOperationId } : {}),
    },
    expectedTarget: { merkleRoot: t.merkleRoot, publicTripleCount: t.publicTripleCount, privateTripleCount: t.privateTripleCount },
  };
}

export function requireFinalizeMatch(matches: boolean): asserts matches {
  if (!matches) throw Object.assign(new Error('The working draft no longer matches the finalize preconditions'), {
    code: 'FINALIZE_PRECONDITION_FAILED',
  });
}

/** Inspect the unique stored owner, including legacy checksum spelling. LIMIT 1 in a display
 * descriptor is insufficient for a write authorization: conflicting controls must refuse. */
export async function readGuardedDraftOwner(
  store: TripleStore, guard: FinalizeGuard, cg: string, name: string, author: string, subGraph?: string,
): Promise<string> {
  const p = guard.expectedPredecessor;
  const ka = assertCanonicalDeterministicUalV1(p.reservedUal);
  requireFinalizeMatch(author.toLowerCase() === guard.expectedAuthorAddress &&
    contextGraphLayerUri(cg, MemoryLayer.WorkingMemory, ka.agentAddress, ka.kaNumber, subGraph) === guard.expectedWmAssertionGraph);
  const owners = await readAssertionLifecycleCandidates(store, cg, author, name, subGraph);
  requireFinalizeMatch(owners.length === 1);
  const owner = owners[0]!;
  const one = (key: string) => {
    const rows = owner.record.bindings.filter(row => row.p === key);
    requireFinalizeMatch(rows.length <= 1);
    return rows[0]?.o;
  };
  const dkg = 'http://dkg.io/ontology/';
  const literal = (key: string) => {
    const raw = one(dkg + key);
    if (raw === undefined) return undefined;
    const term = parseRdfLiteralTerm(raw);
    requireFinalizeMatch(!!term && term.kind !== 'language' && (term.kind !== 'typed' ||
      term.datatype === 'http://www.w3.org/2001/XMLSchema#' + (key === 'contentScopeVersion' ? 'integer' : 'string')));
    return term.value;
  };
  const vm = literal('vmCurrentAssertion')?.toLowerCase();
  const swm = literal('swmCurrentAssertion')?.toLowerCase() ?? vm;
  const wm = literal('wmCurrentAssertion')?.toLowerCase();
  requireFinalizeMatch(literal('assertionName') === name &&
    one('http://www.w3.org/ns/prov#wasAttributedTo')?.toLowerCase() === 'did:dkg:agent:' + guard.expectedAuthorAddress &&
    literal('contentScopeVersion') === String(GRAPH_KA_CONTENT_SCOPE_VERSION) &&
    literal('state') === 'created' && literal('memoryLayer') === MemoryLayer.WorkingMemory &&
    owner.record.number?.toString() === ka.kaNumber && literal('reservedUal') === ka.ual &&
    swm === p.swmAssertionRoot.slice(2) && vm === p.vmAssertionRoot?.slice(2) &&
    (wm === undefined || wm === swm || wm === guard.expectedTarget.merkleRoot.slice(2)));
  const operation = literal('shareOperationId');
  if (operation !== undefined) requireFinalizeMatch(operation === p.shareOperationId);
  // The transient operation field can be trimmed while its promoted event survives.
  const graph = assertSafeIri(contextGraphMetaUri(cg));
  const events = await store.query(`SELECT DISTINCT ?time ?op WHERE { GRAPH <${graph}> {
    ?event <http://www.w3.org/ns/prov#used> <${owner.subject}> ;
           a <${dkg}AssertionPromoted> ; <http://www.w3.org/ns/prov#startedAtTime> ?time ;
           <${dkg}shareOperationId> ?op .
  } } ORDER BY DESC(?time) LIMIT 2`, { source: 'agent.finalizeGuard.promotedOperation' });
  requireFinalizeMatch(events.type === 'bindings');
  const [latest, previous] = events.bindings;
  if (latest) {
    requireFinalizeMatch(typeof latest.time === 'string' && latest.time !== previous?.time && typeof latest.op === 'string');
    const op = parseRdfLiteralTerm(latest.op);
    requireFinalizeMatch(!!op && (op.kind === 'plain' || (op.kind === 'typed' &&
      op.datatype === 'http://www.w3.org/2001/XMLSchema#string')) && op.value === p.shareOperationId);
  } else {
    requireFinalizeMatch(p.shareOperationId === operation);
  }
  return owner.author;
}
