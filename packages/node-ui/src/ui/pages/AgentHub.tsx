import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  streamChatMessage,
  streamChatPersistenceEvents,
  fetchChatPersistenceHealth,
  fetchMemorySessions,
  fetchMemorySession,
  fetchMemorySessionGraphDelta,
  fetchMemorySessionPublication,
  publishMemorySession,
  executeQuery,
  fetchAgents,
  sendPeerMessage,
  fetchMessages,
  fetchStatus,
  streamOpenClawLocalChat,
  fetchOpenClawLocalHealth,
  fetchOpenClawLocalHistory,
  type MemorySession,
  type MemorySessionPublicationStatus,
  type ChatLlmDiagnostics,
  type ChatPersistenceStatusEvent,
} from '../api.js';
import { RdfGraph, useRdfGraph } from '@dkg/graph-viz/react';

type Triple = { subject: string; predicate: string; object: string };

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  data?: unknown;
  sparql?: string;
  turnId?: string;
  persistStatus?: 'pending' | 'in_progress' | 'stored' | 'enshrined' | 'failed' | 'skipped';
  persistError?: string;
  persistAttempts?: number;
  persistMaxAttempts?: number;
  timings?: { llm_ms: number; store_ms: number; total_ms: number };
  responseMode?: 'streaming' | 'blocking' | 'rule-based';
  llmDiagnostics?: ChatLlmDiagnostics;
  graphDiff?: {
    addedNodeCount: number;
    addedEdgeCount: number;
    sampleNodes: string[];
    sampleEdges: string[];
  };
}

interface SessionSummary {
  id: string;
  preview: string;
  messageCount: number;
  lastTs: string;
}

interface DeltaPerfStats {
  sampleCount: number;
  deltaApplied: number;
  fallbackCount: number;
  medianMs: number | null;
  p95Ms: number | null;
  lastMode: 'delta' | 'fallback' | null;
  lastReason: string | null;
}

interface GraphFocusRequest {
  nodeId: string;
  requestId: number;
  zoomLevel?: number;
}

function stripTypedLiteral(value: string): string {
  if (!value) return value;
  const match = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  return match ? match[1] : value;
}

function normalizeTextKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePersistStatus(
  value: string | undefined,
): Message['persistStatus'] | undefined {
  if (!value) return undefined;
  if (
    value === 'pending'
    || value === 'in_progress'
    || value === 'stored'
    || value === 'enshrined'
    || value === 'failed'
    || value === 'skipped'
  ) {
    return value;
  }
  return undefined;
}

const DATE_CREATED = 'http://schema.org/dateCreated';
const SCHEMA_TEXT = 'http://schema.org/text';
const SCHEMA_NAME = 'http://schema.org/name';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG_CHAT_TURN = 'http://dkg.io/ontology/ChatTurn';
const DKG_TURN_ID = 'http://dkg.io/ontology/turnId';
const CLUSTER_TYPE = 'http://dkg.io/ontology/GraphCluster';
const CLUSTER_LINK = 'http://dkg.io/ontology/clusterLinksTo';
const CLUSTER_LITERAL_COUNT = 'http://dkg.io/ontology/literalCount';

function isNodeIri(value: string): boolean {
  return value.startsWith('urn:') || value.startsWith('http://') || value.startsWith('https://') || value.startsWith('did:') || value.startsWith('_:');
}

function edgeKey(t: Triple): string {
  return `${t.subject}\u0000${t.predicate}\u0000${t.object}`;
}

function collectNodeIds(triples: Triple[]): Set<string> {
  const ids = new Set<string>();
  for (const t of triples) {
    ids.add(t.subject);
    if (isNodeIri(t.object)) ids.add(t.object);
  }
  return ids;
}

function collectRenderableEdgeKeys(triples: Triple[]): Set<string> {
  const keys = new Set<string>();
  for (const t of triples) {
    if (!isNodeIri(t.object)) continue;
    keys.add(edgeKey(t));
  }
  return keys;
}

function buildTurnGraphDiff(prevTriples: Triple[], nextTriples: Triple[]) {
  const prevNodes = collectNodeIds(prevTriples);
  const nextNodes = collectNodeIds(nextTriples);
  const addedNodes = [...nextNodes].filter((id) => !prevNodes.has(id));

  const prevEdges = collectRenderableEdgeKeys(prevTriples);
  const nextEdges = collectRenderableEdgeKeys(nextTriples);
  const addedEdges = [...nextEdges].filter((id) => !prevEdges.has(id));

  return {
    addedNodeCount: addedNodes.length,
    addedEdgeCount: addedEdges.length,
    sampleNodes: addedNodes.slice(0, 4),
    sampleEdges: addedEdges.slice(0, 3),
  };
}

function markStoredMessagesEnshrined(prevMsgs: Message[]): Message[] {
  let changed = false;
  const next = prevMsgs.map((m) => {
    if (m.role !== 'assistant' || m.persistStatus !== 'stored') return m;
    changed = true;
    return { ...m, persistStatus: 'enshrined' as const };
  });
  return changed ? next : prevMsgs;
}

function mergeUniqueTriples(base: Triple[], delta: Triple[]): Triple[] {
  if (delta.length === 0) return base;
  const seen = new Set(base.map(edgeKey));
  const merged = [...base];
  for (const triple of delta) {
    const k = edgeKey(triple);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(triple);
  }
  return merged;
}

function deriveLatestTurnWatermark(triples: Triple[]): string | null {
  if (triples.length === 0) return null;
  const turnSubjects = new Set<string>();
  const turnIds = new Map<string, string>();
  const createdAt = new Map<string, number>();
  for (const t of triples) {
    if (t.predicate === RDF_TYPE && t.object === DKG_CHAT_TURN) {
      turnSubjects.add(t.subject);
      continue;
    }
    if (t.predicate === DKG_TURN_ID) {
      turnIds.set(t.subject, stripTypedLiteral(t.object));
      continue;
    }
    if (t.predicate === DATE_CREATED) {
      const parsed = Date.parse(stripTypedLiteral(t.object));
      if (!Number.isNaN(parsed)) createdAt.set(t.subject, parsed);
    }
  }

  const orderedTurns = [...turnSubjects]
    .map((subject) => ({
      subject,
      turnId: turnIds.get(subject),
      ts: createdAt.get(subject) ?? 0,
    }))
    .filter((row) => !!row.turnId)
    .sort((a, b) => (a.ts - b.ts) || String(a.turnId).localeCompare(String(b.turnId)));
  if (orderedTurns.length === 0) return null;
  return orderedTurns[orderedTurns.length - 1]!.turnId ?? null;
}

function quantileMs(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
  return sorted[index] ?? null;
}

function clusterKindForNode(nodeId: string, nodeType?: string): string {
  if (nodeType?.includes('Conversation')) return 'Conversation';
  if (nodeType?.includes('Message')) return 'Message';
  if (nodeType?.includes('ToolInvocation')) return 'ToolInvocation';
  if (nodeType?.includes('ChatTurn')) return 'ChatTurn';
  if (nodeId.includes(':session:')) return 'Conversation';
  if (nodeId.includes(':msg:')) return 'Message';
  if (nodeId.includes(':tool:')) return 'ToolInvocation';
  if (nodeId.includes(':turn:')) return 'ChatTurn';
  if (nodeId.startsWith('urn:dkg:entity:')) return 'Entity';
  if (nodeId.startsWith('did:dkg:')) return 'Paranet';
  if (nodeId.startsWith('http://schema.org/')) return 'SchemaNode';
  if (nodeId.startsWith('urn:')) return 'URN';
  if (nodeId.startsWith('http://') || nodeId.startsWith('https://')) return 'IRI';
  return 'Other';
}

function buildClusterTriples(triples: Triple[]): Triple[] {
  if (triples.length === 0) return [];
  const nodeType = new Map<string, string>();
  for (const t of triples) {
    if (t.predicate === RDF_TYPE && isNodeIri(t.object)) {
      nodeType.set(t.subject, t.object);
    }
  }

  const nodeKinds = new Map<string, string>();
  const clusterNodeMembers = new Map<string, Set<string>>();
  const literalCounts = new Map<string, number>();
  const edgeCounts = new Map<string, number>();

  const ensureKind = (nodeId: string): string => {
    const existing = nodeKinds.get(nodeId);
    if (existing) return existing;
    const kind = clusterKindForNode(nodeId, nodeType.get(nodeId));
    nodeKinds.set(nodeId, kind);
    if (!clusterNodeMembers.has(kind)) clusterNodeMembers.set(kind, new Set());
    clusterNodeMembers.get(kind)!.add(nodeId);
    return kind;
  };

  for (const t of triples) {
    const sourceKind = ensureKind(t.subject);
    if (isNodeIri(t.object)) {
      const targetKind = ensureKind(t.object);
      const edgeKey = `${sourceKind}\u0000${targetKind}`;
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
    } else {
      literalCounts.set(sourceKind, (literalCounts.get(sourceKind) ?? 0) + 1);
    }
  }

  const out: Triple[] = [];
  for (const [kind, members] of clusterNodeMembers) {
    const clusterNode = `urn:dkg:cluster:${kind.toLowerCase()}`;
    out.push(
      { subject: clusterNode, predicate: RDF_TYPE, object: CLUSTER_TYPE },
      { subject: clusterNode, predicate: SCHEMA_NAME, object: JSON.stringify(`${kind} (${members.size})`) },
    );
    const literals = literalCounts.get(kind) ?? 0;
    if (literals > 0) {
      out.push({
        subject: clusterNode,
        predicate: CLUSTER_LITERAL_COUNT,
        object: JSON.stringify(String(literals)),
      });
    }
  }

  for (const [edgeKey, count] of edgeCounts) {
    const [sourceKind, targetKind] = edgeKey.split('\u0000');
    const sourceNode = `urn:dkg:cluster:${sourceKind.toLowerCase()}`;
    const targetNode = `urn:dkg:cluster:${targetKind.toLowerCase()}`;
    out.push({
      subject: sourceNode,
      predicate: CLUSTER_LINK,
      object: targetNode,
    });
    out.push({
      subject: sourceNode,
      predicate: `http://dkg.io/ontology/clusterEdgeCount:${targetKind}`,
      object: JSON.stringify(String(count)),
    });
  }

  return out;
}

function shortUri(uri: string): string {
  if (!uri) return uri;
  const trimmed = uri.replace(/[<>]/g, '');
  if (trimmed.length <= 42) return trimmed;
  return `${trimmed.slice(0, 24)}...${trimmed.slice(-14)}`;
}

function GraphHighlighter(
  { nodeIds, focusRequest }: {
    nodeIds: string[];
    focusRequest: { nodeId: string; requestId: number; zoomLevel?: number } | null;
  },
) {
  const { viz } = useRdfGraph();
  const key = useMemo(() => [...nodeIds].sort().join('\u0000'), [nodeIds]);
  useEffect(() => {
    if (!viz) return;
    if (nodeIds.length > 0) viz.highlightNodes(nodeIds);
    else viz.clearHighlight();
    return () => {
      viz.clearHighlight();
    };
  }, [viz, key, nodeIds]);

  useEffect(() => {
    if (!viz || !focusRequest?.nodeId) return;
    viz.centerOnNode(focusRequest.nodeId, {
      durationMs: 300,
      zoomLevel: focusRequest.zoomLevel ?? 2.1,
    });
  }, [viz, focusRequest?.requestId, focusRequest?.nodeId, focusRequest?.zoomLevel]);

  return null;
}

function extractTimeline(triples: Triple[]): { subjectDates: Map<string, number>; timestamps: number[] } {
  const subjectDates = new Map<string, number>();
  for (const t of triples) {
    if (t.predicate === DATE_CREATED) {
      const d = new Date(t.object);
      if (!isNaN(d.getTime())) subjectDates.set(t.subject, d.getTime());
    }
  }
  const timestamps = [...new Set(subjectDates.values())].sort((a, b) => a - b);
  return { subjectDates, timestamps };
}

function filterTriplesByCursor(triples: Triple[], subjectDates: Map<string, number>, cursor: number): Triple[] {
  const visible = new Set<string>();
  for (const [subj, ts] of subjectDates) {
    if (ts <= cursor) visible.add(subj);
  }
  return triples.filter(t => {
    if (visible.has(t.subject)) return true;
    if (!subjectDates.has(t.subject)) return true;
    return false;
  });
}

let _mid = 10;

function formatDate(ts: string | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!ts || typeof ts !== 'string') return '';
  const trimmed = ts.replace(/\^\^<[^>]+>$/, '').trim().replace(/^"|"$/g, '');
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed || '';
  return date.toLocaleDateString(undefined, options ?? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function welcomeMessage(): Message {
  return {
    id: _mid++,
    role: 'assistant',
    content: 'Agent online. Connected to DKG v9 testnet with access to your Knowledge Assets. How can I help?',
    ts: new Date().toLocaleTimeString(),
  };
}

function sessionSummariesFromApi(sessions: MemorySession[]): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const s of sessions) {
    if (!s?.session) continue;
    const first = s.messages.find(m => m.author === 'user');
    const preview = first?.text?.slice(0, 60) || 'New conversation';
    const lastMsg = s.messages[s.messages.length - 1];
    const candidate: SessionSummary = {
      id: s.session,
      preview,
      messageCount: s.messages.length,
      lastTs: lastMsg?.ts ?? '',
    };
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, candidate);
      continue;
    }
    const existingTime = Date.parse(existing.lastTs);
    const candidateTime = Date.parse(candidate.lastTs);
    const candidateIsNewer = (
      Number.isFinite(candidateTime) && Number.isFinite(existingTime)
        ? candidateTime >= existingTime
        : candidate.lastTs >= existing.lastTs
    );
    if (candidateIsNewer) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = Date.parse(a.lastTs);
    const bTime = Date.parse(b.lastTs);
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
    return b.lastTs.localeCompare(a.lastTs);
  });
}

function emptyDeltaPerfStats(): DeltaPerfStats {
  return {
    sampleCount: 0,
    deltaApplied: 0,
    fallbackCount: 0,
    medianMs: null,
    p95Ms: null,
    lastMode: null,
    lastReason: null,
  };
}

interface PeerInfo {
  name: string;
  peerId: string;
  connectionStatus: string;
  latencyMs?: number | null;
  lastSeen?: number | null;
}

interface PeerMsg {
  ts: number;
  direction: 'in' | 'out';
  peer: string;
  peerName?: string;
  text: string;
}

function PeerChatView() {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
  const [peerMessages, setPeerMessages] = useState<PeerMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingPeers, setLoadingPeers] = useState(true);
  const [peerSearch, setPeerSearch] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [peerMessages]);

  const loadPeers = useCallback(async () => {
    try {
      const res = await fetchAgents();
      const agents: PeerInfo[] = (res.agents ?? [])
        .filter((a: any) => a.connectionStatus !== 'self')
        .map((a: any) => ({
          name: a.name ?? a.peerId?.slice(0, 12),
          peerId: a.peerId,
          connectionStatus: a.connectionStatus,
          latencyMs: a.latencyMs,
          lastSeen: a.lastSeen,
        }));
      agents.sort((a, b) => {
        if (a.connectionStatus === 'connected' && b.connectionStatus !== 'connected') return -1;
        if (b.connectionStatus === 'connected' && a.connectionStatus !== 'connected') return 1;
        return a.name.localeCompare(b.name);
      });
      setPeers(agents);
    } catch { /* ignore */ }
    setLoadingPeers(false);
  }, []);

  useEffect(() => { loadPeers(); }, [loadPeers]);

  const loadMessages = useCallback(async (peerId: string) => {
    try {
      const res = await fetchMessages({ peer: peerId, limit: 100 });
      setPeerMessages(res.messages ?? []);
    } catch { /* ignore */ }
  }, []);

  const selectPeer = useCallback((peer: PeerInfo) => {
    setSelectedPeer(peer);
    setPeerMessages([]);
    loadMessages(peer.peerId);
  }, [loadMessages]);

  useEffect(() => {
    if (!selectedPeer) return;
    pollRef.current = setInterval(() => loadMessages(selectedPeer.peerId), 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [selectedPeer, loadMessages]);

  const sendMsg = useCallback(async () => {
    if (!selectedPeer || !input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setPeerMessages(prev => [...prev, { ts: Date.now(), direction: 'out', peer: selectedPeer.peerId, text }]);
    try {
      await sendPeerMessage(selectedPeer.peerId, text);
    } catch (err: any) {
      setPeerMessages(prev => [...prev, { ts: Date.now(), direction: 'in', peer: 'system', text: `Failed to deliver: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  }, [selectedPeer, input, sending]);

  const connectedCount = peers.filter(p => p.connectionStatus === 'connected').length;
  const ALIVE_MS = 5 * 60 * 1000;

  const peerSearchLower = peerSearch.trim().toLowerCase();
  const matchCount = peerSearchLower
    ? peers.reduce((n, p) => n + (p.name.toLowerCase().includes(peerSearchLower) || p.peerId.toLowerCase().includes(peerSearchLower) ? 1 : 0), 0)
    : peers.length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100%', overflow: 'hidden' }}>
      {/* Peer list sidebar */}
      <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Network Peers</div>
            {peerSearchLower && (
              <div style={{ fontSize: 10, color: 'var(--green)' }}>{matchCount} found</div>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>
            {connectedCount} connected · {peers.length} discovered
          </div>
          <input
            type="text"
            value={peerSearch}
            onChange={ev => setPeerSearch(ev.target.value)}
            placeholder="Search peers…"
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text)', fontSize: 11, outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={ev => { (ev.target as HTMLInputElement).style.borderColor = 'var(--green)'; }}
            onBlur={ev => { (ev.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
          {loadingPeers && <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '12px 6px' }}>Loading peers…</div>}
          {!loadingPeers && peers.length === 0 && (
            <div className="empty-state empty-state--sidebar">
              <div className="empty-state-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div className="empty-state-title">No peers discovered</div>
              <div className="empty-state-desc">Peers will appear here as your node discovers other agents on the network.</div>
            </div>
          )}
          {!loadingPeers && peers.length > 0 && matchCount === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '12px 6px' }}>No peers match "{peerSearch}"</div>
          )}
          {peers.map(p => {
            const isMatch = !peerSearchLower || p.name.toLowerCase().includes(peerSearchLower) || p.peerId.toLowerCase().includes(peerSearchLower);
            const isSelected = selectedPeer?.peerId === p.peerId;
            const isOnline = p.connectionStatus === 'connected' || (p.lastSeen != null && Date.now() - p.lastSeen < ALIVE_MS);
            return (
              <div
                key={p.peerId}
                onClick={() => selectPeer(p)}
                style={{
                  padding: '10px 12px', borderRadius: 8, marginBottom: 4, cursor: 'pointer',
                  background: isSelected ? 'var(--surface)' : 'transparent',
                  border: isSelected ? '1px solid var(--border)' : '1px solid transparent',
                  transition: 'all .15s ease',
                  display: isMatch ? undefined : 'none',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface)'; }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: isOnline ? '#10b981' : '#6b7280',
                    boxShadow: isOnline ? '0 0 6px rgba(16,185,129,.5)' : 'none',
                  }} />
                  <span style={{
                    fontSize: 12, fontWeight: isSelected ? 700 : 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: isSelected ? 'var(--text)' : 'var(--text-muted)',
                  }}>{p.name}</span>
                </div>
                {p.latencyMs != null && (
                  <div className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2, marginLeft: 15 }}>
                    {p.latencyMs}ms
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
          <button onClick={loadPeers} style={{
            fontSize: 10, color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            textDecoration: 'underline', textUnderlineOffset: 2,
          }}>Refresh peers</button>
        </div>
      </div>

      {/* Chat area */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedPeer ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text-dim)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity={0.4}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <div style={{ fontSize: 13 }}>Select a peer to start chatting</div>
            <div style={{ fontSize: 11 }}>Messages are sent directly over the DKG P2P network</div>
          </div>
        ) : (
          <>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 34, height: 34, borderRadius: '50%',
                background: selectedPeer.connectionStatus === 'connected' ? 'rgba(16,185,129,.12)' : 'var(--surface)',
                border: `1px solid ${selectedPeer.connectionStatus === 'connected' ? 'rgba(16,185,129,.3)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={selectedPeer.connectionStatus === 'connected' ? '#10b981' : '#6b7280'} strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedPeer.name}</div>
                <div style={{ fontSize: 11, color: selectedPeer.connectionStatus === 'connected' ? 'var(--green)' : 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                    background: selectedPeer.connectionStatus === 'connected' ? 'var(--green)' : '#6b7280',
                  }} />
                  {selectedPeer.connectionStatus === 'connected' ? 'Connected' : 'Disconnected'}
                  {selectedPeer.latencyMs != null && <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>· {selectedPeer.latencyMs}ms</span>}
                </div>
              </div>
              <div className="mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedPeer.peerId.slice(0, 16)}…
              </div>
            </div>

            <div className="chat-area" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
              {peerMessages.length === 0 && (
                <div className="empty-state" style={{ marginTop: 24 }}>
                  <div className="empty-state-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  </div>
                  <div className="empty-state-title">No messages yet</div>
                  <div className="empty-state-desc">Send a message to start a peer-to-peer conversation.</div>
                </div>
              )}
              {peerMessages.map((m, i) => (
                <div key={i} className={`chat-msg ${m.direction === 'out' ? 'user' : 'assistant'}`}>
                  <div className={`chat-bubble ${m.direction === 'out' ? 'user' : 'assistant'}`}>
                    {m.text}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                    {new Date(m.ts).toLocaleTimeString()}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="chat-msg user">
                  <div className="chat-bubble user" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '12px 16px', opacity: 0.5 }}>
                    Sending…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="chat-input-row">
              <input
                className="chat-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMsg())}
                placeholder={`Message ${selectedPeer.name}…`}
              />
              <button className="chat-send" onClick={sendMsg} disabled={sending || !input.trim()}>Send</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface OcMessage {
  id: string | number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string;
}

let _ocMid = 1000;

const OC_SESSION_URI = 'urn:dkg:chat:session:openclaw:dkg-ui';
const OC_SESSION_ID = 'openclaw:dkg-ui';

function mergeOcMessages(existing: OcMessage[], incoming: OcMessage[]): OcMessage[] {
  const seen = new Set<string>();
  const merged: OcMessage[] = [];
  for (const message of [...incoming, ...existing]) {
    // Prefer stable URI/turnId for dedup; fall back to content-based key
    const id = String(message.id);
    const hasStableId = id && !id.startsWith('oc-') && !/^\d+$/.test(id);
    const dedupeKey = hasStableId
      ? id
      : `${message.role}\u0000${message.ts}\u0000${message.content}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(message);
  }
  return merged;
}

function OpenClawChatView() {
  const [messages, setMessages] = useState<OcMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [graphTriples, setGraphTriples] = useState<Triple[] | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishNotice, setPublishNotice] = useState<string | null>(null);
  const [publicationScope, setPublicationScope] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastHealthOnlineRef = useRef<boolean | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publicationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = (timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Elapsed timer while sending
  useEffect(() => {
    if (sendStartedAt == null) { setElapsed(0); return; }
    setElapsed(Math.floor((Date.now() - sendStartedAt) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - sendStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [sendStartedAt]);

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      clearTimer(reconnectTimerRef);
      clearTimer(graphRefreshTimerRef);
      clearTimer(publicationRefreshTimerRef);
    };
  }, []);

  // Periodic health polling (every 15s)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const h = await fetchOpenClawLocalHealth();
        if (cancelled) return;
        const online = h.ok;
        // Detect offline→online transition — reload history + show indicator
        if (online && lastHealthOnlineRef.current === false) {
          setReconnectedAt(Date.now());
          clearTimer(reconnectTimerRef);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            setReconnectedAt(prev => prev && Date.now() - prev >= 2900 ? null : prev);
          }, 3000);
          fetchOpenClawLocalHistory(100).then(history => {
            if (cancelled) return;
            const loaded: OcMessage[] = history.map(h => ({
              id: h.uri || `oc-history:${_ocMid++}`,
              role: h.author.includes('agent') ? 'assistant' as const : 'user' as const,
              content: h.text,
              ts: h.ts ? new Date(h.ts).toLocaleTimeString() : '',
            }));
            if (loaded.length > 0) setMessages(prev => mergeOcMessages(prev, loaded));
          }).catch(() => {});
        }
        lastHealthOnlineRef.current = online;
        setAgentOnline(online);
      } catch {
        if (!cancelled) {
          lastHealthOnlineRef.current = false;
          setAgentOnline(false);
        }
      }
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load chat history from DKG graph
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await fetchOpenClawLocalHistory(100);
        if (cancelled) return;
        const loaded: OcMessage[] = history.map(h => ({
          id: h.uri || `oc-history:${_ocMid++}`,
          role: h.author.includes('agent') ? 'assistant' as const : 'user' as const,
          content: h.text,
          ts: h.ts ? new Date(h.ts).toLocaleTimeString() : '',
        }));
        if (loaded.length > 0) {
          setMessages(prev => mergeOcMessages(prev, loaded));
        }
      } catch { /* no history available */ }
      if (!cancelled) setHistoryLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Load graph for the openclaw session
  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    try {
      // The OpenClaw tab is a single local-memory surface, not a multi-session chat inbox.
      // Imported memories from files and dkg_memory_import are global to agent-memory, so
      // include their roots explicitly alongside the OpenClaw chat/session graph.
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        {
          SELECT ?s ?p ?o WHERE {
            { <${OC_SESSION_URI}> ?p ?o . BIND(<${OC_SESSION_URI}> AS ?s) }
            UNION
            { ?s <http://schema.org/isPartOf> <${OC_SESSION_URI}> . ?s ?p ?o }
            UNION
            { ?msg <http://schema.org/isPartOf> <${OC_SESSION_URI}> .
              ?msg <http://dkg.io/ontology/usedTool> ?tool .
              ?tool ?p ?o . BIND(?tool AS ?s) }
            UNION
            { ?msg <http://schema.org/isPartOf> <${OC_SESSION_URI}> .
              ?entity <http://dkg.io/ontology/mentionedIn> ?msg .
              ?entity ?p ?o . BIND(?entity AS ?s) }
            UNION
            { ?msg <http://schema.org/isPartOf> <${OC_SESSION_URI}> .
              ?srcEntity <http://dkg.io/ontology/mentionedIn> ?msg .
              ?srcEntity ?rel ?targetEntity .
              FILTER(STRSTARTS(STR(?targetEntity), "urn:dkg:entity:"))
              ?targetEntity ?p ?o . BIND(?targetEntity AS ?s) }
            UNION
            { ?memory <http://dkg.io/ontology/extractedFrom> <${OC_SESSION_URI}> .
              ?memory ?p ?o . BIND(?memory AS ?s) }
            UNION
            { ?memory a <http://dkg.io/ontology/ImportedMemory> .
              ?memory ?p ?o . BIND(?memory AS ?s) }
            UNION
            { ?batch a <http://dkg.io/ontology/MemoryImport> .
              ?batch ?p ?o . BIND(?batch AS ?s) }
            UNION
            { ?sessionEntity <http://dkg.io/ontology/extractedFrom> ?batch .
              ?batch a <http://dkg.io/ontology/MemoryImport> .
              ?sessionEntity ?p ?o . BIND(?sessionEntity AS ?s) }
          }
          ORDER BY ?s ?p ?o
          LIMIT 5000
        }
      }`;
      const res = await executeQuery(sparql, 'agent-memory', true);
      const quads = Array.isArray(res?.result?.quads) ? res.result.quads : [];
      setGraphTriples(quads.map((q: any) => ({
        subject: q.subject,
        predicate: q.predicate,
        object: stripTypedLiteral(q.object),
      })));
    } catch {
      setGraphTriples(null);
    }
    setGraphLoading(false);
  }, []);

  useEffect(() => {
    if (showGraph) loadGraph();
  }, [showGraph, loadGraph]);

  // Fetch publication scope when graph is shown (and after sends/publishes)
  const refreshPublicationScope = useCallback(() => {
    fetchMemorySessionPublication(OC_SESSION_ID).then(pub => {
      setPublicationScope(pub.scope);
    }).catch(() => {
      // Session may not exist yet — show 'empty' instead of stuck 'checking...'
      setPublicationScope(prev => prev ?? 'empty');
    });
  }, []);

  useEffect(() => {
    if (showGraph) refreshPublicationScope();
  }, [showGraph, refreshPublicationScope]);

  const publishSession = useCallback(async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishNotice(null);
    try {
      const result = await Promise.race([
        publishMemorySession(OC_SESSION_ID, { clearAfter: false }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Publishing timed out. Please retry.')), 45_000);
        }),
      ]);
      setPublicationScope(result.publication.scope);
      setPublishNotice(`Published ${result.rootEntityCount} root entities (${result.status})`);
      await loadGraph();
    } catch (err: any) {
      setPublishNotice(`Publish failed: ${err?.message ?? 'Unknown error'}`);
    } finally {
      setPublishing(false);
    }
  }, [publishing, loadGraph]);

  const send = useCallback(async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setMessages(prev => [...prev, { id: _ocMid++, role: 'user', content: text, ts: new Date().toLocaleTimeString() }]);
    setSending(true);
    setSendStartedAt(Date.now());

    // AbortController with 90s timeout
    const ac = new AbortController();
    abortRef.current = ac;
    const timeout = setTimeout(() => ac.abort(), 90_000);

    // Add empty assistant message — will be progressively filled by stream
    const assistantMsgId = _ocMid++;
    setMessages(prev => [...prev, {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      ts: new Date().toLocaleTimeString(),
    }]);

    try {
      await streamOpenClawLocalChat(text, {
        signal: ac.signal,
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: m.content + event.delta }
                : m,
            ));
          } else if (event.type === 'final') {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: event.text }
                : m,
            ));
          }
        },
      });
      // Refresh graph if visible (brief delay for fire-and-forget turn persistence)
      if (showGraph) {
        clearTimer(graphRefreshTimerRef);
        clearTimer(publicationRefreshTimerRef);
        graphRefreshTimerRef.current = setTimeout(() => {
          graphRefreshTimerRef.current = null;
          void loadGraph();
        }, 1500);
        publicationRefreshTimerRef.current = setTimeout(() => {
          publicationRefreshTimerRef.current = null;
          refreshPublicationScope();
        }, 2000);
      }
    } catch (err: any) {
      // User-friendly error messages
      let msg: string;
      if (err.name === 'AbortError') {
        msg = 'Request timed out after 90 seconds. The agent may be overloaded — try again later.';
      } else if (agentOnline === false) {
        msg = 'Agent is offline. Check that the OpenClaw gateway is running.';
      } else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
        msg = 'Network error — unable to reach the agent. Check your connection.';
      } else {
        msg = `Error: ${err.message}`;
      }
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, role: 'system' as const, content: msg }
          : m,
      ));
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
      setSending(false);
      setSendStartedAt(null);
    }
  }, [input, sending, agentOnline, showGraph, loadGraph, refreshPublicationScope]);

  const statusColor = agentOnline === true ? '#4ade80' : agentOnline === false ? '#ef4444' : '#888';
  const statusText = agentOnline === true ? 'Online' : agentOnline === false ? 'Offline' : 'Checking…';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: showGraph ? '1fr 1fr' : '1fr', height: '100%', overflow: 'hidden' }}>
      {/* Chat column */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: statusColor,
              boxShadow: agentOnline === true ? `0 0 6px ${statusColor}66` : 'none',
            }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>OpenClaw Agent</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {reconnectedAt ? 'Reconnected' : statusText}
                <span style={{
                  marginLeft: 8, padding: '1px 6px', borderRadius: 4, fontSize: 9,
                  background: reconnectedAt ? 'rgba(34,211,238,.12)' : 'rgba(74,222,128,.12)',
                  color: reconnectedAt ? '#22d3ee' : 'var(--green)',
                }}>
                  {reconnectedAt ? 'synced' : 'DKG UI'}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setShowGraph(g => !g)}
            title={showGraph ? 'Hide graph' : 'Show knowledge graph'}
            style={{
              padding: '5px 12px', borderRadius: 6,
              border: showGraph ? '1px solid rgba(34,211,238,.5)' : '1px solid var(--border)',
              background: showGraph ? 'rgba(34,211,238,.1)' : 'var(--surface)',
              color: showGraph ? '#22d3ee' : 'var(--text-muted)',
              fontSize: 11, cursor: 'pointer', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 5,
              transition: 'all .15s ease',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
              <line x1="8.5" y1="7.5" x2="10.5" y2="16"/><line x1="15.5" y1="7.5" x2="13.5" y2="16"/>
            </svg>
            {showGraph ? 'Hide Graph' : 'Show Graph'}
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 8px' }}>
          {!historyLoaded && (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, padding: 20 }}>
              Loading history…
            </div>
          )}
          {historyLoaded && messages.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '40px 20px' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
                <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
              </svg>
              <div style={{ fontSize: 13 }}>Send a message to start chatting with your OpenClaw agent.</div>
              <div style={{ fontSize: 11, marginTop: 8 }}>
                Messages and imported memories are persisted to the DKG knowledge graph.
              </div>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} style={{ marginBottom: 16, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                background: m.role === 'user'
                  ? 'rgba(74,222,128,.15)'
                  : m.role === 'system'
                    ? 'rgba(255,255,255,.04)'
                    : 'rgba(255,255,255,.06)',
                border: m.role === 'system' ? '1px solid rgba(255,255,255,.08)' : 'none',
                fontSize: 13, lineHeight: '1.5', whiteSpace: 'pre-wrap',
                color: m.role === 'system' ? 'var(--text-dim)' : 'var(--text)',
                fontStyle: m.role === 'system' ? 'italic' : 'normal',
              }}>
                {m.content}
                <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>{m.ts}</div>
              </div>
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
              <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,.06)', fontSize: 13, color: 'var(--text-dim)' }}>
                Thinking{elapsed > 0 ? `\u2026 ${elapsed}s` : '\u2026'}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Message your OpenClaw agent…"
            disabled={sending || agentOnline === false}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 10,
              border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text)', fontSize: 13, outline: 'none',
            }}
          />
          <button
            onClick={send}
            disabled={sending || !input.trim() || agentOnline === false}
            style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: sending || !input.trim() || agentOnline === false ? 'rgba(74,222,128,.2)' : 'var(--green)',
              color: sending || !input.trim() || agentOnline === false ? 'var(--text-dim)' : '#000',
              fontWeight: 700, fontSize: 12, cursor: sending ? 'wait' : 'pointer',
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* Graph pane */}
      {showGraph && (
        <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Knowledge Graph</span>
                {graphTriples && (
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {graphTriples.length} triples
                  </span>
                )}
                <span
                  className="mono"
                  style={{
                    borderRadius: 999,
                    border: publicationScope === 'enshrined'
                      ? '1px solid rgba(74,222,128,.3)'
                      : publicationScope === 'enshrined_with_pending'
                        ? '1px solid rgba(245,158,11,.35)'
                      : '1px solid var(--border)',
                    background: publicationScope === 'enshrined'
                      ? 'rgba(74,222,128,.1)'
                      : publicationScope === 'enshrined_with_pending'
                        ? 'rgba(245,158,11,.12)'
                      : 'var(--surface)',
                    color: publicationScope === 'enshrined'
                      ? 'var(--green)'
                      : publicationScope === 'enshrined_with_pending'
                        ? '#f59e0b'
                      : 'var(--text-dim)',
                    padding: '2px 8px',
                    fontSize: 10,
                  }}
                >
                  {publicationScope === 'enshrined' ? 'enshrined'
                    : publicationScope === 'enshrined_with_pending' ? 'enshrined + pending'
                    : publicationScope === 'workspace_only' ? 'workspace only'
                    : publicationScope ? 'empty' : 'checking...'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={loadGraph}
                  disabled={graphLoading}
                  style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                    background: 'transparent', color: 'var(--text-muted)', fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  {graphLoading ? 'Loading…' : 'Refresh'}
                </button>
                <button
                  onClick={() => { void publishSession(); }}
                  disabled={publishing}
                  style={{
                    padding: '4px 10px', borderRadius: 6,
                    border: '1px solid rgba(74,222,128,.35)',
                    background: 'rgba(74,222,128,.1)',
                    color: 'var(--green)',
                    fontSize: 10,
                    cursor: publishing ? 'not-allowed' : 'pointer',
                    opacity: publishing ? 0.65 : 1,
                  }}
                >
                  {publishing ? 'Publishing…' : 'Publish session'}
                </button>
              </div>
            </div>
            {publishNotice && (
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: publishNotice.toLowerCase().includes('failed') ? 'var(--red)' : 'var(--green)',
                }}
              >
                {publishNotice}
              </div>
            )}
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              Publish session enshrines the OpenClaw conversation currently in view on the DKG privately. New writes remain in workspace until you publish again.
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {graphLoading && !graphTriples && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                Loading graph…
              </div>
            )}
            {graphTriples && graphTriples.length === 0 && (
              <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
                <div className="empty-state-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><line x1="14.5" y1="9.5" x2="17.5" y2="6.5"/><line x1="9.5" y1="14.5" x2="6.5" y2="17.5"/></svg>
                </div>
                <div className="empty-state-title">No graph data yet</div>
                <div className="empty-state-desc">Send some messages first. The knowledge graph builds as you converse.</div>
              </div>
            )}
            {graphTriples && graphTriples.length > 0 && (
              <RdfGraph
                data={graphTriples}
                format="triples"
                options={{
                  labelMode: 'humanized',
                  renderer: '2d',
                  labels: {
                    predicates: [
                      'http://schema.org/text',
                      'http://schema.org/name',
                      'http://www.w3.org/2000/01/rdf-schema#label',
                      'http://dkg.io/ontology/sessionId',
                      'http://dkg.io/ontology/toolName',
                    ],
                  },
                  style: {
                    classColors: {
                      'http://schema.org/Conversation': '#4ade80',
                      'http://schema.org/Message': '#22d3ee',
                      'http://dkg.io/ontology/ChatTurn': '#38bdf8',
                      'http://dkg.io/ontology/ToolInvocation': '#f59e0b',
                      'http://dkg.io/ontology/ImportedMemory': '#a78bfa',
                      'http://dkg.io/ontology/MemoryImport': '#818cf8',
                      'http://schema.org/Person': '#f472b6',
                      'http://schema.org/Organization': '#fb923c',
                      'http://schema.org/Place': '#34d399',
                      'http://schema.org/Product': '#c084fc',
                      'http://schema.org/Event': '#facc15',
                      'http://schema.org/CreativeWork': '#7dd3fc',
                    },
                    defaultNodeColor: '#94a3b8',
                    defaultEdgeColor: '#5f8598',
                    edgeWidth: 0.9,
                  },
                  hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true,
                    circleTypes: ['http://schema.org/Message'] },
                  focus: { maxNodes: 5000, hops: 999 },
                }}
                style={{ width: '100%', height: '100%' }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentHubPage() {
  const [mode, setMode] = useState<'agent' | 'peers' | 'openclaw'>('agent');
  const [nodeStatus, setNodeStatus] = useState<{ name?: string; hasOpenClawChannel?: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((s: any) => { if (!cancelled) setNodeStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (nodeStatus?.hasOpenClawChannel) setMode(prev => prev === 'agent' ? 'openclaw' : prev);
  }, [nodeStatus]);
  const [messages, setMessages] = useState<Message[]>([welcomeMessage()]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [showGraph, setShowGraph] = useState(false);
  const [graphTriples, setGraphTriples] = useState<Triple[] | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphSessionId, setGraphSessionId] = useState<string | null>(null);
  const [graphLoadLimit, setGraphLoadLimit] = useState(1500);
  const [graphHasMore, setGraphHasMore] = useState(false);
  const [graphViewMode, setGraphViewMode] = useState<'raw' | 'clustered'>('raw');
  const [sessionPublicationById, setSessionPublicationById] = useState<Record<string, MemorySessionPublicationStatus>>({});
  const [publishingSessionId, setPublishingSessionId] = useState<string | null>(null);
  const [publishNotice, setPublishNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const [graphFullScreen, setGraphFullScreen] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [timelineCursor, setTimelineCursor] = useState<number | null>(null);
  const [timelineMode, setTimelineMode] = useState<'timestamp' | 'turn'>('timestamp');
  const [isPlaying, setIsPlaying] = useState(false);
  const [graphSearch, setGraphSearch] = useState('');
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [graphFocusRequest, setGraphFocusRequest] = useState<GraphFocusRequest | null>(null);
  const [isNarrowLayout, setIsNarrowLayout] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth < 1180 : false,
  );
  const [persistenceHealth, setPersistenceHealth] = useState<{
    pending: number;
    inProgress: number;
    stored: number;
    failed: number;
    overduePending: number;
    oldestPendingAgeMs: number | null;
  } | null>(null);
  const [, setDeltaPerfStats] = useState<DeltaPerfStats>(() => emptyDeltaPerfStats());

  const chatAreaRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const graphTriplesRef = useRef<Triple[] | null>(null);
  const graphFetchSeqRef = useRef(0);
  const openSessionSeqRef = useRef(0);
  const showGraphRef = useRef(showGraph);
  const graphSessionIdRef = useRef<string | null>(graphSessionId);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const sessionIdRef = useRef<string | null>(sessionId);
  const loadingRef = useRef(loading);
  const graphHasMoreRef = useRef(graphHasMore);
  const graphFocusRequestSeqRef = useRef(0);
  const sessionMessagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const messageTurnIndexRef = useRef<Map<string, number>>(new Map());
  const bufferedPersistEventsRef = useRef<Map<string, ChatPersistenceStatusEvent>>(new Map());
  const graphWatermarkRef = useRef<Map<string, string | null>>(new Map());
  const deltaLatencySamplesRef = useRef<number[]>([]);
  const applyStoredTurnGraphUpdateRef = useRef<(
    sid: string,
    turnId: string,
    opts?: { linkedMessageId?: number; linkedTurnId?: string },
  ) => Promise<void>>(async () => {});

  useEffect(() => {
    showGraphRef.current = showGraph;
  }, [showGraph]);

  useEffect(() => {
    graphSessionIdRef.current = graphSessionId;
  }, [graphSessionId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    graphHasMoreRef.current = graphHasMore;
  }, [graphHasMore]);

  useEffect(() => {
    graphTriplesRef.current = graphTriples;
  }, [graphTriples]);

  useEffect(() => {
    const onResize = () => setIsNarrowLayout(window.innerWidth < 1180);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const el = chatAreaRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const handleChatScroll = useCallback(() => {
    const el = chatAreaRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    const index = new Map<string, number>();
    for (const m of messages) {
      if (m.turnId) index.set(m.turnId, m.id);
    }
    messageTurnIndexRef.current = index;
  }, [messages]);

  useEffect(() => {
    const sid = activeSessionId ?? sessionId;
    if (!sid) return;
    sessionMessagesCacheRef.current.set(
      sid,
      messages.map((m) => ({ ...m })),
    );
  }, [messages, activeSessionId, sessionId]);

  const resetDeltaPerfStats = useCallback(() => {
    deltaLatencySamplesRef.current = [];
    setDeltaPerfStats(emptyDeltaPerfStats());
  }, []);

  const recordDeltaPerf = useCallback((
    mode: 'delta' | 'fallback',
    elapsedMs: number,
    reason?: string,
  ) => {
    const latency = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    const samples = deltaLatencySamplesRef.current;
    samples.push(latency);
    if (samples.length > 128) {
      samples.splice(0, samples.length - 128);
    }
    const medianMs = quantileMs(samples, 0.5);
    const p95Ms = quantileMs(samples, 0.95);
    setDeltaPerfStats((prev) => ({
      sampleCount: samples.length,
      deltaApplied: prev.deltaApplied + (mode === 'delta' ? 1 : 0),
      fallbackCount: prev.fallbackCount + (mode === 'fallback' ? 1 : 0),
      medianMs,
      p95Ms,
      lastMode: mode,
      lastReason: mode === 'fallback' ? (reason ?? null) : null,
    }));
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetchMemorySessions(50);
      // Filter out OpenClaw channel sessions — they belong in the OpenClaw tab
      const filtered = (res.sessions ?? []).filter(s => !s.session?.startsWith('openclaw:'));
      setSessions(sessionSummariesFromApi(filtered));
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const refreshSessionPublication = useCallback(async (sid: string) => {
    try {
      const publication = await fetchMemorySessionPublication(sid);
      setSessionPublicationById((prev) => ({ ...prev, [sid]: publication }));
      const activeSid = activeSessionIdRef.current ?? sessionIdRef.current;
      if (activeSid === sid && publication.scope === 'enshrined') {
        setMessages((prevMsgs) => markStoredMessagesEnshrined(prevMsgs));
      }
    } catch {
      /* preserve last known publication state */
    }
  }, []);

  const applyPersistenceStatus = useCallback((event: ChatPersistenceStatusEvent) => {
    const indexedMessageId = messageTurnIndexRef.current.get(event.turnId);
    const activeSid = activeSessionIdRef.current ?? sessionIdRef.current;
    setMessages((prev) => {
      let found = false;
      const next = prev.map((m) => {
        if (m.turnId !== event.turnId) return m;
        found = true;
        const nextStoreMs = event.storeMs ?? m.timings?.store_ms ?? 0;
        const nextLlmMs = m.timings?.llm_ms ?? 0;
        const nextTotalMs = nextLlmMs + nextStoreMs;
        return {
          ...m,
          persistStatus: ((m.persistStatus === 'enshrined' && event.status === 'stored')
            ? 'enshrined' as const
            : event.status),
          persistError: event.error,
          persistAttempts: event.attempts,
          persistMaxAttempts: event.maxAttempts,
          timings: m.timings
            ? { ...m.timings, store_ms: nextStoreMs, total_ms: nextTotalMs }
            : m.timings,
        };
      });
      if (!found) {
        // Buffer only if this event can still attach to the active/in-flight turn.
        const shouldBuffer =
          loadingRef.current ||
          (!!activeSid && event.sessionId === activeSid);
        if (shouldBuffer) {
          bufferedPersistEventsRef.current.set(event.turnId, event);
          // Keep buffer bounded for long sessions and reconnect churn.
          if (bufferedPersistEventsRef.current.size > 128) {
            const oldest = bufferedPersistEventsRef.current.keys().next().value;
            if (oldest) bufferedPersistEventsRef.current.delete(oldest);
          }
        }
        return prev;
      }
      bufferedPersistEventsRef.current.delete(event.turnId);
      return next;
    });

    if (event.status === 'stored' && showGraphRef.current && event.sessionId) {
      void applyStoredTurnGraphUpdateRef.current(event.sessionId, event.turnId, {
        linkedMessageId: indexedMessageId,
        linkedTurnId: indexedMessageId == null ? event.turnId : undefined,
      });
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let activeAbort: AbortController | null = null;

    const refreshHealth = async () => {
      try {
        const health = await fetchChatPersistenceHealth();
        if (!disposed) setPersistenceHealth(health);
      } catch {
        if (!disposed) setPersistenceHealth(null);
      }
    };

    const connect = async () => {
      while (!disposed) {
        activeAbort = new AbortController();
        try {
          await streamChatPersistenceEvents({
            signal: activeAbort.signal,
            onEvent: (event) => {
              if (disposed) return;
              if (event.type === 'persist_health') {
                setPersistenceHealth({
                  pending: event.pending,
                  inProgress: event.inProgress,
                  stored: event.stored,
                  failed: event.failed,
                  overduePending: event.overduePending,
                  oldestPendingAgeMs: event.oldestPendingAgeMs,
                });
                return;
              }
              applyPersistenceStatus(event);
            },
          });
        } catch {
          if (disposed || activeAbort.signal.aborted) break;
        }
        if (disposed) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    };

    void refreshHealth();
    void connect();
    const healthPoll = setInterval(() => {
      void refreshHealth();
    }, 20_000);

    return () => {
      disposed = true;
      if (activeAbort) activeAbort.abort();
      clearInterval(healthPoll);
    };
  }, [applyPersistenceStatus]);

  const annotateTurnGraphDiff = useCallback((linkedMessageId: number, graphDiff: Message['graphDiff']) => {
    setMessages((prevMsgs) => prevMsgs.map((m) => (
      m.id === linkedMessageId
        ? {
            ...m,
            graphDiff,
          }
        : m
    )));
  }, []);

  const fetchSessionGraph = useCallback(async (
    sid: string,
    opts?: { limitOverride?: number },
  ) => {
    const fetchSeq = ++graphFetchSeqRef.current;
    setGraphLoading(true);
    setGraphSessionId(sid);
    try {
      const sessionUri = `urn:dkg:chat:session:${sid}`;
      const requestedLimit = Math.max(500, Math.min(opts?.limitOverride ?? graphLoadLimit, 15_000));
      const queryLimit = requestedLimit + 1;
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        {
          SELECT ?s ?p ?o WHERE {
            { <${sessionUri}> ?p ?o . BIND(<${sessionUri}> AS ?s) }
            UNION
            { ?s <http://schema.org/isPartOf> <${sessionUri}> . ?s ?p ?o }
            UNION
            { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
              ?msg <http://dkg.io/ontology/usedTool> ?tool .
              ?tool ?p ?o . BIND(?tool AS ?s) }
            UNION
            { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
              ?entity <http://dkg.io/ontology/mentionedIn> ?msg .
              ?entity ?p ?o . BIND(?entity AS ?s) }
            UNION
            { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
              ?srcEntity <http://dkg.io/ontology/mentionedIn> ?msg .
              ?srcEntity ?rel ?targetEntity .
              FILTER(STRSTARTS(STR(?targetEntity), "urn:dkg:entity:"))
              ?targetEntity ?p ?o . BIND(?targetEntity AS ?s) }
            UNION
            { ?memory <http://dkg.io/ontology/extractedFrom> <${sessionUri}> .
              ?memory ?p ?o . BIND(?memory AS ?s) }
          }
          ORDER BY ?s ?p ?o
          LIMIT ${queryLimit}
        }
      }`;
      const res = await executeQuery(sparql, 'agent-memory', true);
      const quads = Array.isArray(res?.result?.quads) ? res.result.quads : [];
      const triplesAll: Triple[] = quads.map((q: any) => ({
        subject: q.subject,
        predicate: q.predicate,
        object: stripTypedLiteral(q.object),
      }));
      const hasMore = triplesAll.length > requestedLimit;
      const triples = hasMore ? triplesAll.slice(0, requestedLimit) : triplesAll;
      if (graphFetchSeqRef.current !== fetchSeq) return;
      setGraphLoadLimit(requestedLimit);
      setGraphHasMore(hasMore);
      const nodeIds = collectNodeIds(triples);
      setSelectedGraphNodeId((prevSelected) => (
        prevSelected && nodeIds.has(prevSelected) ? prevSelected : null
      ));
      graphWatermarkRef.current.set(sid, deriveLatestTurnWatermark(triples));
      setGraphTriples(triples);
    } catch {
      if (graphFetchSeqRef.current !== fetchSeq) return;
      graphWatermarkRef.current.set(sid, null);
      setGraphHasMore(false);
      setGraphTriples([]);
    } finally {
      if (graphFetchSeqRef.current === fetchSeq) {
        setGraphLoading(false);
      }
    }
  }, [graphLoadLimit]);

  const applyStoredTurnGraphUpdate = useCallback(async (
    sid: string,
    turnId: string,
    opts?: { linkedMessageId?: number; linkedTurnId?: string },
  ) => {
    const startedAt = performance.now();
    const complete = (mode: 'delta' | 'fallback', reason?: string) => {
      recordDeltaPerf(mode, performance.now() - startedAt, reason);
    };
    const visibleGraphSession = graphSessionIdRef.current;
    const visibleChatSession = activeSessionIdRef.current ?? sessionIdRef.current;
    const targetSession = visibleGraphSession ?? visibleChatSession;
    if (targetSession !== sid) return;

    const currentTriples = graphTriplesRef.current;
    if (!currentTriples || graphHasMoreRef.current) {
      await fetchSessionGraph(sid);
      complete('fallback', !currentTriples ? 'missing_graph_snapshot' : 'partial_graph_snapshot');
      return;
    }

    const fetchSeq = graphFetchSeqRef.current;
    const baseTurnId = graphWatermarkRef.current.get(sid) ?? null;
    try {
      const delta = await fetchMemorySessionGraphDelta(sid, turnId, { baseTurnId });
      if (graphFetchSeqRef.current !== fetchSeq) return;
      if (graphSessionIdRef.current && graphSessionIdRef.current !== sid) return;
      if (delta.mode !== 'delta') {
        await fetchSessionGraph(sid);
        complete('fallback', delta.reason ?? 'full_refresh_required');
        return;
      }

      const deltaTriples: Triple[] = (delta.triples ?? []).map((t) => ({
        subject: t.subject,
        predicate: t.predicate,
        object: stripTypedLiteral(t.object),
      }));
      const latestTriples = graphTriplesRef.current ?? [];
      const merged = mergeUniqueTriples(latestTriples, deltaTriples);

      let linkedMessageId = opts?.linkedMessageId;
      if (linkedMessageId == null && opts?.linkedTurnId) {
        linkedMessageId = messageTurnIndexRef.current.get(opts.linkedTurnId);
      }
      if (linkedMessageId != null) {
        annotateTurnGraphDiff(linkedMessageId, buildTurnGraphDiff(latestTriples, merged));
      }

      graphWatermarkRef.current.set(
        sid,
        delta.watermark.appliedTurnId ?? delta.watermark.latestTurnId ?? turnId,
      );
      setGraphSessionId(sid);
      setGraphHasMore(false);
      setGraphTriples(merged);
      complete('delta');
    } catch {
      await fetchSessionGraph(sid);
      complete('fallback', 'delta_request_error');
    }
  }, [annotateTurnGraphDiff, fetchSessionGraph, recordDeltaPerf]);
  applyStoredTurnGraphUpdateRef.current = applyStoredTurnGraphUpdate;

  const visualizeSession = useCallback(async (sid: string) => {
    setShowGraph(true);
    setGraphFullScreen(false);
    setTimelineCursor(null);
    setIsPlaying(false);
    setGraphViewMode('raw');
    setGraphLoadLimit(1500);
    setPublishNotice(null);
    resetDeltaPerfStats();
    await Promise.all([
      fetchSessionGraph(sid, { limitOverride: 1500 }),
      refreshSessionPublication(sid),
    ]);
  }, [fetchSessionGraph, refreshSessionPublication, resetDeltaPerfStats]);

  const toggleGraphPane = useCallback(() => {
    if (showGraph) {
      graphFetchSeqRef.current += 1;
      setShowGraph(false);
      setGraphFullScreen(false);
      setGraphLoading(false);
      setIsPlaying(false);
      setPublishNotice(null);
      setGraphHasMore(false);
      setGraphFocusRequest(null);
      return;
    }
    const sid = activeSessionId ?? sessionId;
    if (!sid) {
      resetDeltaPerfStats();
      setShowGraph(true);
      setGraphFullScreen(false);
      setGraphTriples([]);
      setGraphSessionId(null);
      setGraphLoading(false);
      setGraphHasMore(false);
      setGraphFocusRequest(null);
      return;
    }
    void visualizeSession(sid);
  }, [showGraph, activeSessionId, sessionId, visualizeSession, resetDeltaPerfStats]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: Message = { id: _mid++, role: 'user', content: text, ts: new Date().toLocaleTimeString() };
    const assistantId = _mid++;
    const assistantTs = new Date().toLocaleTimeString();
    setMessages(prev => [...prev, userMsg, {
      id: assistantId,
      role: 'assistant',
      content: '',
      ts: assistantTs,
      responseMode: 'streaming',
    }]);
    setLoading(true);
    stickToBottomRef.current = true;

    try {
      const res = await streamChatMessage(text, {
        sessionId: sessionId ?? undefined,
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            setMessages(prev => prev.map((m) => (
              m.id === assistantId
                ? { ...m, content: `${m.content}${event.delta}` }
                : m
            )));
            return;
          }
          if (event.type === 'final') {
            setMessages(prev => prev.map((m) => (
              m.id === assistantId
                ? {
                    ...m,
                    content: event.reply || m.content,
                    data: event.data,
                    sparql: event.sparql,
                    turnId: event.turnId,
                    persistStatus: event.persistStatus,
                    persistError: event.persistError,
                    timings: event.timings,
                    responseMode: event.responseMode,
                    llmDiagnostics: event.llmDiagnostics,
                  }
                : m
            )));
            if (event.turnId) {
              const buffered = bufferedPersistEventsRef.current.get(event.turnId);
              if (buffered) {
                bufferedPersistEventsRef.current.delete(event.turnId);
                applyPersistenceStatus(buffered);
              }
            }
            if (showGraphRef.current && event.sessionId && event.persistStatus === 'stored' && event.turnId) {
              void applyStoredTurnGraphUpdate(event.sessionId, event.turnId, { linkedMessageId: assistantId });
            }
          }
        },
      });
      if (res.sessionId) {
        setSessionId(res.sessionId);
        setActiveSessionId(res.sessionId);
      }
      loadSessions();
    } catch (err: any) {
      setMessages(prev => prev.map((m) => (
        m.id === assistantId
          ? {
              ...m,
              content: `Error: ${err.message}`,
              responseMode: 'blocking',
            }
          : m
      )));
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId, loadSessions, applyPersistenceStatus, applyStoredTurnGraphUpdate]);

  const startNewChat = useCallback(() => {
    if (loading) return;
    openSessionSeqRef.current += 1;
    graphFetchSeqRef.current += 1;
    bufferedPersistEventsRef.current.clear();
    graphWatermarkRef.current.clear();
    resetDeltaPerfStats();
    setSessionId(null);
    setActiveSessionId(null);
    setMessages([welcomeMessage()]);
    setInput('');
    setGraphTriples(null);
    setGraphSessionId(null);
    setGraphLoading(false);
    setGraphLoadLimit(1500);
    setGraphHasMore(false);
    setGraphViewMode('raw');
    setGraphFullScreen(false);
    setPublishNotice(null);
    setSelectedMessageId(null);
    setSelectedGraphNodeId(null);
    setGraphFocusRequest(null);
    setGraphSearch('');
    setTimelineCursor(null);
    setIsPlaying(false);
    setGraphFullScreen(false);
    stickToBottomRef.current = true;
  }, [loading, resetDeltaPerfStats]);

  const openSession = useCallback(async (sid: string) => {
    if (loading) return;
    if (sid === activeSessionId) return;
    const openSeq = ++openSessionSeqRef.current;
    bufferedPersistEventsRef.current.clear();
    resetDeltaPerfStats();
    setSessionsLoading(true);
    setTimelineCursor(null);
    setIsPlaying(false);
    stickToBottomRef.current = true;
    setSelectedMessageId(null);
    setSelectedGraphNodeId(null);
    setGraphFocusRequest(null);
    setGraphSearch('');
    try {
      const session = await fetchMemorySession(sid);
      if (openSessionSeqRef.current !== openSeq) return;
      if (!session?.messages?.length) return;
      const cached = sessionMessagesCacheRef.current.get(sid) ?? [];
      const cachedByTurnId = new Map<string, Message>();
      for (const row of cached) {
        if (!row.turnId) continue;
        cachedByTurnId.set(row.turnId, row);
      }
      const restored: Message[] = session.messages.map((m) => {
        const role = m.author === 'user' ? 'user' as const : 'assistant' as const;
        const turnId = m.turnId?.trim() || undefined;
        const cachedMatch = turnId ? cachedByTurnId.get(turnId) : undefined;
        let persistStatus = normalizePersistStatus(m.persistStatus);
        if (cachedMatch?.persistStatus === 'enshrined') {
          persistStatus = 'enshrined';
        }
        if (!persistStatus && role === 'assistant' && turnId) {
          persistStatus = 'stored';
        }
        return {
          id: _mid++,
          role,
          content: m.text,
          ts: m.ts ? formatDate(m.ts) || new Date(m.ts).toLocaleTimeString() : '',
          turnId,
          persistStatus,
          graphDiff: cachedMatch?.graphDiff,
          llmDiagnostics: cachedMatch?.llmDiagnostics,
        };
      });
      const knownPublication = sessionPublicationById[sid];
      setMessages(
        knownPublication?.scope === 'enshrined'
          ? markStoredMessagesEnshrined(restored)
          : restored,
      );
      setSessionId(sid);
      setActiveSessionId(sid);
      if (showGraph) {
        setGraphViewMode('raw');
        setGraphLoadLimit(1500);
        await Promise.all([
          fetchSessionGraph(sid, { limitOverride: 1500 }),
          refreshSessionPublication(sid),
        ]);
      } else {
        graphFetchSeqRef.current += 1;
        setGraphTriples(null);
        setGraphSessionId(null);
        setGraphLoading(false);
        setGraphHasMore(false);
      }
    } catch {
      /* ignore load errors */
    } finally {
      if (openSessionSeqRef.current === openSeq) {
        setSessionsLoading(false);
      }
    }
  }, [loading, activeSessionId, showGraph, fetchSessionGraph, refreshSessionPublication, resetDeltaPerfStats, sessionPublicationById]);

  const timeline = useMemo(() => {
    if (!graphTriples || graphTriples.length === 0) return null;
    return extractTimeline(graphTriples);
  }, [graphTriples]);

  const timelineIndex = useMemo(() => {
    if (!timeline || timeline.timestamps.length === 0) return 0;
    const at = timelineCursor ?? timeline.timestamps[timeline.timestamps.length - 1];
    let idx = 0;
    for (let i = 0; i < timeline.timestamps.length; i += 1) {
      if (timeline.timestamps[i] <= at) idx = i;
      else break;
    }
    return idx;
  }, [timeline, timelineCursor]);

  const visibleTriples = useMemo(() => {
    if (!graphTriples || !timeline || timelineCursor === null) return graphTriples;
    return filterTriplesByCursor(graphTriples, timeline.subjectDates, timelineCursor);
  }, [graphTriples, timeline, timelineCursor]);

  useEffect(() => {
    if (timeline && timeline.timestamps.length > 0 && timelineCursor === null) {
      setTimelineCursor(timeline.timestamps[timeline.timestamps.length - 1]);
    }
  }, [timeline, timelineCursor]);

  useEffect(() => {
    if (!isPlaying || !timeline || timeline.timestamps.length < 2) return;
    const ts = timeline.timestamps;
    playRef.current = setInterval(() => {
      setTimelineCursor(prev => {
        const idx = ts.findIndex(t => t > (prev ?? 0));
        if (idx === -1 || idx >= ts.length) {
          setIsPlaying(false);
          return ts[ts.length - 1];
        }
        return ts[idx];
      });
    }, 600);
    return () => { if (playRef.current) clearInterval(playRef.current); };
  }, [isPlaying, timeline]);

  const graphTextSubjectIndex = useMemo(() => {
    const textToSubjects = new Map<string, Set<string>>();
    if (!graphTriples || graphTriples.length === 0) return textToSubjects;
    for (const t of graphTriples) {
      if (t.predicate !== SCHEMA_TEXT) continue;
      const key = normalizeTextKey(stripTypedLiteral(t.object));
      if (!key) continue;
      if (!textToSubjects.has(key)) textToSubjects.set(key, new Set());
      textToSubjects.get(key)!.add(t.subject);
    }
    return textToSubjects;
  }, [graphTriples]);

  const messageNodeIndex = useMemo(() => {
    const map = new Map<number, string[]>();
    if (graphTextSubjectIndex.size === 0) return map;
    for (const m of messages) {
      const key = normalizeTextKey(m.content);
      if (!key) continue;
      const subjects = graphTextSubjectIndex.get(key);
      if (subjects && subjects.size > 0) map.set(m.id, [...subjects]);
    }
    return map;
  }, [messages, graphTextSubjectIndex]);

  const nodeMessageIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (const [mid, nodes] of messageNodeIndex) {
      for (const nodeId of nodes) {
        map.set(nodeId, mid);
      }
    }
    return map;
  }, [messageNodeIndex]);

  const graphRenderTriples = useMemo(() => {
    const triples = visibleTriples ?? graphTriples;
    if (!triples) return triples;
    return graphViewMode === 'clustered' ? buildClusterTriples(triples) : triples;
  }, [visibleTriples, graphTriples, graphViewMode]);

  const renderedClusterCount = useMemo(() => {
    if (graphViewMode !== 'clustered' || !graphRenderTriples) return 0;
    const ids = new Set<string>();
    for (const t of graphRenderTriples) {
      if (t.predicate === RDF_TYPE && t.object === CLUSTER_TYPE) {
        ids.add(t.subject);
      }
    }
    return ids.size;
  }, [graphViewMode, graphRenderTriples]);

  const searchMatchedNodeIds = useMemo(() => {
    const term = graphSearch.trim().toLowerCase();
    const sourceTriples = graphRenderTriples;
    if (!term || !sourceTriples) return [] as string[];
    const out = new Set<string>();
    for (const t of sourceTriples) {
      if (
        t.subject.toLowerCase().includes(term) ||
        t.predicate.toLowerCase().includes(term) ||
        t.object.toLowerCase().includes(term)
      ) {
        out.add(t.subject);
        if (isNodeIri(t.object)) out.add(t.object);
      }
    }
    return [...out];
  }, [graphRenderTriples, graphSearch]);

  const highlightedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedMessageId != null) {
      for (const nodeId of messageNodeIndex.get(selectedMessageId) ?? []) ids.add(nodeId);
    }
    for (const nodeId of searchMatchedNodeIds) ids.add(nodeId);
    if (selectedGraphNodeId) ids.add(selectedGraphNodeId);
    return [...ids];
  }, [selectedMessageId, messageNodeIndex, searchMatchedNodeIds, selectedGraphNodeId]);

  const latestGraphDiff = useMemo(() => {
    return [...messages].reverse().find((m) => m.role === 'assistant' && m.graphDiff);
  }, [messages]);

  const selectedGraphDiff = useMemo(() => {
    if (selectedMessageId != null) {
      const selected = messages.find((m) => m.id === selectedMessageId && m.role === 'assistant' && m.graphDiff);
      if (selected?.graphDiff) return selected;
    }
    return latestGraphDiff ?? null;
  }, [messages, selectedMessageId, latestGraphDiff]);

  const jumpToMessage = useCallback((mid: number) => {
    const el = messageRefs.current.get(mid);
    if (!el) return;
    stickToBottomRef.current = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const requestGraphNodeFocus = useCallback((nodeId: string, zoomLevel = 2.1) => {
    graphFocusRequestSeqRef.current += 1;
    setGraphFocusRequest({
      nodeId,
      requestId: graphFocusRequestSeqRef.current,
      zoomLevel,
    });
  }, []);

  const handleGraphNodeClick = useCallback((node: { id: string }) => {
    setSelectedGraphNodeId(node.id);
    const mid = nodeMessageIndex.get(node.id);
    if (mid == null) return;
    setSelectedMessageId(mid);
  }, [nodeMessageIndex]);

  const graphViewConfig = useMemo(() => ({
    name: 'Conversation',
    palette: 'dark' as const,
    paletteOverrides: {
      edgeColor: '#5f8598',
      particleColor: 'rgba(34, 211, 238, 0.5)',
    },
  }), []);

  const rawGraphNodeIds = useMemo(() => {
    if (!graphTriples || graphTriples.length === 0) return new Set<string>();
    return collectNodeIds(graphTriples);
  }, [graphTriples]);

  const activeGraphSessionId = activeSessionId ?? sessionId ?? graphSessionId;
  const sessionPublication = activeGraphSessionId
    ? (sessionPublicationById[activeGraphSessionId] ?? null)
    : null;

  const scopeBadgeLabel = useMemo(() => {
    if (!sessionPublication) return activeGraphSessionId ? 'checking...' : 'no session';
    if (sessionPublication.scope === 'enshrined') return 'enshrined';
    if (sessionPublication.scope === 'enshrined_with_pending') return 'enshrined + pending';
    if (sessionPublication.scope === 'workspace_only') return 'workspace only';
    return 'empty';
  }, [activeGraphSessionId, sessionPublication]);
  const isPublishingActiveGraphSession = (
    !!publishingSessionId
    && !!activeGraphSessionId
    && publishingSessionId === activeGraphSessionId
  );
  const isPublishingDifferentSession = (
    !!publishingSessionId
    && !!activeGraphSessionId
    && publishingSessionId !== activeGraphSessionId
  );
  const publishButtonDisabled = !graphSessionId || isPublishingActiveGraphSession || isPublishingDifferentSession;
  const visiblePublishNotice = (
    publishNotice && activeGraphSessionId && publishNotice.sessionId === activeGraphSessionId
      ? publishNotice.text
      : null
  );

  useEffect(() => {
    if (graphViewMode !== 'raw') return;
    if (!selectedGraphNodeId) return;
    if (rawGraphNodeIds.has(selectedGraphNodeId)) return;
    setSelectedGraphNodeId(null);
  }, [graphViewMode, rawGraphNodeIds, selectedGraphNodeId]);

  const loadMoreGraph = useCallback(() => {
    const sid = graphSessionIdRef.current;
    if (!sid || graphLoading) return;
    const nextLimit = Math.min(graphLoadLimit + 1500, 15_000);
    void fetchSessionGraph(sid, { limitOverride: nextLimit });
  }, [fetchSessionGraph, graphLoadLimit, graphLoading]);

  const publishSessionGraph = useCallback(async () => {
    const sid = graphSessionIdRef.current ?? activeSessionIdRef.current ?? sessionIdRef.current;
    if (!sid || publishingSessionId != null) return;
    setPublishingSessionId(sid);
    setPublishNotice(null);
    try {
      const result = await Promise.race([
        publishMemorySession(sid, { clearAfter: false }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Publishing timed out. Please retry.')), 45_000);
        }),
      ]);
      setSessionPublicationById((prev) => ({ ...prev, [sid]: result.publication }));
      const activeSid = activeSessionIdRef.current ?? sessionIdRef.current;
      if (activeSid === sid && result.publication.scope === 'enshrined') {
        setMessages((prevMsgs) => markStoredMessagesEnshrined(prevMsgs));
      }
      setPublishNotice({
        sessionId: sid,
        text: `Published ${result.rootEntityCount} root entities (${result.status})`,
      });
      if (showGraphRef.current && graphSessionIdRef.current === sid) {
        await fetchSessionGraph(sid);
      }
      await loadSessions();
    } catch (err: any) {
      setPublishNotice({
        sessionId: sid,
        text: `Publish failed: ${err?.message ?? 'Unknown error'}`,
      });
    } finally {
      setPublishingSessionId((current) => (current === sid ? null : current));
    }
  }, [fetchSessionGraph, publishingSessionId, loadSessions]);

  const graphPane = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>
            {graphViewMode === 'clustered'
              ? `${renderedClusterCount} clusters`
              : `${graphRenderTriples?.length ?? 0} triples`}
          </span>
          {searchMatchedNodeIds.length > 0 && (
            <>
              <span style={{ color: 'var(--text-dim)' }}>.</span>
              <span>{searchMatchedNodeIds.length} highlighted nodes</span>
            </>
          )}
          <span style={{ color: 'var(--text-dim)' }}>.</span>
          <span
            className="mono"
            style={{
              borderRadius: 999,
              border: sessionPublication?.scope === 'enshrined'
                ? '1px solid rgba(74,222,128,.3)'
                : sessionPublication?.scope === 'enshrined_with_pending'
                  ? '1px solid rgba(245,158,11,.35)'
                : '1px solid var(--border)',
              background: sessionPublication?.scope === 'enshrined'
                ? 'rgba(74,222,128,.1)'
                : sessionPublication?.scope === 'enshrined_with_pending'
                  ? 'rgba(245,158,11,.12)'
                : 'var(--surface)',
              color: sessionPublication?.scope === 'enshrined'
                ? 'var(--green)'
                : sessionPublication?.scope === 'enshrined_with_pending'
                  ? '#f59e0b'
                : 'var(--text-dim)',
              padding: '2px 8px',
              fontSize: 10,
            }}
            title={`workspace triples: ${sessionPublication?.workspaceTripleCount ?? 0}, data triples: ${sessionPublication?.dataTripleCount ?? 0}`}
          >
            {scopeBadgeLabel}
          </span>
          {graphSessionId && (
            <>
              <span style={{ color: 'var(--text-dim)' }}>.</span>
              <span className="mono" title={graphSessionId}>session {graphSessionId.slice(0, 10)}</span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={graphSearch}
            onChange={(e) => setGraphSearch(e.target.value)}
            placeholder="Search graph nodes, predicates, values"
            style={{
              flex: 1,
              minWidth: 0,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              padding: '7px 10px',
              fontSize: 11,
            }}
          />
          {graphSearch && (
            <button
              onClick={() => setGraphSearch('')}
              style={{
                borderRadius: 7,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
                padding: '6px 8px',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setGraphViewMode('raw')}
            style={{
              borderRadius: 7,
              border: graphViewMode === 'raw' ? '1px solid rgba(34,211,238,.35)' : '1px solid var(--border)',
              background: graphViewMode === 'raw' ? 'rgba(34,211,238,.1)' : 'var(--surface)',
              color: graphViewMode === 'raw' ? '#22d3ee' : 'var(--text-muted)',
              padding: '5px 9px',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            Raw
          </button>
          <button
            onClick={() => setGraphViewMode('clustered')}
            style={{
              borderRadius: 7,
              border: graphViewMode === 'clustered' ? '1px solid rgba(34,211,238,.35)' : '1px solid var(--border)',
              background: graphViewMode === 'clustered' ? 'rgba(34,211,238,.1)' : 'var(--surface)',
              color: graphViewMode === 'clustered' ? '#22d3ee' : 'var(--text-muted)',
              padding: '5px 9px',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            Clustered
          </button>

          <button
            onClick={loadMoreGraph}
            disabled={!graphHasMore || graphLoading}
            style={{
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: graphHasMore ? 'var(--text-muted)' : 'var(--text-dim)',
              padding: '5px 9px',
              fontSize: 10,
              cursor: graphHasMore ? 'pointer' : 'not-allowed',
              opacity: graphHasMore ? 1 : 0.65,
            }}
            title={graphHasMore ? `Load more triples (current limit ${graphLoadLimit})` : 'All currently loaded triples are shown'}
          >
            {graphHasMore ? 'Load more' : 'Fully loaded'}
          </button>

          <button
            onClick={() => { void publishSessionGraph(); }}
            disabled={publishButtonDisabled}
            title={isPublishingDifferentSession ? 'Another session is currently publishing' : undefined}
            style={{
              marginLeft: 'auto',
              borderRadius: 7,
              border: '1px solid rgba(74,222,128,.35)',
              background: 'rgba(74,222,128,.1)',
              color: 'var(--green)',
              padding: '5px 9px',
              fontSize: 10,
              cursor: publishButtonDisabled ? 'not-allowed' : 'pointer',
              opacity: publishButtonDisabled ? 0.65 : 1,
            }}
          >
            {isPublishingActiveGraphSession ? 'Publishing...' : 'Publish session'}
          </button>
        </div>

        {visiblePublishNotice && (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: visiblePublishNotice.toLowerCase().includes('failed') ? 'var(--red)' : 'var(--green)',
            }}
          >
            {visiblePublishNotice}
          </div>
        )}
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Publish session enshrines the agent conversation currently in view on the DKG privately. New writes remain in workspace until you publish again.
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {graphLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
            Loading graph...
          </div>
        )}

        {!graphLoading && graphTriples == null && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', padding: 20 }}>
            Open a conversation graph to see node growth while you chat.
          </div>
        )}

        {!graphLoading && graphTriples && graphTriples.length === 0 && (
          <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><line x1="14.5" y1="9.5" x2="17.5" y2="6.5"/><line x1="9.5" y1="14.5" x2="6.5" y2="17.5"/></svg>
            </div>
            <div className="empty-state-title">No triples yet</div>
            <div className="empty-state-desc">Memory graph triples will appear here as data is stored.</div>
          </div>
        )}

        {!graphLoading && graphTriples && graphTriples.length > 0 && (
          <RdfGraph
            data={graphRenderTriples ?? graphTriples}
            format="triples"
            options={{
              labelMode: 'humanized',
              renderer: '2d',
              labels: {
                predicates: [
                  'http://schema.org/text',
                  'http://schema.org/name',
                  'http://www.w3.org/2000/01/rdf-schema#label',
                  'http://dkg.io/ontology/sessionId',
                  'http://dkg.io/ontology/toolName',
                ],
              },
              style: {
                classColors: {
                  'http://schema.org/Conversation': '#4ade80',
                  'http://schema.org/Message': '#22d3ee',
                  'http://dkg.io/ontology/ToolInvocation': '#f59e0b',
                  'http://dkg.io/ontology/GraphCluster': '#a78bfa',
                  'http://schema.org/Person': '#f472b6',
                  'http://schema.org/Organization': '#fb923c',
                  'http://schema.org/Place': '#34d399',
                  'http://schema.org/Product': '#c084fc',
                  'http://schema.org/Event': '#facc15',
                  'http://schema.org/CreativeWork': '#7dd3fc',
                },
                defaultNodeColor: '#94a3b8',
                defaultEdgeColor: '#5f8598',
                edgeWidth: 0.9,
              },
              hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true,
                circleTypes: ['http://schema.org/Message'] },
              focus: { maxNodes: 5000, hops: 999 },
            }}
            viewConfig={graphViewConfig}
            style={{ width: '100%', height: '100%' }}
            onNodeClick={handleGraphNodeClick}
          >
            <GraphHighlighter nodeIds={highlightedNodeIds} focusRequest={graphFocusRequest} />
          </RdfGraph>
        )}
      </div>

      {timeline && timeline.timestamps.length > 1 && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'grid', gap: 8, background: 'var(--bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => {
                if (isPlaying) {
                  setIsPlaying(false);
                } else {
                  if (timelineCursor !== null && timelineCursor >= timeline.timestamps[timeline.timestamps.length - 1]) {
                    setTimelineCursor(timeline.timestamps[0]);
                  }
                  setIsPlaying(true);
                }
              }}
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: '1px solid rgba(34,211,238,.3)',
                background: isPlaying ? 'rgba(34,211,238,.15)' : 'var(--surface)',
                color: '#22d3ee',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                flexShrink: 0,
              }}
              title={isPlaying ? 'Pause timeline' : 'Play timeline'}
            >
              {isPlaying ? '||' : '>'}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => setTimelineMode('timestamp')}
                style={{
                  borderRadius: 6,
                  border: timelineMode === 'timestamp' ? '1px solid rgba(34,211,238,.35)' : '1px solid var(--border)',
                  background: timelineMode === 'timestamp' ? 'rgba(34,211,238,.12)' : 'var(--surface)',
                  color: timelineMode === 'timestamp' ? '#22d3ee' : 'var(--text-muted)',
                  padding: '5px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Timestamp
              </button>
              <button
                onClick={() => setTimelineMode('turn')}
                style={{
                  borderRadius: 6,
                  border: timelineMode === 'turn' ? '1px solid rgba(34,211,238,.35)' : '1px solid var(--border)',
                  background: timelineMode === 'turn' ? 'rgba(34,211,238,.12)' : 'var(--surface)',
                  color: timelineMode === 'turn' ? '#22d3ee' : 'var(--text-muted)',
                  padding: '5px 8px',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Turn
              </button>
            </div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)' }}>
              {timelineMode === 'turn'
                ? `Turn ${timelineIndex + 1}/${timeline.timestamps.length}`
                : `At ${new Date(timelineCursor ?? timeline.timestamps[timeline.timestamps.length - 1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 56 }}>
              {timelineMode === 'turn'
                ? 'Turn 1'
                : new Date(timeline.timestamps[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
            <input
              type="range"
              min={timelineMode === 'turn' ? 0 : timeline.timestamps[0]}
              max={timelineMode === 'turn' ? timeline.timestamps.length - 1 : timeline.timestamps[timeline.timestamps.length - 1]}
              step={timelineMode === 'turn' ? 1 : undefined}
              value={timelineMode === 'turn' ? timelineIndex : (timelineCursor ?? timeline.timestamps[timeline.timestamps.length - 1])}
              onChange={(e) => {
                const value = Number(e.target.value);
                setIsPlaying(false);
                if (timelineMode === 'turn') {
                  const idx = Math.max(0, Math.min(timeline.timestamps.length - 1, value));
                  setTimelineCursor(timeline.timestamps[idx]);
                  return;
                }
                setTimelineCursor(value);
              }}
              style={{ flex: 1, accentColor: '#22d3ee', cursor: 'pointer' }}
            />
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 66, textAlign: 'right' }}>
              {timelineMode === 'turn'
                ? `Turn ${timeline.timestamps.length}`
                : new Date(timeline.timestamps[timeline.timestamps.length - 1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          </div>
        </div>
      )}

      {(selectedGraphNodeId || selectedGraphDiff?.graphDiff) && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'grid', gap: 8 }}>
          {selectedGraphNodeId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>Selected node</span>
              <code style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={selectedGraphNodeId}>
                {shortUri(selectedGraphNodeId)}
              </code>
              {nodeMessageIndex.has(selectedGraphNodeId) && (
                <button
                  onClick={() => jumpToMessage(nodeMessageIndex.get(selectedGraphNodeId)!)}
                  style={{
                    marginLeft: 'auto',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg)',
                    color: 'var(--text-muted)',
                    padding: '4px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  Jump to message
                </button>
              )}
            </div>
          )}

          {selectedGraphDiff?.graphDiff && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>What changed</span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                  {selectedMessageId === selectedGraphDiff.id ? 'selected turn' : 'latest persisted turn'}
                </span>
                <button
                  onClick={() => {
                    setSelectedMessageId(selectedGraphDiff.id);
                    jumpToMessage(selectedGraphDiff.id);
                  }}
                  style={{
                    marginLeft: 'auto',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg)',
                    color: 'var(--text-muted)',
                    padding: '4px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  Go to turn
                </button>
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--cyan)' }}>
                +{selectedGraphDiff.graphDiff.addedNodeCount} nodes . +{selectedGraphDiff.graphDiff.addedEdgeCount} edges
              </div>
              {selectedGraphDiff.graphDiff.sampleNodes.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {selectedGraphDiff.graphDiff.sampleNodes.map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        setSelectedGraphNodeId(id);
                        requestGraphNodeFocus(id);
                      }}
                      title={id}
                      style={{
                        borderRadius: 999,
                        border: '1px solid rgba(34,211,238,.25)',
                        background: 'rgba(34,211,238,.08)',
                        color: '#22d3ee',
                        padding: '3px 8px',
                        fontSize: 10,
                        cursor: 'pointer',
                        maxWidth: 220,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {shortUri(id)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const splitGraphMode = showGraph && !graphFullScreen;
  const showChatColumn = !(showGraph && graphFullScreen);
  const chatGraphGridStyle = splitGraphMode
    ? (
      isNarrowLayout
        ? { gridTemplateColumns: '1fr', gridTemplateRows: 'minmax(260px, .95fr) minmax(260px, 1.05fr)' }
        : { gridTemplateColumns: 'minmax(340px, 1fr) minmax(360px, .95fr)', gridTemplateRows: '1fr' }
    )
    : { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };

  return (
    <div className="page-section" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0 }}>
      {/* Mode tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg)', padding: '0 16px', gap: 0, flexShrink: 0 }}>
        {(nodeStatus?.hasOpenClawChannel ? ['openclaw', 'peers'] as const : ['agent', 'peers'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '12px 20px', fontSize: 12, fontWeight: mode === m ? 700 : 500,
              background: 'none', border: 'none', borderBottom: mode === m ? '2px solid var(--green)' : '2px solid transparent',
              color: mode === m ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s ease',
            }}
          >
            {m === 'agent' ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="3"/></svg>
            ) : m === 'openclaw' ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            )}
            {m === 'agent' ? 'My Agent' : m === 'openclaw' ? `OpenClaw${nodeStatus?.name ? ` (${nodeStatus.name})` : ''}` : 'Peer Chat'}
          </button>
        ))}
      </div>

      {mode === 'peers' ? (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <PeerChatView />
        </div>
      ) : mode === 'openclaw' ? (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <OpenClawChatView />
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: historyCollapsed ? '44px 1fr' : '260px 1fr', flex: 1, overflow: 'hidden' }}>

        {/* Left sidebar: chat history */}
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg)', overflow: 'hidden' }}>
          <div style={{ padding: historyCollapsed ? '10px 8px' : '16px 14px 12px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 8 }}>
            <button
              onClick={() => setHistoryCollapsed((prev) => !prev)}
              title={historyCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              style={{
                width: '100%',
                padding: historyCollapsed ? '8px 6px' : '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {historyCollapsed
                  ? <path d="M9 18l6-6-6-6" />
                  : <path d="M15 18l-6-6 6-6" />}
              </svg>
            </button>
            <button
              onClick={startNewChat}
              disabled={loading}
              title="Start a new chat session"
              style={{
                width: '100%',
                padding: historyCollapsed ? '8px 6px' : '10px 14px',
                borderRadius: 10,
                border: '1px solid rgba(74,222,128,.3)',
                background: 'var(--green-dim)',
                color: 'var(--green)',
                fontSize: 12,
                fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: historyCollapsed ? 0 : 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              {!historyCollapsed && 'New Chat'}
            </button>
          </div>

          {!historyCollapsed && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {sessionsLoading && sessions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '12px 6px' }}>Loading conversations…</div>
            )}
            {!sessionsLoading && sessions.length === 0 && (
              <div className="empty-state empty-state--sidebar">
                <div className="empty-state-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div className="empty-state-title">No conversations yet</div>
                <div className="empty-state-desc">Start chatting with your agent. Each conversation is stored in your private knowledge graph.</div>
              </div>
            )}
            {sessions.map((s) => {
              const isActive = s.id === activeSessionId;
              const dateLabel = formatDate(s.lastTs);
              return (
                <div
                  key={s.id}
                  onClick={() => { if (!loading) void openSession(s.id); }}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    marginBottom: 4,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.75 : 1,
                    background: isActive ? 'var(--surface)' : 'transparent',
                    border: isActive ? '1px solid var(--border)' : '1px solid transparent',
                    transition: 'all .15s ease',
                  }}
                  onMouseEnter={e => { if (!isActive && !loading) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface)'; }}
                  onMouseLeave={e => { if (!isActive && !loading) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                >
                  <div style={{
                    fontSize: 12,
                    fontWeight: isActive ? 700 : 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: isActive ? 'var(--text)' : 'var(--text-muted)',
                    marginBottom: 3,
                  }}>
                    {s.preview}{s.preview.length >= 60 ? '…' : ''}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      {s.messageCount} msg{dateLabel ? ` · ${dateLabel}` : ''}
                    </span>
                    {isActive && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (loading) return;
                          if (showGraph && graphSessionId === s.id) {
                            toggleGraphPane();
                          } else {
                            void visualizeSession(s.id);
                          }
                        }}
                        disabled={loading}
                        title="Visualize conversation graph"
                        style={{
                          marginLeft: 'auto',
                          padding: '2px 6px',
                          fontSize: 9,
                          fontWeight: 600,
                          borderRadius: 4,
                          border: '1px solid rgba(34,211,238,.3)',
                          background: 'rgba(34,211,238,.08)',
                          color: '#22d3ee',
                          cursor: loading ? 'not-allowed' : 'pointer',
                          opacity: loading ? 0.7 : 1,
                        }}
                      >
                        {showGraph && graphSessionId === s.id ? 'Hide' : 'Graph'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          )}

          {!historyCollapsed && (
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
              Conversations stored in your private DKG
            </div>
          </div>
          )}
        </div>

        {/* Right: active chat */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--green-dim)', border: '1px solid rgba(74,222,128,.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>AI</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>DKG Agent</div>
              <div style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                Connected
              </div>
            </div>
            {showGraph && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  color: '#22d3ee',
                  background: 'rgba(34,211,238,.1)',
                  border: '1px solid rgba(34,211,238,.28)',
                  borderRadius: 999,
                  padding: '3px 8px',
                }}
              >
                {graphFullScreen ? 'Graph-only view' : 'Split graph view'}
              </span>
            )}
            {persistenceHealth && (
              <span
                className="mono"
                title={`Pending: ${persistenceHealth.pending}, In progress: ${persistenceHealth.inProgress}, Failed: ${persistenceHealth.failed}, Overdue: ${persistenceHealth.overduePending}`}
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  color: persistenceHealth.failed > 0 || persistenceHealth.overduePending > 0 ? 'var(--red)' : 'var(--text-dim)',
                  background: persistenceHealth.failed > 0 || persistenceHealth.overduePending > 0 ? 'rgba(248,113,113,.08)' : 'var(--surface)',
                  border: persistenceHealth.failed > 0 || persistenceHealth.overduePending > 0 ? '1px solid rgba(248,113,113,.3)' : '1px solid var(--border)',
                  borderRadius: 999,
                  padding: '3px 8px',
                }}
              >
                Queue {persistenceHealth.pending}
                {persistenceHealth.failed > 0 ? ` . fail ${persistenceHealth.failed}` : ''}
                {persistenceHealth.overduePending > 0 ? ` . overdue ${persistenceHealth.overduePending}` : ''}
              </span>
            )}
            {showGraph && (
              <button
                onClick={() => setGraphFullScreen((prev) => !prev)}
                style={{
                  marginLeft: 8,
                  padding: '5px 10px',
                  fontSize: 10,
                  fontWeight: 600,
                  borderRadius: 6,
                  border: graphFullScreen ? '1px solid rgba(34,211,238,.5)' : '1px solid var(--border)',
                  background: graphFullScreen ? 'rgba(34,211,238,.1)' : 'var(--surface)',
                  color: graphFullScreen ? '#22d3ee' : 'var(--text-muted)',
                  cursor: 'pointer',
                }}
                title={graphFullScreen ? 'Exit graph-only mode' : 'Focus on graph only'}
              >
                {graphFullScreen ? 'Exit graph-only' : 'Graph only'}
              </button>
            )}
            <button
              onClick={toggleGraphPane}
              style={{
                marginLeft: 'auto',
                padding: '5px 12px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 6,
                border: showGraph ? '1px solid rgba(34,211,238,.5)' : '1px solid var(--border)',
                background: showGraph ? 'rgba(34,211,238,.1)' : 'var(--surface)',
                color: showGraph ? '#22d3ee' : 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                transition: 'all .15s ease',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
                <line x1="8.5" y1="7.5" x2="10.5" y2="16"/><line x1="15.5" y1="7.5" x2="13.5" y2="16"/>
              </svg>
              {showGraph ? 'Hide Graph' : 'Show Graph'}
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'grid', ...chatGraphGridStyle }}>
            {showChatColumn && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                borderRight: splitGraphMode && !isNarrowLayout ? '1px solid var(--border)' : 'none',
                borderBottom: splitGraphMode && isNarrowLayout ? '1px solid var(--border)' : 'none',
              }}
            >
              <div
                ref={chatAreaRef}
                onScroll={handleChatScroll}
                className="chat-area"
                style={{ flex: 1, overflowY: 'scroll', padding: '20px 24px' }}
              >
                {messages.map((m) => {
                  const isSelected = selectedMessageId === m.id;
                  const linkedNodes = messageNodeIndex.get(m.id) ?? [];
                  const showPersistAttemptCounter = (
                    m.persistStatus !== 'stored'
                    && m.persistStatus !== 'enshrined'
                    && m.persistStatus !== 'skipped'
                    && m.persistAttempts != null
                    && m.persistMaxAttempts != null
                  );
                  return (
                    <div
                      key={m.id}
                      ref={(el) => {
                        if (el) messageRefs.current.set(m.id, el);
                        else messageRefs.current.delete(m.id);
                      }}
                      className={`chat-msg ${m.role}`}
                      onClick={() => {
                        setSelectedMessageId(m.id);
                        if (!showGraph) return;
                        const linkedNodeId = linkedNodes[0] ?? null;
                        setSelectedGraphNodeId(linkedNodeId);
                        if (linkedNodeId) {
                          requestGraphNodeFocus(linkedNodeId);
                        }
                      }}
                      style={{ cursor: showGraph ? 'pointer' : 'default' }}
                    >
                      <div
                        className={`chat-bubble ${m.role}`}
                        style={isSelected ? { boxShadow: '0 0 0 1px rgba(34,211,238,.55)' } : undefined}
                      >
                        {m.content}
                      </div>

                      {m.role === 'assistant' && (m.persistStatus || m.llmDiagnostics || m.graphDiff) && (
                        <div style={{ marginTop: 5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          {m.persistStatus && (
                            <span
                              className="mono"
                              title={
                                m.persistStatus === 'enshrined' ? 'Published to the paranet and anchored on-chain' :
                                m.persistStatus === 'stored' ? 'Saved to your local knowledge graph' :
                                m.persistStatus === 'failed' ? 'Failed to persist this memory' :
                                m.persistStatus === 'skipped' ? 'Memory persistence was skipped for this message' :
                                m.persistStatus === 'in_progress' ? 'Currently being saved to the knowledge graph' :
                                'Waiting to be persisted'
                              }
                              style={{
                                fontSize: 10,
                                cursor: 'help',
                                color:
                                  m.persistStatus === 'enshrined' ? '#22d3ee' :
                                  m.persistStatus === 'stored' ? 'var(--green)' :
                                  m.persistStatus === 'failed' ? 'var(--red)' :
                                  m.persistStatus === 'skipped' ? 'var(--text-dim)' : '#f59e0b',
                                background:
                                  m.persistStatus === 'enshrined' ? 'rgba(34,211,238,.1)' :
                                  m.persistStatus === 'stored' ? 'rgba(74,222,128,.1)' :
                                  m.persistStatus === 'failed' ? 'rgba(248,113,113,.08)' :
                                  m.persistStatus === 'skipped' ? 'var(--surface)' : 'rgba(245,158,11,.1)',
                                border:
                                  m.persistStatus === 'enshrined' ? '1px solid rgba(34,211,238,.3)' :
                                  m.persistStatus === 'stored' ? '1px solid rgba(74,222,128,.3)' :
                                  m.persistStatus === 'failed' ? '1px solid rgba(248,113,113,.3)' :
                                  m.persistStatus === 'skipped' ? '1px solid var(--border)' : '1px solid rgba(245,158,11,.35)',
                                borderRadius: 5,
                                padding: '2px 6px',
                              }}
                            >
                              Memory: {m.persistStatus === 'in_progress' ? 'pending' : m.persistStatus}
                              {showPersistAttemptCounter
                                ? ` (${m.persistAttempts}/${m.persistMaxAttempts})`
                                : ''}
                            </span>
                          )}
                          {m.graphDiff && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#22d3ee',
                                background: 'rgba(34,211,238,.1)',
                                border: '1px solid rgba(34,211,238,.28)',
                                borderRadius: 5,
                                padding: '2px 6px',
                              }}
                            >
                              Added to graph: +{m.graphDiff.addedNodeCount} nodes, +{m.graphDiff.addedEdgeCount} edges
                            </span>
                          )}
                          {m.persistStatus === 'failed' && (
                            <span
                              style={{
                                fontSize: 10,
                                color: 'var(--red)',
                                background: 'rgba(248,113,113,.08)',
                                border: '1px solid rgba(248,113,113,.3)',
                                borderRadius: 5,
                                padding: '2px 6px',
                              }}
                            >
                              Memory save failed: {m.persistError ?? 'Unknown error'}
                            </span>
                          )}
                          {m.llmDiagnostics && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#f59e0b',
                                background: 'rgba(245,158,11,.1)',
                                border: '1px solid rgba(245,158,11,.35)',
                                borderRadius: 5,
                                padding: '2px 6px',
                              }}
                              title={m.llmDiagnostics.message}
                            >
                              LLM compatibility issue{m.llmDiagnostics.compatibilityHint ? `: ${m.llmDiagnostics.compatibilityHint}` : ''}
                            </span>
                          )}
                        </div>
                      )}

                      {m.sparql && (
                        <details style={{ marginTop: 4 }}>
                          <summary style={{ fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer' }}>SPARQL used</summary>
                          <pre className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', padding: '6px 8px', background: 'var(--surface)', borderRadius: 4, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{m.sparql}</pre>
                        </details>
                      )}

                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>{m.ts}</div>
                    </div>
                  );
                })}

                {loading && (
                  <div className="chat-msg assistant">
                    <div className="chat-bubble assistant" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '12px 16px' }}>
                      {[0, 0.2, 0.4].map((d, i) => (
                        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block', animation: `pulse 1.2s ease ${d}s infinite` }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="chat-input-row">
                <input
                  className="chat-input"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
                  placeholder="Query the graph, recall memories, publish knowledge..."
                />
                <button className="chat-send" onClick={send} disabled={loading}>Send</button>
              </div>
            </div>
            )}

            {showGraph && !isNarrowLayout && (
              <div style={{ display: 'flex', minWidth: 0, overflow: 'hidden' }}>
                {graphPane}
              </div>
            )}
          </div>

          {showGraph && isNarrowLayout && (
            <div style={{ borderTop: '1px solid var(--border)', height: '43%', minHeight: 260, maxHeight: '70%', display: 'flex', overflow: 'hidden' }}>
              {graphPane}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
