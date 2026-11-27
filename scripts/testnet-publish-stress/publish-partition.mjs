// Compact, deterministic blank-node label from a Wikidata URI.
// `http://www.wikidata.org/entity/Q66212` → `_:wd_Q66212`.
// Anything not Wikidata stays as a URI (rdf:type etc.).
function urlToBnodeLabel(uri) {
  const m = uri.match(/^https?:\/\/(?:www\.)?wikidata\.org\/entity\/([A-Z][0-9]+)$/);
  if (m) return `_:wd_${m[1]}`;
  return null;
}

function buildPartitionQuads(partition, cgId, stressRunId, partitionIdx) {
  // Anchor subject is the ONE non-blank root entity per partition.
  // `autoPartition` will skolemize every blank-node subject under this
  // anchor's namespace, so every Wikidata entity in this partition lives
  // inside this KA and doesn't pollute the CG-wide root-entity space
  // (which would trigger "Rule 4: rootEntity already exists" on overlap
  // with prior partitions).
  //
  // Anchor URI also encodes the partition idx so two partitions referencing
  // the same Wikidata entity skolemize them under different namespaces and
  // never collide on the KA-shaped path either.
  const idxStr = String(partitionIdx).padStart(6, '0');
  const anchor = `urn:dkg:stress:${stressRunId}:partition:${idxStr}`;
  const stressRun = `urn:dkg:stress:${stressRunId}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  const quads = [];
  const isoTs = new Date().toISOString();

  // Anchor metadata (3 quads)
  quads.push({
    subject: anchor,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: '<https://ontology.dkg.io/stress#PublishStressPartition>',
    graph,
  });
  quads.push({
    subject: anchor,
    predicate: 'https://ontology.dkg.io/stress#belongsTo',
    object: `<${stressRun}>`,
    graph,
  });
  quads.push({
    subject: anchor,
    predicate: 'http://purl.org/dc/terms/created',
    object: `"${isoTs}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
    graph,
  });

  // Track which Wikidata entities have been seen as a subject so we can
  // link each one directly to the anchor via `stress:contains`. Without
  // an anchor → blank-node-object edge, the skolemizer won't know which
  // root the blank node belongs to (see auto-partition.ts).
  const seenAsSubject = new Set();

  // Wikidata triples — convert URI subjects/objects to blank nodes scoped
  // to this partition. Predicates and non-Wikidata objects are preserved.
  for (const t of partition.triples) {
    const m = t.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)$/);
    if (!m) continue;
    const [, subjectUri, predicate, objectRaw] = m;
    const subjectBnode = urlToBnodeLabel(subjectUri);
    if (subjectBnode == null) continue;  // unexpected — skip silently

    // Anchor → contains → blank node (one edge per unique subject).
    if (!seenAsSubject.has(subjectBnode)) {
      seenAsSubject.add(subjectBnode);
      quads.push({
        subject: anchor,
        predicate: 'https://ontology.dkg.io/stress#contains',
        object: subjectBnode,
        graph,
      });
    }

    // Convert the object: if it's a Wikidata URI, swap to a blank node so
    // the skolemizer pulls it into the same KA; otherwise keep verbatim
    // (literal or non-Wikidata URI such as `<...wikidata.org/entity/Q5>`
    // is also Wikidata so it gets bnoded too).
    let objToken = objectRaw.trim();
    const angleMatch = objToken.match(/^<([^>]+)>$/);
    if (angleMatch) {
      const objBnode = urlToBnodeLabel(angleMatch[1]);
      if (objBnode != null) objToken = objBnode;
    }
    quads.push({
      subject: subjectBnode,
      predicate,
      object: objToken,
      graph,
    });
  }

  return { anchor, quads };
}

// -----------------------------------------------------------------------------
// Per-partition publish (returns { kaId, txHash, status, ms, error? })
// -----------------------------------------------------------------------------

export function createPartitionPublisher({ cgId, stressRunId, apiCall, sleep, log }) {
  return async function publishOnePartition(partition, partitionIdx, attempt = 0) {
  const startedAt = Date.now();
  // Assertion name — short, deterministic, URI-safe. Suffix with attempt
  // counter so retries after a successful create + failed publish don't
  // 409 on the next create call. The assertion-create endpoint rejects
  // duplicate names; retries need their own fresh name.
  const attemptSuffix = attempt > 0 ? `-r${attempt}` : '';
  const name = `stress-${stressRunId}-${String(partitionIdx).padStart(6, '0')}${attemptSuffix}`;
  const { anchor, quads } = buildPartitionQuads(partition, cgId, stressRunId, partitionIdx);

  // 1. Combined create + write + finalize + promote. The route requires
  //    `finalize: true` to allow `alsoShareSwm: true`, and `quads` to be present
  //    to allow `finalize: true` — exactly the bundle we want.
  const createRes = await apiCall('POST', '/api/knowledge-assets', {
    name,
    contextGraphId: cgId,
    quads,
    finalize: true,
    alsoShareSwm: true,
  }, { timeoutMs: 60_000 });
  const merkleRoot = createRes.seal?.merkleRoot ?? createRes.merkleRoot;

  // Brief pause so the promote's SWM gossip can reach peers before publish
  // asks them for storage ACKs. Empirically observed `MERKLE_MISMATCH_IN_SWM`
  // / `NO_DATA_IN_SWM` errors at quorum check when this is skipped on
  // 100+ quad payloads. 3 seconds covers the gossip round-trip on Base
  // Sepolia + libp2p with 5 connected cores.
  await sleep(3000);

  // 2. publish — SWM → VM. Returns kaId + txHash on success. The route's
  //    retryable authority 503 comes before anything is signed or sent, so the
  //    same publish is sent again rather than under a fresh name below.
  const publishRes = await apiCall('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
    contextGraphId: cgId,
  }, {
    timeoutMs: 180_000,
    retryPublishAuthority: true,
    onAuthorityRetry: ({ retry, delayMs }) => log(`[retry] partition=${partitionIdx} publish: authority unavailable, retry ${retry} in ${delayMs} ms`),
  });

  return {
    partitionIdx,
    name,
    anchor,
    merkleRoot,
    kaId: publishRes.kaId,
    txHash: publishRes.txHash,
    blockNumber: publishRes.blockNumber,
    status: publishRes.status,
    ms: Date.now() - startedAt,
  };
};
}
