/**
 * Per-VM-entity on-chain identity lookup.
 *
 * Returns the on-chain anchor ("publish batch operation"), the owner
 * wallet / peer id, and the publish timestamp for a single Verified
 * Memory entity. Drives the <VerifiedIdentityBanner> in the KA detail
 * header.
 *
 * Data model (what the daemon writes into `_shared_memory_meta`):
 *   <op>     a dkg:WorkspaceOperation ;
 *            dkg:rootEntity       <entity> ;
 *            dkg:publishedAt      "2026-04-18T11:54:57Z"^^xsd:dateTime ;
 *            prov:wasAttributedTo <peerId or wallet> .
 *   <entity> dkg:workspaceOwner   "<peerId>" .
 *
 * We surface:
 *   • ual            — the `?op` URI (closest thing to an on-chain UAL
 *                      until the daemon emits real did:dkg:… identifiers)
 *   • owner          — workspaceOwner attached to the entity
 *   • publishedAt    — ISO timestamp from the op
 *   • publisherPeerId— prov:wasAttributedTo from the op
 *   • opId           — short id parsed out of the op URI (for display)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { executeQuery } from '../api.js';

const DKG_NS  = 'http://dkg.io/ontology/';
const PROV_NS = 'http://www.w3.org/ns/prov#';

export interface VerifiedEntityIdentity {
  /** Closest-to-on-chain identifier we have — the WorkspaceOperation URI. */
  ual: string | null;
  /** Short op id for display (tail of the op URI). */
  opId: string | null;
  /** Wallet address OR peer id attached to the entity. */
  owner: string | null;
  /** ISO timestamp of the publish. */
  publishedAt: string | null;
  /** Peer id / DID of the agent that performed the publish. */
  publisherPeerId: string | null;
  loading: boolean;
  error?: string;
}

// `/api/query` can return SPARQL-JSON binding cells (`{ value, type, … }`)
// rather than bare strings — running `.match()` / `.trim()` on the object
// form throws. Normalise first.
function bindingValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw === null || raw === undefined ? '' : String(raw);
  }
  return String(v);
}

function stripLiteral(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  if (m) return m[1];
  return raw;
}

function stripIri(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

function buildOwnerQuery(cgId: string, entityIri: string): string {
  // The owner triple sits directly on the entity (not on the op) —
  // look in the project's _shared_memory_meta graphs.
  return `PREFIX dkg: <${DKG_NS}>
SELECT ?owner WHERE {
  GRAPH ?g { <${entityIri}> dkg:workspaceOwner ?owner . }
  FILTER(
    STRSTARTS(STR(?g), "did:dkg:context-graph:${cgId}") &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} LIMIT 1`;
}

function buildAnchorQuery(cgId: string, entityIri: string): string {
  // Look up the publish op (UAL-ish) that anchors this entity. An
  // entity can be anchored by multiple ops over time; we pick the most
  // recent so the banner always reflects the latest verification.
  return `PREFIX dkg: <${DKG_NS}>
PREFIX prov: <${PROV_NS}>
SELECT ?op ?publishedAt ?agent WHERE {
  GRAPH ?g {
    ?op a dkg:WorkspaceOperation ;
        dkg:rootEntity <${entityIri}> ;
        dkg:publishedAt ?publishedAt .
    OPTIONAL { ?op prov:wasAttributedTo ?agent }
  }
  FILTER(
    STRSTARTS(STR(?g), "did:dkg:context-graph:${cgId}") &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} ORDER BY DESC(?publishedAt) LIMIT 1`;
}

const EMPTY: VerifiedEntityIdentity = {
  ual: null,
  opId: null,
  owner: null,
  publishedAt: null,
  publisherPeerId: null,
  loading: false,
};

/**
 * Fetch the Verified-Memory identity block for a single entity.
 * Automatically no-ops (and returns a loading: false placeholder) when
 * the entity's trust level is not `verified` — callers still render
 * whatever they render without the banner in that case.
 */
export function useVerifiedEntityIdentity(
  contextGraphId: string | undefined,
  entityUri: string | null | undefined,
  enabled: boolean = true,
): VerifiedEntityIdentity {
  const [state, setState] = useState<VerifiedEntityIdentity>(() => ({ ...EMPTY }));
  const versionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !contextGraphId || !entityUri) {
      setState({ ...EMPTY });
      return;
    }
    const version = ++versionRef.current;
    setState(prev => ({ ...prev, loading: true, error: undefined }));

    (async () => {
      try {
        const [ownerRes, anchorRes] = await Promise.all([
          executeQuery(buildOwnerQuery(contextGraphId, entityUri), contextGraphId).catch(() => null),
          executeQuery(buildAnchorQuery(contextGraphId, entityUri), contextGraphId).catch(() => null),
        ]);
        if (version !== versionRef.current) return;

        const ownerRow = ((ownerRes as any)?.result?.bindings ?? [])[0];
        const anchorRow = ((anchorRes as any)?.result?.bindings ?? [])[0];

        const ual = anchorRow ? stripIri(anchorRow.op) : null;
        const publishedAt = anchorRow ? stripLiteral(anchorRow.publishedAt) : null;
        const publisherPeerId = anchorRow?.agent ? stripLiteral(anchorRow.agent) : null;
        const owner = ownerRow ? stripLiteral(ownerRow.owner) : null;

        setState({
          ual,
          opId: ual ? ual.slice(ual.lastIndexOf(':') + 1) : null,
          owner,
          publishedAt: publishedAt || null,
          publisherPeerId,
          loading: false,
        });
      } catch (err: any) {
        if (version !== versionRef.current) return;
        setState({ ...EMPTY, loading: false, error: err?.message ?? String(err) });
      }
    })();
  }, [contextGraphId, entityUri, enabled]);

  return state;
}

/**
 * Map a peer id back to a known agent URI, if we have one whose
 * `agent:peerId` matches. Caller passes in the agents index.
 */
export function agentFromPeerId(
  peerId: string,
  agents: Map<string, { uri: string; peerId?: string }>,
): string | null {
  if (!peerId) return null;
  for (const a of agents.values()) {
    if (a.peerId && a.peerId === peerId) return a.uri;
  }
  return null;
}

/** Truncate 0x… / peer-id to "abcd…ef12" for compact display. */
export function truncateId(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return '';
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
