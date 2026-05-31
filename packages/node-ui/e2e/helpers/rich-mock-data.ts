/**
 * Deterministic memory-layer fixture for Playwright route interception.
 * Mirrors V10 named-graph layout used by `useMemoryEntities` SPARQL queries.
 */

export const PHARMA_CG_ID = 'cg:pharma-drug-interactions';
export const CLIMATE_CG_ID = 'cg:climate-science';
export const SUPPLY_CG_ID = 'cg:supply-chain-eu';

export const EDGE_CG_IDS = [PHARMA_CG_ID, SUPPLY_CG_ID] as const;
export const CORE_CG_IDS = [CLIMATE_CG_ID] as const;

export interface SparqlBinding {
  s: { value: string; type: 'uri' };
  p: { value: string; type: 'uri' };
  o: { value: string; type: 'uri' | 'literal' };
  g: { value: string; type: 'uri' };
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const INTERACTS = 'http://dkg.io/ontology/pharma/interactsWith';
const ENTITY_TYPE = 'http://dkg.io/ontology/pharma/Drug';

function uri(v: string) {
  return { value: v, type: 'uri' as const };
}

function lit(v: string) {
  return { value: v, type: 'literal' as const };
}

function binding(
  s: string,
  p: string,
  o: string,
  g: string,
  oIsLiteral = false,
): SparqlBinding {
  return {
    s: uri(s),
    p: uri(p),
    o: oIsLiteral ? lit(o) : uri(o),
    g: uri(g),
  };
}

/** WM assertion graphs — per-agent drafts under /assertion/ */
export function wmBindings(cgId: string): SparqlBinding[] {
  const base = `did:dkg:context-graph:${cgId}`;
  const wmGraph = `${base}/entities/assertion/0x1111111111111111111111111111111111111111/pharma-draft`;
  const drugA = `${base}/entities/drug/warfarin`;
  const drugB = `${base}/entities/drug/aspirin`;
  return [
    binding(drugA, RDF_TYPE, ENTITY_TYPE, wmGraph),
    binding(drugA, RDFS_LABEL, 'Warfarin', wmGraph, true),
    binding(drugB, RDF_TYPE, ENTITY_TYPE, wmGraph),
    binding(drugB, RDFS_LABEL, 'Aspirin', wmGraph, true),
    binding(drugA, INTERACTS, drugB, wmGraph),
  ];
}

/** SWM — promoted shared memory graphs ending in /_shared_memory */
export function swmBindings(cgId: string): SparqlBinding[] {
  const base = `did:dkg:context-graph:${cgId}`;
  const swmGraph = `${base}/entities/_shared_memory`;
  const drugA = `${base}/entities/drug/warfarin`;
  const drugB = `${base}/entities/drug/aspirin`;
  return [
    binding(drugA, RDF_TYPE, ENTITY_TYPE, swmGraph),
    binding(drugA, RDFS_LABEL, 'Warfarin', swmGraph, true),
    binding(drugB, RDF_TYPE, ENTITY_TYPE, swmGraph),
    binding(drugB, RDFS_LABEL, 'Aspirin', swmGraph, true),
    binding(drugA, INTERACTS, drugB, swmGraph),
  ];
}

/** VM — committed per-sub-graph and root content graphs */
export function vmBindings(cgId: string): SparqlBinding[] {
  const base = `did:dkg:context-graph:${cgId}`;
  const vmGraph = `${base}/entities`;
  const drugA = `${base}/entities/drug/warfarin`;
  const drugB = `${base}/entities/drug/aspirin`;
  return [
    binding(drugA, RDF_TYPE, ENTITY_TYPE, vmGraph),
    binding(drugA, RDFS_LABEL, 'Warfarin', vmGraph, true),
    binding(drugB, RDF_TYPE, ENTITY_TYPE, vmGraph),
    binding(drugB, RDFS_LABEL, 'Aspirin', vmGraph, true),
    binding(drugA, INTERACTS, drugB, vmGraph),
  ];
}

/** Profile SELECT bindings for `useProjectProfile` sub-graph query */
export function profileSubGraphSelectBindings(_cgId: string): Array<Record<string, { value: string; type: string }>> {
  return [
    {
      slug: { value: 'entities', type: 'literal' },
      displayName: { value: 'Entities', type: 'literal' },
      description: { value: 'Core drug entities', type: 'literal' },
      icon: { value: '⬡', type: 'literal' },
      color: { value: '#38bdf8', type: 'literal' },
      rank: { value: '1', type: 'literal' },
    },
  ];
}

/** Legacy triple-shaped meta bindings under `.../meta` graphs (profile parser path). */
export function profileMetaBindings(cgId: string): SparqlBinding[] {
  const base = `did:dkg:context-graph:${cgId}`;
  const metaGraph = `${base}/meta/profile`;
  const sg = `${base}/meta/subgraph/entities`;
  const PROFILE = 'http://dkg.io/ontology/profile/';
  return [
    binding(sg, `${PROFILE}SubGraphBinding`, `${PROFILE}SubGraphBinding`, metaGraph),
    binding(sg, `${PROFILE}forSubGraph`, 'entities', metaGraph, true),
    binding(sg, `${PROFILE}displayName`, 'Entities', metaGraph, true),
    binding(sg, `${PROFILE}icon`, '⬡', metaGraph, true),
    binding(sg, `${PROFILE}color`, '#38bdf8', metaGraph, true),
    binding(sg, `${PROFILE}rank`, '1', metaGraph, true),
  ];
}

export interface SubGraphListItem {
  name: string;
  uri: string;
  description?: string;
  entityCount: number;
  tripleCount: number;
}

export function subGraphList(cgId: string): { contextGraphId: string; subGraphs: SubGraphListItem[] } {
  const base = `did:dkg:context-graph:${cgId}`;
  return {
    contextGraphId: cgId,
    subGraphs: [
      {
        name: 'entities',
        uri: `${base}/entities`,
        description: 'Core drug entities',
        entityCount: 2,
        tripleCount: 5,
      },
      {
        name: 'decisions',
        uri: `${base}/decisions`,
        description: 'Clinical decisions',
        entityCount: 0,
        tripleCount: 0,
      },
    ],
  };
}

/** Expected triple totals per layer for pharma fixture */
export const PHARMA_LAYER_TRIPLE_COUNTS = {
  wm: 5,
  swm: 5,
  vm: 5,
  total: 15,
} as const;
