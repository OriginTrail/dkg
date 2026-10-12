// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { contextGraphMetaGraphUri, DKG_ONTOLOGY, MemoryLayer } from '@origintrail-official/dkg-core';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDurableMetaPlan } from '../src/sync/responder/durable-meta-plan.js';
import { readDurableMetaPage } from '../src/sync/responder/graph-plan.js';

const URL = process.env.BLAZEGRAPH_TEST_URL;
const CG = `durable-meta-plan-live-${randomUUID()}`;
const CG_ENTITY = `did:dkg:context-graph:${CG}`;
const GRAPH = contextGraphMetaGraphUri(CG);
const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const VM = `"${MemoryLayer.VerifiableMemory}"`;
const WM = `"${MemoryLayer.WorkingMemory}"`;
const DELEGATION_PREFIX = `did:dkg:agent-delegation:${CG}:`;

function q(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: GRAPH };
}

function descriptor(index: number, status: string): Quad[] {
  const ual = `did:dkg:base:84532/0x${'1'.repeat(40)}/${index}`;
  return [
    q(ual, `${DKG}contentScopeVersion`, `"2"^^<${XSD}integer>`),
    q(ual, `${DKG}status`, `"${status}"`),
    q(ual, `${DKG}kaUal`, ual),
    q(ual, `${DKG}assertionVersion`, `"1"^^<${XSD}integer>`),
    q(ual, `${DKG}merkleRoot`, `"root-${index}"`),
  ];
}

// One subject per admission branch, and one per way of not being admitted.
// Agent-delegation subjects have their own cases below.
const ADMITTED: Quad[] = [
  q(CG_ENTITY, 'http://schema.org/name', '"root"'),
  q(CG_ENTITY, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '"0xAcTiVe"'),
  q(CG_ENTITY, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '"0xReVoKeD"'),
  q(CG_ENTITY, DKG_ONTOLOGY.DKG_REVOKED_AGENT, '"0xREVOKED"'),
  q('did:dkg:activity:one', `${DKG}note`, '"activity"'),
  q('urn:lifecycle:vm', `${DKG}memoryLayer`, VM),
  q('urn:lifecycle:vm', `${DKG}assertionGraph`, 'urn:assertion-graph:1'),
  q('urn:lifecycle:vm', `${DKG}assertionName`, '"named"'),
  q('urn:assertion-graph:1', `${DKG}label`, '"assertion graph row"'),
  q('urn:event:generated', 'http://www.w3.org/ns/prov#generated', 'urn:lifecycle:vm'),
  q(`${CG_ENTITY}/assertion/0xabc/named`, `${DKG}label`, '"assertion name row"'),
  ...descriptor(1, 'confirmed'),
  ...descriptor(2, 'confirmed'),
  ...descriptor(3, 'confirmed'),
];
const ACTIVE_DELEGATION = `${DELEGATION_PREFIX}0xactive`;
const DELEGATIONS: Quad[] = [
  q(ACTIVE_DELEGATION, DKG_ONTOLOGY.DKG_DELEGATION_AGENT, '"0xactive"'),
  q(`${DELEGATION_PREFIX}0xrevoked`, DKG_ONTOLOGY.DKG_DELEGATION_AGENT, '"0xrevoked"'),
  q(`${DELEGATION_PREFIX}0xorphaned`, DKG_ONTOLOGY.DKG_DELEGATION_AGENT, '"0xorphaned"'),
];
const NOT_ADMITTED: Quad[] = [
  q('did:dkg:join-request:one', `${DKG}memoryLayer`, VM),
  q('urn:lifecycle:wm', `${DKG}memoryLayer`, WM),
  q('urn:lifecycle:wm', `${DKG}assertionGraph`, 'urn:assertion-graph:wm'),
  q('urn:lifecycle:wm', `${DKG}assertionName`, '"working"'),
  q('urn:assertion-graph:wm', `${DKG}label`, '"assertion graph of a working-memory lifecycle"'),
  q('urn:event:working', 'http://www.w3.org/ns/prov#generated', 'urn:lifecycle:wm'),
  q(`${CG_ENTITY}/assertion/0xabc/working`, `${DKG}label`, '"named only by a working-memory lifecycle"'),
  q(`${CG_ENTITY}/assertion/0xabc/unnamed`, `${DKG}label`, '"no lifecycle has this name"'),
  q('urn:noise', `${DKG}label`, '"noise"'),
  ...descriptor(4, 'tentative'),
];

const isDelegation = (subject: string): boolean => subject.startsWith(DELEGATION_PREFIX);

describe('durable metadata paged from a session plan (live Blazegraph)', () => {
  let store: BlazegraphStore;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>>;

  beforeAll(async () => {
    if (!URL) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(URL) });
    handles = await manager.acquireMany([CG]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 15_000 });
    await store.insert([...ADMITTED, ...DELEGATIONS, ...NOT_ADMITTED]);
  });

  afterAll(async () => {
    if (store) await store.close();
    if (handles) await manager.disposeAll(handles);
  });

  const buildPlan = () => buildDurableMetaPlan({
    store,
    contextGraphId: CG,
    registeredSubGraphNames: [],
    budgetKey: 'live',
  });

  it('plans exactly the admitted subjects with their row counts', async () => {
    const plan = await buildPlan();
    const expected = new Map<string, number>();
    for (const quad of ADMITTED) expected.set(quad.subject, (expected.get(quad.subject) ?? 0) + 1);
    const planned = plan.subjects.filter((entry) => !isDelegation(entry.subject));
    expect(new Map(planned.map((entry) => [entry.subject, entry.rowCount]))).toEqual(expected);
    expect(plan.blankNodeRows).toBe(0);
    expect(plan.totalRows).toBe(plan.subjects.reduce((rows, entry) => rows + entry.rowCount, 0));
  });

  it('never plans the delegation of a revoked or an unknown agent', async () => {
    const delegations = (await buildPlan()).subjects.map((entry) => entry.subject).filter(isDelegation);
    expect(delegations.filter((subject) => subject !== ACTIVE_DELEGATION)).toEqual([]);
  });

  // Known difference of this store, the same before the plan lane: its
  // store-side delegation test admits no subject (#3186). This case becomes an
  // ordinary one when the two stores agree.
  it.fails('plans the delegation of an active member (#3186)', async () => {
    const delegations = (await buildPlan()).subjects.map((entry) => entry.subject).filter(isDelegation);
    expect(delegations).toEqual([ACTIVE_DELEGATION]);
  });

  it('serves every admitted row once, in pages of whole subjects', async () => {
    const pages: Array<Array<{ s: string; p: string; o: string }>> = [];
    for (let offset = 0, guard = 0; guard < 50; guard += 1) {
      const rows = await readDurableMetaPage({
        store,
        contextGraphId: CG,
        registeredSubGraphNames: [],
        offset,
        limit: 4,
      });
      if (rows.length === 0) break;
      pages.push(rows.map(({ s, p, o }) => ({ s, p, o })));
      offset += rows.length;
    }
    const served = pages.flat();
    const outsideDelegations = served.filter((row) => !isDelegation(row.s));
    expect(new Set(outsideDelegations.map(({ s, p, o }) => JSON.stringify([s, p, o]))))
      .toEqual(new Set(ADMITTED.map(({ subject, predicate, object }) => JSON.stringify([subject, predicate, object]))));
    expect(outsideDelegations).toHaveLength(ADMITTED.length);
    expect(served.filter((row) => isDelegation(row.s) && row.s !== ACTIVE_DELEGATION)).toEqual([]);
    const pageOfSubject = new Map<string, number>();
    pages.forEach((page, index) => {
      for (const row of page) {
        expect(pageOfSubject.get(row.s) ?? index).toBe(index);
        pageOfSubject.set(row.s, index);
      }
    });
  });
});
