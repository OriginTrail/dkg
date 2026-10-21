// SPDX-License-Identifier: Apache-2.0
import { rdfLiteralLexicalValue, assertSafeGraphIriForSparql, mq, lit, intLit } from './metadata-rdf-terms.js';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { LOCAL_TRUSTED_KA_CONTROLS_GRAPH } from '@origintrail-official/dkg-storage';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
const DKG = 'http://dkg.io/ontology/';
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const LOCAL_TRUSTED_KA_CONTROL_PREDICATES = new Set([
  `${DKG}accessPolicy`,
  `${DKG}allowedPeer`,
  `${DKG}publisherPeerId`,
]);
const LOCAL_TRUSTED_KA_ANCHOR_PREDICATES = new Set([
  `${DKG}assertionVersion`,
  `${DKG}merkleRoot`,
]);
const LOCAL_TRUSTED_KA_UAL_PREDICATE = `${DKG}kaUal`;
const LOCAL_TRUSTED_KA_SIDECAR_PREDICATES = new Set([
  ...LOCAL_TRUSTED_KA_CONTROL_PREDICATES,
  ...LOCAL_TRUSTED_KA_ANCHOR_PREDICATES,
]);

export interface LocallyTrustedKnowledgeAssetControlAnchor {
  readonly assertionVersion: string;
  readonly merkleRoot: Uint8Array;
}

export interface LocallyTrustedKnowledgeAssetControlEnvelope {
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
  publisherPeerId: string;
}

function readControlAnchor(
  quads: readonly Quad[],
  predicate: string,
  label: string,
): string {
  const values = [...new Set(
    quads.filter((quad) => quad.predicate === predicate).map((quad) => quad.object),
  )];
  if (values.length !== 1) {
    throw new Error(`Locally trusted KA controls require exactly one ${label}`);
  }
  return values[0]!;
}

function parseControlVersion(raw: string): bigint {
  const lexical = raw.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  if (!/^\d+$/.test(lexical)) throw new Error(`Invalid trusted-control assertionVersion: ${raw}`);
  return BigInt(lexical);
}

function normalizeControlRoot(raw: string): string {
  const lexical = raw.match(/^"([^"]*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  const root = lexical.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error(`Invalid trusted-control merkleRoot: ${raw}`);
  return root;
}

/**
 * Persist one validated local-control entry. Both the rolling-compatible
 * metadata-quad API and the typed envelope API terminate here; neither needs
 * to adapt through the other.
 */
async function writeLocallyTrustedKnowledgeAssetControlEntry(
  store: TripleStore,
  ual: string,
  version: bigint,
  root: string,
  sidecarQuads: readonly Quad[],
): Promise<void> {
  assertSafeGraphIriForSparql(ual);
  const entry = `${ual}/_local_controls/${version}/${root}`;
  assertSafeGraphIriForSparql(entry);
  const controls = sidecarQuads.map((quad) => ({
    ...quad,
    subject: entry,
    graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
  }));
  validateLocallyTrustedControlRows(controls);
  const storedVersion = parseControlVersion(
    readControlAnchor(controls, `${DKG}assertionVersion`, 'assertionVersion'),
  );
  const storedRoot = normalizeControlRoot(
    readControlAnchor(controls, `${DKG}merkleRoot`, 'merkleRoot'),
  );
  if (storedVersion !== version || storedRoot !== root) {
    throw new Error('Locally trusted KA control entry does not match its assertion anchor');
  }
  await store.insert([
    ...controls,
    {
      subject: entry,
      predicate: LOCAL_TRUSTED_KA_UAL_PREDICATE,
      object: ual,
      graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    },
  ]);
}

/** Select exact-anchor ownership once; admit trusted fallback controls only when requested. */
async function selectOrAdmitLocallyTrustedKnowledgeAssetControls(store: TripleStore, input: {
  metaGraph: string; ual: string; metadataQuads: readonly Quad[]; restoreMissing: boolean;
  anchor?: LocallyTrustedKnowledgeAssetControlAnchor;
}): Promise<Quad[]> {
  const { metaGraph, ual, metadataQuads, restoreMissing, anchor } = input;
  assertSafeGraphIriForSparql(metaGraph);
  const sidecarQuads = metadataQuads.filter(
    quad => quad.subject === ual && LOCAL_TRUSTED_KA_SIDECAR_PREDICATES.has(quad.predicate),
  );
  const version = parseControlVersion(readControlAnchor(sidecarQuads, `${DKG}assertionVersion`, 'assertionVersion'));
  const root = normalizeControlRoot(readControlAnchor(sidecarQuads, `${DKG}merkleRoot`, 'merkleRoot'));
  if (restoreMissing) validateLocallyTrustedControlRows(sidecarQuads);
  if (anchor && (version !== BigInt(anchor.assertionVersion) || root !== toHex(anchor.merkleRoot).toLowerCase())) {
    throw new Error('Locally trusted KA control entry does not match its assertion anchor');
  }
  // A curator must not replace or append to a member's authenticated exact-anchor owner.
  const entry = `${ual}/_local_controls/${version}/${root}`;
  const rows = (await readLocallyTrustedControlEntries(store, ual, {}, entry)).get(entry) ?? [];
  if (rows.length > 0) {
    validateLocallyTrustedControlRows(rows);
    if (parseControlVersion(readControlAnchor(rows, `${DKG}assertionVersion`, 'assertionVersion')) !== version
      || normalizeControlRoot(readControlAnchor(rows, `${DKG}merkleRoot`, 'merkleRoot')) !== root) {
      throw new Error('Locally trusted KA control entry does not match its assertion anchor');
    }
  }
  const selected = visibleControlRows(rows, ual, metaGraph);
  if (selected.length > 0 || !restoreMissing) return selected;
  await writeLocallyTrustedKnowledgeAssetControlEntry(store, ual, version, root, sidecarQuads);
  return visibleControlRows(sidecarQuads, ual, metaGraph);
}

/** Persist locally authored access controls outside sync-visible metadata. */
export async function replaceLocallyTrustedKnowledgeAssetControls(
  store: TripleStore, ual: string, metadataQuads: readonly Quad[],
): Promise<void> {
  await selectOrAdmitLocallyTrustedKnowledgeAssetControls(store, {
    metaGraph: metadataQuads[0]!.graph, ual, metadataQuads, restoreMissing: true,
  });
}

/** Apply already-selected controls without another lookup or inheritance decision. */
export function overlaySelectedKnowledgeAssetControls(metadata: readonly Quad[], selected: readonly Quad[]): Quad[] {
  if (selected.length === 0) return [...metadata];
  return [...metadata.filter(quad => !LOCAL_TRUSTED_KA_CONTROL_PREDICATES.has(quad.predicate)), ...selected];
}

/**
 * Replace one receiver-authenticated local control envelope directly. The
 * caller supplies only the assertion anchor and controls; visible KA metadata
 * is deliberately not part of this local-only persistence contract.
 */
export async function replaceLocallyTrustedKnowledgeAssetControlEnvelope(
  store: TripleStore,
  ual: string,
  anchor: LocallyTrustedKnowledgeAssetControlAnchor,
  controls: LocallyTrustedKnowledgeAssetControlEnvelope,
): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(ual, anchor.assertionVersion);
  if (anchor.merkleRoot.length !== 32) {
    throw new Error('Locally trusted KA controls require one 32-byte merkleRoot');
  }
  const graph = LOCAL_TRUSTED_KA_CONTROLS_GRAPH;
  const version = BigInt(scope.assertionVersion);
  const root = toHex(anchor.merkleRoot).toLowerCase();
  await writeLocallyTrustedKnowledgeAssetControlEntry(store, scope.ual, version, root, [
    mq(scope.ual, `${DKG}assertionVersion`, intLit(BigInt(scope.assertionVersion)), graph),
    mq(scope.ual, `${DKG}merkleRoot`, lit(root), graph),
    mq(scope.ual, `${DKG}accessPolicy`, lit(controls.accessPolicy), graph),
    mq(scope.ual, `${DKG}publisherPeerId`, lit(controls.publisherPeerId), graph),
    ...[...new Set(controls.allowedPeers)].sort().map((peerId) => (
      mq(scope.ual, `${DKG}allowedPeer`, lit(peerId), graph)
    )),
  ]);
}

function visibleControlRows(rows: readonly Quad[], ual: string, graph: string): Quad[] {
  return rows.filter(quad => LOCAL_TRUSTED_KA_CONTROL_PREDICATES.has(quad.predicate))
    .map(quad => ({ ...quad, subject: ual, graph }));
}

/** Exact recovery bounds the query to its canonical entry; ordinary overlays read history. */
async function readLocallyTrustedControlEntries(
  store: TripleStore, ual: string, options: QueryOptions, entry?: string,
): Promise<Map<string, Quad[]>> {
  assertSafeGraphIriForSparql(ual);
  if (entry !== undefined) assertSafeGraphIriForSparql(entry);
  const predicates = [...LOCAL_TRUSTED_KA_SIDECAR_PREDICATES]
    .map((predicate) => `<${predicate}>`)
    .join('\n');
  const result = await store.query(`
    SELECT ?entry ?predicate ?object WHERE {
      ${entry === undefined ? '' : `VALUES ?entry { <${entry}> }`}
      GRAPH <${LOCAL_TRUSTED_KA_CONTROLS_GRAPH}> {
        ?entry <${LOCAL_TRUSTED_KA_UAL_PREDICATE}> <${ual}> .
        ?entry ?predicate ?object .
        VALUES ?predicate { ${predicates} }
      }
    }
  `, options);
  if (result.type !== 'bindings') return new Map();
  const rowsByEntry = new Map<string, Quad[]>();
  for (const row of result.bindings) {
    const predicate = row.predicate?.replace(/^<|>$/g, '');
    if (
      !row.entry
      || !predicate
      || row.object === undefined
      || !LOCAL_TRUSTED_KA_SIDECAR_PREDICATES.has(predicate)
    ) {
      continue;
    }
    const subject = row.entry.replace(/^<|>$/g, '');
    const rows = rowsByEntry.get(subject) ?? [];
    rows.push({
      subject,
      predicate,
      object: row.object,
      graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    });
    rowsByEntry.set(subject, rows);
  }
  return rowsByEntry;
}

/** Read trusted local controls and remap them into the visible metadata commit. */
export async function readLocallyTrustedKnowledgeAssetControls(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  incomingMetadataQuads: readonly Quad[],
  options: QueryOptions = {},
): Promise<Quad[]> {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  const incomingVersion = parseControlVersion(
    readControlAnchor(incomingMetadataQuads, `${DKG}assertionVersion`, 'assertionVersion'),
  );
  const incomingRoot = normalizeControlRoot(
    readControlAnchor(incomingMetadataQuads, `${DKG}merkleRoot`, 'merkleRoot'),
  );
  const rowsByEntry = await readLocallyTrustedControlEntries(store, ual, options);
  const candidates: Array<{ version: bigint; rows: Quad[] }> = [];
  for (const rows of rowsByEntry.values()) {
    validateLocallyTrustedControlRows(rows);
    const sidecarVersion = parseControlVersion(
      readControlAnchor(rows, `${DKG}assertionVersion`, 'sidecar assertionVersion'),
    );
    const sidecarRoot = normalizeControlRoot(
      readControlAnchor(rows, `${DKG}merkleRoot`, 'sidecar merkleRoot'),
    );
    if (sidecarVersion > incomingVersion) continue;
    if (sidecarVersion === incomingVersion && sidecarRoot !== incomingRoot) continue;
    candidates.push({ version: sidecarVersion, rows });
  }
  if (candidates.length === 0) return [];
  const highestVersion = candidates.reduce(
    (highest, candidate) => candidate.version > highest ? candidate.version : highest,
    candidates[0]!.version,
  );
  const highest = candidates.filter((candidate) => candidate.version === highestVersion);
  if (highest.length !== 1) return [];
  return visibleControlRows(highest[0]!.rows, ual, metaGraph);
}

/** Resolve this KA's trusted sidecar and replace peer-provided control rows in one step. */
export async function overlayLocallyTrustedKnowledgeAssetControls(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  incomingMetadata: readonly Quad[],
  options: QueryOptions = {},
): Promise<Quad[]> {
  if (incomingMetadata.some((quad) => quad.subject !== ual || quad.graph !== metaGraph)) {
    throw new Error('Locally trusted KA control overlay requires one asset in one metadata graph');
  }
  const locallyTrustedControls = await readLocallyTrustedKnowledgeAssetControls(
    store,
    metaGraph,
    ual,
    incomingMetadata,
    options,
  );
  return overlaySelectedKnowledgeAssetControls(incomingMetadata, locallyTrustedControls);
}

/**
 * Read the local-only control sidecar through the publisher-owned RDF contract.
 * Consumers receive a typed envelope instead of duplicating predicate and
 * literal parsing rules outside this module.
 */
export async function readLocallyTrustedKnowledgeAssetControlEnvelope(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  incomingMetadataQuads: readonly Quad[],
  options: QueryOptions = {},
): Promise<LocallyTrustedKnowledgeAssetControlEnvelope | undefined> {
  const rows = await readLocallyTrustedKnowledgeAssetControls(
    store,
    metaGraph,
    ual,
    incomingMetadataQuads,
    options,
  );
  if (rows.length === 0) return undefined;

  const lexicalValues = (predicate: string): string[] => [...new Set(
    rows
      .filter((quad) => quad.predicate === predicate)
      .map((quad) => rdfLiteralLexicalValue(quad.object))
      .filter((value): value is string => value !== undefined),
  )];
  const policies = lexicalValues(`${DKG}accessPolicy`);
  const publishers = lexicalValues(`${DKG}publisherPeerId`);
  const allowedPeers = lexicalValues(`${DKG}allowedPeer`).sort();
  const accessPolicy = policies[0];
  if (
    policies.length !== 1
    || publishers.length !== 1
    || (
      accessPolicy !== 'public'
      && accessPolicy !== 'ownerOnly'
      && accessPolicy !== 'allowList'
    )
  ) {
    throw new Error('Locally trusted KA controls could not be decoded');
  }
  return {
    accessPolicy,
    allowedPeers,
    publisherPeerId: publishers[0]!,
  };
}

function validateLocallyTrustedControlRows(rows: readonly Quad[]): void {
  const values = (predicate: string) => [...new Set(
    rows.filter((quad) => quad.predicate === predicate).map((quad) => quad.object),
  )];
  const policies = values(`${DKG}accessPolicy`);
  const publishers = values(`${DKG}publisherPeerId`);
  const allowedPeers = values(`${DKG}allowedPeer`);
  if (policies.length !== 1 || !['"public"', '"ownerOnly"', '"allowList"'].includes(policies[0]!)) {
    throw new Error('Locally trusted KA controls require exactly one valid accessPolicy');
  }
  if (publishers.length !== 1 || !/^"(?:[^"\\]|\\.)+"$/.test(publishers[0]!)) {
    throw new Error('Locally trusted KA controls require exactly one publisherPeerId');
  }
  if (
    (policies[0] === '"allowList"' && allowedPeers.length === 0)
    || (policies[0] !== '"allowList"' && allowedPeers.length > 0)
    || allowedPeers.some((peer) => !/^"(?:[^"\\]|\\.)+"$/.test(peer))
  ) {
    throw new Error('Locally trusted KA controls have an invalid allowedPeer envelope');
  }
}

/** Caller holds the KA materialization lock. Select once, preserving exact-anchor local ownership. */
export async function reconcileConfirmedKnowledgeAssetControls(store: TripleStore, input: {
  metaGraph: string; ual: string; anchor: LocallyTrustedKnowledgeAssetControlAnchor;
  metadataQuads: readonly Quad[]; restoreMissing: boolean;
}): Promise<Quad[]> {
  const { metaGraph, ual, anchor, metadataQuads, restoreMissing } = input;
  if (metadataQuads.some(q => q.subject !== ual || q.graph !== metaGraph)) {
    throw new Error('Confirmed control reconciliation requires one asset in one metadata graph');
  }
  return selectOrAdmitLocallyTrustedKnowledgeAssetControls(store, {
    metaGraph, ual, anchor, metadataQuads, restoreMissing,
  });
}
