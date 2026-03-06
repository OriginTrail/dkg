import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { sendChatMessage, fetchMemorySessions, fetchMemorySession, executeQuery, type MemorySession } from '../api.js';
import { RdfGraph } from '@dkg/graph-viz/react';

type Triple = { subject: string; predicate: string; object: string };

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  data?: unknown;
  sparql?: string;
}

interface SessionSummary {
  id: string;
  preview: string;
  messageCount: number;
  lastTs: string;
}

function stripTypedLiteral(value: string): string {
  if (!value) return value;
  const match = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  return match ? match[1] : value;
}

const DATE_CREATED = 'http://schema.org/dateCreated';

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
  return sessions.map(s => {
    const first = s.messages.find(m => m.author === 'user');
    const preview = first?.text?.slice(0, 60) || 'New conversation';
    const lastMsg = s.messages[s.messages.length - 1];
    return {
      id: s.session,
      preview,
      messageCount: s.messages.length,
      lastTs: lastMsg?.ts ?? '',
    };
  });
}

export function AgentHubPage() {
  const [messages, setMessages] = useState<Message[]>([welcomeMessage()]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetchMemorySessions(50);
      setSessions(sessionSummariesFromApi(res.sessions ?? []));
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: Message = { id: _mid++, role: 'user', content: text, ts: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await sendChatMessage(text, sessionId ?? undefined);
      if (res.sessionId && !sessionId) {
        setSessionId(res.sessionId);
        setActiveSessionId(res.sessionId);
      }
      setMessages(prev => [...prev, {
        id: _mid++,
        role: 'assistant',
        content: res.reply,
        ts: new Date().toLocaleTimeString(),
        data: res.data,
        sparql: res.sparql,
      }]);
      loadSessions();
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: _mid++,
        role: 'assistant',
        content: `Error: ${err.message}`,
        ts: new Date().toLocaleTimeString(),
      }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId, loadSessions]);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setActiveSessionId(null);
    setMessages([welcomeMessage()]);
    setInput('');
    setShowGraph(false);
    setGraphTriples(null);
    setTimelineCursor(null);
    setIsPlaying(false);
  }, []);

  const openSession = useCallback(async (sid: string) => {
    if (sid === activeSessionId) return;
    setSessionsLoading(true);
    setShowGraph(false);
    setGraphTriples(null);
    setTimelineCursor(null);
    setIsPlaying(false);
    try {
      const session = await fetchMemorySession(sid);
      if (!session?.messages?.length) return;
      const restored: Message[] = session.messages.map((m) => ({
        id: _mid++,
        role: m.author === 'user' ? 'user' as const : 'assistant' as const,
        content: m.text,
        ts: m.ts ? formatDate(m.ts) || new Date(m.ts).toLocaleTimeString() : '',
      }));
      setMessages(restored);
      setSessionId(sid);
      setActiveSessionId(sid);
    } catch {
      /* ignore load errors */
    } finally {
      setSessionsLoading(false);
    }
  }, [activeSessionId]);

  const [showGraph, setShowGraph] = useState(false);
  const [graphTriples, setGraphTriples] = useState<Triple[] | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [timelineCursor, setTimelineCursor] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const timeline = useMemo(() => {
    if (!graphTriples || graphTriples.length === 0) return null;
    return extractTimeline(graphTriples);
  }, [graphTriples]);

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

  const graphViewConfig = useMemo(() => ({
    name: 'Conversation',
    palette: 'dark' as const,
    paletteOverrides: {
      edgeColor: '#5f8598',
      particleColor: 'rgba(34, 211, 238, 0.5)',
    },
  }), []);

  const visualizeSession = useCallback(async (sid: string) => {
    if (showGraph && graphTriples) {
      setShowGraph(false);
      return;
    }
    setShowGraph(true);
    setGraphLoading(true);
    setTimelineCursor(null);
    setIsPlaying(false);
    try {
      const sessionUri = `urn:dkg:chat:session:${sid}`;
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        { <${sessionUri}> ?p ?o . BIND(<${sessionUri}> AS ?s) }
        UNION
        { ?s <http://schema.org/isPartOf> <${sessionUri}> . ?s ?p ?o }
        UNION
        { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
          ?entity <http://dkg.io/ontology/mentionedIn> ?msg .
          ?entity ?p ?o . BIND(?entity AS ?s) }
      } LIMIT 5000`;
      const res = await executeQuery(sparql, 'agent-memory', false, '_workspace');
      const quads = Array.isArray(res?.result?.quads) ? res.result.quads : [];
      setGraphTriples(quads.map((q: any) => ({
        subject: q.subject,
        predicate: q.predicate,
        object: stripTypedLiteral(q.object),
      })));
    } catch {
      setGraphTriples([]);
    } finally {
      setGraphLoading(false);
    }
  }, [showGraph, graphTriples]);

  return (
    <div className="page-section" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100%', overflow: 'hidden' }}>

        {/* Left sidebar: chat history */}
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg)', overflow: 'hidden' }}>
          <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--border)' }}>
            <button
              onClick={startNewChat}
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid rgba(74,222,128,.3)',
                background: 'var(--green-dim)',
                color: 'var(--green)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Chat
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {sessionsLoading && sessions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '12px 6px' }}>Loading conversations…</div>
            )}
            {!sessionsLoading && sessions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '12px 6px' }}>
                No conversations yet. Start chatting with your agent — each conversation is stored in your private knowledge graph.
              </div>
            )}
            {sessions.map((s) => {
              const isActive = s.id === activeSessionId;
              const dateLabel = formatDate(s.lastTs);
              return (
                <div
                  key={s.id}
                  onClick={() => openSession(s.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    marginBottom: 4,
                    cursor: 'pointer',
                    background: isActive ? 'var(--surface)' : 'transparent',
                    border: isActive ? '1px solid var(--border)' : '1px solid transparent',
                    transition: 'all .15s ease',
                  }}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface)'; }}
                  onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
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
                        onClick={(e) => { e.stopPropagation(); visualizeSession(s.id); }}
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
                          cursor: 'pointer',
                        }}
                      >
                        Graph
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
              Conversations stored in your private DKG
            </div>
          </div>
        </div>

        {/* Right: active chat */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--green-dim)', border: '1px solid rgba(74,222,128,.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🤖</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>DKG Agent</div>
              <div style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                Connected
              </div>
            </div>
            {activeSessionId && (
              <button
                onClick={() => visualizeSession(activeSessionId)}
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
                {showGraph ? 'Chat' : 'Graph'}
              </button>
            )}
          </div>

          {showGraph ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {graphLoading && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
                  Loading graph…
                </div>
              )}
              {!graphLoading && graphTriples && graphTriples.length === 0 && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
                  No triples found for this conversation.
                </div>
              )}
              {!graphLoading && graphTriples && graphTriples.length > 0 && (
                <>
                  <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2">
                      <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
                      <line x1="8.5" y1="7.5" x2="10.5" y2="16"/><line x1="15.5" y1="7.5" x2="13.5" y2="16"/>
                    </svg>
                    <span>{visibleTriples?.length ?? graphTriples.length} / {graphTriples.length} triples</span>
                    <span style={{ color: 'var(--text-dim)' }}>·</span>
                    <span>Conversation stored as RDF in your private <code style={{ fontSize: 10, background: 'var(--surface)', padding: '1px 4px', borderRadius: 3 }}>agent-memory</code> paranet</span>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <RdfGraph
                      data={visibleTriples ?? graphTriples}
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
                          },
                          defaultNodeColor: '#94a3b8',
                          defaultEdgeColor: '#5f8598',
                          edgeWidth: 0.9,
                        },
                        hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true },
                        focus: { maxNodes: 5000, hops: 999 },
                      }}
                      viewConfig={graphViewConfig}
                      style={{ width: '100%', height: '100%' }}
                    />
                  </div>
                  {timeline && timeline.timestamps.length > 1 && (
                    <div style={{
                      padding: '10px 16px',
                      borderTop: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'var(--bg)',
                    }}>
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
                          width: 28, height: 28, borderRadius: '50%',
                          border: '1px solid rgba(34,211,238,.3)',
                          background: isPlaying ? 'rgba(34,211,238,.15)' : 'var(--surface)',
                          color: '#22d3ee', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, flexShrink: 0,
                        }}
                        title={isPlaying ? 'Pause' : 'Play timeline'}
                      >
                        {isPlaying ? '⏸' : '▶'}
                      </button>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 55, fontFamily: 'JetBrains Mono, monospace' }}>
                        {timelineCursor ? new Date(timeline.timestamps[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                      </div>
                      <input
                        type="range"
                        min={timeline.timestamps[0]}
                        max={timeline.timestamps[timeline.timestamps.length - 1]}
                        value={timelineCursor ?? timeline.timestamps[timeline.timestamps.length - 1]}
                        onChange={e => { setIsPlaying(false); setTimelineCursor(Number(e.target.value)); }}
                        style={{ flex: 1, accentColor: '#22d3ee', cursor: 'pointer' }}
                      />
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 55, fontFamily: 'JetBrains Mono, monospace', textAlign: 'right' }}>
                        {timelineCursor ? new Date(timelineCursor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                      </div>
                      <div style={{
                        padding: '2px 8px', borderRadius: 10,
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        color: '#22d3ee', fontSize: 11, fontWeight: 600, minWidth: 30, textAlign: 'center',
                      }}>
                        {visibleTriples ? Math.round((visibleTriples.length / graphTriples.length) * 100) : 100}%
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <>
              <div className="chat-area" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {messages.map(m => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    <div className={`chat-bubble ${m.role}`}>{m.content}</div>
                    {m.sparql && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer' }}>SPARQL used</summary>
                        <pre className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', padding: '6px 8px', background: 'var(--surface)', borderRadius: 4, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{m.sparql}</pre>
                      </details>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>{m.ts}</div>
                  </div>
                ))}
                {loading && (
                  <div className="chat-msg assistant">
                    <div className="chat-bubble assistant" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '12px 16px' }}>
                      {[0, 0.2, 0.4].map((d, i) => (
                        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block', animation: `pulse 1.2s ease ${d}s infinite` }} />
                      ))}
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
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
                  placeholder="Query the graph, recall memories, publish knowledge…"
                />
                <button className="chat-send" onClick={send} disabled={loading}>Send</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
