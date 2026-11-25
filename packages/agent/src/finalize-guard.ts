// SPDX-License-Identifier: Apache-2.0
import { lifecycleFields } from './lifecycle-fields.js';
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
  if (!matches) refuseFinalizeMatch();
}

function refuseFinalizeMatch(): never {
  throw Object.assign(new Error('Finalize preconditions no longer match this draft'), {
    code: 'FINALIZE_PRECONDITION_FAILED',
  });
}

/** Inspect the unique stored owner, including legacy checksum spelling. LIMIT 1 in a display
 * descriptor is insufficient for a write authorization: conflicting controls must refuse. */
export async function readGuardedFinalizeLifecycle(
  store: TripleStore, guard: FinalizeGuard, cg: string, name: string, author: string, subGraph?: string,
): Promise<{
  author: string; number: bigint; reservedUal: string; persistedAssertionVersion?: string; hasConfirmedVm: boolean;
}> {
  const p = guard.expectedPredecessor;
  const ka = assertCanonicalDeterministicUalV1(p.reservedUal);
  requireFinalizeMatch(author.toLowerCase() === guard.expectedAuthorAddress &&
    contextGraphLayerUri(cg, MemoryLayer.WorkingMemory, ka.agentAddress, ka.kaNumber, subGraph) === guard.expectedWmAssertionGraph);
  const owners = await readAssertionLifecycleCandidates(store, cg, author, name, subGraph);
  requireFinalizeMatch(owners.length === 1);
  const owner = owners[0]!;
  const { one, literal } = lifecycleFields(owner.record.bindings, refuseFinalizeMatch);
  const dkg = 'http://dkg.io/ontology/';
  // Pull-from can retain the last sealed WM pointer after replacing its draft.
  // Check its storage representation; the target is proven from the actual quads.
  const previousSeal = literal('wmCurrentAssertion');
  requireFinalizeMatch(previousSeal === undefined || /^[0-9a-f]{64}$/i.test(previousSeal));
  const vm = literal('vmCurrentAssertion')?.toLowerCase();
  const swm = literal('swmCurrentAssertion')?.toLowerCase() ?? vm;
  requireFinalizeMatch(literal('assertionName') === name &&
    one('http://www.w3.org/ns/prov#wasAttributedTo')?.toLowerCase() === 'did:dkg:agent:' + guard.expectedAuthorAddress &&
    literal('contentScopeVersion', 'integer') === String(GRAPH_KA_CONTENT_SCOPE_VERSION) &&
    literal('state') === 'created' && literal('memoryLayer') === MemoryLayer.WorkingMemory &&
    owner.record.number?.toString() === ka.kaNumber && literal('reservedUal') === ka.ual &&
    swm === p.swmAssertionRoot.slice(2) && vm === p.vmAssertionRoot?.slice(2));
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
  const number = owner.record.number;
  requireFinalizeMatch(number !== undefined);
  return { author: owner.author, number, reservedUal: ka.ual,
    persistedAssertionVersion: literal('assertionVersion', 'integer'), hasConfirmedVm: vm !== undefined };
}
