import {
  DKG_ONTOLOGY,
  contextGraphDataUri,
  partitionCatalogQuads,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

export type TrustedCatalogTripleKeys = ReadonlySet<string> | readonly string[] | undefined;

const FIELD_SEPARATOR = '\u0000';

function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function catalogTripleKey(q: Pick<Quad, 'subject' | 'predicate' | 'object'>): string {
  return `${q.subject}${FIELD_SEPARATOR}${q.predicate}${FIELD_SEPARATOR}${q.object}`;
}

export function trustedCatalogTripleKeySet(keys: TrustedCatalogTripleKeys): ReadonlySet<string> {
  if (!keys) return new Set<string>();
  if (keys instanceof Set) return keys;
  return new Set(keys);
}

export function generatedPrivateCatalogFloorQuads(
  contextGraphId: string,
  graph = '',
): Quad[] {
  const cgDid = contextGraphDataUri(contextGraphId);
  return [
    {
      subject: cgDid,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DCAT_DATASET,
      graph,
    },
    {
      subject: cgDid,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH,
      graph,
    },
    {
      subject: cgDid,
      predicate: DKG_ONTOLOGY.DCT_IDENTIFIER,
      object: literal(cgDid),
      graph,
    },
    {
      subject: cgDid,
      predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
      object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED,
      graph,
    },
  ];
}

export function generatedPrivateCatalogTripleKeys(contextGraphId: string): ReadonlySet<string> {
  return new Set(generatedPrivateCatalogFloorQuads(contextGraphId).map(catalogTripleKey));
}

export interface PrepareGeneratedPrivateCatalogFloorOptions {
  /** Graph term applied to newly generated floor quads. */
  graph?: string;
  /**
   * append-missing preserves immutable/legacy snapshots and fills only absent
   * deterministic triples. replace-generated rebuilds the recognized catalog
   * partition while retaining ordinary private data on the CG-DID subject.
   */
  mode?: 'append-missing' | 'replace-generated';
}

export interface PreparedGeneratedPrivateCatalogFloor {
  quads: Quad[];
  trustedNonManifestCatalogTriples: ReadonlySet<string>;
}

/**
 * Single preparation boundary for the deterministic private-CG catalog floor.
 *
 * Callers receive the publish quads and their exact trust allow-list together,
 * so queue, sync, and update paths cannot drift by generating one without the
 * other. This helper does not decide whether a CG is private; that security
 * decision remains with the live chain-policy resolver at each call site.
 */
export function prepareGeneratedPrivateCatalogFloor(
  contextGraphId: string,
  quads: readonly Quad[],
  options: PrepareGeneratedPrivateCatalogFloorOptions = {},
): PreparedGeneratedPrivateCatalogFloor {
  const floor = generatedPrivateCatalogFloorQuads(
    contextGraphId,
    options.graph ?? '',
  );
  const trustedNonManifestCatalogTriples = generatedPrivateCatalogTripleKeys(
    contextGraphId,
  );

  if (options.mode === 'replace-generated') {
    const { otherQuads } = partitionCatalogQuads(
      quads,
      contextGraphDataUri(contextGraphId),
    );
    return {
      quads: [...otherQuads, ...floor],
      trustedNonManifestCatalogTriples,
    };
  }

  const present = new Set(quads.map(catalogTripleKey));
  return {
    quads: [
      ...quads,
      ...floor.filter((quad) => !present.has(catalogTripleKey(quad))),
    ],
    trustedNonManifestCatalogTriples,
  };
}

export function assertTrustedCatalogTriplesAreGeneratedFloor(
  contextGraphId: string,
  keysInput: TrustedCatalogTripleKeys,
): void {
  const keys = trustedCatalogTripleKeySet(keysInput);
  if (keys.size === 0) return;

  const generated = generatedPrivateCatalogTripleKeys(contextGraphId);
  const invalid = [...keys].filter((key) => !generated.has(key));
  if (invalid.length > 0 || keys.size !== generated.size) {
    throw new Error(
      `trustedNonManifestCatalogTriples for context graph "${contextGraphId}" ` +
      'must exactly match the deterministic generated private-CG catalog floor triples',
    );
  }
}

export interface TrustedCatalogRootSplit {
  readonly contentRootMap: Map<string, Quad[]>;
  readonly generatedCatalogRootEntities: string[];
}

export function splitTrustedGeneratedCatalogRootMap(
  kaMap: ReadonlyMap<string, Quad[]>,
  trustedKeysInput: TrustedCatalogTripleKeys,
): TrustedCatalogRootSplit {
  const trustedKeys = trustedCatalogTripleKeySet(trustedKeysInput);
  const contentRootMap = new Map<string, Quad[]>();
  const generatedCatalogRootEntities: string[] = [];

  for (const [rootEntity, publicForRoot] of kaMap) {
    const trustedCount = publicForRoot.filter((q) => trustedKeys.has(catalogTripleKey(q))).length;
    if (trustedCount === 0) {
      contentRootMap.set(rootEntity, publicForRoot);
      continue;
    }
    const publicKeys = new Set(publicForRoot.map(catalogTripleKey));
    const isCompleteTrustedFloor =
      publicKeys.size === trustedKeys.size &&
      [...publicKeys].every((key) => trustedKeys.has(key));
    if (trustedCount === publicForRoot.length && isCompleteTrustedFloor) {
      generatedCatalogRootEntities.push(rootEntity);
      continue;
    }
    throw new Error(
      `Generated catalog subject "${rootEntity}" mixes trusted catalog triples ` +
      'with non-catalog triples; refusing to hide it from the KA manifest',
    );
  }

  return { contentRootMap, generatedCatalogRootEntities };
}
