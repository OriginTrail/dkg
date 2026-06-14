/**
 * useEntityOnChainReceipt — resolves the REAL on-chain identity of a single
 * graph entity (UAL, transaction hash, block number, packed KA id, author).
 *
 * Unlike `useVerifiedEntityIdentity` (which surfaces the *synthetic*
 * WorkspaceOperation op-id as a UAL placeholder), this hook reads the genuine
 * blockchain receipt the publisher persists at publish time:
 *
 *   • `buildAssertionPublishReceiptQuads` (packages/core/src/assertion-seal.ts)
 *     writes, keyed by the FULL assertion URI, into the context-graph `_meta`:
 *        <assertionUri>  dkg:publishedAtTx        "0x…"            (real tx hash)
 *        <assertionUri>  dkg:publishedAtBlock     "N"^^xsd:integer
 *        <assertionUri>  dkg:assertionFinalizedAt "…"^^xsd:dateTime
 *     (`dkg:publishedAtKaId` is legacy — RFC ka-metadata-trim Phase 2 stopped
 *      writing it; the packed id is read off the UAL subject's `dkg:batchId`
 *      row instead, read-both with old-store receipt rows.)
 *   • the assertion lifecycle URN, in the SAME `_meta` graph, carries:
 *        <lifecycle>  dkg:rootEntity  <memberEntity> ;   (one row per member —
 *                     the objects are the seal's MEMBER ENTITIES, never the
 *                     assertion URI itself)
 *        <lifecycle>  dkg:reservedUal "did:dkg:evm:<chain>/<addr>/<n>" ;
 *                     prov:wasAttributedTo <did:dkg:agent:0x…> .
 *     The lifecycle URN is pinned to the assertion URI structurally over the
 *     FULL scope (cg + optional subGraphName), not just {addr,name}:
 *     lifecycle = urn:dkg:assertion:{cg}[:{sub}]:{addr}:{name} while the
 *     assertion URI is did:dkg:context-graph:{cg}[/{sub}]/assertion/{addr}/{name}
 *     (constants.ts), and names cannot contain "/" — so taking the assertion
 *     URI's {cg}[/{sub}] (before "/assertion/") plus {addr}/{name} (after) and
 *     replacing "/"→":" yields the URN tail unambiguously. Pinning on
 *     {addr,name} ALONE would let a same-named assertion in a DIFFERENT
 *     sub-graph match and leak the wrong reservedUal/agent/batchId.
 *
 * The clicked node is an *entity*, not the KA.
 *
 * Resolution (RFC ka-metadata-trim P3.4 — read-both):
 *   0. PRIMARY: single hop straight off the seal subject in `_meta`. The
 *      receipt rows are keyed by the assertion URI; the entity→assertion link
 *      is the seal's member-entity rows (`dkg:assertionRootEntity` / the
 *      §10.1-renamed `dkg:assertionEntity`) or the assertion-URI prefix of
 *      the clicked entity (member entities are namespaced under their
 *      assertion URI). `reservedUal`/`prov:wasAttributedTo` are read BOTH
 *      from the seal subject itself (new shape, lifecycle merged — P3.2) and
 *      from a separate lifecycle URN row joined on `dkg:rootEntity` (old
 *      stores).
 *   LEGACY fallback (old stores only — the publisher no longer writes
 *   `ShareTransition` records):
 *   1. entity → ShareTransition (`_shared_memory_meta`) → (addr, name, agent).
 *   2. (addr, name) + the clicked entity → `_meta`. Because the same
 *      `(addr, name)` can exist in BOTH a root partition and a sub-graph
 *      partition, we do not trust `(addr, name)` alone: we additionally require
 *      the receipt's assertion URI to be a PREFIX of the clicked entity,
 *      preferring prefix / longest matches, so the EXACT assertion the entity
 *      belongs to wins rather than an arbitrary same-named one.
 *
 * Status semantics:
 *   • 'verified'  — a real on-chain receipt (tx hash) was found.
 *   • 'offchain'  — the entity is known to WM/SWM but has no VM receipt yet.
 *   • 'error'     — a query failed (kept DISTINCT from 'offchain').
 *   • 'idle'      — no entity / disabled.
 *
 * Everything is read-only over `/api/query`; nothing is written.
 */
import { useEffect, useRef, useState } from 'react';
import { executeQuery } from '../api.js';

const DKG = 'http://dkg.io/ontology/';

export type OnChainReceiptStatus = 'idle' | 'loading' | 'verified' | 'offchain' | 'error';

export interface EntityOnChainReceipt {
  status: OnChainReceiptStatus;
  /** Real deterministic UAL: did:dkg:evm:<chainId>/<addr>/<number>. */
  ual: string | null;
  /** Real blockchain transaction hash of the publish. */
  txHash: string | null;
  /** Block number the publish landed in. */
  blockNumber: string | null;
  /** Packed Option-1 KA id (author<<96 | number), as a decimal string. */
  kaId: string | null;
  /** 0x author address (parsed from the assertion source). */
  author: string | null;
  /**
   * ISO assertion-finalize timestamp from the publish receipt
   * (`dkg:assertionFinalizedAt`). This is the assertion's finalize time — NOT
   * the WM→SWM promote time (the `ShareTransition` timestamp), which we
   * deliberately do not surface as a publish/finalize time.
   */
  finalizedAt: string | null;
  /** did:dkg:agent:… that fired the publish. */
  agent: string | null;
  error?: string;
}

const EMPTY: EntityOnChainReceipt = {
  status: 'idle',
  ual: null,
  txHash: null,
  blockNumber: null,
  kaId: null,
  author: null,
  finalizedAt: null,
  agent: null,
};

/** SPARQL binding → plain string (handles both bare strings and {value}). */
function bv(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    // strip wrapping quotes + ^^<datatype> / @lang on literal lexical forms
    return v.startsWith('"')
      ? v.replace(/^"/, '').replace(/"(\^\^<[^>]*>|@[\w-]+)?$/, '')
      : v;
  }
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw == null ? '' : String(raw);
  }
  return String(v);
}

/** Strip `< >` IRI wrapping. */
function unwrapIri(s: string): string {
  const t = s.trim();
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

/** Escape a value for safe embedding inside a SPARQL string literal. */
function sparqlStr(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Validate a value for embedding inside a `<…>` SPARQL IRI ref. Returns the
 * value unchanged when safe, or '' when it contains characters that would
 * break out of the IRI ref — in which case the caller treats resolution as
 * impossible rather than building a malformed (or injectable) query.
 */
function sparqlIri(value: string): string {
  return /[<>"{}|\\^`\s]/.test(value) ? '' : value;
}

/**
 * Hop 0 (PRIMARY — RFC ka-metadata-trim P3.4): resolve the receipt straight
 * off the seal subject in `_meta`, no ShareTransition bridge. Read-both:
 *   - entity link: seal `dkg:assertionRootEntity` (legacy name) and
 *     `dkg:assertionEntity` (§10.1 rename), plus the assertion-URI prefix
 *     match for namespaced member entities;
 *   - `reservedUal` / attribution: from the seal subject itself (new shape —
 *     once the P3.2 lifecycle merge lands) OR from the separate lifecycle
 *     URN (current + old stores). Codex review "node-ui-receipt": the URN
 *     never carries `dkg:rootEntity <assertionUri>` — its rootEntity rows
 *     stamp MEMBER entities — so the lifecycle join goes through the CLICKED
 *     entity and is pinned to ?asrt by the structural FULL-SCOPE
 *     correspondence (URN tail `:{cg}[:{sub}]:{addr}:{name}` ⟷ URI
 *     `did:dkg:context-graph:{cg}[/{sub}]/assertion/{addr}/{name}`, names
 *     cannot contain "/"). A clicked member entity can be stamped by the
 *     same-named assertion in MORE THAN ONE sub-graph, so pinning on
 *     `{addr,name}` alone would bind the wrong sub-graph's reservedUal.
 * `entityIri` MUST already be validated via `sparqlIri`.
 */
export function buildSealReceiptQuery(cgId: string, entityIri: string): string {
  const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
  const entityLit = sparqlStr(entityIri);
  // RFC ka-metadata-trim Phase 2 — `dkg:publishedAtKaId` is no longer
  // written (it was the third copy of the on-chain id). Read-both: prefer
  // the legacy receipt row when present (old stores), else resolve the id
  // off the UAL subject's `dkg:batchId` row — the UAL node is the
  // reservedUal IRI, reachable from the seal subject (or the lifecycle
  // URN) via `dkg:reservedUal`.
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?asrt ?tx ?block ?kaId ?batchId ?finalizedAt ?ual ?agentLc ?ualSelf ?agentSelf WHERE {
  GRAPH <${metaGraph}> {
    ?asrt dkg:publishedAtTx ?tx ;
          dkg:publishedAtBlock ?block .
    FILTER(
      STRSTARTS("${entityLit}", STR(?asrt)) ||
      EXISTS { ?asrt dkg:assertionRootEntity <${entityIri}> } ||
      EXISTS { ?asrt dkg:assertionEntity <${entityIri}> }
    )
    OPTIONAL { ?asrt dkg:publishedAtKaId ?kaId . }
    OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
    OPTIONAL {
      ?lc dkg:rootEntity <${entityIri}> ;
          dkg:reservedUal ?ual .
      # Pin the lifecycle URN to the FULL assertion scope (cg + optional
      # subGraphName), not just {addr}:{name} — otherwise a same-named
      # assertion in a sibling sub-graph (urn:dkg:assertion:{cg}:{other}:{addr}:{name})
      # also STRENDS-matches and leaks the wrong reservedUal/agent/batchId.
      # cgId is a build-time constant, so anchor on it as a literal and keep its
      # slashes intact (wallet-scoped cgIds like "<addr>/<name>" embed RAW in the
      # URN via assertionLifecycleUri); only the [/sub]/{addr}/{name} tail derived
      # from ?asrt is "/"->":" converted (sub/addr/name cannot contain "/").
      FILTER(STRENDS(STR(?lc), CONCAT(
        ":${sparqlStr(cgId)}",
        REPLACE(STRBEFORE(STRAFTER(STR(?asrt), "did:dkg:context-graph:${sparqlStr(cgId)}"), "/assertion/"), "/", ":"),
        ":",
        REPLACE(STRAFTER(STR(?asrt), "/assertion/"), "/", ":")
      )))
      OPTIONAL { ?lc prov:wasAttributedTo ?agentLc . }
    }
    OPTIONAL { ?asrt dkg:reservedUal ?ualSelf . }
    OPTIONAL { ?asrt prov:wasAttributedTo ?agentSelf . }
    BIND(IRI(COALESCE(?ualSelf, ?ual)) AS ?ualNode)
    OPTIONAL { ?ualNode dkg:batchId ?batchId . }
  }
} ORDER BY DESC(STRSTARTS("${entityLit}", STR(?asrt))) DESC(STRLEN(STR(?asrt))) LIMIT 1`;
}

/** `…/assertion/{addr}/{name}` → { addr, name } (assertion-URI form). */
function parseAssertionUri(asrt: string): { addr: string; name: string } | null {
  const m = asrt.match(/\/assertion\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { addr: m[1], name: m[2] };
}

/**
 * LEGACY Step 1 (old stores): entity → ShareTransition → assertion source /
 * agent / timestamp. The publisher stopped writing ShareTransition records
 * (RFC ka-metadata-trim P3.4) — this hop only resolves rows written by older
 * nodes. Cross-subgraph `GRAPH ?g` over `_shared_memory_meta`, so we
 * deliberately do NOT pass contextGraphId (mirrors `useVerifiedMemoryAnchors`:
 * passing it constrains `GRAPH ?g` to CG-direct graphs and drops the share
 * records). `entityIri` MUST already be validated via `sparqlIri`.
 */
function buildShareQuery(cgId: string, entityIri: string): string {
  return `PREFIX dkg: <${DKG}>
SELECT ?source ?agent ?ts WHERE {
  GRAPH ?g {
    ?op a dkg:ShareTransition ;
        dkg:entities <${entityIri}> ;
        dkg:source ?source ;
        dkg:agent ?agent ;
        dkg:timestamp ?ts .
  }
  FILTER(
    STRSTARTS(STR(?g), "did:dkg:context-graph:${sparqlStr(cgId)}/") &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} ORDER BY DESC(?ts) LIMIT 1`;
}

/**
 * Step 2: resolve the EXACT on-chain receipt for the assertion the clicked
 * entity belongs to.
 *
 * The receipt is keyed by the full assertion URI. Since `(addr, name)` is NOT
 * unique across partitions, we constrain the match three ways: the assertion
 * URI must (a) end with `/assertion/{addr}/{name}` and (b) be a prefix of the
 * clicked entity URI, and we (c) order prefix-matches first then longest-first
 * so the most specific (correct) assertion wins under `LIMIT 1`. reservedUal is
 * joined off the lifecycle URN via its member-entity `dkg:rootEntity` stamp on
 * the clicked entity, pinned to `(addr, name)` by the URN tail (the URN never
 * carries the assertion URI as a rootEntity object — Codex review
 * "node-ui-receipt").
 */
export function buildReceiptQuery(cgId: string, entityIri: string, addr: string, name: string): string {
  const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
  const suffix = `/assertion/${addr}/${name}`;
  const entityLit = sparqlStr(entityIri);
  return `PREFIX dkg: <${DKG}>
SELECT ?ual ?tx ?block ?kaId ?finalizedAt WHERE {
  GRAPH <${metaGraph}> {
    ?asrt dkg:publishedAtTx ?tx ;
          dkg:publishedAtBlock ?block .
    OPTIONAL { ?asrt dkg:publishedAtKaId ?kaId . }
    FILTER(STRENDS(STR(?asrt), "${sparqlStr(suffix)}"))
    OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
    OPTIONAL {
      ?lc dkg:rootEntity <${entityIri}> ;
          dkg:reservedUal ?ual .
      FILTER(STRENDS(STR(?lc), "${sparqlStr(`:${addr}:${name}`)}"))
    }
  }
} ORDER BY DESC(STRSTARTS("${entityLit}", STR(?asrt))) DESC(STRLEN(STR(?asrt))) LIMIT 1`;
}

/** `assertion/{addr}/{name}` → { addr, name }. */
function parseSource(source: string): { addr: string; name: string } | null {
  const m = source.match(/^assertion\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { addr: m[1], name: m[2] };
}

export function useEntityOnChainReceipt(
  contextGraphId: string | undefined,
  entityUri: string | null | undefined,
  enabled: boolean = true,
): EntityOnChainReceipt {
  const [state, setState] = useState<EntityOnChainReceipt>(() => ({ ...EMPTY }));
  const versionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !contextGraphId || !entityUri) {
      setState({ ...EMPTY });
      return;
    }
    const version = ++versionRef.current;
    setState({ ...EMPTY, status: 'loading' });

    (async () => {
      try {
        const safeEntity = sparqlIri(entityUri);
        if (!safeEntity) {
          // Entity id is not embeddable as a SPARQL IRI ref — can't resolve.
          setState({ ...EMPTY, status: 'offchain' });
          return;
        }

        // ── Hop 0 (PRIMARY): seal-subject receipt rows in `_meta` ──
        // NOTE: query rejections propagate to the outer catch → 'error' state,
        // kept distinct from a clean "no rows" → fallback / 'offchain'.
        const sealRes = await executeQuery(
          buildSealReceiptQuery(contextGraphId, safeEntity),
          contextGraphId,
        );
        if (version !== versionRef.current) return;
        const sealRow = ((sealRes as any)?.result?.bindings ?? [])[0];
        if (sealRow?.tx) {
          const asrt = sealRow.asrt ? unwrapIri(bv(sealRow.asrt)) : '';
          const parsedAsrt = parseAssertionUri(asrt);
          const author = parsedAsrt?.addr ?? null;
          // Prefer the new-shape (seal-subject) attribution/UAL rows; fall
          // back to the lifecycle-URN attribution, then derive the agent DID
          // from the parsed author address.
          const agentRaw =
            (sealRow.agentSelf ? unwrapIri(bv(sealRow.agentSelf)) : '') ||
            (sealRow.agentLc ? unwrapIri(bv(sealRow.agentLc)) : '');
          const agent = agentRaw || (author ? `did:dkg:agent:${author.toLowerCase()}` : null);
          const ual = (sealRow.ualSelf ? bv(sealRow.ualSelf) : '') || (sealRow.ual ? bv(sealRow.ual) : '');
          // Read-both (RFC ka-metadata-trim Phase 2): legacy
          // `dkg:publishedAtKaId` receipt row (old stores) wins, else the
          // UAL-subject `dkg:batchId` row carries the on-chain id.
          const kaId = (sealRow.kaId ? bv(sealRow.kaId) : '') || (sealRow.batchId ? bv(sealRow.batchId) : '');
          setState({
            status: 'verified',
            ual: ual || null,
            txHash: bv(sealRow.tx) || null,
            blockNumber: sealRow.block ? bv(sealRow.block) : null,
            kaId: kaId || null,
            author,
            finalizedAt: sealRow.finalizedAt ? bv(sealRow.finalizedAt) : null,
            agent,
          });
          return;
        }

        // ── LEGACY Hop 1 (old stores): entity → ShareTransition ──
        const shareRes = await executeQuery(buildShareQuery(contextGraphId, safeEntity));
        if (version !== versionRef.current) return;

        const shareRow = ((shareRes as any)?.result?.bindings ?? [])[0];
        if (!shareRow) {
          // No share record — entity lives only in Working Memory.
          setState({ ...EMPTY, status: 'offchain' });
          return;
        }
        const source = bv(shareRow.source);
        const parsed = parseSource(source);
        const agent = shareRow.agent ? unwrapIri(bv(shareRow.agent)) : null;
        const addr = parsed?.addr ?? null;

        if (!parsed || !sparqlIri(parsed.addr) || !sparqlStr(parsed.name)) {
          // Resolved a share but can't safely build the receipt query.
          setState({ ...EMPTY, status: 'offchain', author: addr, agent });
          return;
        }

        // ── LEGACY Hop 2: pull the EXACT on-chain receipt from `_meta` ──
        const receiptRes = await executeQuery(
          buildReceiptQuery(contextGraphId, safeEntity, parsed.addr, parsed.name),
          contextGraphId,
        );
        if (version !== versionRef.current) return;

        const receiptRow = ((receiptRes as any)?.result?.bindings ?? [])[0];
        const ual = receiptRow?.ual ? bv(receiptRow.ual) : null;
        const txHash = receiptRow?.tx ? bv(receiptRow.tx) : null;
        const blockNumber = receiptRow?.block ? bv(receiptRow.block) : null;
        const kaId = receiptRow?.kaId ? bv(receiptRow.kaId) : null;
        const finalizedAt = receiptRow?.finalizedAt ? bv(receiptRow.finalizedAt) : null;

        setState({
          status: txHash ? 'verified' : 'offchain',
          ual: ual || null,
          txHash: txHash || null,
          blockNumber: blockNumber || null,
          kaId: kaId || null,
          author: addr,
          finalizedAt: finalizedAt || null,
          agent,
        });
      } catch (err: any) {
        if (version !== versionRef.current) return;
        setState({ ...EMPTY, status: 'error', error: err?.message ?? String(err) });
      }
    })();
  }, [contextGraphId, entityUri, enabled]);

  return state;
}
