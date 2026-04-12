import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useJourneyStore } from '../../stores/journey.js';
import { type ChatAssistantStreamEvent, type MemorySession, streamChatMessage, fetchConnections, fetchAgents } from '../../api.js';
import { api } from '../../api-wrapper.js';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

interface AgentInfo {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  connectionStatus?: string;
  connectionTransport?: string;
  connectionDirection?: string;
  lastSeen?: number;
  latencyMs?: number;
}

interface ConnectionInfo {
  peerId: string;
  transport: string;
  direction: string;
  openedAt: number;
  durationMs: number;
}

function shortPeerId(peerId: string): string {
  return peerId.length > 12 ? peerId.slice(-8) : peerId;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function AgentsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [connections, setConnections] = useState<{ total: number; direct: number; relayed: number }>({ total: 0, direct: 0, relayed: 0 });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [agentData, connData] = await Promise.all([
        fetchAgents().catch(() => ({ agents: [] })),
        fetchConnections().catch(() => ({ total: 0, direct: 0, relayed: 0 })),
      ]);
      setAgents(agentData.agents ?? []);
      setConnections({ total: connData.total ?? 0, direct: connData.direct ?? 0, relayed: connData.relayed ?? 0 });
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 15000); return () => clearInterval(iv); }, [refresh]);

  const selfAgent = agents.find(a => a.connectionStatus === 'self');
  const peerAgents = agents.filter(a => a.connectionStatus !== 'self');
  const connectedAgents = peerAgents.filter(a => a.connectionStatus === 'connected');
  const knownAgents = peerAgents.filter(a => a.connectionStatus !== 'connected');

  return (
    <div className="v10-agents-tab">
      <div className="v10-agents-summary">
        <span className="v10-agents-stat">
          <span className="v10-agents-stat-dot connected" />
          {connections.total} peer{connections.total !== 1 ? 's' : ''}
        </span>
        <span className="v10-agents-stat">
          {connectedAgents.length + 1} agent{connectedAgents.length !== 0 ? 's' : ''}
        </span>
        <button className="v10-agents-refresh" onClick={refresh} title="Refresh">↻</button>
      </div>

      {loading && <p className="v10-agents-loading">Loading agents...</p>}

      {selfAgent && (
        <div className="v10-agent-card self">
          <div className="v10-agent-card-header">
            <span className="v10-agent-card-dot self" />
            <span className="v10-agent-card-name">{selfAgent.name}</span>
            <span className="v10-agent-card-badge">self</span>
          </div>
          <div className="v10-agent-card-meta">
            <span>{selfAgent.nodeRole ?? 'core'}</span>
            <span title={selfAgent.peerId}>{shortPeerId(selfAgent.peerId)}</span>
          </div>
        </div>
      )}

      {connectedAgents.length > 0 && (
        <>
          <div className="v10-agents-section-label">Connected Peers</div>
          {connectedAgents.map(a => (
            <div key={a.peerId} className="v10-agent-card connected">
              <div className="v10-agent-card-header">
                <span className="v10-agent-card-dot connected" />
                <span className="v10-agent-card-name">{a.name}</span>
                <span className="v10-agent-card-badge">{a.connectionTransport ?? 'direct'}</span>
              </div>
              <div className="v10-agent-card-meta">
                <span>{a.nodeRole ?? 'core'}</span>
                <span title={a.peerId}>{shortPeerId(a.peerId)}</span>
                {a.latencyMs != null && <span>{a.latencyMs}ms</span>}
              </div>
            </div>
          ))}
        </>
      )}

      {knownAgents.length > 0 && (
        <>
          <div className="v10-agents-section-label">Known Agents</div>
          {knownAgents.map(a => (
            <div key={a.peerId} className="v10-agent-card known">
              <div className="v10-agent-card-header">
                <span className="v10-agent-card-dot known" />
                <span className="v10-agent-card-name">{a.name}</span>
              </div>
              <div className="v10-agent-card-meta">
                <span>{a.framework ?? 'DKG'}</span>
                <span title={a.peerId}>{shortPeerId(a.peerId)}</span>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="v10-agents-section-label" style={{ marginTop: 16 }}>Connect Agent</div>
      <div className="v10-agent-connect-cards">
        <button className="v10-agent-connect-card">
          <span className="v10-agent-connect-card-name">Hermes</span>
          <span className="v10-agent-connect-card-desc">Nous Research agent</span>
        </button>
        <button className="v10-agent-connect-card">
          <span className="v10-agent-connect-card-name">OpenClaw</span>
          <span className="v10-agent-connect-card-desc">Claude Code / MCP</span>
        </button>
        <button className="v10-agent-connect-card">
          <span className="v10-agent-connect-card-name">ElizaOS</span>
          <span className="v10-agent-connect-card-desc">ElizaOS adapter</span>
        </button>
      </div>
    </div>
  );
}

export function PanelRight() {
  const { stage, advance } = useJourneyStore();
  const [mode, setMode] = useState<'chat' | 'agents' | 'sessions'>('agents');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessions, setSessions] = useState<MemorySession[]>([]);
  const msgIdRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const loadSessions = useCallback(() => {
    api.fetchMemorySessions(20)
      .then(({ sessions: s }: any) => setSessions(s))
      .catch(() => {});
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { id: ++msgIdRef.current, role: 'user', content: text };
    const assistantMsg: ChatMessage = { id: ++msgIdRef.current, role: 'assistant', content: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);

    const assistantId = assistantMsg.id;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await streamChatMessage(text, {
        sessionId,
        signal: controller.signal,
        onEvent: (event: ChatAssistantStreamEvent) => {
          if (event.type === 'text_delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.delta } : m
              )
            );
          } else if (event.type === 'meta' && event.sessionId) {
            setSessionId(event.sessionId);
          }
        },
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: res.reply || m.content, streaming: false }
            : m
        )
      );

      if (res.sessionId) setSessionId(res.sessionId);
      if (stage === 0) advance();
      loadSessions();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `Error: ${err.message}`, streaming: false }
              : m
          )
        );
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [input, sending, sessionId, stage, advance, loadSessions]);

  const openSession = useCallback((session: MemorySession) => {
    const mapped: ChatMessage[] = session.messages.map((m, i) => ({
      id: ++msgIdRef.current,
      role: m.author === 'user' ? 'user' as const : 'assistant' as const,
      content: m.text,
    }));
    setMessages(mapped);
    setSessionId(session.session);
    setMode('chat');
  }, []);

  return (
    <div className="v10-panel-right">
      <div className="v10-agent-mode-tabs">
        <button
          className={`v10-agent-mode-tab ${mode === 'agents' ? 'active' : ''}`}
          onClick={() => setMode('agents')}
        >
          Agents
        </button>
        <button
          className={`v10-agent-mode-tab ${mode === 'chat' ? 'active' : ''}`}
          onClick={() => setMode('chat')}
        >
          Chat
        </button>
        <button
          className={`v10-agent-mode-tab ${mode === 'sessions' ? 'active' : ''}`}
          onClick={() => setMode('sessions')}
        >
          Sessions
        </button>
      </div>

      {mode === 'agents' && <AgentsTab />}

      {mode === 'chat' && (
        <>
          <div className="v10-agent-content">
            {messages.length === 0 && (
              <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 12, textAlign: 'center', marginTop: 40 }}>
                Ask your agent a question to get started.
              </div>
            )}
            <div className="v10-chat-messages">
              {messages.map((m) => (
                <div key={m.id} className={`v10-chat-msg ${m.role}`}>
                  <div className={`v10-chat-bubble ${m.role}`}>
                    {m.content}
                    {m.streaming && <span className="v10-chat-cursor" />}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>

          <div className="v10-agent-input-area">
            <input
              type="text"
              placeholder="Ask your agent..."
              className="v10-agent-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={sending}
            />
            <button className="v10-agent-send-btn" onClick={send} disabled={sending || !input.trim()}>
              ↑
            </button>
          </div>
        </>
      )}

      {mode === 'sessions' && (
        <div className="v10-agent-content">
          <div className="v10-sessions-list">
            {sessions.length === 0 ? (
              <p style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 12, textAlign: 'center' }}>
                No sessions yet
              </p>
            ) : (
              sessions.map((s) => {
                const preview = s.messages?.[0]?.text?.slice(0, 60) || s.session;
                const count = s.messages?.length ?? 0;
                return (
                  <button
                    key={s.session}
                    className="v10-session-item"
                    onClick={() => openSession(s)}
                  >
                    <span className="v10-session-preview">{preview}</span>
                    <span className="v10-session-count">{count} msg{count !== 1 ? 's' : ''}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
