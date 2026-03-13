import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useFetch, shortId } from '../hooks.js';
import { fetchAgents, fetchMessages, sendPeerMessage, fetchStatus } from '../api.js';

interface Message {
  ts: number;
  direction: 'in' | 'out';
  peer: string;
  peerName?: string;
  text: string;
  delivered?: boolean;
}

interface Agent {
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  connectionStatus?: 'connected' | 'disconnected' | 'self';
  connectionTransport?: 'direct' | 'relayed';
}

const POLL_INTERVAL = 3_000;

function OnlineIndicator({ agent }: { agent: Agent }) {
  const isOnline = agent.connectionStatus === 'connected';
  const isRelayed = agent.connectionTransport === 'relayed';
  const title = isOnline 
    ? `Online (${isRelayed ? 'relayed' : 'direct'})` 
    : 'Offline';
  
  return (
    <span 
      className={`online-indicator ${isOnline ? 'online' : 'offline'}`}
      title={title}
    />
  );
}

export function MessagesPage() {
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);
  const { data: statusData } = useFetch(fetchStatus, [], 30_000);

  const agents: Agent[] = (agentData?.agents ?? []).filter(
    (a: Agent) => a.peerId !== statusData?.peerId,
  );
  const agentNameMap = new Map<string, string>();
  for (const a of agentData?.agents ?? []) agentNameMap.set(a.peerId, a.name);

  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastPollTs = useRef(0);

  const selectedAgent = agents.find(a => a.peerId === selectedPeer) ??
    (agentData?.agents ?? []).find((a: Agent) => a.peerId === selectedPeer);

  const pollMessages = useCallback(async () => {
    if (!selectedPeer) return;
    try {
      const name = agentNameMap.get(selectedPeer) ?? selectedPeer;
      const res = await fetchMessages({ peer: name, limit: 200 });
      setMessages(res.messages);
    } catch { /* ignore poll errors */ }
  }, [selectedPeer]);

  useEffect(() => {
    if (!selectedPeer) { setMessages([]); return; }
    pollMessages();
    const timer = setInterval(pollMessages, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [selectedPeer, pollMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-select first peer if none selected
  useEffect(() => {
    if (!selectedPeer && agents.length > 0) {
      setSelectedPeer(agents[0].peerId);
    }
  }, [agents, selectedPeer]);

  const handleSend = async () => {
    if (!inputText.trim() || !selectedPeer || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const name = agentNameMap.get(selectedPeer) ?? selectedPeer;
      const result = await sendPeerMessage(name, inputText.trim());
      if (result.delivered) {
        setInputText('');
        await pollMessages();
      } else {
        setSendError(result.error ?? 'Message not delivered');
      }
    } catch (err: any) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div>
      <h1 className="page-title">Messages</h1>

      <div className="chat-layout">
        {/* Peer list sidebar */}
        <div className="chat-peers">
          <div className="chat-peers-header">Agents</div>
          {agents.length === 0 ? (
            <div className="chat-peers-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div className="empty-state-icon" style={{ width: 36, height: 36, borderRadius: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No agents discovered</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>Agents will appear as they join the network.</div>
            </div>
          ) : (
            agents.map((a: Agent) => (
              <button
                key={a.peerId}
                className={`chat-peer-item ${selectedPeer === a.peerId ? 'active' : ''}`}
                onClick={() => { setSelectedPeer(a.peerId); setSendError(null); }}
              >
                <div className="chat-peer-name">
                  <OnlineIndicator agent={a} />
                  {a.name}
                </div>
                <div className="chat-peer-meta">
                  <span className={`badge ${a.nodeRole === 'core' ? 'badge-info' : 'badge-success'}`}>
                    {a.nodeRole ?? 'edge'}
                  </span>
                  <span className="mono" style={{ fontSize: 11 }}>{shortId(a.peerId, 6)}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Chat area */}
        <div className="chat-main">
          {selectedPeer ? (
            <>
              <div className="chat-header">
                <div className="chat-header-name">
                  {selectedAgent && <OnlineIndicator agent={selectedAgent} />}
                  {selectedAgent?.name ?? shortId(selectedPeer, 12)}
                </div>
                <div className="chat-header-meta">
                  <span className="mono">{shortId(selectedPeer, 16)}</span>
                  {selectedAgent?.connectionStatus === 'connected' && (
                    <span className="chat-status-text">
                      {selectedAgent.connectionTransport === 'relayed' ? '· relayed' : '· direct'}
                    </span>
                  )}
                </div>
              </div>

              <div className="chat-messages">
                {messages.length === 0 ? (
                  <div className="chat-empty" style={{ flexDirection: 'column', gap: 10 }}>
                    <div className="empty-state-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </div>
                    <div className="empty-state-title">No messages yet</div>
                    <div className="empty-state-desc">Send a message below to start a peer-to-peer conversation.</div>
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`chat-bubble ${msg.direction === 'out' ? 'chat-bubble-out' : 'chat-bubble-in'}`}>
                      <div className="chat-bubble-text">{msg.text}</div>
                      <div className="chat-bubble-time">
                        {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {msg.direction === 'out' && (
                          <span className={`chat-delivery ${msg.delivered !== false ? 'delivered' : 'failed'}`} title={msg.delivered !== false ? 'Delivered' : 'Not delivered'}>
                            {msg.delivered !== false ? (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M1.5 8.5l3 3 2-2M5.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/>
                              </svg>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-area">
                {sendError && (
                  <div className="chat-send-error">{sendError}</div>
                )}
                <div className="chat-input-row">
                  <input
                    className="chat-input"
                    type="text"
                    placeholder={`Message ${selectedAgent?.name ?? 'agent'}...`}
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                  />
                  <button
                    className="btn btn-primary chat-send-btn"
                    onClick={handleSend}
                    disabled={sending || !inputText.trim()}
                  >
                    {sending ? (
                      <svg className="chat-spinner" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="30 10" /></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7-14 7V9l10-1-10-1V1z"/></svg>
                    )}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-no-selection">
              <svg width="48" height="48" viewBox="0 0 16 16" fill="var(--text-muted)" opacity="0.3">
                <path d="M1 2h14v9H5l-4 3V2z"/>
              </svg>
              <div>Select an agent to start chatting</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
